import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost, ProviderResponse } from '../src/collector/host.js';
import { beginRun, captureRuleId } from '../src/collector/run.js';
import { runBackfillBars } from '../src/collector/backfill.js';
import { resolve } from '../src/qa/operator.js';
import {
  QC204_DISCONTINUITY, QC205_VOLUME_REGIME, QC209_DORMANT_SERIES_RESUMES,
  QC210_BARS_PREDATE_LISTING, BAR_CHECKS, entityStartDates,
  volumeRegimeAroundSteps, dormancyBeforeSteps,
  REGIME_WINDOW, MIN_WINDOW_BARS, type VolumeBar
} from '../src/qa/checks/bars.js';
import { makeBarIngest, volumeOrNull } from '../src/ingest/market.js';
import { buildTradingCalendar, sessionOnOrBefore } from '../src/collector/trading-calendar.js';

/**
 * Bar volume, end to end — the 2026-09-12 findings.
 *
 * gen-001's AAPL bar read `volume 0` beside `transactions 1,225,501`. Polygon's
 * daily `v` is fractional (it counts fractional-share trades); the parser
 * asserted integrality, "failed", and wrote 0. QC-205 skipped every zero median
 * and so evaluated nothing on three backfills, and the chain subset computed
 * dollar volume as `close × 0` and admitted nobody. Every fixture before this
 * one used a whole-number volume, which is why no test saw any of it.
 *
 * On gen-002 the rewritten QC-205 then showed a second fault: windows counted in
 * stored BARS let a sparse series reach across a splice (SOLS). Windows are now
 * exchange sessions, and QC-209 covers the dormant-shell form QC-205 cannot
 * measure. Every series here is laid on real sessions for that reason — a
 * calendar-day series would put bars on weekends that no window can count.
 */

let dir: string;
let raw: Database.Database;
let db: SqliteLike;

const SESSIONS = buildTradingCalendar('2023-01-03', '2026-09-11').filter((r) => r.isTradingDay).map((r) => r.date);

function makeHost(polygonGet: CollectorHost['polygonGet']): CollectorHost {
  return {
    openGenerationDb: () => db,
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => b,
    decryptFromArchive: (b) => b,
    polygonGet,
    etradeGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    httpGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    nowET: () => '2026-09-11T18:00:00-04:00',
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test', version: '0' }
  };
}

function seedUniverse(tickers: readonly string[]): void {
  const host = makeHost(async () => ({ status: 200, body: '{"results":[]}', requestedAt: 't', respondedAt: 't' }));
  const run = beginRun(db, host, { kind: 'manual', tradingDate: '2026-09-11' });
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
    ).run(run.runId, '2026-09-11', 't', ruleId, 9001, t);
  }
}

/** A run of bars: `count` of them, one every `every` sessions. */
interface Leg { readonly count: number; readonly close: number; readonly volume: number; readonly every?: number }

/** Session dates for consecutive legs, starting at session `start`. */
function legDates(legs: readonly Leg[], start = 0): { date: string; leg: Leg }[] {
  const out: { date: string; leg: Leg }[] = [];
  let s = start;
  for (const leg of legs) {
    for (let k = 0; k < leg.count; k++) {
      out.push({ date: SESSIONS[s]!, leg });
      s += leg.every ?? 1;
    }
  }
  return out;
}

/** A Polygon aggs body, every bar at 13:00 ET on a real session. */
function aggs(legs: readonly Leg[]): string {
  return JSON.stringify({
    results: legDates(legs).map(({ date, leg }) => ({
      t: Date.parse(`${date}T17:00:00Z`), o: leg.close, h: leg.close, l: leg.close, c: leg.close, v: leg.volume, n: 100
    }))
  });
}

/** The same legs as the pure functions read them. */
function series(legs: readonly Leg[]): VolumeBar[] {
  return legDates(legs).map(({ date, leg }) => ({ ticker: 'X', trade_date: date, close: leg.close, volume: leg.volume }));
}

