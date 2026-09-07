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
  'marketdataApiToken',
  'ivolatilityApiKey',
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

/**
 * Keys whose stored value is present but could not be decrypted this boot.
 *
 * **This exists because returning `''` on a decryption failure is indefensible.**
 * An absent setting and an undecryptable one are different facts, and collapsing
 * them means a boot where the OS credential store is not ready yet comes up with
 * every secret silently blank: Polygon, E*Trade and Anthropic all read as "not
 * configured", every call 401s, and it looks exactly like a provider outage or
 * an expired subscription. Observed 2026-09-07 — 32 keyless Polygon 401s in one
 * afternoon, indistinguishable in the log from a revoked key except that the
 * successful calls carry an `apiKey` param and the failures carry none.
 *
 * The read still returns `''` so no caller changes behaviour, but the failure is
 * now recorded and reported at boot instead of vanishing into a `catch`.
 */
const _undecryptable = new Set<string>();

export function undecryptableKeys(): readonly string[] {
  return [...(_undecryptable as Set<string>)].sort();
}

/** Cleared after the operator has been told, so a later boot reports afresh. */
export function clearUndecryptableKeys(): void {
  _undecryptable.clear();
}

function decrypt(stored: string, key: string): string {
  if (!stored) return '';
  if (!stored.startsWith(ENC_PREFIX)) return stored; // legacy plain-text — return as-is
  if (!isAvailable()) {
    // Not a corrupt value: the credential store itself is unavailable. Recorded
    // as such, because the remedy (restart, or a different OS session) is not
    // the same as re-entering the key.
    _undecryptable.add(key);
    return '';
  }
  try {
    const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  } catch {
    // A stored ciphertext that will not decrypt. The value is NOT absent — it is
    // unreadable, and the caller must be able to tell the difference.
    _undecryptable.add(key);
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
  return SENSITIVE_KEYS.has(key) ? decrypt(row.value, key) : row.value;
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
