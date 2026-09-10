import { app, safeStorage } from 'electron';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CollectorHost, ProviderResponse, SqliteLike } from '@tradeanalyzer/core';
import { applyDictionary, assertNotRedirected, etTimestamp, recordCloseHandle, recordOpenHandle, DICTIONARY_VERSION } from '@tradeanalyzer/core';
import { etradeGetRaw, renewAccessToken, type OAuthCredentials } from '../services/etrade-auth.js';
import type { TokenBucketRateLimiter } from '../services/rate-limiter.js';
import { logApiCall, logError } from '../services/logger.js';

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

/**
 * Whether the generation the pointer names actually exists.
 *
 * **Generation creation belongs to the new exe alone** (06 §3). This app is a
 * collector host: it writes *into* a generation, and has no business making one.
 * `readSharedPointer` already refuses to invent a pointer for exactly that
 * reason — but the guard stopped one level short, because `new Database(path)`
 * creates the file when it is missing, so the 2-minute claim tick would quietly
 * manufacture a generation of its own.
 *
 * Observed 2026-09-07: after the corrupt gen-001 was deleted, the collector's
 * next tick recreated it — 52 tables, `integrity_check: ok`, and **zero rows in
 * `meta_generation`**, because only the new exe writes that. It looks like a
 * healthy generation from every angle except the one that says whose it is.
 * (Worth noting against the original bug report, which read `meta_generation = 0`
 * as evidence of the corruption. It is *also* the signature of a generation the
 * wrong application created.)
 */
export function generationExists(pointer: DataRootPointer): boolean {
  return existsSync(generationPaths(pointer).dbPath);
}

export interface ElectronCollectorHostOptions {
  readonly signal: AbortSignal;
  readonly onProgress: (phase: string, done: number, total: number, note?: string) => void;
  /**
   * **The application's single Polygon limiter — the instance, not a copy.**
   *
   * Polygon rate-limits per API key, and the collector shares this app's key, so
   * two buckets would be two independent budgets spending one allowance. That is
   * why Q4 chose to host the collector here in the first place: one token holder,
   * one limiter (NewApp 01 §63, 04 §1.1).
   *
   * `polygonGet` bypassed it entirely from v1.1.196 to v1.1.211 — a direct
   * `fetch`, against spec 06 §5 change #3 and CLAUDE.md's standing rule. It went
   * unfixed on purpose while the generation corruption was open, because the
   * limiter changes the collector's write pace and pace was an experimental
   * variable.
   */
  readonly rateLimiter: TokenBucketRateLimiter;
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

    // Refuse before SQLite is involved. If this process were launched from a
    // containerised shell its `%APPDATA%` is redirected, and it would then write
    // a private copy of `data.sqlite` while sharing the real write-ahead log
    // with the new exe — two writers, one lock, two files. That is what
    // corrupted gen-001 twice on 2026-09-07, deterministically, in the middle of
    // `universe_seed`. The pointer's directory is checked as well as the
    // generation's, because `dataRoot` is configurable and the pointer is not.
    assertNotRedirected([dirname(SHARED_POINTER()), dirname(dbPath)], 'TradeAnalyzer');

    // Refuse before `mkdirSync`, which would otherwise create the generation
    // directory, and before `new Database`, which would create the file. The
    // callers check `generationExists()` and report `skipped`; this is the
    // choke point that makes it impossible rather than merely unlikely.
    if (!existsSync(dbPath)) {
      throw new Error(
        `No generation at ${dbPath}. Generation creation belongs to TradeAnalyzer 2 (NewApp 06 §3) — ` +
          'this application only collects into one. Creating it here would produce a generation with ' +
          'no `meta_generation` row that looks healthy from every angle except whose it is. ' +
          'Run TradeAnalyzer 2 once.'
      );
    }

    mkdirSync(archiveRoot, { recursive: true });

    // Write-capable, never readonly. On Windows a readonly connection cannot
    // attach the live WAL index and silently reads only up to the last
    // checkpoint — the new exe holds this same file open, so a readonly handle
    // here would read a stale generation and report it as current (CLAUDE.md).
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    applyDictionary(db as unknown as SqliteLike);

    // The other half of the answer to "are both applications looking at the same
    // file". The new exe writes its own row on open; a reader that finds only
    // one of the two is looking at a split file set.
    recordOpenHandle(db as unknown as SqliteLike, {
      appName: this.hostApp.name,
      appVersion: this.hostApp.version,
      dbPath,
      dictionaryVersion: DICTIONARY_VERSION,
      openedAt: this.nowET(),
      processId: process.pid
    });

