// The EDGAR contact identity — one module, every caller.
//
// The SEC asks automated clients to "declare your user agent in request
// headers", with a contact address so they can reach whoever is running the
// automation. Two independent callers in this app talk to sec.gov:
//
//   1. `sec-edgar-provider.ts` — XBRL fundamentals and the ticker→CIK map.
//   2. `ElectronCollectorHost.httpGet` — the NewApp collector's filings, company
//      facts and Form 4 sweeps.
//
// Before v1.1.227 they disagreed: the first sent `trader@local` (an address that
// does not exist) and the second sent no contact at all. Both are now built
// here, because a rule that must hold for every caller belongs in the function
// they all call — the shape this project has paid for repeatedly (the portfolio
// cash snapshot, the E*Trade OAuth transport, the dev scripts' redirect guard).
//
// **The address is NOT in this file and never should be.** It lives in the
// `settings` table, set by the operator in Settings, because this repository has
// a GitHub remote and a contact address committed here would be in its history
// permanently — which no later edit removes.

import type { DbHandle } from '../db/connection.js';
import { logApiCall } from './logger.js';

/** The settings key holding the operator's EDGAR contact address. */
export const EDGAR_CONTACT_KEY = 'edgarContact';

let _db: DbHandle | null = null;
let _appVersion = '0.0.0';

/**
 * Installed once at boot. A setter rather than a parameter because
 * `sec-edgar-provider` is a module of free functions reached through
 * `polygon-provider.getFundamentals`, and threading a handle through those call
 * sites would put the identity back in the hands of each caller — the thing this
 * module exists to prevent.
 */
export function setEdgarContactSource(db: DbHandle, appVersion: string): void {
  _db = db;
  _appVersion = appVersion;
}

/** The configured contact address, or null when the operator has not set one. */
export function edgarContact(): string | null {
  if (!_db) return null;
  try {
    const row = _db.prepare('SELECT value FROM settings WHERE key = ?').get(EDGAR_CONTACT_KEY) as
      | { value: string }
      | undefined;
    const value = row?.value.trim() ?? '';
    return value === '' ? null : value;
  } catch {
    // A contact address is a courtesy, never a reason a provider call cannot be
    // made. Deliberately a plain setting and not `secureGet`: an encrypted read
    // can fail closed and blank every key at once (v1.1.200), and degrading a
    // courtesy header into a failed fetch would be the worse trade.
    return null;
  }
}

/**
 * The `User-Agent` for every sec.gov request.
 *
 * With no contact configured this degrades to the name-only agent rather than
 * emitting empty parentheses — `TradeAnalyzer/1.1.227 ()` reads as a bug at the
 * receiving end and tells the SEC less than saying nothing.
 */
export function edgarUserAgent(): string {
  const contact = edgarContact();
  return contact === null
    ? `TradeAnalyzer/${_appVersion}`
    : `TradeAnalyzer/${_appVersion} (${contact})`;
}

/** Headers for a direct `fetch` to sec.gov. Prefer `edgarFetch`, which also logs. */
export function edgarHeaders(): Record<string, string> {
  return { 'User-Agent': edgarUserAgent() };
}

/**
 * The one way to call sec.gov: applies the identity AND records the call.
 *
 * Three callers used to build headers with `edgarHeaders()` and then `fetch`
 * directly — this app's fundamentals provider (twice) and the Test API screen —
 * so none of them appeared in `logs/api/`. Only the NewApp collector's
 * `httpGet` logged. That is the same shape as the E*Trade integration before
 * v1.1.144, and it cost exactly what it cost there: on 2026-09-11 a live EDGAR
 * call was made specifically to confirm the configured contact address, and it
 * left no trace to read.
 *
 * Applying the header and recording the call are now one operation, because a
 * caller that remembers the first and forgets the second is invisible in the
 * one place anybody looks.
 */
export async function edgarFetch(url: string): Promise<Response> {
  const requestedAt = new Date().toISOString();
  const started = Date.now();
  const endpoint = (() => {
    try { return new URL(url).pathname; } catch { return url; }
  })();

  const record = (status: number | null, bytes: number | null, error?: string, preview?: string): void => {
    try {
      logApiCall({
        timestamp: requestedAt,
        provider: 'edgar',
        endpoint,
        method: 'GET',
        // The User-Agent is the point of this log line: it is the only place the
        // configured contact is observable without opening the database.
        requestParams: { userAgent: edgarUserAgent() },
        responseStatus: status,
        responseLatencyMs: Date.now() - started,
        responseSizeBytes: bytes,
        retryCount: 0,
        jobRunId: null,
        ...(error !== undefined ? { errorMessage: error } : {}),
        ...(preview !== undefined ? { responseBodyPreview: preview } : {})
      });
    } catch {
      /* a logger failure must never be the reason a provider call fails */
    }
  };

  try {
    const res = await fetch(url, { headers: edgarHeaders() });
    if (res.ok) {
      record(res.status, Number(res.headers.get('content-length')) || null);
      return res;
    }
    // A failure body is what diagnosis needs; a success body is never logged.
    const clone = res.clone();
    const body = await clone.text().catch(() => '');
    record(res.status, body.length || null, `HTTP ${res.status}`, body.slice(0, 300));
    return res;
  } catch (err) {
    record(null, null, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