const SESSION_INDEX: ReadonlyMap<string, number> = new Map(SESSIONS.map((d, i) => [d, i]));

const REUSE: readonly Leg[] = [
  { count: 30, close: 2, volume: 1_000.5 },
  { count: 30, close: 90, volume: 5_000_000.25 }
];

/** SOLS, measured 2026-09-12: a sub-penny shell printing every few weeks, then an active listing. */
const DORMANT_SHELL: readonly Leg[] = [
  { count: 3, close: 0.0001, volume: 5_000, every: 30 },
  { count: 3, close: 0.000001, volume: 4_500, every: 30 },
  { count: 2, close: 0.0001, volume: 32_887, every: 30 },
  { count: 40, close: 48.74, volume: 4_222_115 }
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-bar-volume-'));
  raw = new Database(join(dir, 'data.sqlite'));
  db = raw as unknown as SqliteLike;
  applyDictionary(db);
  raw.exec("INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) VALUES (1,'t','pilot','x','y')");
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the bar parser keeps volume as Polygon sends it', () => {
  const ctx = { runId: 1, observedAt: 't', captureRuleId: 1 } as unknown as Parameters<ReturnType<typeof makeBarIngest>>[1];
  const ingest = makeBarIngest({ ticker: 'AAPL', fetchKind: 'backfill', adjustedAsOf: '2026-09-11' });
  const t = Date.parse('2026-09-10T17:00:00Z');

  it('stores a fractional volume exactly, not as 0', () => {
    const rows = ingest(JSON.stringify({ results: [{ t, c: 326.57, v: 54_321_987.35, n: 1_225_501 }] }), ctx);
    expect(rows[0]!.values['volume']).toBe(54_321_987.35);
  });

  it('stores an absent volume as null, never 0', () => {
    const rows = ingest(JSON.stringify({ results: [{ t, c: 326.57 }] }), ctx);
    expect(rows[0]!.values['volume']).toBeNull();
  });

  it('keeps a genuine zero and refuses what is not a usable number', () => {
    expect(volumeOrNull(0)).toBe(0);
    expect(volumeOrNull('1000')).toBeNull();
    expect(volumeOrNull(-5)).toBeNull();
    expect(volumeOrNull(Number.NaN)).toBeNull();
  });

  it('writes the fractional value through the real schema', async () => {
    seedUniverse(['AAPL']);
    const host = makeHost(async (path): Promise<ProviderResponse> => ({
      status: 200,
      body: path.includes('/splits') ? '{"results":[]}' : aggs([{ count: 3, close: 326.57, volume: 54_321_987.35 }]),
      requestedAt: 't', respondedAt: 't'
    }));
    await runBackfillBars(host, { tradingDate: '2026-09-11' });
    const vols = raw.prepare('SELECT DISTINCT volume, typeof(volume) AS kind FROM raw_daily_bar').all();
    expect(vols).toEqual([{ volume: 54_321_987.35, kind: 'real' }]);
  });
});

