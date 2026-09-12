import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import {
  setEdgarContactSource, edgarContact, edgarUserAgent, edgarHeaders, EDGAR_CONTACT_KEY
} from '../src/main/services/edgar-identity.js';

/**
 * The EDGAR contact identity (v1.1.227).
 *
 * The SEC asks automated clients to declare a contact address. Two independent
 * callers here talk to sec.gov, and they used to disagree: the app's own
 * fundamentals provider sent `trader@local` (an address nobody can be reached
 * at) and the NewApp collector sent no contact at all. Both now build the header
 * in one place — the rule belongs in the function every caller uses.
 *
 * The address itself is a SETTING and must never be committed: this repository
 * has a GitHub remote, and history is not something a later edit removes.
 */

let db: DbHandle;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  setEdgarContactSource(db, '1.1.227');
});

describe('the EDGAR contact', () => {
  it('is read from settings, not compiled in', () => {
    expect(edgarContact()).toBeNull();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(EDGAR_CONTACT_KEY, 'someone+edgar@example.com');
    expect(edgarContact()).toBe('someone+edgar@example.com');
    expect(edgarUserAgent()).toBe('TradeAnalyzer/1.1.227 (someone+edgar@example.com)');
  });

  it('degrades to a name-only agent when unset, never empty parentheses', () => {
    // `TradeAnalyzer/1.1.227 ()` reads as a bug at the receiving end and says
    // less than saying nothing.
    expect(edgarUserAgent()).toBe('TradeAnalyzer/1.1.227');
    expect(edgarUserAgent()).not.toContain('()');
    expect(edgarHeaders()['User-Agent']).toBe('TradeAnalyzer/1.1.227');
  });

  it('treats a blank or whitespace setting as unset', () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(EDGAR_CONTACT_KEY, '   ');
    expect(edgarContact()).toBeNull();
    expect(edgarUserAgent()).not.toContain('(');
  });
});

// ── source assertions ────────────────────────────────────────────────────────

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : /\.(ts|tsx)$/.test(full) ? [full] : [];
  });
}

const SRC = join(process.cwd(), 'src');

describe('no contact address is committed to this repository', () => {
  it('no source file contains an email-shaped literal in a User-Agent', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const code = readFileSync(file, 'utf8');
      // An address inside a string literal. The placeholder in the Settings
      // hint (`you+edgar@example.com`) and the doc examples are example.com,
      // which is reserved by RFC 2606 precisely for this.
      for (const m of code.matchAll(/['"`][^'"`\n]*@(?!example\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}[^'"`\n]*['"`]/g)) {
        if (/User-Agent|trader@|contact/i.test(m[0])) offenders.push(`${file.slice(SRC.length + 1)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every EDGAR caller goes through edgarFetch, so every call is logged', () => {
    // Three callers built headers and then called `fetch` directly, so none of
    // them reached `logs/api/` — the E*Trade-before-v1.1.144 shape. It cost a
    // real diagnosis: a live EDGAR call made to confirm the configured contact
    // left no trace. Applying the identity and recording the call are one
    // operation now, and this asserts nobody re-separates them.
    const files = [
      join(SRC, 'main', 'services', 'sec-edgar-provider.ts'),
      join(SRC, 'main', 'ipc', 'ipc-test-api.ts')
    ];
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      const sec = code.split('\n').filter((l) => /fetch\(/.test(l) && /sec\.gov|EDGAR_BASE/.test(l));
      for (const line of sec) {
        expect(line).toContain('edgarFetch(');
      }
    }
  });

  it('both EDGAR callers build their agent from the one module', () => {
    // Comments stripped first. The unstripped version of this assertion failed
    // on the doc comment in `sec-edgar-provider.ts` that explains the file used
    // to hard-code `trader@local` — a source scan that reads its own
    // documentation teaches "stop writing the comment", which is the worse
    // outcome. Fifth time in this repo; the rule is in CLAUDE.md.
    const code = (rel: string[]): string =>
      readFileSync(join(SRC, ...rel), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

    const provider = code(['main', 'services', 'sec-edgar-provider.ts']);
    const host = code(['main', 'collector-host', 'electron-collector-host.ts']);
    // The provider reaches the identity through `edgarFetch`, which applies the
    // headers and logs the call as one operation. It no longer names
    // `edgarHeaders` itself — that export remains for a caller that genuinely
    // only needs headers, and the collector host is one (its `httpGet` already
    // logs, so it composes the agent directly).
    expect(provider).toContain('edgarFetch(');
    expect(provider).not.toContain('trader@local');
    expect(host).toContain('edgarUserAgent()');
  });
});
