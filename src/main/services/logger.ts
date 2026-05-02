// Structured JSON logging per EP-3 and EP-4.
// Writes to logs/api/ and logs/errors/ as .jsonl files, one object per line.
// Files rotate daily; older files are pruned on startup (30 days for api, 90 for errors).
// API keys and PII are scrubbed at write time.
// see SPEC: EP-3, EP-4

import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

export type ApiLogLevel = 'INFO' | 'WARNING' | 'ERROR' | 'FATAL';
export type ErrorLevel = 'WARNING' | 'ERROR' | 'FATAL';

const API_RETENTION_DAYS = 30;
const ERROR_RETENTION_DAYS = 90;

function logsDir(): string {
  return join(app.getPath('userData'), 'logs');
}

function apiLogsDir(): string {
  return join(logsDir(), 'api');
}

function errorLogsDir(): string {
  return join(logsDir(), 'errors');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function todayFilename(prefix: string): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${prefix}_${yyyy}-${mm}-${dd}.jsonl`;
}

function pruneOldLogs(dir: string, days: number): void {
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - days * 86_400_000;
  for (const entry of readdirSync(dir)) {
    try {
      const fpath = join(dir, entry);
      if (statSync(fpath).mtimeMs < cutoff) rmSync(fpath);
    } catch {
      // skip
    }
  }
}

function writeLine(dir: string, filename: string, obj: Record<string, unknown>): void {
  ensureDir(dir);
  const path = join(dir, filename);
  const stream = createWriteStream(path, { flags: 'a', encoding: 'utf8' });
  stream.write(JSON.stringify(obj) + '\n');
  stream.end();
}

function formatMs(ms: number): number {
  return Math.round(ms);
}

// ─── API Logger ────────────────────────────────────────────────────────────────

export interface ApiLogEntry {
  timestamp: string;
  provider: string;
  endpoint: string;
  method: string;
  requestParams: Record<string, unknown>;
  responseStatus: number | null;
  responseLatencyMs: number | null;
  responseSizeBytes: number | null;
  retryCount: number;
  jobRunId: string | null;
}

let _apiStream: ReturnType<typeof createWriteStream> | null = null;
let _apiDate = '';

function getApiStream(): { stream: ReturnType<typeof createWriteStream>; date: string } {
  const date = todayFilename('api').replace('.jsonl', '');
  if (_apiStream && _apiDate === date) return { stream: _apiStream, date: _apiDate };
  if (_apiStream) { try { _apiStream.end(); } catch { /* ignore */ } }
  ensureDir(apiLogsDir());
  const path = join(apiLogsDir(), todayFilename('api'));
  _apiStream = createWriteStream(path, { flags: 'a', encoding: 'utf8' });
  _apiDate = date;
  return { stream: _apiStream, date: _apiDate };
}

export function logApiCall(entry: ApiLogEntry): void {
  const { stream } = getApiStream();
  stream.write(JSON.stringify(entry) + '\n');
}

/** Scrub any field that might contain an API key or sensitive user data.
 *  Operates on a copy so the original object is not mutated. */
export function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const scrubbed = { ...obj };
  for (const key of Object.keys(scrubbed)) {
    const k = key.toLowerCase();
    if (k.includes('key') || k.includes('secret') || k.includes('token') || k.includes('password')) {
      (scrubbed as Record<string, unknown>)[key] = '[REDACTED]';
    }
  }
  return scrubbed;
}

// ─── Error Logger ──────────────────────────────────────────────────────────────

export interface ErrorLogEntry {
  timestamp: string;
  appVersion: string;
  errorClass: string;
  message: string;
  stack: string | null;
  operation: string;
  ticker: string | null;
  correlationId: string | null;
  level: ErrorLevel;
}

let _errorStream: ReturnType<typeof createWriteStream> | null = null;
let _errorDate = '';

function getErrorStream(): { stream: ReturnType<typeof createWriteStream>; date: string } {
  const date = todayFilename('errors').replace('.jsonl', '');
  if (_errorStream && _errorDate === date) return { stream: _errorStream, date: _errorDate };
  if (_errorStream) { try { _errorStream.end(); } catch { /* ignore */ } }
  ensureDir(errorLogsDir());
  const path = join(errorLogsDir(), todayFilename('errors'));
  _errorStream = createWriteStream(path, { flags: 'a', encoding: 'utf8' });
  _errorDate = date;
  return { stream: _errorStream, date: _errorDate };
}

export function logError(entry: ErrorLogEntry): void {
  const { stream } = getErrorStream();
  stream.write(JSON.stringify(entry) + '\n');
}

export function logErrorFromException(
  err: unknown,
  operation: string,
  ticker: string | null,
  level: ErrorLevel,
  correlationId?: string | null
): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack ?? null : null;
  const errorClass = err instanceof Error ? err.constructor.name : 'UnknownError';
  logError({
    timestamp: new Date().toISOString(),
    appVersion: '0.1.2', // updated on version bump
    errorClass,
    message,
    stack,
    operation,
    ticker,
    correlationId: correlationId ?? null,
    level
  });
}

// ─── Startup pruning ───────────────────────────────────────────────────────────

export function pruneOldLogsOnStartup(): void {
  pruneOldLogs(apiLogsDir(), API_RETENTION_DAYS);
  pruneOldLogs(errorLogsDir(), ERROR_RETENTION_DAYS);
}

export { apiLogsDir, errorLogsDir };