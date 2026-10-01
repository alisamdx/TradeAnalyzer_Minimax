// Session sentinel — lets the NEXT boot say how the previous session ended.
//
// On 2026-09-28 the app went silent at 10:41:54 ET mid-brief and was next started at
// 07:52 ET the following day. Nothing anywhere could say whether it was closed, crashed
// or froze: a normal quit logged nothing, the main process had no uncaught-error handler,
// and Windows recorded no crash, hang, sleep or shutdown. A frozen main thread cannot log
// its own freeze, so the evidence has to be read by the process that comes after it.
//
// A small JSON file under logs/ holds { pid, startedAt, lastAliveAt, cleanExit }. The
// running session refreshes `lastAliveAt` every minute and sets `cleanExit` on quit. At
// boot, a previous file without `cleanExit` is reported as an unclean end, and its
// `lastAliveAt` bounds when the session stopped (to within one heartbeat).

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ErrorLogEntry } from './logger';

export interface SessionRecord {
  pid: number;
  appVersion: string;
  startedAt: string;
  lastAliveAt: string;
  cleanExit: boolean;
  exitReason: string | null;
}

export type PreviousSession =
  | { kind: 'none' }
  | { kind: 'clean'; record: SessionRecord }
  | { kind: 'unclean'; record: SessionRecord }
  | { kind: 'unreadable'; error: string };

function isSessionRecord(v: unknown): v is SessionRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.pid === 'number' &&
    typeof r.startedAt === 'string' &&
    typeof r.lastAliveAt === 'string' &&
    typeof r.cleanExit === 'boolean'
  );
}

export function readPreviousSession(path: string): PreviousSession {
  if (!existsSync(path)) return { kind: 'none' };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isSessionRecord(parsed)) return { kind: 'unreadable', error: 'unexpected shape' };
    return parsed.cleanExit ? { kind: 'clean', record: parsed } : { kind: 'unclean', record: parsed };
  } catch (err) {
    return { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) };
  }
}

/** The boot-time log entry for the previous session, or null when there is nothing to say. */
export function previousSessionEntry(prev: PreviousSession, appVersion: string, now: Date): ErrorLogEntry | null {
  const base = {
    timestamp: now.toISOString(),
    appVersion,
    errorClass: 'SessionSentinel',
    stack: null,
    operation: 'app:previous-session',
    ticker: null,
    correlationId: null
  };
  if (prev.kind === 'none' || prev.kind === 'clean') return null;
  if (prev.kind === 'unreadable') {
    return { ...base, level: 'WARNING', message: `previous session record unreadable (${prev.error}) — cannot tell how it ended` };
  }
  const r = prev.record;
  return {
    ...base,
    level: 'WARNING',
    message:
      `previous session ended WITHOUT a clean quit — pid ${r.pid}, v${r.appVersion}, started ${r.startedAt}, ` +
      `last alive ${r.lastAliveAt} (heartbeat every 60 s). Crash, kill or a frozen main thread; ` +
      `a normal quit would have logged app:quit.`
  };
}

function writeAtomic(path: string, record: SessionRecord): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), 'utf8');
  renameSync(tmp, path);
}

export interface SessionSentinel {
  /** Refresh lastAliveAt. Called by the interval; exposed for tests. */
  beat(): void;
  /** Record a clean end. Idempotent. */
  markCleanExit(reason: string): void;
  stop(): void;
}

export interface SentinelOptions {
  path: string;
  appVersion: string;
  log: (entry: ErrorLogEntry) => void;
  intervalMs?: number;
  now?: () => Date;
  pid?: number;
}

/**
 * Reports the previous session (if it ended uncleanly), then takes over the file for this
 * one. Never throws: a sentinel failure must not stop the app booting.
 */
export function startSessionSentinel(opts: SentinelOptions): SessionSentinel {
  const now = opts.now ?? (() => new Date());
  const safe = (fn: () => void): void => {
    try { fn(); } catch { /* the sentinel is diagnostic only */ }
  };

  safe(() => {
    const entry = previousSessionEntry(readPreviousSession(opts.path), opts.appVersion, now());
    if (entry) opts.log(entry);
  });

  const startedAt = now().toISOString();
  const record: SessionRecord = {
    pid: opts.pid ?? process.pid,
    appVersion: opts.appVersion,
    startedAt,
    lastAliveAt: startedAt,
    cleanExit: false,
    exitReason: null
  };
  safe(() => writeAtomic(opts.path, record));

  const beat = (): void => {
    if (record.cleanExit) return;
    record.lastAliveAt = now().toISOString();
    safe(() => writeAtomic(opts.path, record));
  };
  const timer = setInterval(beat, opts.intervalMs ?? 60_000);
  timer.unref?.();

  return {
    beat,
    markCleanExit(reason: string) {
      if (record.cleanExit) return;
      record.cleanExit = true;
      record.exitReason = reason;
      record.lastAliveAt = now().toISOString();
      clearInterval(timer);
      safe(() => writeAtomic(opts.path, record));
    },
    stop() {
      clearInterval(timer);
    }
  };
}
