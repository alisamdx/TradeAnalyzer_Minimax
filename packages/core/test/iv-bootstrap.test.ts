import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CheckContext } from '../src/qa/check.js';
import type { CollectorHost, ProviderResponse } from '../src/collector/host.js';
import { beginRun } from '../src/collector/run.js';
import {
  ivBootstrapChecks,
  QC907_BOOTSTRAP_OVERLAP,
  QC908_BOOTSTRAP_DISAGREEMENT,
  MIN_OVERLAP_DAYS
} from '../src/qa/checks/iv-bootstrap.js';
import { checksFor, ALL_CHECKS } from '../src/qa/registry.js';
import { summarise } from '../src/qa/check.js';

/**
 * QC-907 / QC-908 — the bootstrap overlap (03 §3.8a, 04 §7.3).
 *
 * **The gate for B7b is the first test below**: QC-907 shown firing on a
 * zero-overlap fixture. A check that cannot fail on the case it exists for is
 * not a recorded check, and zero overlap is exactly the case — the existing
 * app's `iv_history` splices two sources with no common ticker-day at all, and
 * the check as first drafted would have read that as clean.
 */

let dir: string;
let raw: Database.Database;

const DATE = '2026-09-09';

function db(): SqliteLike {
  return raw as unknown as SqliteLike;
}

function ctx(): CheckContext {
  return { db: db(), runId: 1, tradingDate: DATE, observedAt: `${DATE}T17:30:00-04:00` };
}

/** A day of our own derived series. */
function storeDerived(ticker: string, date: string, iv30: number, status = 'ok'): void {
  raw
    .prepare(
      `INSERT INTO derived_iv30_daily
         (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
          ticker, iv30, iv30_status, near_expiration, far_expiration, near_iv, far_iv,
          derivation_version, status)
       VALUES (1, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, 1, ?)`
    )
    .run(
      date,
      `${date}T17:30:00-04:00`,
      ticker,
      status === 'ok' ? iv30 : null,
      status === 'ok' ? 'ok' : 'omitted',
      status
    );
}

/** A day of the purchased series. */
function storeExt(ticker: string, date: string, iv30: number, accepted = 0): void {
  raw
    .prepare(
      `INSERT INTO ext_iv_history
         (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
          ticker, date, iv30, source, method_note, load_run_id, accepted, accepted_at, accepted_note)
       VALUES (1, ?, ?, NULL, 1, ?, ?, ?, 'ivolatility', '30d constant-maturity ATM IVX', 1, ?, NULL, NULL)`
    )
    .run(date, `${date}T17:30:00-04:00`, ticker, date, iv30, accepted);
}

function tradingDays(n: number, from = 1): string[] {
  // Plain sequential dates; the checks count paired rows, not sessions.
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 7, from + i));
    return d.toISOString().slice(0, 10);
  });
}

/**
 * A minimal host, only so `beginRun` can open a real run.
 *
 * The run row is created through the real helper rather than a hand-written
 * INSERT: three separate attempts at hand-writing fixture rows in this step
 * each guessed a column wrong (`body_bytes`, `quote_status`, `host_app`), and
 * every one of those was the schema being right.
 */
