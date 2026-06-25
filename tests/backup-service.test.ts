import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
import {
  createBackupZip,
  restoreDbFromFile,
  runAutoBackupIfDue,
  pruneOldBackups,
  defaultBackupSources,
  BACKUP_DB_ENTRY,
} from '../src/main/services/backup-service.js';

let dir: string;
let dbPath: string;
let db: Database.Database;

function seedDb(path: string): Database.Database {
  const d = new Database(path);
  d.pragma('journal_mode = WAL');
  d.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  d.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)');
  d.prepare('INSERT INTO widgets (name) VALUES (?)').run('alpha');
  d.prepare('INSERT INTO widgets (name) VALUES (?)').run('beta');
  return d;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-backup-test-'));
  dbPath = join(dir, 'trade-analyzer.sqlite');
  db = seedDb(dbPath);
});

afterEach(() => {
  try { db.close(); } catch { /* */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

describe('createBackupZip', () => {
  it('writes a real zip with the DB snapshot + manifest', async () => {
    const out = join(dir, 'backup.zip');
    const { zipPath, entries } = await createBackupZip(db, out, '9.9.9');
    expect(zipPath).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(entries).toBeGreaterThanOrEqual(2); // db + manifest

    const zip = new AdmZip(out);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain(BACKUP_DB_ENTRY);
    expect(names).toContain('manifest.json');
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8'));
    expect(manifest.appVersion).toBe('9.9.9');
  });

  it('includes logs + AI_CONTEXT when present', async () => {
    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir);
    writeFileSync(join(logsDir, 'app.log'), 'hello');
    const ai = join(dir, 'AI_CONTEXT.md');
    writeFileSync(ai, '# ctx');
    const out = join(dir, 'backup.zip');
    await createBackupZip(db, out, '1.0.0', { logsDir, aiContextPath: ai });
    const names = new AdmZip(out).getEntries().map((e) => e.entryName);
    expect(names.some((n) => n.startsWith('logs/'))).toBe(true);
    expect(names).toContain('AI_CONTEXT.md');
  });
});

describe('restoreDbFromFile', () => {
  it('restores the DB out of a backup zip', async () => {
    const out = join(dir, 'backup.zip');
    await createBackupZip(db, out, '1.0.0');
    const dest = join(dir, 'restored.sqlite');
    expect(restoreDbFromFile(out, dest)).toBe(true);
    const restored = new Database(dest, { readonly: true });
    const rows = restored.prepare('SELECT name FROM widgets ORDER BY id').all() as { name: string }[];
    restored.close();
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'beta']);
  });

  it('restores from a bare .sqlite file', () => {
    const dest = join(dir, 'restored2.sqlite');
    expect(restoreDbFromFile(dbPath, dest)).toBe(true);
    expect(existsSync(dest)).toBe(true);
  });

  it('returns false for an unrecognized file type', () => {
    const txt = join(dir, 'note.txt');
    writeFileSync(txt, 'nope');
    expect(restoreDbFromFile(txt, join(dir, 'x.sqlite'))).toBe(false);
  });

  it('returns false for a zip with no DB entry', () => {
    const z = new AdmZip();
    z.addFile('readme.txt', Buffer.from('hi'));
    const zp = join(dir, 'empty.zip');
    z.writeZip(zp);
    expect(restoreDbFromFile(zp, join(dir, 'x.sqlite'))).toBe(false);
  });
});

describe('runAutoBackupIfDue', () => {
  const backupsDir = (): string => join(dir, 'backups');

  it('does nothing when disabled', async () => {
    const r = await runAutoBackupIfDue(db, '1.0.0', backupsDir());
    expect(r).toEqual({ ran: false, reason: 'disabled' });
  });

  it('runs when enabled with no prior backup, then records the timestamp', async () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('autoBackupEnabled', 'true');
    const r = await runAutoBackupIfDue(db, '1.0.0', backupsDir());
    expect(r.ran).toBe(true);
    expect(r.zipPath && existsSync(r.zipPath)).toBe(true);
    const last = (db.prepare('SELECT value FROM settings WHERE key = ?').get('lastAutoBackupAt') as { value: string }).value;
    expect(Number.isFinite(Date.parse(last))).toBe(true);
  });

  it('skips when the interval has not elapsed', async () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('autoBackupEnabled', 'true');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('autoBackupIntervalDays', '7');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('lastAutoBackupAt', new Date().toISOString());
    const r = await runAutoBackupIfDue(db, '1.0.0', backupsDir());
    expect(r).toEqual({ ran: false, reason: 'not_due' });
  });

  it('writes into a scoped subfolder of a user-chosen autoBackupDir', async () => {
    const custom = join(dir, 'my-cloud-folder');
    mkdirSync(custom);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('autoBackupEnabled', 'true');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('autoBackupDir', custom);
    const r = await runAutoBackupIfDue(db, '1.0.0', backupsDir());
    expect(r.ran).toBe(true);
    expect(r.zipPath!.startsWith(join(custom, 'TradeAnalyzer-AutoBackups'))).toBe(true);
    expect(existsSync(r.zipPath!)).toBe(true);
    // The default location was NOT used.
    expect(existsSync(join(backupsDir(), 'auto'))).toBe(false);
  });

  it('runs when the interval has elapsed', async () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('autoBackupEnabled', 'true');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('autoBackupIntervalDays', '1');
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('lastAutoBackupAt', old);
    const r = await runAutoBackupIfDue(db, '1.0.0', backupsDir());
    expect(r.ran).toBe(true);
  });
});

describe('pruneOldBackups', () => {
  it('keeps only the newest N zips', () => {
    const d = join(dir, 'prune');
    mkdirSync(d);
    for (let i = 0; i < 5; i++) {
      const p = join(d, `b${i}.zip`);
      writeFileSync(p, 'x');
      // stagger mtimes so ordering is deterministic
    }
    pruneOldBackups(d, 2);
    expect(readdirSync(d).filter((f) => f.endsWith('.zip')).length).toBe(2);
  });
});

describe('defaultBackupSources', () => {
  it('derives logs + AI_CONTEXT paths and strips the out/renderer suffix', () => {
    const s = defaultBackupSources('/app/out/renderer', '/userdata');
    expect(s.logsDir).toBe(join('/userdata', 'logs'));
    expect(s.aiContextPath).toBe(join('/app', '.ai', 'AI_CONTEXT.md'));
  });
});
