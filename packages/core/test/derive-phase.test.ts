import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost, ProviderResponse } from '../src/collector/host.js';
import { beginRun, captureRuleId, type RunHandle } from '../src/collector/run.js';
import { runDerivePhase } from '../src/collector/phases/derive.js';

/**
 * Phase 9 against a real generation (B7b).
 *
 * `iv30.test.ts` covers the arithmetic as a pure function; this covers the
 * things only a database can be wrong about — that the row inserts at all,
 * that supersession is resolved, and that a ticker which cannot be computed
 * still gets a row saying so.
 *
 * The insert is worth a real table rather than a mock: the column this phase
 * could not fill (`source_response_id`, NOT NULL with a foreign key until the
 * dictionary was corrected at B7b) would have passed any mock happily.
 */

let dir: string;
let raw: Database.Database;

const DATE = '2026-09-09';

function db(): SqliteLike {
  return raw as unknown as SqliteLike;
}

function makeHost(overrides: Partial<CollectorHost> = {}): CollectorHost {
  const empty: ProviderResponse = {
    status: 200, body: '{}', requestedAt: `${DATE}T17:05:00-04:00`, respondedAt: `${DATE}T17:05:01-04:00`
  };
  return {
    openGenerationDb: () => db(),
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => b,
    decryptFromArchive: (b) => b,
    polygonGet: async () => empty,
    etradeGet: async () => empty,
    httpGet: async () => empty,
    nowET: () => `${DATE}T17:30:00-04:00`,
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test-host', version: '0.0.0' },
    ...overrides
  };
}

function newRun(): RunHandle {
  const run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
  // A real response row for the snapshot rows to point at. `meta_response.run_id`
  // is NOT NULL, so it cannot be created before the run exists — which is the
  // whole contrast this file is about: the raw layer genuinely has a response to
  // name, and the derived layer does not.
  const info = raw
    .prepare(
      `INSERT INTO meta_response
         (run_id, provider, endpoint, params_json, requested_at, responded_at, http_status,
          byte_length, archive_file, archive_offset, sha256, dedup_hash, encrypted,
          at_provider_cap, parse_status)
       VALUES (?, 'etrade', '/chain', '{}', ?, ?, 200, 2, 'a.jsonl', 0, 'x', ?, 0, 0, 'ok')`
    )
    .run(run.runId, `${DATE}T17:05:00-04:00`, `${DATE}T17:05:01-04:00`, `dedup-${run.runId}`);
  responseId = Number(info.lastInsertRowid);
  ruleId = captureRuleId(db(), makeHost(), 'chain', { maxDte: 90 }, 'test rule');
  return run;
}

let osiSeq = 0;

/** Inserts a call+put pair at one strike, as phase 7 would have stored it. */
function storePair(
  run: RunHandle,
  opts: {
    ticker: string;
    expiration: string;
    strike: number;
    iv: number;
    spot: number;
    observedAt?: string;
    ivStatus?: string;
    osiSuffix?: string;
  }
): void {
  const observedAt = opts.observedAt ?? `${DATE}T17:05:01-04:00`;
  for (const right of ['call', 'put'] as const) {
    osiSeq += 1;
    const osi = opts.osiSuffix
      ? `${opts.ticker}-${opts.expiration}-${opts.strike}-${right}-${opts.osiSuffix}`
      : `${opts.ticker}-${opts.expiration}-${opts.strike}-${right}`;
    raw
      .prepare(
        `INSERT INTO raw_option_contract_snapshot
           (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
            ticker, osi_symbol, expiration_date, strike, right,
            bid, ask, price_status, last, last_status, bid_size, ask_size, size_status,
            volume, volume_status, open_interest, open_interest_status,
            iv, iv_status, delta, gamma, theta, vega, rho, greeks_status,
            underlying_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 1.0, 1.1, 'ok', 1.05, 'ok', 1, 1, 'ok',
                 10, 'ok', 100, 'ok',
                 ?, ?, 0.5, 0.01, -0.1, 0.2, 0.01, 'ok',
                 ?)`
      )
      .run(
        run.runId,
        DATE,
        observedAt,
        ruleId,
        responseId,
        opts.ticker,
        osi,
        opts.expiration,
        opts.strike,
        right,
        // The status-column CHECK (P3) enforces this pairing: a status other
        // than `ok` requires a NULL value. Passing a number beside `invalid`
        // is rejected by the generated constraint, which is the pattern doing
        // its job — an unusable reading cannot also carry a usable-looking one.
        (opts.ivStatus ?? 'ok') === 'ok' ? opts.iv : null,
        opts.ivStatus ?? 'ok',
        opts.spot
      );
  }
}