function makeHost(): CollectorHost {
  const empty: ProviderResponse = {
    status: 200, body: '{}', requestedAt: `${DATE}T17:00:00-04:00`, respondedAt: `${DATE}T17:00:01-04:00`
  };
  return {
    openGenerationDb: () => db(),
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => b,
    decryptFromArchive: (b) => b,
    polygonGet: async () => empty,
    etradeGet: async () => empty,
    httpGet: async () => empty,
    nowET: () => `${DATE}T17:00:00-04:00`,
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test-host', version: '0.0.0' }
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-b7b-iv-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
  raw.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) " +
      "VALUES (1, '2026-09-09T00:00:00-04:00', 'pilot', 'x', 'y')"
  );
  beginRun(db(), makeHost(), { kind: 'bootstrap_iv', tradingDate: DATE });
  raw.exec(
    `INSERT INTO meta_response
       (source_response_id, run_id, provider, endpoint, params_json, requested_at, responded_at,
        http_status, byte_length, archive_file, archive_offset, sha256, dedup_hash, encrypted,
        at_provider_cap, parse_status)
     VALUES (1, 1, 'ivolatility', '/equities/eod/ivx', '{}', '2026-09-09T17:00:00-04:00',
             '2026-09-09T17:00:01-04:00', 200, 2, 'a.jsonl', 0, 'x', 'd1', 0, 0, 'ok')`
  );
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('QC-907 — zero overlap is the MAXIMUM firing, not a pass', () => {
  it('fires hardest when the two series have never measured the same day', () => {
    // The exact shape of the existing app's splice: both series exist, both are
    // long, and they share no date at all.
    for (const d of tradingDays(40, 1)) storeExt('AAA', d, 0.4);
    for (const d of tradingDays(40, 60)) storeDerived('AAA', d, 0.41);

    const evals = QC907_BOOTSTRAP_OVERLAP.run(ctx());

    expect(evals).toHaveLength(1);
    expect(evals[0]!.fired).toBe(true);
    // The value is reported, and it is zero. Reporting nothing here is what the
    // first draft did, and it is indistinguishable from a clean comparison.
    expect(evals[0]!.value).toBe(0);
    expect(evals[0]!.detail).toContain('never measured the same day');
  });

  it('reports paired_days on every evaluation, fired or not', () => {
    for (const d of tradingDays(MIN_OVERLAP_DAYS)) {
      storeExt('AAA', d, 0.4);
      storeDerived('AAA', d, 0.4);
    }
    storeExt('BBB', '2026-08-01', 0.4); // no derived counterpart at all

    const evals = QC907_BOOTSTRAP_OVERLAP.run(ctx());
    // Both carry a value — the distribution is the point, and a check that
    // recorded only its fires could not tell "never fires" from "cannot fire".
    expect(evals.map((e) => [e.key, e.value, e.fired])).toEqual([
      ['AAA', MIN_OVERLAP_DAYS, false],
      ['BBB', 0, true]
    ]);

    const dist = summarise(evals.flatMap((e) => (e.value === undefined ? [] : [e.value])), MIN_OVERLAP_DAYS);
    // `summarise` returns null on no evaluations; `toMatchObject` fails loudly on
    // a null where a property read would only have failed the typecheck.
    expect(dist).toMatchObject({ n: 2, min: 0 });
  });

  it('is driven by the ticker list, not by the join', () => {
    // A ticker with no common day produces NO join row, so a check iterating
    // the join would skip precisely the case it exists for.
    storeExt('LONELY', '2026-08-01', 0.4);
    storeDerived('OTHER', '2026-08-01', 0.4);

    const evals = QC907_BOOTSTRAP_OVERLAP.run(ctx());
    expect(evals.map((e) => e.key)).toEqual(['LONELY']);
    expect(evals[0]!.fired).toBe(true);
  });

  it('does not count a day our own derivation could not compute', () => {
    for (const d of tradingDays(MIN_OVERLAP_DAYS)) storeExt('AAA', d, 0.4);
    for (const d of tradingDays(MIN_OVERLAP_DAYS)) storeDerived('AAA', d, 0, 'insufficient_expirations');

    // Both series have a row on all 20 days, but on none of them did both
    // *measure* the same thing. Counting these would inflate the very quantity
    // the check protects.
    const evals = QC907_BOOTSTRAP_OVERLAP.run(ctx());
    expect(evals[0]!.value).toBe(0);
    expect(evals[0]!.fired).toBe(true);
  });

  it('passes once the overlap is sufficient', () => {
    for (const d of tradingDays(MIN_OVERLAP_DAYS)) {
      storeExt('AAA', d, 0.4);
      storeDerived('AAA', d, 0.4);
    }
    expect(QC907_BOOTSTRAP_OVERLAP.run(ctx())[0]!.fired).toBe(false);
  });

  it('ignores a series already accepted', () => {
    for (const d of tradingDays(3)) storeExt('AAA', d, 0.4, 1);
    expect(QC907_BOOTSTRAP_OVERLAP.run(ctx())).toHaveLength(0);
  });
});

