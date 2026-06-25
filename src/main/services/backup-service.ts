// Backup / restore (EP-11) — real .zip archives + scheduled auto-backup.
//
// Replaces the earlier "write an un-zipped folder into userData and tell the user to copy it"
// behaviour. A backup is now a single .zip the user chooses the location for, containing a
// CONSISTENT database snapshot (via better-sqlite3's online backup — WAL-safe, unlike a raw file
// copy of a live DB), plus recent logs, AI_CONTEXT.md, and a manifest. Restore accepts either that
// .zip (DB is extracted from it) or a bare .sqlite/.db file.
//
// Shared by the interactive IPC handlers (Settings → Backup) and the startup auto-backup so the two
// paths can't drift.

import AdmZip from 'adm-zip';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DbHandle } from '../db/connection.js';

export interface BackupSources {
  logsDir?: string;
  aiContextPath?: string;
}

/** The DB file inside a backup zip. */
export const BACKUP_DB_ENTRY = 'trade-analyzer.sqlite';

/**
 * Resolve the default extra files to fold into a backup, given Electron's app + userData paths.
 * Pure (takes plain strings) so it stays testable and electron-free.
 */
export function defaultBackupSources(appPath: string, userDataPath: string): BackupSources {
  return {
    logsDir: join(userDataPath, 'logs'),
    // AI_CONTEXT lives at the repo root in dev; absent in a packaged build (skipped if missing).
    aiContextPath: join(appPath.replace(/[\\/]out[\\/]renderer$/, ''), '.ai', 'AI_CONTEXT.md'),
  };
}

/**
 * Build a real .zip backup at `outZipPath`: a consistent DB snapshot + optional logs + AI_CONTEXT +
 * manifest. Uses the SQLite online backup API for the DB so in-flight WAL data is included.
 */
export async function createBackupZip(
  db: DbHandle,
  outZipPath: string,
  appVersion: string,
  sources: BackupSources = {}
): Promise<{ zipPath: string; entries: number }> {
  // Consistent snapshot to a temp file (db.backup checkpoints into a complete standalone DB).
  const snap = join(tmpdir(), `ta-backup-${Date.now()}.sqlite`);
  await db.backup(snap);
  let entries = 0;
  try {
    const zip = new AdmZip();
    zip.addLocalFile(snap, '', BACKUP_DB_ENTRY);
    entries++;
    if (sources.logsDir && existsSync(sources.logsDir)) {
      zip.addLocalFolder(sources.logsDir, 'logs');
      entries++;
    }
    if (sources.aiContextPath && existsSync(sources.aiContextPath)) {
      zip.addLocalFile(sources.aiContextPath, '', 'AI_CONTEXT.md');
      entries++;
    }
    const manifest = JSON.stringify({ createdAt: new Date().toISOString(), appVersion }, null, 2);
    zip.addFile('manifest.json', Buffer.from(manifest, 'utf8'));
    entries++;
    zip.writeZip(outZipPath);
  } finally {
    // Clean the temp snapshot (+ any stray WAL/SHM siblings).
    for (const f of [snap, `${snap}-wal`, `${snap}-shm`]) {
      try { rmSync(f, { force: true }); } catch { /* best-effort */ }
    }
  }
  return { zipPath: outZipPath, entries };
}

/**
 * Restore a database from a backup. Accepts a .zip (extracts the DB entry) or a bare .sqlite/.db
 * (copied directly). Writes the DB bytes to `destDbPath`, overwriting it. Returns false if a zip
 * carries no DB entry. The caller is responsible for telling the user to restart.
 */
export function restoreDbFromFile(sourcePath: string, destDbPath: string): boolean {
  const lower = sourcePath.toLowerCase();
  if (lower.endsWith('.zip')) {
    const zip = new AdmZip(sourcePath);
    const entry = zip
      .getEntries()
      .find((e) => e.entryName === BACKUP_DB_ENTRY || e.entryName.endsWith(`/${BACKUP_DB_ENTRY}`));
    if (!entry) return false;
    writeFileSync(destDbPath, entry.getData());
    return true;
  }
  if (lower.endsWith('.sqlite') || lower.endsWith('.db')) {
    const zip = new AdmZip();
    zip.addLocalFile(sourcePath); // reuse adm-zip's robust file read → bytes
    writeFileSync(destDbPath, zip.getEntries()[0]!.getData());
    return true;
  }
  return false;
}

/** Keep only the newest `keep` *.zip files in `dir`; delete the rest. Best-effort. */
export function pruneOldBackups(dir: string, keep: number): void {
  if (!existsSync(dir)) return;
  try {
    const zips = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.zip'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of zips.slice(keep)) {
      try { rmSync(join(dir, f), { force: true }); } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
}

export interface AutoBackupResult {
  ran: boolean;
  reason?: 'disabled' | 'not_due' | 'error';
  zipPath?: string;
  error?: string;
}

/**
 * Run a backup if auto-backup is enabled and the interval has elapsed since the last one. Reads
 * `autoBackupEnabled` / `autoBackupIntervalDays` / `lastAutoBackupAt` from the settings table and
 * writes the timestamp back on success. Writes to `<backupsDir>/auto/` and keeps the newest 5.
 */
export async function runAutoBackupIfDue(
  db: DbHandle,
  appVersion: string,
  backupsDir: string,
  sources: BackupSources = {}
): Promise<AutoBackupResult> {
  const get = (k: string): string | undefined =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value;

  if (get('autoBackupEnabled') !== 'true') return { ran: false, reason: 'disabled' };

  const intervalDays = Math.max(1, parseInt(get('autoBackupIntervalDays') ?? '7', 10) || 7);
  const last = get('lastAutoBackupAt');
  if (last) {
    const lastMs = Date.parse(last);
    if (Number.isFinite(lastMs) && Date.now() - lastMs < intervalDays * 86_400_000) {
      return { ran: false, reason: 'not_due' };
    }
  }

  try {
    const autoDir = join(backupsDir, 'auto');
    mkdirSync(autoDir, { recursive: true });
    const zipPath = join(autoDir, `trade-analyzer-backup-${new Date().toISOString().slice(0, 10)}.zip`);
    await createBackupZip(db, zipPath, appVersion, sources);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'lastAutoBackupAt',
      new Date().toISOString()
    );
    pruneOldBackups(autoDir, 5);
    return { ran: true, zipPath };
  } catch (err) {
    return { ran: false, reason: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