describe('QC-205 measures volume AROUND each discontinuity, in sessions', () => {
  it('fires on the reuse signature with fractional volumes', () => {
    const out = volumeRegimeAroundSteps(series(REUSE), SESSION_INDEX, 0.4, 15);
    expect(out).toHaveLength(1);
    expect(out[0]!.fired).toBe(true);
    expect(out[0]!.value).toBeCloseTo(5_000_000.25 / 1_000.5, 6);
  });

  it('measures a genuine move without firing, so the distribution holds it', () => {
    const out = volumeRegimeAroundSteps(
      series([{ count: 30, close: 100, volume: 1_000_000.5 }, { count: 30, close: 50, volume: 3_000_001.5 }]),
      SESSION_INDEX, 0.4, 15
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.fired).toBe(false);
    expect(out[0]!.value).toBeCloseTo(3, 5);
  });

  it('does not measure a step whose window holds fewer than the minimum bars', () => {
    const young = series([{ count: 30, close: 100, volume: 1_000.5 }, { count: MIN_WINDOW_BARS - 1, close: 50, volume: 9_000_000.5 }]);
    expect(volumeRegimeAroundSteps(young, SESSION_INDEX, 0.4, 15)).toEqual([]);
  });

  it('finds a step deep in the history, not only at the tail', () => {
    // The first version compared the last 20 rows with the 20 before them, so a
    // reuse two years back was invisible by construction.
    const deep = series([...REUSE, { count: 400, close: 90, volume: 5_000_000.25 }]);
    const out = volumeRegimeAroundSteps(deep, SESSION_INDEX, 0.4, 15);
    expect(out.map((e) => e.fired)).toEqual([true]);
    expect(out[0]!.affects).toEqual([deep[30]!.trade_date]);
  });

  it('never lends a sparse series a window from across a splice (SOLS)', () => {
    // Counted in bars, the shell's steps "saw" the listing's volume months later
    // and three of them reported the same post-splice median. Counted in
    // sessions, none of the shell's windows holds enough bars to be measured —
    // and neither does the splice's own before-window, which is QC-209's case.
    expect(volumeRegimeAroundSteps(series(DORMANT_SHELL), SESSION_INDEX, 0.4, 15)).toEqual([]);
  });

  it('evaluates after a real backfill — Evaluated 0 is what gen-001 read on all three runs', async () => {
    seedUniverse(['BNY']);
    const host = makeHost(async (path): Promise<ProviderResponse> => ({
      status: 200, body: path.includes('/splits') ? '{"results":[]}' : aggs(REUSE), requestedAt: 't', respondedAt: 't'
    }));
    const report = await runBackfillBars(host, { tradingDate: '2026-09-11' });
    expect(report.reviewQueue.filter((q) => q.checkId === 'QC-205')).toHaveLength(1);
  });

  it('reads the latest version of each day, so stacked backfills are still one series', async () => {
    seedUniverse(['BNY']);
    let afterVolume = 5_000_000.25;
    const host = makeHost(async (path): Promise<ProviderResponse> => ({
      status: 200,
      body: path.includes('/splits')
        ? '{"results":[]}'
        : aggs([REUSE[0]!, { count: 30, close: 90, volume: afterVolume }]),
      requestedAt: 't', respondedAt: 't'
    }));
    await runBackfillBars(host, { tradingDate: '2026-09-11' });
    afterVolume = 3_000_000.75;
    await runBackfillBars(host, { tradingDate: '2026-09-11' });
    afterVolume = 2_000_000.5;
    const last = await runBackfillBars(host, { tradingDate: '2026-09-11' });

    expect(raw.prepare("SELECT COUNT(*) AS n FROM raw_daily_bar WHERE ticker = 'BNY'").get()).toEqual({ n: 180 });
    const out = QC205_VOLUME_REGIME.run({ db, runId: last.runId, tradingDate: '2026-09-11', observedAt: 't' });
    // One step, measured once, on the newest observation of every day.
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBeCloseTo(2_000_000.5 / 1_000.5, 6);
  });

  it('a "not reuse" ruling closes that step for good, and the next gate run does not reopen it (v1.1.276)', async () => {
    // On 2026-09-18 all ten QC-205 findings were genuine events on continuing listings (APLD's
    // uplisting, GME's squeeze, WAL's bank run). A false_positive resolution used to be reopened
    // by the very next run as a recurrence, because a historic step fires every night.
    seedUniverse(['BNY']);
    const host = makeHost(async (path): Promise<ProviderResponse> => ({
      status: 200, body: path.includes('/splits') ? '{"results":[]}' : aggs(REUSE), requestedAt: 't', respondedAt: 't'
    }));
    const first = await runBackfillBars(host, { tradingDate: '2026-09-11' });
    const finding = raw
      .prepare("SELECT exception_id, key FROM qa_exception WHERE check_id = 'QC-205' AND state = 'open'")
      .get() as { exception_id: number; key: string };
    expect(finding).toBeDefined();

    resolve(db, host, finding.exception_id, 'false_positive', 'continuing listing — the volume came with an uplisting, not a new issuer');

    const out = QC205_VOLUME_REGIME.run({ db, runId: first.runId, tradingDate: '2026-09-11', observedAt: 't' });
    const same = out.find((e) => e.key === finding.key)!;
    expect(same.fired).toBe(false);
    expect(same.value).toBeGreaterThan(15); // still measured: the distribution stays whole
    expect(same.evidence!['ruledNotReuse']).toContain('uplisting');

    await runBackfillBars(host, { tradingDate: '2026-09-11' });
    expect(raw.prepare('SELECT state FROM qa_exception WHERE exception_id = ?').get(finding.exception_id))
      .toEqual({ state: 'resolved' });
  });
});

