import type { SqliteLike } from '../../db/sqlite-like.js';
import type { CollectorHost } from '../host.js';
import { throwIfCancelled } from '../host.js';
import { captureResponse } from '../capture.js';
import { recipes } from '../../ingest/recipes.js';
import { captureRuleId, type RunHandle } from '../run.js';
import { earningsResponseAtCap } from '../../ingest/events.js';
import { BLS_RELEASES, FOMC_CALENDAR_URL, blsScheduleUrl } from '../../ingest/macro-calendar.js';
import {
  parseDailyFormIndex, dailyFormIndexUrl, submissionsAtCap, reportFilingsInIndex, filingInstanceName
} from '../../ingest/edgar.js';
import { SEC_TICKER_MAP_URL } from '../../ingest/sec-ticker-map.js';
import { effectiveCikByTicker } from '../cik.js';
import { previousTradingDay, tradingDaysInRange } from '../trading-calendar.js';
import { sweepPolygonPages } from '../paged.js';
import { refusedSymbolAnswers, withRefusals } from '../symbol-rulings.js';
import { FUND_TYPES } from '../../qa/checks/earnings-fundamentals.js';
import {
  factsBatch, FACTS_PER_RUN, filingFactsQueue, FILING_FACTS_PER_RUN, FILING_INDEX_ENDPOINT,
  FILING_INSTANCE_ENDPOINT, COMPANYFACTS_ENDPOINT, isSecAnswer
} from '../facts-queue.js';
// The queue moved to collector/facts-queue.ts (v1.1.322); re-exported for existing callers.
export { factsQueue, factsBatch } from '../facts-queue.js';

/**
 * Phase 8 — the event and macro domains (04 §2).
 *
 * Eight domains across five transports, and the only phase whose sub-phases run
 * on **different cadences**: the treasury curve and the index quotes are daily,
 * recommendations and short interest are weekly, the macro calendar is monthly,
 * and the fact pull is triggered by a filing rather than by a clock.
 *
 * Every sub-phase is attempted independently, like the phases above it. A domain
 * that fails is a domain the gate reports on; it does not cost the other seven.
 *
 * **The cadence gate reads `meta_response`, not the domain table.** Asking "when
 * did we last write a recommendation row" cannot distinguish a call that was
 * never made from one that was made and returned nothing — and those want
 * opposite responses. Asking when the call was last *made* separates them.
 */

export const EVENTS_RULE = {
  earningsWindowDays: 90,
  earningsSliceDays: 30,
  recommendationCadenceDays: 7,
  shortInterestCadenceDays: 7,
  macroCalendarCadenceDays: 30,
  factsLookbackDays: 400
} as const;

/**
 * EDGAR requires a declared identity and rejects anonymous automation — but the
 * `User-Agent` is deliberately **not** set here.
 *
 * `core` does not know who is running it, and the host already sends a
 * descriptive agent on every `httpGet`. Hard-coding one in the library would
 * both duplicate that and put a contact address in a checked-in source file,
 * where it would travel with the code to whoever built it next. Identity is an
 * environment fact, which is precisely what `CollectorHost` exists to carry.
 *
 * EDGAR's fair-access policy asks for a contact address in the agent string;
 * supplying one is a host-side setting, recorded in 04 §11.
 */
const EDGAR_HEADERS: Readonly<Record<string, string>> = {
  'Accept-Encoding': 'gzip, deflate'
};

const REPORT_FORMS: ReadonlySet<string> = new Set(['10-K', '10-Q', '20-F', '40-F']);

export interface SubPhaseCount {
  readonly stored: number;
  readonly calls: number;
  readonly failed: number;
  readonly skipped?: string;
}

/** How one phase-8 sub-phase ended, as `meta_run_phase` records it. */
export interface SubPhaseOutcome {
  readonly status: 'ok' | 'failed' | 'cancelled';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly error?: string;
}

