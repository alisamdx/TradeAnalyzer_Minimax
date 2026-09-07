import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost, ProviderResponse } from '../src/collector/host.js';
import { beginRun, captureRuleId } from '../src/collector/run.js';
import { runBackfillBars, backfillQueueClear } from '../src/collector/backfill.js';
import { runGate } from '../src/qa/gate.js';
import { QC205_VOLUME_REGIME, QC204_DISCONTINUITY } from '../src/qa/checks/bars.js';
import {
  acknowledge, accept, resolve, expireAcceptances, recordTickerReuse, reviewQueue,
  OperatorActionRefused
} from '../src/qa/operator.js';

let dir: string;
let raw: Database.Database;
let db: SqliteLike;
let sentEmails: { subject: string; text: string }[];

function makeHost(polygonGet?: CollectorHost['polygonGet']): CollectorHost {
  return {
    openGenerationDb: () => db,
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => b,
    decryptFromArchive: (b) => b,
    polygonGet: polygonGet ?? (async () => ({ status: 200, body: '{"results":[]}', requestedAt: 't', respondedAt: 't' })),
    etradeGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    httpGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    nowET: () => '2026-09-06T18:00:00-04:00',
    sendEmail: async (m) => { sentEmails.push({ subject: m.subject, text: m.text }); },
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test', version: '0' }
  };
}

/** A bar series with a step and a permanent volume-regime shift — the reuse signature. */
function reuseSeries(): string {
  const results: unknown[] = [];
  const day = 86_400_000;
  const start = Date.parse('2026-06-01T00:00:00Z');
  // Entity A: penny-ish price, tiny volume.
  for (let i = 0; i < 25; i++) {
    results.push({ t: start + i * day, o: 2, h: 2.1, l: 1.9, c: 2, v: 1_000 });
  }
  // Entity B from here: different price level, volume two orders larger.
  for (let i = 25; i < 50; i++) {
    results.push({ t: start + i * day, o: 90, h: 91, l: 89, c: 90, v: 5_000_000 });
  }
  return JSON.stringify({ results });
}

/** A clean, unremarkable series. */
function cleanSeries(base = 100): string {
  const day = 86_400_000;
  const start = Date.parse('2026-06-01T00:00:00Z');
  return JSON.stringify({
    results: Array.from({ length: 50 }, (_, i) => ({
      t: start + i * day, o: base, h: base + 1, l: base - 1, c: base + (i % 3) * 0.1, v: 1_000_000 + i
    }))
  });
}

