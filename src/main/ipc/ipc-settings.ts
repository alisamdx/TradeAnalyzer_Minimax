// IPC handlers for Settings (FR-6, EP-10, EP-11).
// Settings storage, rate limit config, cache TTLs, diagnostics self-check, backup/restore.
// see SPEC: NFR-3, NFR-5, NFR-6, EP-10, EP-11

import { ipcMain, dialog, app, BrowserWindow, shell } from 'electron';
import { existsSync, statSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DbHandle } from '../db/connection.js';
import type { TokenBucketRateLimiter } from '../services/rate-limiter.js';
import type { QuoteCache, FundamentalsCache } from '../services/cache-service.js';
import { TTL_SECONDS } from '../services/cache-service.js';

function ok<T>(value: T) { return { ok: true as const, value }; }
function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error && 'code' in err ? (err as Error & { code: string }).code : 'UNKNOWN';
  return { ok: false as const, error: { code, message } };
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface AppSettings {
  polygonApiKey: string;
  rateLimitRpm: number;
  quoteCacheTtlSec: number;
  fundamentalsCacheTtlSec: number;
  optionsCacheTtlSec: number;
  logRetentionDays: number;
  errorLogRetentionDays: number;
  autoBackupEnabled: boolean;
  autoBackupIntervalDays: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  polygonApiKey: '',
  rateLimitRpm: 100,
  quoteCacheTtlSec: TTL_SECONDS.QUOTE,
  fundamentalsCacheTtlSec: TTL_SECONDS.FUNDAMENTALS,
  optionsCacheTtlSec: TTL_SECONDS.OPTIONS,
  logRetentionDays: 30,
  errorLogRetentionDays: 90,
  autoBackupEnabled: false,
  autoBackupIntervalDays: 7
};