export interface EventsPhaseResult {
  readonly earnings: SubPhaseCount;
  readonly etradeEarnings: SubPhaseCount;
  readonly indexQuotes: SubPhaseCount;
  readonly treasury: SubPhaseCount;
  readonly macroCalendar: SubPhaseCount;
  readonly secTickerMap: SubPhaseCount;
  readonly filings: SubPhaseCount;
  readonly facts: SubPhaseCount;
  readonly shortInterest: SubPhaseCount;
  readonly recommendations: SubPhaseCount;
  readonly insider: SubPhaseCount;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Days since this endpoint was last called at all, or null if it never was. */
function daysSinceLastCall(db: SqliteLike, endpointLike: string, tradingDate: string): number | null {
  const row = db
    .prepare(
      `SELECT MAX(substr(requested_at, 1, 10)) AS last_date
         FROM meta_response
        WHERE endpoint LIKE ? AND http_status = 200`
    )
    .get(endpointLike) as { last_date: string | null } | undefined;

  const last = row?.last_date;
  if (!last) return null;
  return Math.round((Date.parse(`${tradingDate}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000);
}

function dueForCadence(
  db: SqliteLike,
  endpointLike: string,
  tradingDate: string,
  cadenceDays: number
): boolean {
  const since = daysSinceLastCall(db, endpointLike, tradingDate);
  return since === null || since >= cadenceDays;
}

function activeMembers(db: SqliteLike): readonly string[] {
  return (
    db
      .prepare('SELECT DISTINCT ticker FROM ref_universe_membership WHERE valid_to IS NULL ORDER BY ticker')
      .all() as { ticker: string }[]
  ).map((r) => r.ticker);
}

function subsetMembers(db: SqliteLike): readonly string[] {
  return (
    db
      .prepare(
        'SELECT DISTINCT ticker FROM ref_chain_subset_membership WHERE valid_to IS NULL ORDER BY ticker'
      )
      .all() as { ticker: string }[]
  ).map((r) => r.ticker);
}

/**
 * The effective CIK per active ticker — SEC's map first, Polygon's otherwise (v1.1.331,
 * `collector/cik.ts`) — the join EDGAR needs in both directions.
 */
function cikMap(db: SqliteLike): { byTicker: Map<string, string>; byCik: Map<string, string> } {
  const byTicker = effectiveCikByTicker(db);
  const byCik = new Map<string, string>();
  for (const [ticker, cik] of byTicker) {
    // A CIK can carry several tickers (share classes). First in ticker order wins — good
    // enough for attributing a Form 4, and not good enough to be the only record, which is
    // why the filing keeps its own CIK.
    if (!byCik.has(cik)) byCik.set(cik, ticker);
  }
  return { byTicker, byCik };
}

/**
 * SEC's ticker → CIK map, weekly (v1.1.331). One call to a ~1 MB file, filtered to the universe at
 * ingestion. It runs before every EDGAR sub-phase so a corrected CIK is used the same night.
 */
export const SEC_TICKER_MAP_CADENCE_DAYS = 7;

export async function runSecTickerMap(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly force?: boolean } = {}
): Promise<SubPhaseCount> {
  if (!opts.force && !dueForCadence(db, '%company_tickers%', run.tradingDate, SEC_TICKER_MAP_CADENCE_DAYS)) {
    return skipped(`not due — cadence is ${SEC_TICKER_MAP_CADENCE_DAYS} days`);
  }
  const universe = new Set(activeMembers(db));
  if (universe.size === 0) return skipped('no active universe members');
  const ruleId = captureRuleId(
    db, host, 'sec_ticker_map', { cadenceDays: SEC_TICKER_MAP_CADENCE_DAYS, filter: 'universe' },
    "SEC's company_tickers.json, the CIK every EDGAR lookup prefers."
  );
  host.progress('sec-ticker-map', 0, 1, 'company_tickers.json');
  const response = await host.httpGet(SEC_TICKER_MAP_URL, EDGAR_HEADERS);
  const result = captureResponse({
    host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'edgar',
    endpoint: '/files/company_tickers.json', slug: 'sec-company-tickers', params: {}, response,
    captureRuleId: ruleId, recipe: recipes.secTickerMap({ universe })
  });
  return { stored: result.rowsWritten, calls: 1, failed: result.parseStatus === 'ok' ? 0 : 1 };
}

const EMPTY: SubPhaseCount = { stored: 0, calls: 0, failed: 0 };

function skipped(reason: string): SubPhaseCount {
  return { stored: 0, calls: 0, failed: 0, skipped: reason };
}

/**
 * Earnings — a **sweep that subdivides when it hits the cap** (P8).
 *
 * Finnhub's bulk calendar returns at most 1,500 entries and **drops the earliest
 * dates**, so during earnings season a 90-day request comes back holding only
 * the last two weeks of it. The existing app trusted such a payload and stored
 * NVDA's August report as November — a quarter late — which silently suppressed
 * all three mechanisms that would have corrected it, and put NVDA at wheel #1 on
 * the day it printed.
 *
 * So a response *at* the cap is treated as evidence of truncation, and the slice
 * is halved and re-requested. A fixed slice size is not enough: peak season
 * needs windows as narrow as five days, and which weeks those are is not
 * knowable in advance.
 */
export async function runEarningsSweep(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly windowDays?: number; readonly sliceDays?: number } = {}
): Promise<SubPhaseCount> {
  const ruleId = captureRuleId(db, host, 'earnings', EVENTS_RULE, 'Earnings calendar sweep, subdividing on the provider cap.');
  const universe = new Set(activeMembers(db));
  const windowDays = opts.windowDays ?? EVENTS_RULE.earningsWindowDays;
  const sliceDays = opts.sliceDays ?? EVENTS_RULE.earningsSliceDays;

  let stored = 0;
  let calls = 0;
  let failed = 0;

  // A queue rather than a loop, so a slice that comes back capped can push its
  // two halves back on and be re-swept at a finer grain.
  const queue: { from: string; to: string }[] = [];
  for (let offset = 0; offset < windowDays; offset += sliceDays) {
    queue.push({
      from: addDays(run.tradingDate, offset),
      to: addDays(run.tradingDate, Math.min(offset + sliceDays - 1, windowDays - 1))
    });
  }

  while (queue.length > 0) {
    throwIfCancelled(host, 'phase-8-earnings');
    const slice = queue.shift() as { from: string; to: string };
    host.progress('earnings', calls, calls + queue.length + 1, `${slice.from}..${slice.to}`);

    const path = '/calendar/earnings';
    const response = await host.httpGet(
      `https://finnhub.io/api/v1${path}?from=${slice.from}&to=${slice.to}`
    );
    calls++;

    const atCap = response.body ? earningsResponseAtCap(response.body) : false;
    const result = captureResponse({
      host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'finnhub',
      endpoint: path, slug: 'calendar-earnings',
      params: { from: slice.from, to: slice.to }, response, captureRuleId: ruleId,
      atProviderCap: atCap,
      recipe: recipes.earnings({ sweepFrom: slice.from, sweepTo: slice.to, universe })
    });

    if (result.parseStatus === 'ok') stored += result.rowsWritten;
    else failed++;

    // A single-day slice cannot be subdivided further. Its rows are kept and the
    // cap is left recorded on the response row, which is the honest outcome: we
    // know the answer is incomplete and we can say so, rather than believing it.
    const span = Math.round(
      (Date.parse(`${slice.to}T00:00:00Z`) - Date.parse(`${slice.from}T00:00:00Z`)) / 86_400_000
    );
    if (atCap && span >= 1) {
      const mid = addDays(slice.from, Math.floor(span / 2));
      queue.push({ from: slice.from, to: mid }, { from: addDays(mid, 1), to: slice.to });
    }
  }

  return { stored, calls, failed };
}

/** The most gap tickers asked per run, so a failed Finnhub sweep cannot become ~500 calls. */
export const ETRADE_EARNINGS_GAP_CAP = 60;
/** Tickers Finnhub DOES cover, asked too, so QC-602 has pairs to compare. Rotates by staleness. */
export const ETRADE_EARNINGS_OVERLAP_SAMPLE = 10;

/**
 * E*Trade earnings dates — the collector's second earnings source (v1.1.270).
 *
 * One quote call per chain-subset stock that this run's Finnhub sweep gave **no** future date
 * (on 2026-09-18: SWKS, IOT, ROIV, JHX, GOOG, BRK.B, a class of new listings — 17 QC-603
 * findings, every one a Finnhub coverage gap, not a truncation), plus a small rotating sample of
 * tickers Finnhub did cover. Without the sample the two sources would never overlap by
 * construction, and QC-602 would compare zero pairs every night — the vacuous pass it was
 * rewritten to refuse.
 *
 * Runs after the sweep because the gap is the sweep's answer. Funds are skipped: no earnings.
 */
export async function runEtradeEarnings(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle
): Promise<SubPhaseCount> {
  const ruleId = captureRuleId(
    db, host, 'earnings_etrade',
    { gapCap: ETRADE_EARNINGS_GAP_CAP, overlapSample: ETRADE_EARNINGS_OVERLAP_SAMPLE },
    'E*Trade next earnings date for subset stocks the Finnhub sweep did not date, plus a rotating overlap sample.'
  );

  const eligible = `
    SELECT m.ticker,
           EXISTS (SELECT 1 FROM raw_earnings_event e
                    WHERE e.ticker = m.ticker AND e.source = 'finnhub'
                      AND e.run_id = ? AND e.report_date >= ?) AS finnhub_dated,
           (SELECT MAX(e.observed_at) FROM raw_earnings_event e
             WHERE e.ticker = m.ticker AND e.source = 'etrade') AS etrade_last
      FROM (SELECT DISTINCT ticker FROM ref_chain_subset_membership WHERE valid_to IS NULL) m
     WHERE m.ticker NOT IN (
       SELECT ticker FROM raw_ticker_reference
        WHERE security_type IN ${FUND_TYPES}
          AND row_id IN (SELECT MAX(row_id) FROM raw_ticker_reference GROUP BY ticker))`;
  const rows = db.prepare(eligible).all(run.runId, run.tradingDate) as {
    ticker: string; finnhub_dated: number; etrade_last: string | null;
  }[];

  const gaps = rows.filter((r) => r.finnhub_dated === 0).map((r) => r.ticker).sort().slice(0, ETRADE_EARNINGS_GAP_CAP);
  // Never-asked first, then the longest since last asked: the sample walks the whole
  // covered set over the weeks instead of re-asking the same ten names.
  const overlap = rows
    .filter((r) => r.finnhub_dated === 1)
    .sort((a, b) =>
      a.etrade_last === b.etrade_last
        ? a.ticker.localeCompare(b.ticker)
        : a.etrade_last === null ? -1 : b.etrade_last === null ? 1 : a.etrade_last.localeCompare(b.etrade_last))
    .slice(0, ETRADE_EARNINGS_OVERLAP_SAMPLE)
    .map((r) => r.ticker);
  const tickers = [...gaps, ...overlap];
  if (tickers.length === 0) return skipped('every subset stock has a Finnhub date and the overlap sample is empty');

  let stored = 0;
  let calls = 0;
  let failed = 0;
  for (const [i, ticker] of tickers.entries()) {
    throwIfCancelled(host, 'phase-8-earnings-etrade');
    host.progress('earnings-etrade', i, tickers.length, ticker);

    const path = `/v1/market/quote/${ticker}`;
    const params = { detailFlag: 'ALL', requireEarningsDate: 'true' };
    const response = await host.etradeGet(path, params);
    calls++;

    const result = captureResponse({
      host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'etrade',
      endpoint: '/v1/market/quote/{symbol}', slug: 'quote-earnings',
      params: { symbol: ticker, ...params }, response, captureRuleId: ruleId,
      recipe: recipes.etradeEarnings({ ticker })
    });
    if (result.parseStatus === 'ok') stored += result.rowsWritten;
    else failed++;
  }
  return { stored, calls, failed };
}

/** Index quotes — one E*Trade call per enabled series in `ref_macro_series`. */
export async function runIndexQuotes(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle
): Promise<SubPhaseCount> {
  const ruleId = captureRuleId(db, host, 'index_quotes', { source: 'etrade' }, 'One quote per enabled macro series.');
  const series = (
    db.prepare('SELECT symbol FROM ref_macro_series WHERE enabled = 1 ORDER BY symbol').all() as {
      symbol: string;
    }[]
  ).map((r) => r.symbol);

  if (series.length === 0) return skipped('no enabled series in ref_macro_series');

  let stored = 0;
  let calls = 0;
  let failed = 0;

  for (const [i, symbol] of series.entries()) {
    throwIfCancelled(host, 'phase-8-index-quotes');
    host.progress('index-quotes', i, series.length, symbol);

    const path = `/v1/market/quote/${symbol}`;
    const response = await host.etradeGet(path, {});
    calls++;

    const result = captureResponse({
      host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'etrade',
      endpoint: path, slug: 'index-quote', params: { symbol }, response, captureRuleId: ruleId,
      recipe: recipes.indexQuote({ symbol })
    });

    if (result.parseStatus === 'ok') stored += result.rowsWritten;
    else failed++;
  }

  return { stored, calls, failed };
}

/**
 * The treasury par yield curve — **one call returns the whole year**.
 *
 * Which is why the daily pull is naturally idempotent and a backfill is the
 * identical call: there is no separate history endpoint to get wrong.
 */
export async function runTreasuryYields(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle
): Promise<SubPhaseCount> {
  const ruleId = captureRuleId(db, host, 'treasury', { source: 'treasury' }, 'Daily par yield curve, whole year per call.');
  const year = run.tradingDate.slice(0, 4);
  const url =
    'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/' +
    `daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve` +
    `&field_tdr_date_value=${year}&page&_format=csv`;

  host.progress('treasury', 0, 1, year);
  const response = await host.httpGet(url);

  const result = captureResponse({
    host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'treasury',
    endpoint: '/daily-treasury-rates.csv', slug: 'treasury-yields',
    params: { year }, response, captureRuleId: ruleId,
    recipe: recipes.treasury()
  });

  return { stored: result.rowsWritten, calls: 1, failed: result.parseStatus === 'ok' ? 0 : 1 };
}

/**
 * The macro calendar — monthly, and the only sub-phase reading **HTML pages**.
 *
 * Four calls: the FOMC meeting calendar and one BLS schedule per release. Both
 * shapes were read live before the parsers were written (see
 * `ingest/macro-calendar.ts` for what that turned up).
 */
export async function runMacroCalendar(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly force?: boolean } = {}
): Promise<SubPhaseCount> {
  if (!opts.force && !dueForCadence(db, '%fomccalendars%', run.tradingDate, EVENTS_RULE.macroCalendarCadenceDays)) {
    return skipped(`not due — cadence is ${EVENTS_RULE.macroCalendarCadenceDays} days`);
  }

  const ruleId = captureRuleId(db, host, 'macro_calendar', { cadenceDays: EVENTS_RULE.macroCalendarCadenceDays }, 'FOMC and BLS release schedules, monthly.');
  let stored = 0;
  let calls = 0;
  let failed = 0;

  host.progress('macro-calendar', 0, 1 + BLS_RELEASES.length, 'FOMC');
  const fomc = await host.httpGet(FOMC_CALENDAR_URL);
  calls++;
  const fomcResult = captureResponse({
    host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'fred',
    endpoint: FOMC_CALENDAR_URL, slug: 'fomc-calendar', params: {}, response: fomc,
    captureRuleId: ruleId, recipe: recipes.fomc()
  });
  if (fomcResult.parseStatus === 'ok') stored += fomcResult.rowsWritten;
  else failed++;

  for (const [i, release] of BLS_RELEASES.entries()) {
    throwIfCancelled(host, 'phase-8-macro-calendar');
    host.progress('macro-calendar', i + 1, 1 + BLS_RELEASES.length, release.type);

    const url = blsScheduleUrl(release.slug);
    const response = await host.httpGet(url);
    calls++;

    const result = captureResponse({
      host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'fred',
      endpoint: url, slug: `bls-${release.slug}`, params: { release: release.slug },
      response, captureRuleId: ruleId, recipe: recipes.bls(release)
    });

    if (result.parseStatus === 'ok') stored += result.rowsWritten;
    else failed++;
  }

  return { stored, calls, failed };
}

/**
 * EDGAR submissions for filers whose reference row changed, plus a rolling
 * heartbeat slice so a filer that never changes is still checked.
 */
/**
 * How far back the filings sweep stores report filings — deliberately INSIDE the year EDGAR
 * guarantees in `filings.recent` (v1.1.275).
 *
 * EDGAR's `recent` block holds "at least one year of filings or 1,000, whichever is more": JPM's
 * held 26,192 on 2026-09-15, oldest exactly one year back. The sweep asked for the 400-day facts
 * lookback, so for every filer with 1,000+ filings a year, the 35 days past EDGAR's year sat in
 * overflow files and QC-008 read the response as truncated: iShares Trust, JEF, JPM. Nothing
 * here needs a report filing older than a year — the fact pull reads companyfacts whole and
 * keeps its own 400-day window — so the fix is to ask for what `recent` always contains.
 */
export const FILINGS_LOOKBACK_DAYS = 360;

/**
 * The universe's report filers, one entry per CIK: `[ticker, cik]`, ticker order, funds excluded.
 *
 * Funds file no 10-K/10-Q, so their submissions can only ever store nothing — and a trust's
 * thousands of fund filings made every one of them read as capped (v1.1.275). One filer per CIK:
 * iShares Trust stands behind seven universe tickers and was fetched six times in one run. A CIK
 * with several share classes is filed under its alphabetically first ticker, by both the
 * submissions sweep and the daily index, so the two never disagree about a filing's ticker.
 */
export function reportFilers(db: SqliteLike): readonly (readonly [string, string])[] {
  const { byTicker } = cikMap(db);
  const funds = new Set(
    (
      db
        .prepare(
          `SELECT ticker FROM raw_ticker_reference
            WHERE security_type IN ${FUND_TYPES}
              AND row_id IN (SELECT MAX(row_id) FROM raw_ticker_reference GROUP BY ticker)`
        )
        .all() as { ticker: string }[]
    ).map((r) => r.ticker)
  );
  const seenCik = new Set<string>();
  return [...byTicker.entries()]
    .filter(([ticker]) => !funds.has(ticker))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .filter(([, cik]) => (seenCik.has(cik) ? false : (seenCik.add(cik), true)));
}

/**
 * The filers the submissions sweep asks this run: the ones asked longest ago, never-asked first
 * (v1.1.325).
 *
 * The daily form index is now what finds new report filings (see `runInsiderSweep`); this sweep
 * is the backstop that reads each filer's own list, which also carries the period and primary
 * document the index lacks. It used to be a slice at `(day × 20) mod filers`, and that had two
 * faults measured on gen-002: the day was a CALENDAR day while the collector runs on trading
 * days, so every weekend's two slices were never asked; and any change in the filer count moved
 * the pointer — v1.1.275's fund exclusion (1,083 → 1,012) sent it back from L to H, so
 * 2026-09-23..25 re-asked filers already read nine days earlier and stored 20, 0 and 1 filings
 * while 877 filers had never been asked at all. Ordering by the last ask, read from
 * `meta_response`, has no pointer to move: it cannot skip a filer, and a second run on one date
 * asks the next twenty instead of the same ones.
 */
export function submissionsSlice(
  db: SqliteLike,
  filers: readonly (readonly [string, string])[],
  maxFilers: number
): readonly (readonly [string, string])[] {
  const lastAsked = new Map<string, number>();
  for (const r of db
    .prepare(
      `SELECT json_extract(params_json, '$.cik') AS cik, requested_at FROM meta_response
        WHERE endpoint = '/submissions/CIK{cik}.json' AND parse_status = 'ok'`
    )
    .all() as { cik: string; requested_at: string }[]) {
    const t = Date.parse(r.requested_at);
    if (!Number.isNaN(t) && t > (lastAsked.get(r.cik) ?? -Infinity)) lastAsked.set(r.cik, t);
  }
  // A stable sort keeps ticker order among equals, so never-asked filers go alphabetically.
  return [...filers]
    .sort((a, b) => (lastAsked.get(a[1]) ?? -Infinity) - (lastAsked.get(b[1]) ?? -Infinity))
    .slice(0, maxFilers);
}

export async function runEdgarFilings(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly maxFilers?: number } = {}
): Promise<SubPhaseCount> {
  const ruleId = captureRuleId(
    db, host, 'edgar_filings',
    { forms: [...REPORT_FORMS], lookbackDays: FILINGS_LOOKBACK_DAYS, funds: 'excluded', order: 'least_recently_asked' },
    'Submissions index for the operating-company filers asked longest ago.'
  );
  const filers = reportFilers(db);
  if (filers.length === 0) return skipped('no CIKs known yet — raw_ticker_reference has none');
  const slice = submissionsSlice(db, filers, opts.maxFilers ?? 20);

  const since = addDays(run.tradingDate, -FILINGS_LOOKBACK_DAYS);
  // What is already stored for this CIK, so a re-pull skips it instead of
  // throwing. `raw_edgar_filing` is UNIQUE on `accession_no` alone, and the
  // transaction is the whole response — so one already-seen filing discards
  // every NEW filing beside it and reports as a parse failure. HSY on
  // 2026-09-22, stored at 17:05 and re-asked at 20:47; and since v1.1.325 the
  // daily index stores most report filings before this sweep reaches the filer.
  const storedAccessions = db.prepare(
    'SELECT accession_no FROM raw_edgar_filing WHERE cik = ?'
  );
  let stored = 0;
  let calls = 0;
  let failed = 0;

  for (const [i, [ticker, cik]] of slice.entries()) {
    throwIfCancelled(host, 'phase-8-edgar-filings');
    host.progress('edgar-filings', i, slice.length, ticker);

    const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
    const response = await host.httpGet(url, EDGAR_HEADERS);
    calls++;

    const result = captureResponse({
      host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'edgar',
      endpoint: `/submissions/CIK{cik}.json`, slug: 'edgar-submissions',
      params: { cik, ticker }, response, captureRuleId: ruleId,
      atProviderCap: response.body ? submissionsAtCap(response.body, since) : false,
      recipe: recipes.submissions({
        cik, ticker, since, forms: REPORT_FORMS,
        knownAccessions: new Set((storedAccessions.all(cik) as { accession_no: string }[]).map((r) => r.accession_no))
      })
    });

    if (result.parseStatus === 'ok') stored += result.rowsWritten;
    else failed++;
  }

  return { stored, calls, failed };
}