function seedUniverse(tickers: readonly string[]): void {
  const host = makeHost();
  const run = beginRun(db, host, { kind: 'manual', tradingDate: '2026-09-06' });
  const ruleId = captureRuleId(db, host, 'universe', { lists: ['sp500'] }, 'test');
  raw.exec(
    "INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) " +
      `VALUES (9001, ${run.runId}, 'polygon', '/x', '{}', 't', 'a', 0, 'seed-hash', 0, 0, 'ok')`
  );
  for (const t of tickers) {
    raw.prepare(
      `INSERT INTO ref_universe_membership (
         run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
         ticker, list_source, valid_from, valid_to, change_reason
       ) VALUES (?,?,?,?,?,?, 'sp500', '2021-01-01', NULL, 'initial')`
    ).run(run.runId, '2026-09-06', 't', ruleId, 9001, t);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-backfill-'));
  raw = new Database(join(dir, 'data.sqlite'));
  db = raw as unknown as SqliteLike;
  applyDictionary(db);
  raw.exec("INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) VALUES (1,'t','pilot','x','y')");
  sentEmails = [];
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('backfill_bars', () => {
  it('stores five years in one pass, so every row shares an adjustment basis', async () => {
    // The consistency that matters. The existing app built history incrementally
    // and re-fetched a three-day tail, so a later split left pre-split bars next
    // to post-split ones — 153 permanent steps across 126 tickers.
    seedUniverse(['AAPL', 'MSFT']);
    const host = makeHost(async (path) =>
      path.includes('/splits')
        ? { status: 200, body: '{"results":[]}', requestedAt: 't', respondedAt: 't' }
        : { status: 200, body: cleanSeries(), requestedAt: 't', respondedAt: 't' }
    );

    const report = await runBackfillBars(host, { tradingDate: '2026-09-06' });

    expect(report.tickersAttempted).toBe(2);
    expect(report.tickersStored).toBe(2);
    expect(report.barsStored).toBe(100);

    const bases = raw.prepare('SELECT DISTINCT adjusted_as_of FROM raw_daily_bar').all();
    expect(bases).toEqual([{ adjusted_as_of: '2026-09-06' }]);
    const kinds = raw.prepare('SELECT DISTINCT fetch_kind FROM raw_daily_bar').all();
    expect(kinds).toEqual([{ fetch_kind: 'backfill' }]);
  });

  it('fetches splits BEFORE the bars, so a discontinuity has something to be explained by', async () => {
    const order: string[] = [];
    seedUniverse(['AAPL']);
    const host = makeHost(async (path): Promise<ProviderResponse> => {
      order.push(path.includes('/splits') ? 'splits' : 'bars');
      return { status: 200, body: path.includes('/splits') ? '{"results":[]}' : cleanSeries(), requestedAt: 't', respondedAt: 't' };
    });
    await runBackfillBars(host, { tradingDate: '2026-09-06' });
    expect(order[0]).toBe('splits');
  });

  it('opens the review queue with the ticker-reuse candidates and emails it', async () => {
    seedUniverse(['BNY']);
    const host = makeHost(async (path) =>
      path.includes('/splits')
        ? { status: 200, body: '{"results":[]}', requestedAt: 't', respondedAt: 't' }
        : { status: 200, body: reuseSeries(), requestedAt: 't', respondedAt: 't' }
    );

    const report = await runBackfillBars(host, { tradingDate: '2026-09-06' });

    expect(report.verdict).toBe('red');
    expect(report.reviewQueue.some((q) => q.checkId === 'QC-205')).toBe(true);
    expect(report.emailSent).toBe(true);
    expect(sentEmails[0]!.text).toContain('BLOCKING');
    expect(sentEmails[0]!.text).toContain('QC-205');
  });

  it('reports the queue as not clear until every QC-204/205 finding is ruled on', async () => {
    seedUniverse(['BNY']);
    const host = makeHost(async (path) =>
      path.includes('/splits')
        ? { status: 200, body: '{"results":[]}', requestedAt: 't', respondedAt: 't' }
        : { status: 200, body: reuseSeries(), requestedAt: 't', respondedAt: 't' }
    );
    await runBackfillBars(host, { tradingDate: '2026-09-06' });

    const before = backfillQueueClear(db);
    expect(before.clear).toBe(false);
    expect(before.outstanding.length).toBeGreaterThan(0);

    for (const o of before.outstanding) {
      accept(db, makeHost(), o.exceptionId, 'reviewed during the backfill');
    }
    expect(backfillQueueClear(db).clear).toBe(true);
  });
});

describe('operator actions on exceptions', () => {
  function raiseOne(severity: 'blocking' | 'warning' = 'blocking'): number {
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    runGate(db, host, {
      runId: run.runId, tradingDate: '2026-09-06',
      checks: [{
        ...QC205_VOLUME_REGIME, severity,
        run: () => [{ key: 'BNY', value: 76, fired: true, detail: '20-day median volume shifted 76.0x' }]
      }]
    });
    return (raw.prepare('SELECT exception_id FROM qa_exception').get() as { exception_id: number }).exception_id;
  }

  it('refuses to resolve a finding that is still firing', () => {
    // Resolving would mark the domain-day usable on the strength of an opinion,
    // and the next run would reopen it — so the only lasting effect would be a
    // misleading clean day in between.
    const id = raiseOne();
    expect(() => resolve(db, makeHost(), id, 'data_corrected', 'looks fine to me'))
      .toThrow(OperatorActionRefused);
    expect(() => resolve(db, makeHost(), id, 'data_corrected', 'looks fine to me'))
      .toThrow(/still firing/);
  });

  it('allows a false_positive resolution while firing, because that is a claim about the CHECK', () => {
    const id = raiseOne();
    resolve(db, makeHost(), id, 'false_positive', 'the check is wrong for this ticker');
    expect(raw.prepare('SELECT state FROM qa_exception WHERE exception_id = ?').get(id))
      .toEqual({ state: 'resolved' });
  });

  it('requires a note on both resolve and accept', () => {
    const id = raiseOne();
    expect(() => resolve(db, makeHost(), id, 'false_positive', '   ')).toThrow(/needs a note/);
    expect(() => accept(db, makeHost(), id, '')).toThrow(/needs a note/);
  });

  it('gives every acceptance an expiry, defaulting to 30 days', () => {
    // An acceptance without an expiry is a decision nobody revisits.
    const id = raiseOne();
    const until = accept(db, makeHost(), id, 'genuine repricing, not reuse');
    expect(until).toBe('2026-10-06');
    const row = raw.prepare('SELECT state, accepted_until, accepted_note FROM qa_exception WHERE exception_id = ?').get(id) as Record<string, unknown>;
    expect(row['state']).toBe('accepted');
    expect(row['accepted_until']).toBe('2026-10-06');
    expect(row['accepted_note']).toBe('genuine repricing, not reuse');
  });

  it('makes the domain-day usable again on acceptance', () => {
    const id = raiseOne();
    expect(raw.prepare("SELECT status FROM qa_domain_day_status WHERE domain='bars'").get()).toEqual({ status: 'unusable' });
    accept(db, makeHost(), id, 'genuine move');
    expect(raw.prepare("SELECT status FROM qa_domain_day_status WHERE domain='bars'").get()).toEqual({ status: 'usable' });
  });

  it('moves an expired acceptance to expired_review WITHOUT making the day unusable again', () => {
    // 03 §5.2. An acceptance expiring is a prompt to re-examine a known fact,
    // not the discovery of a new one — the data has not changed. Letting expiry
    // flip the day back would mean an acceptance taken on pilot day 1 resets the
    // streak around day 21, every time, defeating the 20-day criterion with its
    // own escape valve.
    const id = raiseOne();
    accept(db, makeHost(), id, 'genuine move', '2026-09-10');
    expect(expireAcceptances(db, makeHost(), '2026-09-11')).toBe(1);

    expect(raw.prepare('SELECT state FROM qa_exception WHERE exception_id = ?').get(id))
      .toEqual({ state: 'expired_review' });
    expect(raw.prepare("SELECT status FROM qa_domain_day_status WHERE domain='bars'").get())
      .toEqual({ status: 'usable' });
  });

  it('records an actor and a note for every state change', () => {
    const id = raiseOne();
    acknowledge(db, makeHost(), id, 'looking into it');
    accept(db, makeHost(), id, 'genuine move');
    const events = raw
      .prepare('SELECT actor, from_state, to_state, note FROM qa_exception_event WHERE exception_id = ? ORDER BY row_id')
      .all(id) as Record<string, unknown>[];
    expect(events.map((e) => e['to_state'])).toEqual(['open', 'acknowledged', 'accepted']);
    expect(events.every((e) => typeof e['note'] === 'string' && (e['note'] as string).length > 0)).toBe(true);
    expect(events.slice(1).every((e) => e['actor'] === 'operator')).toBe(true);
  });

  it('refuses to acknowledge anything that is not open', () => {
    const id = raiseOne();
    acknowledge(db, makeHost(), id);
    expect(() => acknowledge(db, makeHost(), id)).toThrow(/Only an open exception/);
  });
});

describe('the ticker-reuse ruling destroys nothing', () => {
  it('closes the membership range and opens a new one, leaving every bar in place', () => {
    seedUniverse(['BNY']);
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    raw.exec(
      "INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) " +
        `VALUES (9100, ${run.runId}, 'polygon', '/b', '{}', 't', 'a', 1, 'bar-hash', 0, 0, 'ok')`
    );
    const ruleId = captureRuleId(db, host, 'bars', { depthDays: 1 }, 'test');
    for (const [i, close] of [2, 2, 90, 90].entries()) {
      raw.prepare(
        `INSERT INTO raw_daily_bar (
           run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
           ticker, trade_date, open, high, low, close, volume, adjusted_as_of, fetch_kind, is_final
         ) VALUES (?,?,?,?,?,'BNY',?,?,?,?,?,?, '2026-09-06','backfill',1)`
      ).run(run.runId, '2026-09-06', 't', ruleId, 9100,
        `2026-06-0${i + 1}`, close, close, close, close, close < 10 ? 1000 : 5_000_000);
    }

    runGate(db, host, {
      runId: run.runId, tradingDate: '2026-09-06',
      checks: [{
        ...QC205_VOLUME_REGIME,
        run: () => [{ key: 'BNY', value: 76, fired: true, detail: 'volume regime shifted 76.0x' }]
      }]
    });
    const id = (raw.prepare('SELECT exception_id FROM qa_exception').get() as { exception_id: number }).exception_id;

    const barsBefore = raw.prepare('SELECT COUNT(*) AS n FROM raw_daily_bar').get();
    const result = recordTickerReuse(db, host, {
      exceptionId: id, ticker: 'BNY', spliceDate: '2026-06-03',
      note: 'volume 76x and a price level change — a different company'
    });

    expect(result.closed).toBe(1);
    expect(result.opened).toBe(1);
    expect(result.spliceDate).toBe('2026-06-03');

    // Nothing was deleted. The bars are evidence about two companies, and
    // destroying the earlier one's history to fix an INTERPRETATION problem
    // would be the wrong trade.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM raw_daily_bar').get()).toEqual(barsBefore);

    const memberships = raw
      .prepare('SELECT valid_from, valid_to, change_reason, predecessor_ticker FROM ref_universe_membership ORDER BY valid_from')
      .all() as Record<string, unknown>[];
    expect(memberships).toHaveLength(2);
    expect(memberships[0]!['valid_to']).toBe('2026-06-02');
    expect(memberships[0]!['change_reason']).toBe('ticker_change');
    expect(memberships[1]!['valid_from']).toBe('2026-06-03');
    expect(memberships[1]!['valid_to']).toBeNull();
    expect(memberships[1]!['predecessor_ticker']).toBe('BNY');

    expect(raw.prepare('SELECT state, resolution_kind FROM qa_exception WHERE exception_id = ?').get(id))
      .toEqual({ state: 'resolved', resolution_kind: 'data_corrected' });
  });

  it('lets a reader separate the two entities by intersecting bars with membership', () => {
    // This is what the ruling buys: one entity at a time, without deleting
    // anything. No re-fetch could achieve it — the provider keys by ticker too.
    seedUniverse(['BNY']);
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    raw.exec(
      "INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) " +
        `VALUES (9200, ${run.runId}, 'polygon', '/b', '{}', 't', 'a', 2, 'h2', 0, 0, 'ok')`
    );
    const ruleId = captureRuleId(db, host, 'bars', { depthDays: 1 }, 'test');
    for (const [i, close] of [2, 2, 90, 90].entries()) {
      raw.prepare(
        `INSERT INTO raw_daily_bar (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
           ticker, trade_date, open, high, low, close, volume, adjusted_as_of, fetch_kind, is_final)
         VALUES (?,?,?,?,?,'BNY',?,?,?,?,?,1000,'2026-09-06','backfill',1)`
      ).run(run.runId, '2026-09-06', 't', ruleId, 9200, `2026-06-0${i + 1}`, close, close, close, close);
    }
    runGate(db, host, {
      runId: run.runId, tradingDate: '2026-09-06',
      checks: [{ ...QC204_DISCONTINUITY, run: () => [{ key: 'BNY', value: 44, fired: true, detail: 'step' }] }]
    });
    const id = (raw.prepare('SELECT exception_id FROM qa_exception').get() as { exception_id: number }).exception_id;
    recordTickerReuse(db, host, { exceptionId: id, ticker: 'BNY', spliceDate: '2026-06-03', note: 'reuse' });

    const currentEntity = raw
      .prepare(
        `SELECT b.trade_date, b.close FROM raw_daily_bar b
           JOIN ref_universe_membership m
             ON m.ticker = b.ticker
            AND b.trade_date >= m.valid_from
            AND (m.valid_to IS NULL OR b.trade_date <= m.valid_to)
          WHERE b.ticker = 'BNY' AND m.valid_to IS NULL
          ORDER BY b.trade_date`
      )
      .all() as { trade_date: string; close: number }[];

    expect(currentEntity.map((r) => r.close)).toEqual([90, 90]);
  });

  it('takes the splice date from the observed discontinuity when none is given', () => {
    // Getting it wrong by one day is easy and its consequence is silent: a bar
    // of the new company stays in the old entity's range and nothing complains.
    // QC-204 keyed the finding at the exact boundary, so that is the default.
    seedUniverse(['BNY']);
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    runGate(db, host, {
      runId: run.runId, tradingDate: '2026-09-06',
      checks: [
        { ...QC204_DISCONTINUITY, run: () => [{ key: 'BNY 2026-06-26', value: 44, fired: true, detail: 'step' }] },
        { ...QC205_VOLUME_REGIME, run: () => [{ key: 'BNY', value: 76, fired: true, detail: 'reuse' }] }
      ]
    });
    const id = (raw.prepare("SELECT exception_id FROM qa_exception WHERE check_id='QC-205'").get() as { exception_id: number }).exception_id;

    const result = recordTickerReuse(db, host, { exceptionId: id, ticker: 'BNY', note: 'reuse' });
    expect(result.spliceDate).toBe('2026-06-26');
    expect(raw.prepare("SELECT valid_to FROM ref_universe_membership WHERE valid_to IS NOT NULL").get())
      .toEqual({ valid_to: '2026-06-25' });
  });

  it('refuses when it has neither a given splice date nor a discontinuity to take one from', () => {
    const host = makeHost();
    seedUniverse(['QUIET']);
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    runGate(db, host, {
      runId: run.runId, tradingDate: '2026-09-06',
      checks: [{ ...QC205_VOLUME_REGIME, run: () => [{ key: 'QUIET', value: 76, fired: true, detail: 'x' }] }]
    });
    const id = (raw.prepare('SELECT exception_id FROM qa_exception').get() as { exception_id: number }).exception_id;
    expect(() => recordTickerReuse(db, host, { exceptionId: id, ticker: 'QUIET', note: 'x' }))
      .toThrow(/no QC-204 discontinuity/);
  });

  it('refuses when there is no open membership row to close', () => {
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    runGate(db, host, {
      runId: run.runId, tradingDate: '2026-09-06',
      checks: [{ ...QC205_VOLUME_REGIME, run: () => [{ key: 'GHOST', value: 76, fired: true, detail: 'x' }] }]
    });
    const id = (raw.prepare('SELECT exception_id FROM qa_exception').get() as { exception_id: number }).exception_id;
    expect(() => recordTickerReuse(db, host, { exceptionId: id, ticker: 'GHOST', spliceDate: '2026-06-03', note: 'x' }))
      .toThrow(/no open membership row/);
  });
});

describe('the review queue', () => {
  it('lists only blocking findings still awaiting a ruling', () => {
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    runGate(db, host, {
      runId: run.runId, tradingDate: '2026-09-06',
      checks: [
        { ...QC205_VOLUME_REGIME, run: () => [{ key: 'BNY', value: 76, fired: true, detail: 'reuse' }] },
        { ...QC204_DISCONTINUITY, severity: 'warning', run: () => [{ key: 'MRNA', value: 1.77, fired: true, detail: 'move' }] }
      ]
    });
    const queue = reviewQueue(db);
    expect(queue.map((q) => q.checkId)).toEqual(['QC-205']);
  });
});