describe('QC-209 — a dormant symbol resuming as an active one', () => {
  it('fires on the splice where a sparse shell becomes a traded listing (SOLS)', () => {
    const out = dormancyBeforeSteps(series(DORMANT_SHELL), SESSION_INDEX, 0.4, 20);
    const fired = out.filter((e) => e.fired);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.evidence!['closeAfter']).toBe(48.74);
    expect(fired[0]!.value).toBe(29);
  });

  it('records the shell\'s own sub-penny steps without firing — nothing dense follows them', () => {
    const out = dormancyBeforeSteps(series(DORMANT_SHELL), SESSION_INDEX, 0.4, 20);
    const inside = out.filter((e) => !e.fired);
    // Every step is in the distribution, fired or not.
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.every((e) => (e.value ?? 0) >= 20)).toBe(true);
  });

  it('does not fire on a genuine move in a densely traded series', () => {
    const out = dormancyBeforeSteps(series(REUSE), SESSION_INDEX, 0.4, 20);
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBe(0);
    expect(out[0]!.fired).toBe(false);
  });

  it('fires through the real backfill gate and joins the review queue', async () => {
    seedUniverse(['SOLS']);
    const host = makeHost(async (path): Promise<ProviderResponse> => ({
      status: 200, body: path.includes('/splits') ? '{"results":[]}' : aggs(DORMANT_SHELL), requestedAt: 't', respondedAt: 't'
    }));
    const report = await runBackfillBars(host, { tradingDate: '2026-09-11' });
    expect(report.reviewQueue.filter((q) => q.checkId === 'QC-209')).toHaveLength(1);
    expect(report.reviewQueue.filter((q) => q.checkId === 'QC-205')).toHaveLength(0);
    expect(QC209_DORMANT_SERIES_RESUMES.thresholds['minGapSessions']).toBe(REGIME_WINDOW);
  });
});

describe('a one-shot job is dated to its session, not the calendar', () => {
  it('maps a weekend to the Friday before it', () => {
    // Run 9 of gen-001 started 01:35 on Saturday 2026-09-12 and recorded that date.
    expect(sessionOnOrBefore('2026-09-12')).toBe('2026-09-11');
    expect(sessionOnOrBefore('2026-09-13')).toBe('2026-09-11');
  });

  it('keeps a session as itself', () => {
    expect(sessionOnOrBefore('2026-09-14')).toBe('2026-09-14');
  });

  it('skips a rule holiday and an unscheduled closure', () => {
    expect(sessionOnOrBefore('2026-04-03')).toBe('2026-04-02'); // Good Friday
    expect(sessionOnOrBefore('2025-01-09')).toBe('2025-01-08'); // National Day of Mourning
  });
});