/**
 * XBRL facts, pulled for filers whose newest stored report filing has no facts
 * yet — filing-triggered rather than clock-triggered, so a quiet quarter costs
 * nothing. Which filers, and how many, is `factsBatch` in collector/facts-queue.ts (v1.1.322).
 */
export async function runEdgarFacts(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly maxFilers?: number } = {}
): Promise<SubPhaseCount> {
  const ruleId = captureRuleId(db, host, 'edgar_facts', { trigger: 'new_report_filing' }, 'Company facts (history, and the QC-705 cross-check) for filers with a report filing companyfacts has not yet delivered.');

  // Retries get reserved slots so a backlog of new filings cannot starve them (v1.1.322).
  const pending = factsBatch(db, run.tradingDate, opts.maxFilers ?? FACTS_PER_RUN);
  if (pending.length === 0) return skipped('no filing without harvested facts due for a fetch');

  const since = addDays(run.tradingDate, -EVENTS_RULE.factsLookbackDays);
  let stored = 0;
  let calls = 0;
  let failed = 0;

  for (const [i, { cik }] of pending.entries()) {
    throwIfCancelled(host, 'phase-8-edgar-facts');
    host.progress('edgar-facts', i, pending.length, cik);

    const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
    const response = await host.httpGet(url, EDGAR_HEADERS);
    calls++;

    const result = captureResponse({
      host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'edgar',
      endpoint: COMPANYFACTS_ENDPOINT, slug: 'edgar-companyfacts',
      params: { cik }, response, captureRuleId: ruleId,
      recipe: recipes.companyFacts({ cik, since })
    });

    if (result.parseStatus === 'ok') stored += result.rowsWritten;
    else failed++;
  }

  return { stored, calls, failed };
}