export function registerSettingsIpc(
  db: DbHandle,
  rateLimiter: TokenBucketRateLimiter
): void {

  ipcMain.handle('settings:get', (_e, key: string) => {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      return ok<string | null>(row?.value ?? null);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    try {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
      return ok(true);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('settings:get-all', () => {
    try {
      const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
      const settings: AppSettings = { ...DEFAULT_SETTINGS };
      for (const row of rows) {
        const k = row.key as keyof AppSettings;
        if (k in settings) {
          const v = row.value;
          if (k === 'polygonApiKey') settings.polygonApiKey = v ?? '';
          else if (k === 'rateLimitRpm') settings.rateLimitRpm = v !== undefined ? parseInt(v, 10) : DEFAULT_SETTINGS.rateLimitRpm;
          else if (k === 'quoteCacheTtlSec') settings.quoteCacheTtlSec = v !== undefined ? parseInt(v, 10) : DEFAULT_SETTINGS.quoteCacheTtlSec;
          else if (k === 'fundamentalsCacheTtlSec') settings.fundamentalsCacheTtlSec = v !== undefined ? parseInt(v, 10) : DEFAULT_SETTINGS.fundamentalsCacheTtlSec;
          else if (k === 'optionsCacheTtlSec') settings.optionsCacheTtlSec = v !== undefined ? parseInt(v, 10) : DEFAULT_SETTINGS.optionsCacheTtlSec;
          else if (k === 'logRetentionDays') settings.logRetentionDays = v !== undefined ? parseInt(v, 10) : DEFAULT_SETTINGS.logRetentionDays;
          else if (k === 'errorLogRetentionDays') settings.errorLogRetentionDays = v !== undefined ? parseInt(v, 10) : DEFAULT_SETTINGS.errorLogRetentionDays;
          else if (k === 'autoBackupEnabled') settings.autoBackupEnabled = v === 'true';
          else if (k === 'autoBackupIntervalDays') settings.autoBackupIntervalDays = v !== undefined ? parseInt(v, 10) : DEFAULT_SETTINGS.autoBackupIntervalDays;
        }
      }
      return ok(settings);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('settings:set-all', (_e, partial: Partial<AppSettings>) => {
    try {
      const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      for (const [k, v] of Object.entries(partial)) {
        stmt.run(k, String(v));
      }
      if (partial.rateLimitRpm !== undefined) {
        rateLimiter.setRate(partial.rateLimitRpm);
      }
      return ok(true);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('settings:get-api-key', () => {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('polygonApiKey') as { value: string } | undefined;
      return ok<string>(row?.value ?? '');
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('settings:set-api-key', (_e, apiKey: string) => {
    try {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('polygonApiKey', apiKey);
      return ok(true);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('settings:open-logs-dir', () => {
    const logsDir = join(app.getPath('userData'), 'logs', 'api');
    shell.openPath(logsDir).catch(() => { /* best effort */ });
    return ok(true);
  });

  // ── Backup / Restore (EP-11) ─────────────────────────────────────────────
  ipcMain.handle('settings:backup-everything', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!win) return fail(new Error('No window available'));
      const result = await dialog.showSaveDialog(win, {
        title: 'Backup TradeAnalyzer',
        defaultPath: `trade-analyzer-backup-${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
      });
      if (result.canceled || !result.filePath) return ok(null);

      const dbPath = join(app.getPath('userData'), 'trade-analyzer.sqlite');
      const backupsDir = join(app.getPath('userData'), 'backups');
      mkdirSync(backupsDir, { recursive: true });

      const timestamp = Date.now();
      const backupDir = join(backupsDir, `backup-${timestamp}`);
      mkdirSync(backupDir, { recursive: true });

      // Copy DB
      if (existsSync(dbPath)) {
        copyFileSync(dbPath, join(backupDir, 'trade-analyzer.sqlite'));
      }

      // Copy logs dir
      const srcLogsDir = join(app.getPath('userData'), 'logs');
      if (existsSync(srcLogsDir)) {
        copyDirRecursive(srcLogsDir, join(backupDir, 'logs'));
      }

      // Copy AI_CONTEXT if present at repo root (not in userData — use user's app dir)
      const aiCtxSrc = join(app.getAppPath().replace(/[\\/]out[\\/]renderer$/, ''), 'AI_CONTEXT.md');
      const aiCtxDst = join(backupDir, 'AI_CONTEXT.md');
      if (existsSync(aiCtxSrc)) {
        copyFileSync(aiCtxSrc, aiCtxDst);
      }

      // Use Node's built-in archiver-free approach: write the backup manifest.
      const manifest = JSON.stringify({ createdAt: new Date().toISOString(), appVersion: app.getVersion() }, null, 2);
      writeFileSync(join(backupDir, 'manifest.json'), manifest, 'utf8');

      return ok({ backupPath: backupDir, message: `Backup ready at ${backupDir}. Note: not zipped yet — copy the backup folder manually.` });
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('settings:restore-backup', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!win) return fail(new Error('No window available'));
      const result = await dialog.showOpenDialog(win, {
        title: 'Restore from Backup',
        filters: [
          { name: 'SQLite Database', extensions: ['sqlite', 'db'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile']
      });
      if (result.canceled || result.filePaths.length === 0) return ok(null);

      const selectedPath = result.filePaths[0]!;
      const dbPath = join(app.getPath('userData'), 'trade-analyzer.sqlite');

      if (selectedPath.endsWith('.sqlite') || selectedPath.endsWith('.db')) {
        copyFileSync(selectedPath, dbPath);
      }

      return ok({ restored: true, message: 'Restore applied. Restart the app to load restored data.' });
    } catch (err) { return fail(err); }
  });
}

// ─── Diagnostics (EP-10) ────────────────────────────────────────────────────

export interface DiagnosticCheck {
  ok: boolean;
  message: string;
}

export interface DiagnosticsResult {
  checks: Record<string, DiagnosticCheck>;
  overall: 'ok' | 'degraded' | 'error';
}

export function registerDiagnosticsIpc(
  db: DbHandle,
  quoteCache: QuoteCache,
  fundamentalsCache: FundamentalsCache
): void {
  ipcMain.handle('diagnostics:run', () => {
    try {
      const checks: Record<string, DiagnosticCheck> = {};

      // Schema version
      const svRow = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
      checks['schema_version'] = {
        ok: svRow.v !== null && svRow.v > 0,
        message: svRow.v !== null ? `Schema v${svRow.v}` : 'Not initialized'
      };

      // DB file size
      const dbPath = join(app.getPath('userData'), 'trade-analyzer.sqlite');
      let dbSize = 0;
      try { dbSize = statSync(dbPath).size; } catch { /* no file yet */ }
      checks['db_file'] = {
        ok: true,
        message: dbSize > 0 ? `${(dbSize / 1_000_000).toFixed(2)} MB` : '0 MB (empty)'
      };

      // Quote cache stats
      const quoteRows = db.prepare(
        "SELECT COUNT(*) as total, SUM(CASE WHEN fetched_at > datetime('now', '-24 hours') THEN 1 ELSE 0 END) as fresh FROM quote_cache"
      ).get() as { total: number; fresh: number };
      const quoteHitRate = quoteRows.total > 0
        ? Math.round((quoteRows.fresh / quoteRows.total) * 100) : 0;
      checks['quote_cache'] = {
        ok: true,
        message: `${quoteRows.total} cached, ${quoteHitRate}% fresh (24h)`
      };

      // Fundamentals cache stats
      const fundRows = db.prepare(
        "SELECT COUNT(*) as total, SUM(CASE WHEN fetched_at > datetime('now', '-24 hours') THEN 1 ELSE 0 END) as fresh FROM fundamentals_cache"
      ).get() as { total: number; fresh: number };
      const fundHitRate = fundRows.total > 0
        ? Math.round((fundRows.fresh / fundRows.total) * 100) : 0;
      checks['fundamentals_cache'] = {
        ok: true,
        message: `${fundRows.total} cached, ${fundHitRate}% fresh (24h)`
      };

      // Log directory size
      const logsDir = join(app.getPath('userData'), 'logs');
      const logsSize = walkDirSize(logsDir);
      checks['log_dir'] = { ok: true, message: logsSize > 0 ? `${(logsSize / 1_000_000).toFixed(2)} MB` : '0 MB' };

      // Recent errors (last 24h)
      const errorsDir = join(app.getPath('userData'), 'logs', 'errors');
      const errorCount = countJsonlLines(errorsDir);
      checks['recent_errors'] = {
        ok: errorCount === 0,
        message: errorCount === 0 ? 'No errors (24h)' : `${errorCount} error(s) (24h)`
      };

      // Settings count
      const settingsCount = (db.prepare('SELECT COUNT(*) as c FROM settings').get() as { c: number }).c;
      checks['settings'] = { ok: true, message: `${settingsCount} setting(s)` };

      // App version
      checks['app_version'] = { ok: true, message: app.getVersion() };

      const allOk = Object.values(checks).every(c => c.ok);
      const overall: DiagnosticsResult['overall'] = allOk ? 'ok' : 'degraded';
      return ok({ checks, overall } satisfies DiagnosticsResult);
    } catch (err) { return fail(err); }
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function copyDirRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      try { copyFileSync(srcPath, dstPath); } catch { /* skip */ }
    }
  }
}

function walkDirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += walkDirSize(full);
      } else {
        try { total += statSync(full).size; } catch { /* skip */ }
      }
    }
  } catch { /* doesn't exist */ }
  return total;
}

function countJsonlLines(dir: string): number {
  let count = 0;
  const cutoff = Date.now() - 86_400_000;
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        if (statSync(full).mtimeMs < cutoff) continue;
        const lines = readFileSync(full, 'utf8').split('\n');
        count += lines.filter(l => l.trim().length > 0).length;
      } catch { /* skip */ }
    }
  } catch { /* dir doesn't exist */ }
  return count;
}