    this.db = db;
    return db as unknown as SqliteLike;
  }

  close(): void {
    if (!this.db) return;

    // Stamp the close BEFORE closing, so "were both applications holding this
    // file at once" is answerable by reading the table rather than by asking
    // somebody what they had running. On 2026-09-09 that question was the live
    // hypothesis in a corruption investigation and the table could not answer it.
    try {
      recordCloseHandle(this.db as unknown as SqliteLike, {
        appName: this.hostApp.name,
        dbPath: generationPaths(this.pointer).dbPath,
        closedAt: this.nowET()
      });
    } catch {
      /* an annotation must never be the reason a job cannot finish */
    }

    // Explicitly, not left to close-time semantics. A `db.close()` with a
    // multi-megabyte WAL relies on SQLite checkpointing on the way out, and a
    // checkpoint that silently does nothing is indistinguishable from one that
    // worked — measured once at 918,792 bytes of WAL discarded with the base
    // file byte-for-byte unchanged. The new exe was fixed for this; the
    // collector host still trusted close.
    //
    // The result is logged **every time, including success**, and with the WAL
    // size that preceded it. Warning-only was the same trap one level up: no
    // warning is equally consistent with "the checkpoint applied cleanly" and
    // with "`close()` was never reached", and those are opposite readings of a
    // seed that comes back clean. `packages/next` has logged every checkpoint
    // unconditionally since it was written; this is the host catching up.
    const walBytes = (() => {
      try {
        return statSync(`${generationPaths(this.pointer).dbPath}-wal`).size;
      } catch {
        return -1; // no `-wal` to read — reported as such rather than as zero
      }
    })();
    try {
      const [row] = this.db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number; log: number; checkpointed: number }[];
      // Three outcomes, not two. `log === checkpointed` is also true of `0 === 0`,
      // so "flushed four megabytes" and "there was nothing to flush" both read as
      // applied — which is the very ambiguity this line exists to remove, one
      // level further down, and it went unnoticed until the numbers were read
      // beside `walBytes`.
      //
      // Measured on the two clean seeds of 2026-09-09: `walBytes≈4.15MB` with
      // `log=0 checkpointed=0`, twice. `wal_autocheckpoint` (every 1000 pages by
      // default) had already flushed everything long before `close()`, so the
      // explicit checkpoint moved no frames on either run. That is what struck
      // the missing checkpoint off as the cause of the corruption — and without
      // the distinction below it would have gone into the record as the fix.
      const verdict =
        row === undefined ? 'returned nothing'
        : row.busy !== 0 ? 'was BUSY and did not finish'
        : row.log !== row.checkpointed ? 'did NOT fully apply'
        : row.log === 0 ? 'had nothing to do — the WAL held no pending frames'
        : 'applied';
      const healthy = verdict === 'applied' || verdict.startsWith('had nothing');
      logError({
        timestamp: etTimestamp(),
        appVersion: this.hostApp.version,
        errorClass: 'CollectorCheckpoint',
        message:
          `checkpoint ${verdict} — ` +
          `walBytes=${walBytes} busy=${row?.busy} log=${row?.log} checkpointed=${row?.checkpointed}`,
        stack: null,
        operation: 'collector-host:close',
        ticker: null,
        correlationId: null,
        level: healthy ? 'INFO' : 'WARNING'
      });
    } catch (err) {
      // Still says something. A checkpoint that threw is a third outcome, and
      // silence would collapse it into the other two.
      logError({
        timestamp: etTimestamp(),
        appVersion: this.hostApp.version,
        errorClass: 'CollectorCheckpoint',
        message: `checkpoint threw — walBytes=${walBytes}: ${(err as Error).message}`,
        stack: null,
        operation: 'collector-host:close',
        ticker: null,
        correlationId: null,
        level: 'WARNING'
      });
      /* fall through to close, which will checkpoint or not on its own */
    }

    this.db.close();
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

    // Acquired BEFORE the clock starts, deliberately: `responseLatencyMs` must
    // measure Polygon, not how long we queued for a token. A wait folded into
    // the latency figure would make the provider look slow exactly when the
    // limiter is working hardest, and `logs/api/` is the first thing read when a
    // provider path misbehaves.
    await this.opts.rateLimiter.acquire(1);

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
    // Delegates to `core`'s `etTimestamp`. This used to be an inline
    // `Intl.DateTimeFormat` build, correct and pinned by a test — and the new exe
    // then wrote `openedAt` with `toISOString()` and put a UTC stamp into the
    // same forensic table, a day out. **The rule was living in a test attached to
    // one implementation instead of in a function both applications call**, which
    // is the shape this project keeps paying for. One implementation now.
    return etTimestamp();
  }

  async sendEmail(msg: { subject: string; text: string; html: string }): Promise<void> {
    await this.opts.sendEmail(msg);
  }

  progress(phase: string, done: number, total: number, note?: string): void {
    this.opts.onProgress(phase, done, total, note);
  }
}