/**
 * XBRL facts read from a report filing's OWN instance — the PRIMARY source for every new report
 * filing since v1.1.365 (v1.1.360 read it only for filings SEC's companyfacts had omitted for two
 * weeks). `filingFactsQueue` decides which. Runs BEFORE `runEdgarFacts`, the day the filing appears
 * in the daily form index.
 *
 * Two requests per filing: the directory listing, to find the instance by name, then the instance.
 * Both are captured, so an attempt that found no instance is on record and waits the weekly retry
 * cadence instead of being asked every night. A non-2xx counts as a failure, and so does an
 * instance that does not parse; a filing without XBRL does not, since that is an answer.
 */
export async function runEdgarFilingFacts(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly maxFilings?: number } = {}
): Promise<SubPhaseCount> {
  const ruleId = captureRuleId(
    db, host, 'edgar_filing_facts',
    { trigger: 'new_report_filing', primary: true },
    "XBRL facts from a report filing's own instance — the primary source for a new report filing."
  );
  const pending = filingFactsQueue(db, run.tradingDate).slice(0, opts.maxFilings ?? FILING_FACTS_PER_RUN);
  if (pending.length === 0) return skipped('no report filing omitted by companyfacts is due');

  let stored = 0;
  let calls = 0;
  let failed = 0;

  for (const [i, f] of pending.entries()) {
    throwIfCancelled(host, 'phase-8-edgar-filing-facts');
    host.progress('edgar-filing-facts', i, pending.length, f.ticker);

    // The archive path takes the CIK without its zero padding and the accession without dashes.
    const base = `https://www.sec.gov/Archives/edgar/data/${String(Number(f.cik))}/${f.accessionNo.replace(/-/g, '')}/`;
    const index = await host.httpGet(`${base}index.json`, EDGAR_HEADERS);
    calls++;
    const indexResult = captureResponse({
      host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'edgar',
      endpoint: FILING_INDEX_ENDPOINT, slug: 'edgar-filing-index',
      params: { cik: f.cik, accession: f.accessionNo }, response: index, captureRuleId: ruleId
    });
    if (indexResult.parseStatus !== 'ok') {
      failed++;
      continue;
    }

    let instance: string | null;
    try {
      instance = filingInstanceName(index.body);
    } catch {
      failed++; // a 200 that is not the JSON listing
      continue;
    }
    if (instance === null) continue;

    const response = await host.httpGet(`${base}${instance}`, EDGAR_HEADERS);
    calls++;
    const result = captureResponse({
      host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'edgar',
      endpoint: FILING_INSTANCE_ENDPOINT, slug: 'edgar-filing-instance',
      params: { cik: f.cik, accession: f.accessionNo, instance }, response, captureRuleId: ruleId,
      recipe: recipes.filingFacts({ cik: f.cik, accessionNo: f.accessionNo, form: f.form, filedDate: f.filed })
    });
    if (result.parseStatus === 'ok') stored += result.rowsWritten;
    else failed++;
  }

  return { stored, calls, failed };
}

