/**
 * Secure settings storage using Electron's safeStorage API.
 *
 * Sensitive values are encrypted with the OS credential store before being
 * written to the SQLite settings table, and decrypted transparently on read.
 *
 *   Windows → DPAPI (tied to the Windows login session)
 *   macOS   → Keychain
 *   Linux   → libsecret / kwallet
 *
 * Migration: if a sensitive key is read and the stored value is plain text
 * (detected by attempting decryption), the plain value is returned as-is and
 * re-encrypted on the next write. This handles existing Polygon API keys that
 * were stored before this module was introduced.
 *
 * Encrypted values are stored as Base64 strings prefixed with "enc:" so we
 * can distinguish them from legacy plain-text values.
 */

import { safeStorage } from 'electron';
import type { Database } from 'better-sqlite3';

// ─── Sensitive key registry ───────────────────────────────────────────────────

/** Keys whose values must be encrypted at rest. */
const SENSITIVE_KEYS = new Set([
  'polygonApiKey',
  'etradeConsumerKey',
  'etradeConsumerSecret',
  'etradeAccessToken',
  'etradeAccessSecret',
  'etradeRequestToken',
  'etradeRequestSecret',
]);

const ENC_PREFIX = 'enc:';

// ─── Encryption helpers ───────────────────────────────────────────────────────

function isAvailable(): boolean {
  try { return safeStorage.isEncryptionAvailable(); }
  catch { return false; }
}

function encrypt(plaintext: string): string {
  if (!plaintext) return '';
  if (!isAvailable()) return plaintext; // fallback: store plain if OS has no keychain
  const buf = safeStorage.encryptString(plaintext);
  return ENC_PREFIX + buf.toString('base64');
}

function decrypt(stored: string): string {
  if (!stored) return '';
  if (!stored.startsWith(ENC_PREFIX)) return stored; // legacy plain-text — return as-is
  if (!isAvailable()) return stored; // can't decrypt without keychain
  try {
    const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  } catch {
    // Decryption failed (e.g. different OS user, corrupted value) — return empty
    return '';
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read a setting. Sensitive keys are decrypted automatically.
 * Returns '' if the key does not exist.
 */
export function secureGet(db: Database, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row?.value) return '';
  return SENSITIVE_KEYS.has(key) ? decrypt(row.value) : row.value;
}

/**
 * Write a setting. Sensitive keys are encrypted automatically.
 */
export function secureSet(db: Database, key: string, value: string): void {
  const stored = SENSITIVE_KEYS.has(key) ? encrypt(value) : value;
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, stored);
}

/**
 * Migrate any existing plain-text sensitive values to encrypted form.
 * Call once on startup after the DB is ready.
 */
export function migratePlaintextSecrets(db: Database): void {
  if (!isAvailable()) return; // nothing to migrate if encryption isn't available
  for (const key of SENSITIVE_KEYS) {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      if (!row?.value) continue;
      if (row.value.startsWith(ENC_PREFIX)) continue; // already encrypted
      // Plain-text found — re-encrypt it
      const encrypted = encrypt(row.value);
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(encrypted, key);
    } catch { /* best effort — skip if table not ready */ }
  }
}

/**
 * Returns whether OS-level encryption is available on this machine.
 * Used for diagnostics / settings UI.
 */
export function encryptionAvailable(): boolean {
  return isAvailable();
}
