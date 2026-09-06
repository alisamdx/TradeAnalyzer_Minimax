import { app, safeStorage } from 'electron';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CollectorHost, ProviderResponse, SqliteLike } from '@tradeanalyzer/core';
import { applyDictionary } from '@tradeanalyzer/core';
import { etradeGetRaw, renewAccessToken, type OAuthCredentials } from '../services/etrade-auth.js';
import { logApiCall } from '../services/logger.js';

/**
 * `ElectronCollectorHost` — NewApp 04 §1.1, 06 §5 change #3.
 *
 * The adapter that lets the collector run inside the existing app during stage 1.
 * It is deliberately thin: it owns **no** collection logic, only the four things
 * the existing app happens to have and `core` deliberately does not — the
 * provider transports with their accumulated hardening, `safeStorage`, the
 * generation database handle, and the batch progress channel.
 *
 * Nothing about this arrangement is load-bearing beyond the E*Trade token (Q4),
 * which is why cut-over later is just "the new exe stops queueing and runs them
 * itself".
 */

const SHARED_POINTER = () =>
  join(app.getPath('appData'), 'tradeanalyzer-shared', 'data-root.json');

interface DataRootPointer {
  dataRoot: string;
  currentGeneration: number;
}

/**
 * Reads where the generation lives.
 *
 * The pointer is written by whichever application creates a generation — in
 * practice the new exe — and read by both. It is the only file the two share.
 * **Never created here**: if it is missing, the new exe has not been run, and
 * silently inventing a path would create a second, empty generation that looks
 * exactly like the real one having lost its data.
 */
export function readSharedPointer(): DataRootPointer | undefined {
  const path = SHARED_POINTER();
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DataRootPointer>;
  if (typeof parsed.dataRoot !== 'string' || typeof parsed.currentGeneration !== 'number') {
    throw new Error(`${path} is present but malformed; the collector will not guess where the data is.`);
  }
  return { dataRoot: parsed.dataRoot, currentGeneration: parsed.currentGeneration };
}

export function generationPaths(pointer: DataRootPointer): { dbPath: string; archiveRoot: string } {
  const dir = join(pointer.dataRoot, `gen-${String(pointer.currentGeneration).padStart(3, '0')}`);
  return { dbPath: join(dir, 'data.sqlite'), archiveRoot: join(dir, 'archive') };
}

export interface ElectronCollectorHostOptions {
  readonly signal: AbortSignal;
  readonly onProgress: (phase: string, done: number, total: number, note?: string) => void;
  readonly getPolygonApiKey: () => string;
  readonly getEtradeCredentials: () => OAuthCredentials | null;
  readonly sendEmail: (msg: { subject: string; text: string; html: string }) => Promise<void>;
}

export class ElectronCollectorHost implements CollectorHost {
  private db: Database.Database | undefined;

  readonly hostApp: { name: string; version: string };

  constructor(
    private readonly pointer: DataRootPointer,
    private readonly opts: ElectronCollectorHostOptions
  ) {
    this.hostApp = { name: 'TradeAnalyzer', version: app.getVersion() };
  }

  get signal(): AbortSignal {
    return this.opts.signal;
  }