let responseId: number;
let ruleId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-b7b-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
  raw.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) " +
      "VALUES (1, '2026-09-09T00:00:00-04:00', 'pilot', 'x', 'y')"
  );
  osiSeq = 0;
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('phase 9 — writing the derivation', () => {
  it('writes a row a real generation accepts', () => {
    const run = newRun();
    for (const expiration of ['2026-09-25', '2026-10-30']) {
      storePair(run, { ticker: 'AAA', expiration, strike: 95, iv: 0.4, spot: 100 });
      storePair(run, { ticker: 'AAA', expiration, strike: 105, iv: 0.4, spot: 100 });
    }

    const counts = runDerivePhase(db(), makeHost(), run);
    expect(counts).toEqual({ tickers: 1, ok: 1, insufficientExpirations: 0, noAtmQuotes: 0 });

    const row = raw.prepare('SELECT * FROM derived_iv30_daily').get() as Record<string, unknown>;
    expect(row['ticker']).toBe('AAA');
    expect(row['status']).toBe('ok');
    expect(row['iv30'] as number).toBeCloseTo(0.4, 10);
    expect(row['run_id']).toBe(run.runId);
    // Null, and legitimately so: a derived row is a function of many stored
    // rows, not a parse of one response.
    expect(row['source_response_id']).toBeNull();
    expect(row['capture_rule_id']).toBeNull();
  });

  it('writes a row for a ticker that could not be computed, not silence', () => {
    const run = newRun();
    // One expiration only — no bracketing pair.
    storePair(run, { ticker: 'BBB', expiration: '2026-09-25', strike: 95, iv: 0.4, spot: 100 });
    storePair(run, { ticker: 'BBB', expiration: '2026-09-25', strike: 105, iv: 0.4, spot: 100 });

    const counts = runDerivePhase(db(), makeHost(), run);
    expect(counts).toEqual({ tickers: 1, ok: 0, insufficientExpirations: 1, noAtmQuotes: 0 });

    const row = raw.prepare('SELECT * FROM derived_iv30_daily').get() as Record<string, unknown>;
    // Storing only the successes would make "we could not price this"
    // indistinguishable from "we never looked".
    expect(row['status']).toBe('insufficient_expirations');
    expect(row['iv30']).toBeNull();
    expect(row['iv30_status']).toBe('omitted');
  });

  it('resolves supersession — a re-observed contract is read once, at its latest value', () => {
    const run = newRun();
    for (const expiration of ['2026-09-25', '2026-10-30']) {
      for (const strike of [95, 105]) {
        // Morning observation, then an afternoon one at a different vol. The
        // afternoon value is the day's answer; averaging the two would make the
        // result depend on how often the collector happened to run.
        storePair(run, {
          ticker: 'CCC', expiration, strike, iv: 0.9, spot: 100,
          observedAt: `${DATE}T10:15:00-04:00`
        });
        storePair(run, {
          ticker: 'CCC', expiration, strike, iv: 0.3, spot: 100,
          observedAt: `${DATE}T17:05:01-04:00`
        });
      }
    }

    runDerivePhase(db(), makeHost(), run);
    const row = raw.prepare('SELECT * FROM derived_iv30_daily').get() as Record<string, unknown>;
    expect(row['iv30'] as number).toBeCloseTo(0.3, 10);
  });

  it('is a no-op on a day with no chain, rather than an error', () => {
    const run = newRun();
    const counts = runDerivePhase(db(), makeHost(), run);

    // Phase 7's own counts already report an absent chain; failing here would
    // report one problem twice.
    expect(counts).toEqual({ tickers: 0, ok: 0, insufficientExpirations: 0, noAtmQuotes: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM derived_iv30_daily').get()).toEqual({ n: 0 });
  });

  it('supersedes rather than updates when the day is derived twice', () => {
    const run = newRun();
    for (const expiration of ['2026-09-25', '2026-10-30']) {
      storePair(run, { ticker: 'DDD', expiration, strike: 95, iv: 0.4, spot: 100 });
      storePair(run, { ticker: 'DDD', expiration, strike: 105, iv: 0.4, spot: 100 });
    }

    runDerivePhase(db(), makeHost(), run);
    runDerivePhase(db(), makeHost({ nowET: () => `${DATE}T18:00:00-04:00` }), run);

    // Append-only: two rows with different `observed_at`, and the append-only
    // trigger would have raised had the second been written as an UPDATE.
    const rows = raw
      .prepare('SELECT observed_at FROM derived_iv30_daily ORDER BY observed_at')
      .all() as { observed_at: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.observed_at).not.toBe(rows[1]!.observed_at);
  });

  it('derives every ticker in the day independently', () => {
    const run = newRun();
    for (const expiration of ['2026-09-25', '2026-10-30']) {
      storePair(run, { ticker: 'EEE', expiration, strike: 95, iv: 0.4, spot: 100 });
      storePair(run, { ticker: 'EEE', expiration, strike: 105, iv: 0.4, spot: 100 });
    }
    // FFF has a chain but nothing usable — it must not cost EEE its row.
    storePair(run, { ticker: 'FFF', expiration: '2026-09-25', strike: 95, iv: 0.4, spot: 100, ivStatus: 'invalid' });

    const counts = runDerivePhase(db(), makeHost(), run);
    expect(counts.tickers).toBe(2);
    expect(counts.ok).toBe(1);

    const statuses = raw
      .prepare('SELECT ticker, status FROM derived_iv30_daily ORDER BY ticker')
      .all() as { ticker: string; status: string }[];
    expect(statuses).toEqual([
      { ticker: 'EEE', status: 'ok' },
      { ticker: 'FFF', status: 'no_atm_quotes' }
    ]);
  });
});