/** Two sub-phases reported as one domain: calls, rows and failures add; skipped only if both were. */
function combined(a: SubPhaseCount, b: SubPhaseCount): SubPhaseCount {
  const skippedBoth = a.skipped !== undefined && b.skipped !== undefined;
  return {
    stored: a.stored + b.stored,
    calls: a.calls + b.calls,
    failed: a.failed + b.failed,
    ...(skippedBoth ? { skipped: `${a.skipped as string}; ${b.skipped as string}` } : {})
  };
}

/**
 * Short interest — weekly, one whole-market sweep from Polygon.
 *
 * Verified live on 2026-09-14: the first daily run after the endpoint fix stored
 * 67,386 rows with a newest settlement date of 2026-09-14. There is no
 * chain-subset skip here: the sweep asks for every ticker FINRA publishes, so
 * an empty subset (a fresh generation before 20 bars exist) is no reason to
 * leave the domain empty.
 */
export async function runShortInterest(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly force?: boolean } = {}
): Promise<SubPhaseCount> {
  if (!opts.force && !dueForCadence(db, '%short-interest%', run.tradingDate, EVENTS_RULE.shortInterestCadenceDays)) {
    return skipped(`not due — cadence is ${EVENTS_RULE.shortInterestCadenceDays} days`);
  }

  const ruleId = captureRuleId(db, host, 'short_interest', { cadenceDays: EVENTS_RULE.shortInterestCadenceDays }, 'Short interest, whole-market sweep, weekly.');

  // `/stocks/v1/...`, not `vX`. The placeholder shipped unreplaced and Polygon
  // answers it with an 18-byte "404 page not found" — which was then read as
  // "short interest is not on our plan" and written into the spec as the one
  // §12 domain with no confirmed free source. Polygon documents this endpoint as
  // included in every Stocks plan, with fields matching this table exactly.
  const path = '/stocks/v1/short-interest';
  let stored = 0;
  let calls = 0;
  let failed = 0;

  // Requested by settlement date rather than per ticker: FINRA publishes the
  // whole market twice a month, so one windowed sweep answers for everyone.
  //
  // Paged, and the page size deliberately left at the endpoint's own scale. This
  // is a WHOLE-MARKET sweep — every ticker FINRA publishes, across the ~3
  // settlement dates in a 45-day window — so it is the largest list this collector
  // asks for, and the one where a cap would be least visible. 50,000 very probably
  // does not bind; it was also very probably true that EDGAR's 1,000-filing cap
  // and Finnhub's 1,500-row calendar did not bind, right up until they did. A cap
  // that is harmless today is still a cap, so the paging and the cap flag stay.
  const since = addDays(run.tradingDate, -45);
  host.progress('short-interest', 0, 1, 'sweep');
  await sweepPolygonPages(host, {
    path,
    params: { 'settlement_date.gte': since, limit: '50000' },
    onPage: (page) => {
      calls++;
      const result = captureResponse({
        host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'polygon',
        endpoint: path, slug: 'short-interest',
        params: { since, page: String(page.index + 1) },
        response: page.response, captureRuleId: ruleId,
        atProviderCap: page.atProviderCap,
        recipe: recipes.shortInterest()
      });
      if (result.parseStatus === 'ok') stored += result.rowsWritten;
      else failed++;
    }
  });

  return { stored, calls, failed };
}