describe('QC-908 — disagreement, but only where there is enough overlap', () => {
  it('does not evaluate a series that has not cleared QC-907', () => {
    // Three days, wildly disagreeing. A disagreement measured over three days
    // is not a disagreement, and reporting one would put a blocking exception
    // on the operator's desk that no amount of data could yet justify.
    for (const d of tradingDays(3)) {
      storeExt('AAA', d, 0.9);
      storeDerived('AAA', d, 0.2);
    }
    expect(QC908_BOOTSTRAP_DISAGREEMENT.run(ctx())).toHaveLength(0);
  });

  it('fires on a real disagreement over a sufficient overlap', () => {
    for (const d of tradingDays(MIN_OVERLAP_DAYS)) {
      storeExt('AAA', d, 0.45);
      storeDerived('AAA', d, 0.40);
    }
    const evals = QC908_BOOTSTRAP_DISAGREEMENT.run(ctx());
    expect(evals).toHaveLength(1);
    expect(evals[0]!.value).toBeCloseTo(0.05, 10);
    expect(evals[0]!.fired).toBe(true);
  });

  it('uses the median, so a few bad days do not decide it', () => {
    const days = tradingDays(MIN_OVERLAP_DAYS + 1);
    days.forEach((d, i) => {
      storeExt('AAA', d, 0.40);
      // Three days where our side priced badly, then the rest half a vol point
      // apart. A mean would be dragged over the threshold by the three; the
      // median is not, which is the point of using it.
      //
      // Written as three *stored* days rather than an UPDATE over good ones —
      // `derived_iv30_daily` is append-only with no mutable columns, and the
      // trigger refused the shortcut. The guard was right and the fixture was
      // taking a liberty the production path could not take either.
      storeDerived('AAA', d, i < 3 ? 0.9 : 0.395);
    });

    const evals = QC908_BOOTSTRAP_DISAGREEMENT.run(ctx());
    expect(evals[0]!.value).toBeCloseTo(0.005, 10);
    expect(evals[0]!.fired).toBe(false);
  });
});

describe('registration is conditional on there being a bootstrap', () => {
  it('registers nothing while no external series has been loaded', () => {
    // A check registered against an unbought bootstrap evaluates nothing every
    // run and lands in QC-952's zero-fire review looking exactly like one that
    // is silently broken — which is how that review stops being read.
    expect(ivBootstrapChecks(db())).toHaveLength(0);
    expect(checksFor(db())).toHaveLength(ALL_CHECKS.length);
  });

  it('registers both the moment a load exists', () => {
    storeExt('AAA', '2026-08-01', 0.4);
    expect(ivBootstrapChecks(db()).map((c) => c.id)).toEqual(['QC-907', 'QC-908']);
    expect(checksFor(db())).toHaveLength(ALL_CHECKS.length + 2);
  });
});

describe('acceptance is a narrow, recorded edit', () => {
  it('permits flipping `accepted` and refuses to touch the value beside it', () => {
    storeExt('AAA', '2026-08-01', 0.4);

    // Loading is not accepting: the flag is written 0 and nothing reads the row.
    expect(
      raw.prepare('SELECT accepted FROM ext_iv_history WHERE ticker = ?').get('AAA')
    ).toEqual({ accepted: 0 });

    raw
      .prepare(
        "UPDATE ext_iv_history SET accepted = 1, accepted_at = ?, accepted_note = ? WHERE ticker = ?"
      )
      .run(`${DATE}T18:00:00-04:00`, 'overlap clean over 22 paired days', 'AAA');
    expect(
      (raw.prepare('SELECT accepted FROM ext_iv_history WHERE ticker = ?').get('AAA') as { accepted: number }).accepted
    ).toBe(1);

    // The IV itself is a stored fact and stays frozen — the append-only guard
    // permits learning something *about* the row, never rewriting it.
    expect(() =>
      raw.prepare('UPDATE ext_iv_history SET iv30 = 0.9 WHERE ticker = ?').run('AAA')
    ).toThrow(/append-only|permits changing only/);
  });

  it('refuses a DELETE, acceptance or not', () => {
    storeExt('AAA', '2026-08-01', 0.4);
    expect(() => raw.prepare('DELETE FROM ext_iv_history').run()).toThrow(/append-only/);
  });
});