describe('QC-210 — bars that predate the ticker\'s current listing', () => {
  /**
   * The identity test, against QC-205's and QC-209's behavioural ones. Those ask
   * whether a splice LOOKS like one; this asks the reference data where the
   * listing began, so it catches a reuse whose two occupants happen to trade at
   * similar volume — which is most of them. Measured on gen-002 (2026-09-17):
   * QC-205 fired on 2 of the 11 tickers holding pre-listing bars, and 12 steps
   * sat in history belonging to a previous occupant with no check firing at all.
   */
  let refSeq = 0;
  function seedReference(
    rows: readonly { ticker: string; listDate: string | null; name?: string }[]
  ): void {
    const host = makeHost(async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }));
    const run = beginRun(db, host, { kind: 'manual', tradingDate: '2026-09-11' });
    const ruleId = captureRuleId(db, host, 'reference', { source: 'test' }, 'test');
    // A distinct response per call: two reference sweeps are two responses, and
    // the supersession test needs both to exist.
    const responseId = 9100 + refSeq++;
    raw.exec(
      "INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) " +
        `VALUES (${responseId}, ${run.runId}, 'polygon', '/ref', '{}', 't', 'a', 0, 'ref-hash-${responseId}', 0, 0, 'ok')`
    );
    for (const r of rows) {
      raw
        .prepare(
          `INSERT INTO raw_ticker_reference
             (run_id, as_of_date, observed_at, capture_rule_id, source_response_id, ticker, name,
              security_type, market_cap_status, shares_outstanding_status, list_date, active,
              optionable_status)
           VALUES (?, '2026-09-11', 't', ?, ?, ?, ?, 'CS', 'omitted', 'omitted', ?, 1, 'omitted')`
        )
        .run(run.runId, ruleId, responseId, r.ticker, r.name ?? `${r.ticker} Inc.`, r.listDate);
    }
  }

  /** Bars for one ticker on real sessions, starting at session `start`. */
  function seedBars(ticker: string, start: number, count: number): number {
    const host = makeHost(async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }));
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-11' });
    const ruleId = captureRuleId(db, host, 'bars', { k: ticker }, 'test');
    raw.exec(
      "INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) " +
        `VALUES (920${start}, ${run.runId}, 'polygon', '/aggs', '{}', 't', 'a', 0, 'bar-hash-${ticker}-${start}', 0, 0, 'ok')`
    );
    for (let k = 0; k < count; k++) {
      raw
        .prepare(
          `INSERT INTO raw_daily_bar
             (run_id, as_of_date, observed_at, capture_rule_id, source_response_id, ticker, trade_date,
              open, high, low, close, volume, adjusted_as_of, fetch_kind, is_final)
           VALUES (?, '2026-09-11', 't', ?, 920${start}, ?, ?, 10, 10, 10, 10, 1000, '2026-09-11', 'backfill', 1)`
        )
        .run(run.runId, ruleId, ticker, SESSIONS[start + k]);
    }
    return run.runId;
  }

  it('fires when the stored series starts before the listing did', () => {
    // SOLS: Solstice listed 2025-10-20 with 582 bars stored from 2021-12-31.
    const runId = seedBars('SOLS', 0, 40);
    seedReference([{ ticker: 'SOLS', listDate: SESSIONS[30]!, name: 'Solstice Advanced Materials' }]);

    const out = QC210_BARS_PREDATE_LISTING.run({ db, runId, tradingDate: '2026-09-11', observedAt: 't' });
    expect(out).toHaveLength(1);
    expect(out[0]!.fired).toBe(true);
    expect(out[0]!.value).toBe(30);
    expect(out[0]!.detail).toContain('Solstice');
    expect(out[0]!.evidence!['listDate']).toBe(SESSIONS[30]);
  });

  it('records a zero for a clean ticker rather than staying silent', () => {
    // The zeros ARE the base rate: 11 of 1,082 is only readable because the
    // 1,071 that are fine were evaluated too.
    const runId = seedBars('AAPL', 10, 20);
    seedReference([{ ticker: 'AAPL', listDate: SESSIONS[10]! }]);

    const out = QC210_BARS_PREDATE_LISTING.run({ db, runId, tradingDate: '2026-09-11', observedAt: 't' });
    expect(out).toHaveLength(1);
    expect(out[0]!.fired).toBe(false);
    expect(out[0]!.value).toBe(0);
  });

  it('does not evaluate a ticker whose listing is unknown — untestable is not a pass', () => {
    const runId = seedBars('MYST', 0, 20);
    seedReference([{ ticker: 'MYST', listDate: null }]);

    expect(QC210_BARS_PREDATE_LISTING.run({ db, runId, tradingDate: '2026-09-11', observedAt: 't' })).toEqual([]);
  });

  it('reads the LATEST reference row, so a corrected list_date supersedes', () => {
    const runId = seedBars('BAM', 0, 40);
    seedReference([{ ticker: 'BAM', listDate: SESSIONS[0]! }]);
    seedReference([{ ticker: 'BAM', listDate: SESSIONS[25]! }]);

    const out = QC210_BARS_PREDATE_LISTING.run({ db, runId, tradingDate: '2026-09-11', observedAt: 't' });
    expect(out).toHaveLength(1);
    expect(out[0]!.fired).toBe(true);
    expect(out[0]!.value).toBe(25);
  });

  it('is registered and blocking, with a structural threshold', () => {
    expect(BAR_CHECKS.map((c) => c.id)).toContain('QC-210');
    expect(QC210_BARS_PREDATE_LISTING.severity).toBe('blocking');
    expect(QC210_BARS_PREDATE_LISTING.thresholds['maxBarsBeforeListing']).toBe(0);
    // No automatic remediation: truncate-before-listing is an operator action,
    // and a relisting or redomicile may be continuous history.
    expect(QC210_BARS_PREDATE_LISTING.remediation).toBeUndefined();
  });
});