/** Analyst recommendations — weekly, one call per chain-subset ticker. */
export async function runRecommendations(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly force?: boolean } = {}
): Promise<SubPhaseCount> {
  if (!opts.force && !dueForCadence(db, '%/stock/recommendation%', run.tradingDate, EVENTS_RULE.recommendationCadenceDays)) {
    return skipped(`not due — cadence is ${EVENTS_RULE.recommendationCadenceDays} days`);
  }

  const ruleId = captureRuleId(db, host, 'recommendations', { cadenceDays: EVENTS_RULE.recommendationCadenceDays }, 'Recommendation trend for the chain subset, weekly.');
  const tickers = subsetMembers(db);
  if (tickers.length === 0) return skipped('chain subset is empty');

  // Read once for the phase, not once per ticker: the table holds a handful of
  // operator rulings and a query per ticker would be a query per ticker.
  const refusals = refusedSymbolAnswers(db);

  let stored = 0;
  let calls = 0;
  let failed = 0;

  for (const [i, ticker] of tickers.entries()) {
    throwIfCancelled(host, 'phase-8-recommendations');
    host.progress('recommendations', i, tickers.length, ticker);

    const path = '/stock/recommendation';
    const response = await host.httpGet(`https://finnhub.io/api/v1${path}?symbol=${ticker}`);
    calls++;

    const result = captureResponse({
      host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'finnhub',
      endpoint: path, slug: 'recommendation', params: { symbol: ticker },
      response, captureRuleId: ruleId,
      recipe: recipes.recommendations({ ticker, ...withRefusals(refusals, ticker) })
    });

    if (result.parseStatus === 'ok') stored += result.rowsWritten;
    else failed++;
  }

  return { stored, calls, failed };
}

/**
 * Insider transactions — **one full-index sweep**, then a Form 4 fetch per
 * universe filing.
 *
 * The sweep is what makes this cheap: EDGAR publishes every filing of the day in
 * one file, so the universe filter runs locally and only the handful of Form 4s
 * that actually concern us are fetched. Polling ~300 tickers to learn that
 * nothing was filed is the shape of waste the corporate-actions sweep avoids the
 * same way.
 */