  openGenerationDb(): SqliteLike {
    if (this.db) return this.db as unknown as SqliteLike;
    const { dbPath, archiveRoot } = generationPaths(this.pointer);
    mkdirSync(archiveRoot, { recursive: true });

    // Write-capable, never readonly. On Windows a readonly connection cannot
    // attach the live WAL index and silently reads only up to the last
    // checkpoint — the new exe holds this same file open, so a readonly handle
    // here would read a stale generation and report it as current (CLAUDE.md).
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    applyDictionary(db as unknown as SqliteLike);
    this.db = db;
    return db as unknown as SqliteLike;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  archiveRoot(): string {
    return generationPaths(this.pointer).archiveRoot;
  }

  encryptForArchive(buf: Buffer): Buffer {
    if (!safeStorage.isEncryptionAvailable()) {
      // Refusing beats writing account data in the clear. The archive is
      // permanent (04 §6), so a file written unencrypted today stays
      // unencrypted forever and there is no way to tell later which files those
      // were.
      throw new Error(
        'safeStorage is unavailable, so account-domain archive lines cannot be encrypted (P15, Q20). ' +
          'Refusing to write them in the clear.'
      );
    }
    return safeStorage.encryptString(buf.toString('base64'));
  }

  decryptFromArchive(buf: Buffer): Buffer {
    return Buffer.from(safeStorage.decryptString(buf), 'base64');
  }

  async polygonGet(path: string, params: Record<string, string>): Promise<ProviderResponse> {
    const url = new URL(`https://api.polygon.io${path}`);
    const apiKey = this.opts.getPolygonApiKey();
    if (apiKey) url.searchParams.set('apiKey', apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const requestedAt = new Date().toISOString();
    const started = Date.now();
    try {
      const res = await fetch(url.toString());
      const body = await res.text();
      logApiCall({
        timestamp: requestedAt,
        provider: 'polygon',
        endpoint: path,
        method: 'GET',
        // The key lives in the query string, so params are rebuilt from the
        // caller's rather than read back off the URL.
        requestParams: params,
        responseStatus: res.status,
        responseLatencyMs: Date.now() - started,
        responseSizeBytes: body.length,
        retryCount: 0,
        jobRunId: null
      });
      return { status: res.status, body, requestedAt, respondedAt: new Date().toISOString() };
    } catch (err) {
      logApiCall({
        timestamp: requestedAt,
        provider: 'polygon',
        endpoint: path,
        method: 'GET',
        requestParams: params,
        responseStatus: null,
        responseLatencyMs: Date.now() - started,
        responseSizeBytes: null,
        retryCount: 0,
        jobRunId: null,
        errorMessage: err instanceof Error ? err.message : String(err)
      });
      return {
        status: null,
        body: '',
        requestedAt,
        respondedAt: null,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  /**
   * E*Trade, with renew-and-retry on **any** failure.
   *
   * Never gate the renewal on an auth-shaped error message. A dormant token does
   * not reliably fail as a 401 — it can kill or hang the response stream — and
   * that exact heuristic bit two separate paths in the existing app, one of them
   * halting the evening orchestrator on 8 of 10 trading days. Renewing an active
   * token errors harmlessly, so trying costs nothing.
   */
  async etradeGet(path: string, params: Record<string, string>): Promise<ProviderResponse> {
    const creds = this.opts.getEtradeCredentials();
    if (!creds) {
      return {
        status: null,
        body: '',
        requestedAt: new Date().toISOString(),
        respondedAt: null,
        error: 'E*Trade credentials are not configured.'
      };
    }

    const first = await etradeGetRaw(path, params, creds);
    const ok = first.status !== null && first.status >= 200 && first.status < 300;
    if (ok) return first;

    try {
      await renewAccessToken(creds);
    } catch {
      // A renew failure is not itself fatal: the retry below will report the
      // real outcome, and an expired-past-midnight token needs a manual
      // re-auth that no amount of retrying can substitute for.
    }
    return etradeGetRaw(path, params, this.opts.getEtradeCredentials() ?? creds);
  }

  async httpGet(url: string, headers: Record<string, string> = {}): Promise<ProviderResponse> {
    const requestedAt = new Date().toISOString();
    try {
      const res = await fetch(url, {
        headers: {
          // EDGAR requires a descriptive User-Agent and rejects requests without one.
          'User-Agent': `TradeAnalyzer/${app.getVersion()} (collector)`,
          ...headers
        }
      });
      const body = await res.text();
      return { status: res.status, body, requestedAt, respondedAt: new Date().toISOString() };
    } catch (err) {
      return {
        status: null,
        body: '',
        requestedAt,
        respondedAt: null,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  nowET(): string {
    // ISO-8601 with the America/New_York offset, per 02 §0.1. Built from parts
    // rather than from toISOString(), which would give UTC and silently shift
    // every evening timestamp onto the following day.
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
    const utcMs = Date.UTC(
      Number(get('year')), Number(get('month')) - 1, Number(get('day')),
      Number(get('hour')) % 24, Number(get('minute')), Number(get('second'))
    );
    const offsetMinutes = Math.round((utcMs - now.getTime()) / 60_000);
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMinutes);
    const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
  }

  async sendEmail(msg: { subject: string; text: string; html: string }): Promise<void> {
    await this.opts.sendEmail(msg);
  }

  progress(phase: string, done: number, total: number, note?: string): void {
    this.opts.onProgress(phase, done, total, note);
  }
}