describe('a ruled ticker reuse ends the previous occupant\'s series', () => {
  /**
   * `recordTickerReuse` closes one membership range and opens another "so a
   * reader intersecting bars with membership sees one entity at a time" — and
   * until v1.1.261 there was no such reader. QC-204, QC-205, QC-209 and QC-210
   * all kept evaluating the previous occupant's bars, so a ruled reuse fired
   * again on the very next run and the operator's ruling lasted one run.
   *
   * Measured on gen-002: SOLS carried 21 QC-204 findings and JAN 7, of which 26
   * sit before the splice.
   */
  function seedMembership(ticker: string, args: { from: string; reason: string }): void {
    const host = makeHost(async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }));
    const run = beginRun(db, host, { kind: 'manual', tradingDate: '2026-09-11' });
    const ruleId = captureRuleId(db, host, 'membership', { t: ticker }, 'test');
    raw.exec(
      "INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) " +
        `VALUES (9300, ${run.runId}, 'polygon', '/m', '{}', 't', 'a', 0, 'mem-${ticker}', 0, 0, 'ok')`
    );
    raw
      .prepare(
        `INSERT INTO ref_universe_membership
           (run_id, as_of_date, observed_at, capture_rule_id, source_response_id, ticker, list_source,
            valid_from, valid_to, change_reason)
         VALUES (?, '2026-09-11', 't', ?, 9300, ?, 'russell1000', ?, NULL, ?)`
      )
      .run(run.runId, ruleId, ticker, args.from, args.reason);
  }

  /** The shell, then the listing: a step QC-204 and QC-205 both see. */
  function seedSplicedSeries(ticker: string): { runId: number; spliceDate: string } {
    const host = makeHost(async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }));
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-11' });
    const ruleId = captureRuleId(db, host, 'bars', { t: ticker }, 'test');
    raw.exec(
      "INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) " +
        `VALUES (9400, ${run.runId}, 'polygon', '/aggs', '{}', 't', 'a', 0, 'spl-${ticker}', 0, 0, 'ok')`
    );
    const legs = legDates(REUSE);
    for (const { date, leg } of legs) {
      raw
        .prepare(
          `INSERT INTO raw_daily_bar
             (run_id, as_of_date, observed_at, capture_rule_id, source_response_id, ticker, trade_date,
              open, high, low, close, volume, adjusted_as_of, fetch_kind, is_final)
           VALUES (?, '2026-09-11', 't', ?, 9400, ?, ?, ?, ?, ?, ?, ?, '2026-09-11', 'backfill', 1)`
        )
        .run(run.runId, ruleId, ticker, date, leg.close, leg.close, leg.close, leg.close, leg.volume);
    }
    return { runId: run.runId, spliceDate: legs[30]!.date };
  }

  it('QC-204 stops comparing across a ruled splice', () => {
    const { runId, spliceDate } = seedSplicedSeries('SOLS');
    const before = QC204_DISCONTINUITY.run({ db, runId, tradingDate: '2026-09-11', observedAt: 't' });
    expect(before.filter((e) => e.fired)).toHaveLength(1);

    seedMembership('SOLS', { from: spliceDate, reason: 'ticker_change' });

    const after = QC204_DISCONTINUITY.run({ db, runId, tradingDate: '2026-09-11', observedAt: 't' });
    expect(after.filter((e) => e.fired)).toHaveLength(0);
  });

  it('QC-205 stops reaching its before-window across a ruled splice', () => {
    const { runId, spliceDate } = seedSplicedSeries('SOLS');
    expect(QC205_VOLUME_REGIME.run({ db, runId, tradingDate: '2026-09-11', observedAt: 't' })).toHaveLength(1);

    seedMembership('SOLS', { from: spliceDate, reason: 'ticker_change' });

    expect(QC205_VOLUME_REGIME.run({ db, runId, tradingDate: '2026-09-11', observedAt: 't' })).toHaveLength(0);
  });

  /** A reference row with a list_date, local to this block. */
  function seedListing(ticker: string, listDate: string): void {
    const host = makeHost(async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }));
    const run = beginRun(db, host, { kind: 'manual', tradingDate: '2026-09-11' });
    const ruleId = captureRuleId(db, host, 'reference', { t: ticker }, 'test');
    raw.exec(
      "INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) " +
        `VALUES (9500, ${run.runId}, 'polygon', '/ref', '{}', 't', 'a', 0, 'lst-${ticker}', 0, 0, 'ok')`
    );
    raw
      .prepare(
        `INSERT INTO raw_ticker_reference
           (run_id, as_of_date, observed_at, capture_rule_id, source_response_id, ticker, name,
            security_type, market_cap_status, shares_outstanding_status, list_date, active, optionable_status)
         VALUES (?, '2026-09-11', 't', ?, 9500, ?, ?, 'CS', 'omitted', 'omitted', ?, 1, 'omitted')`
      )
      .run(run.runId, ruleId, ticker, `${ticker} Inc.`, listDate);
  }

  it('QC-210 leaves the population once the reuse is ruled', () => {
    const { runId, spliceDate } = seedSplicedSeries('SOLS');
    seedListing('SOLS', spliceDate);
    expect(
      QC210_BARS_PREDATE_LISTING.run({ db, runId, tradingDate: '2026-09-11', observedAt: 't' })
        .filter((e) => e.fired)
    ).toHaveLength(1);

    seedMembership('SOLS', { from: spliceDate, reason: 'ticker_change' });

    expect(QC210_BARS_PREDATE_LISTING.run({ db, runId, tradingDate: '2026-09-11', observedAt: 't' })).toEqual([]);
  });

  it('an ORDINARY membership row changes nothing — valid_from is when the ticker joined our list', () => {
    // The trap this narrow reading avoids: every ticker has a `valid_from` at
    // the universe seed, and intersecting bars with membership in general would
    // throw away every bar before it and gut all four checks.
    const { runId, spliceDate } = seedSplicedSeries('SOLS');
    seedMembership('SOLS', { from: spliceDate, reason: 'initial' });

    expect(entityStartDates(db).has('SOLS')).toBe(false);
    expect(QC204_DISCONTINUITY.run({ db, runId, tradingDate: '2026-09-11', observedAt: 't' }).filter((e) => e.fired))
      .toHaveLength(1);
  });
});