export async function runInsiderSweep(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly maxFilings?: number } = {}
): Promise<SubPhaseCount & { readonly indexed: number; readonly reportFilings: number }> {
  const ruleId = captureRuleId(
    db, host, 'insider',
    { source: 'edgar_full_index', reportForms: [...REPORT_FORMS] },
    'Daily sweep of the EDGAR full index: Form 4s fetched, and the universe\'s report filings stored from the index itself.'
  );
  const { byCik } = cikMap(db);
  const filerTicker = new Map(reportFilers(db).map(([ticker, cik]) => [cik, ticker] as const));
  const storedAccession = db.prepare('SELECT 1 FROM raw_edgar_filing WHERE accession_no = ?');

  // **The day's index is published after the collector runs.** EDGAR posts
  // `form.YYYYMMDD.idx` late in the evening, and the 17:05 slot (in practice
  // 18:05-19:33, behind the after-close chain) asks for it hours early: the
  // 2026-09-10 and 2026-09-11 runs both got 404 on a URL that serves correctly
  // later the same night. Asking only for today's index made this phase
  // structurally incapable of ever storing a row — `events_insider` sat at 0 and
  // looked exactly like a day nobody filed a Form 4.
  //
  // So: today's index when it exists, otherwise the previous trading day's. A
  // one-day-late insider sweep is the honest maximum for an evening run, and the
  // date actually used is recorded in `params` rather than assumed to be
  // `run.tradingDate` — which is the difference between a late row and a wrong one.
  //
  // **And every session since the last index that parsed, not just yesterday's
  // (v1.1.268).** Unpublished answered 404 on 2026-09-10/11, a 215-byte AccessDenied
  // 403 on 2026-09-14..16, and HTTP 503 on 2026-09-18 — which the 404/403-only
  // fallback did not recognise, so that run stored nothing and 09-17's filings
  // could never be asked for again: the next run falls back to 09-18. Sweeping
  // from the last parsed index forward makes a missed day a late day instead of
  // a lost one, and a re-run of the same evening asks for nothing it already has.
  const dates = insiderIndexDates(db, run.tradingDate);

  let stored = 0;
  let calls = 0;
  let failed = 0;
  let indexed = 0;
  let reportFilings = 0;
  // Was 100 until v1.1.369: an index listing more universe Form 4s than that lost the rest with no
  // record (2026-10-14's listed 102). At the shared 8/s sec.gov pace 1,000 is about two minutes.
  const limit = opts.maxFilings ?? INSIDER_FORM4_LIMIT;

  const fetchForm4 = async (cik: string, accessionNo: string, path: string): Promise<void> => {
    const response = await host.httpGet(`https://www.sec.gov/Archives/${path}`, EDGAR_HEADERS);
    calls++;
    const result = captureResponse({
      host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'edgar',
      endpoint: FORM4_ENDPOINT, slug: 'edgar-form4',
      params: { cik, accession: accessionNo },
      response, captureRuleId: ruleId,
      recipe: recipes.form4({ accessionNo, tickerByCik: byCik, derivatives: true })
    });
    if (result.parseStatus === 'ok') stored += result.rowsWritten;
    else failed++;
  };

  // **Retry Form 4s SEC did not answer (v1.1.369).** The walk below never revisits an index that
  // parsed, so a Form 4 throttled inside it was lost for good: on 2026-10-15 six P&G Form 4s from
  // the 10-14 index got HTTP 429 and nothing would ever ask again. A failure that is not an answer
  // (`isSecAnswer`) is retried on each later run for `FORM4_RETRY_DAYS`.
  for (const r of form4Retries(db, run.tradingDate)) {
    throwIfCancelled(host, 'phase-8-insider');
    host.progress('insider', 0, 1, `retry ${r.accession}`);
    await fetchForm4(r.cik, r.accession, `edgar/data/${String(Number(r.cik))}/${r.accession}.txt`);
  }

  for (const indexDate of dates) {
    throwIfCancelled(host, 'phase-8-insider');
    host.progress('insider', 0, 1, `full index ${indexDate}`);
    const indexResponse = await host.httpGet(dailyFormIndexUrl(indexDate), EDGAR_HEADERS);
    calls++;

    const ok = indexResponse.status !== null && indexResponse.status >= 200 && indexResponse.status < 300;
    // Today's index not being there yet is the normal evening case, whatever
    // status SEC chooses to say it with. It is not captured: the next run asks
    // for it again, and a stored failure would fire QC-910 every night.
    if (!ok && indexDate === run.tradingDate) continue;
    // A PAST session answering 404/403 has no index and never will: SEC publishes
    // none on federal holidays the NYSE trades through (Columbus Day, Veterans
    // Day). Stopping there would stall the walk on that date for ever.
    if (indexResponse.status === 404 || indexResponse.status === 403) continue;

    // The index is a routing document for the Form 4s, archived for provenance so the
    // set of filings we chose from is recoverable — and, since v1.1.325, the source of
    // the universe's new 10-K/10-Q rows (`raw_edgar_filing`), a session after filing.
    // The recipe carries only this index's own candidates, so it stays a few lines.
    const candidates = ok && indexResponse.body
      ? reportFilingsInIndex(indexResponse.body, filerTicker, REPORT_FORMS)
      : [];
    const indexResult = captureResponse({
      host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'edgar',
      endpoint: '/Archives/edgar/daily-index/form.idx', slug: 'edgar-form-index',
      params: { date: indexDate }, response: indexResponse, captureRuleId: ruleId,
      ...(candidates.length > 0
        ? {
            recipe: recipes.formIndexFilings({
              filers: new Map(candidates.map((f) => [f.cik, filerTicker.get(f.cik) as string] as const)),
              forms: REPORT_FORMS,
              knownAccessions: new Set(
                candidates.filter((f) => storedAccession.get(f.accessionNo) !== undefined).map((f) => f.accessionNo)
              )
            })
          }
        : {})
    });
    if (indexResult.parseStatus === 'ok') reportFilings += indexResult.rowsWritten;

    if (indexResult.parseStatus !== 'ok' || !indexResponse.body) {
      // A past session that cannot be read stops the walk: its successors would
      // parse, advance the "last parsed" mark past it, and lose it for good.
      failed++;
      break;
    }

    const form4s = parseDailyFormIndex(indexResponse.body).filter(
      (f) => f.formType === '4' && byCik.has(f.cik)
    );
    indexed += form4s.length;

    for (const [i, filing] of form4s.slice(0, limit).entries()) {
      throwIfCancelled(host, 'phase-8-insider');
      host.progress('insider', i, Math.min(form4s.length, limit), filing.companyName);
      await fetchForm4(filing.cik, filing.accessionNo, filing.path);
    }
  }

  return { stored, calls, failed, indexed, reportFilings };
}

/** Form 4s fetched per daily index (v1.1.369; was 100). */
export const INSIDER_FORM4_LIMIT = 1000;

/** How long a Form 4 SEC did not answer keeps being retried. */
export const FORM4_RETRY_DAYS = 30;

