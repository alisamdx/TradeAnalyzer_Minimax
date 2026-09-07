import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * An undecryptable credential must not read as an absent one.
 *
 * The old `decrypt()` swallowed a safeStorage failure and returned `''`, so a
 * boot where the OS credential store was not ready came up with **every** secret
 * silently blank — Polygon, E*Trade, Anthropic — and every provider call failed
 * as unauthorised. Measured 2026-09-07: 32 keyless Polygon 401s in one
 * afternoon, indistinguishable in the API log from a revoked key except that the
 * successful calls carry an `apiKey` parameter and the failures carry none. The
 * operator's workaround was to close the app and start it again.
 *
 * The read still returns `''` — no caller changes behaviour — but the failure is
 * now recorded so startup can report it instead of running credential-less.
 */

let available = true;
let decryptThrows = false;

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from(`enc(${s})`, 'utf8'),
    decryptString: (b: Buffer) => {
      if (decryptThrows) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      const text = b.toString('utf8');
      const m = /^enc\((.*)\)$/s.exec(text);
      if (!m) throw new Error('not our ciphertext');
      return m[1] as string;
    }
  }
}));

const { secureGet, undecryptableKeys, clearUndecryptableKeys } = await import(
  '../src/main/services/secure-settings.js'
);

/** Just enough of better-sqlite3's surface for `secureGet`. */
function fakeDb(rows: Readonly<Record<string, string>>) {
  return {
    prepare: () => ({
      get: (key: string) => (key in rows ? { value: rows[key] } : undefined)
    })
  } as never;
}

function encrypted(plain: string): string {
  return 'enc:' + Buffer.from(`enc(${plain})`, 'utf8').toString('base64');
}

beforeEach(() => {
  available = true;
  decryptThrows = false;
  clearUndecryptableKeys();
});

describe('secureGet — an unreadable secret is not an absent one', () => {
  it('reads a decryptable value and records no failure', () => {
    const db = fakeDb({ polygonApiKey: encrypted('pk-live-123') });
    expect(secureGet(db, 'polygonApiKey')).toBe('pk-live-123');
    expect(undecryptableKeys()).toEqual([]);
  });

  it('records the key when decryption throws', () => {
    decryptThrows = true;
    const db = fakeDb({ polygonApiKey: encrypted('pk-live-123') });
    // Still returns '' so no call site changes behaviour...
    expect(secureGet(db, 'polygonApiKey')).toBe('');
    // ...but the failure is now visible, which is the whole point.
    expect(undecryptableKeys()).toEqual(['polygonApiKey']);
  });

  it('records the key when the credential store is unavailable', () => {
    // Distinct from a corrupt value: the remedy is a restart or a different OS
    // session, not re-entering the key.
    available = false;
    const db = fakeDb({ etradeAccessToken: encrypted('tok') });
    expect(secureGet(db, 'etradeAccessToken')).toBe('');
    expect(undecryptableKeys()).toEqual(['etradeAccessToken']);
  });

  it('does NOT record a key that is genuinely unset', () => {
    // The distinction the old code destroyed. An absent setting is normal; an
    // unreadable one means the app is about to fail every call for a reason
    // the operator cannot see.
    const db = fakeDb({});
    expect(secureGet(db, 'polygonApiKey')).toBe('');
    expect(undecryptableKeys()).toEqual([]);
  });

  it('does not record a legacy plain-text value', () => {
    // Pre-safeStorage values have no `enc:` prefix and are returned as-is.
    const db = fakeDb({ polygonApiKey: 'legacy-plain-key' });
    expect(secureGet(db, 'polygonApiKey')).toBe('legacy-plain-key');
    expect(undecryptableKeys()).toEqual([]);
  });

  it('collects every failing key, because a bad boot loses them all at once', () => {
    decryptThrows = true;
    const db = fakeDb({
      polygonApiKey: encrypted('a'),
      etradeAccessToken: encrypted('b'),
      etradeConsumerKey: encrypted('c')
    });
    secureGet(db, 'polygonApiKey');
    secureGet(db, 'etradeAccessToken');
    secureGet(db, 'etradeConsumerKey');
    expect(undecryptableKeys()).toEqual([
      'etradeAccessToken', 'etradeConsumerKey', 'polygonApiKey'
    ]);
  });

  it('leaves a non-sensitive setting alone', () => {
    const db = fakeDb({ anthropicApiKey: 'not-in-the-sensitive-set' });
    expect(secureGet(db, 'anthropicApiKey')).toBe('not-in-the-sensitive-set');
    expect(undecryptableKeys()).toEqual([]);
  });
});