const FORM4_ENDPOINT = '/Archives/edgar/data/{cik}/{accession}.txt';

/**
 * Form 4s whose latest request got no ANSWER from SEC (a 429, 5xx or network fault) within the last
 * `FORM4_RETRY_DAYS`, and which have never been fetched successfully — due again this run.
 */
export function form4Retries(db: SqliteLike, tradingDate: string): { cik: string; accession: string }[] {
  const rows = db
    .prepare(
      `SELECT json_extract(params_json, '$.cik') AS cik, json_extract(params_json, '$.accession') AS accession,
              http_status, parse_status, requested_at
         FROM meta_response WHERE endpoint = ? ORDER BY requested_at`
    )
    .all(FORM4_ENDPOINT) as { cik: string; accession: string; http_status: number | null; parse_status: string; requested_at: string }[];
  const latest = new Map<string, { cik: string; httpStatus: number | null; ok: boolean; on: string }>();
  const everOk = new Set<string>();
  for (const r of rows) {
    if (r.parse_status === 'ok') everOk.add(r.accession);
    latest.set(r.accession, { cik: r.cik, httpStatus: r.http_status, ok: r.parse_status === 'ok', on: r.requested_at.slice(0, 10) });
  }
  const cutoff = new Date(Date.parse(`${tradingDate}T00:00:00Z`) - FORM4_RETRY_DAYS * 86_400_000).toISOString().slice(0, 10);
  return [...latest]
    .filter(([acc, l]) => !everOk.has(acc) && !l.ok && !isSecAnswer(l.httpStatus) && l.on >= cutoff)
    .map(([accession, l]) => ({ cik: l.cik, accession }))
    .sort((a, b) => a.accession.localeCompare(b.accession));
}

/** How many sessions back the insider sweep will catch up in one run. */
export const INSIDER_CATCH_UP_SESSIONS = 5;

/** The newest session whose EDGAR daily form index was captured and parsed, or null. */
export function lastParsedInsiderIndexDate(db: SqliteLike): string | null {
  const row = db
    .prepare(
      `SELECT MAX(json_extract(params_json, '$.date')) AS d FROM meta_response
        WHERE endpoint = '/Archives/edgar/daily-index/form.idx' AND parse_status = 'ok'`
    )
    .get() as { d: string | null } | undefined;
  return row?.d ?? null;
}

/**
 * The sessions whose daily index the sweep should ask for, oldest first: every
 * session after the last parsed index up to `tradingDate`, capped at the most
 * recent five. With no parsed index yet it is the previous session and today.
 */
export function insiderIndexDates(db: SqliteLike, tradingDate: string): readonly string[] {
  const last = lastParsedInsiderIndexDate(db);
  if (last !== null && last >= tradingDate) return [];
  const from = last ?? previousTradingDay(db, tradingDate);
  if (from === null) return [tradingDate];
  const days = tradingDaysInRange(db, from, tradingDate).filter((d) => (last === null ? d >= from : d > from));
  const withToday = days.includes(tradingDate) ? days : [...days, tradingDate];
  return withToday.slice(-(INSIDER_CATCH_UP_SESSIONS + 1));
}

/** Phase 8 — every sub-phase, each attempted independently. */
export async function runEventsPhase(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: {
    readonly force?: boolean;
    readonly onError?: (name: string, err: unknown) => void;
    /**
     * Every sub-phase's outcome, success included (v1.1.361), so the run can record each one in
     * `meta_run_phase`. `onError` alone said only what failed, which cannot tell "ran clean" from
     * "never ran".
     */
    readonly onOutcome?: (name: string, outcome: SubPhaseOutcome) => void;
  } = {}
): Promise<EventsPhaseResult> {
  const attempt = async (
    name: string,
    fn: () => Promise<SubPhaseCount>
  ): Promise<SubPhaseCount> => {
    const startedAt = host.nowET();
    try {
      const result = await fn();
      opts.onOutcome?.(name, { status: 'ok', startedAt, finishedAt: host.nowET() });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (host.signal.aborted) {
        opts.onOutcome?.(name, { status: 'cancelled', startedAt, finishedAt: host.nowET(), error });
        throw err;
      }
      opts.onError?.(name, err);
      opts.onOutcome?.(name, { status: 'failed', startedAt, finishedAt: host.nowET(), error });
      return { ...EMPTY, failed: 1, skipped: error };
    }
  };

  const earnings = await attempt('earnings', () => runEarningsSweep(host, db, run));
  const etradeEarnings = await attempt('earnings-etrade', () => runEtradeEarnings(host, db, run));
  const indexQuotes = await attempt('index-quotes', () => runIndexQuotes(host, db, run));
  const treasury = await attempt('treasury', () => runTreasuryYields(host, db, run));
  const macroCalendar = await attempt('macro-calendar', () => runMacroCalendar(host, db, run, opts));
  // SEC's own CIK map first (v1.1.331): every EDGAR sub-phase below maps tickers through it.
  const secTickerMap = await attempt('sec-ticker-map', () => runSecTickerMap(host, db, run, opts));
  // The insider sweep runs BEFORE the filings and facts (v1.1.325): its daily index is
  // now where new report filings come from, and the fact pull is triggered by them.
  const insider = await attempt('insider', () => runInsiderSweep(host, db, run));
  const rotation = await attempt('edgar-filings', () => runEdgarFilings(host, db, run));
  const fromIndex = 'reportFilings' in insider ? (insider as { reportFilings: number }).reportFilings : 0;
  return {
    earnings,
    etradeEarnings,
    indexQuotes,
    treasury,
    macroCalendar,
    secTickerMap,
    // `events_filings` counts every report filing stored, from either source.
    filings: { ...rotation, stored: rotation.stored + fromIndex },
    // `events_facts` counts both sources. The filing's own instance goes FIRST since v1.1.365: it is
    // the primary source for a new filing; companyfacts follows for history and the QC-705 cross-check.
    facts: combined(
      await attempt('edgar-filing-facts', () => runEdgarFilingFacts(host, db, run)),
      await attempt('edgar-facts', () => runEdgarFacts(host, db, run))
    ),
    shortInterest: await attempt('short-interest', () => runShortInterest(host, db, run, opts)),
    recommendations: await attempt('recommendations', () => runRecommendations(host, db, run, opts)),
    insider
  };
}
