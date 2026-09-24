import type { SqliteLike } from '../../db/sqlite-like.js';
import type { CollectorHost } from '../host.js';
import { throwIfCancelled } from '../host.js';
import { captureResponse } from '../capture.js';
import { recipes } from '../../ingest/recipes.js';
import { captureRuleId, type RunHandle } from '../run.js';
import { earningsResponseAtCap } from '../../ingest/events.js';
import { BLS_RELEASES, FOMC_CALENDAR_URL, blsScheduleUrl } from '../../ingest/macro-calendar.js';
import { parseDailyFormIndex, dailyFormIndexUrl, submissionsAtCap } from '../../ingest/edgar.js';
import { previousTradingDay, tradingDaysInRange } from '../trading-calendar.js';
import { sweepPolygonPages } from '../paged.js';
import { refusedSymbolAnswers, withRefusals } from '../symbol-rulings.js';
import { FUND_TYPES } from '../../qa/checks/earnings-fundamentals.js';
import { factsBatch, FACTS_PER_RUN } from '../facts-queue.js';
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

export interface EventsPhaseResult {
  readonly earnings: SubPhaseCount;
  readonly etradeEarnings: SubPhaseCount;
  readonly indexQuotes: SubPhaseCount;
  readonly treasury: SubPhaseCount;
  readonly macroCalendar: SubPhaseCount;
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

/** The latest known CIK per active ticker — the join EDGAR needs in both directions. */
function cikMap(db: SqliteLike): { byTicker: Map<string, string>; byCik: Map<string, string> } {
  const rows = db
    .prepare(
      `SELECT r.ticker, r.cik FROM raw_ticker_reference r
        WHERE r.cik IS NOT NULL
          AND r.row_id IN (SELECT MAX(row_id) FROM raw_ticker_reference GROUP BY ticker)
          AND r.ticker IN (SELECT ticker FROM ref_universe_membership WHERE valid_to IS NULL)`
    )
    .all() as { ticker: string; cik: string }[];

  const byTicker = new Map<string, string>();
  const byCik = new Map<string, string>();
  for (const r of rows) {
    byTicker.set(r.ticker, r.cik);
    // A CIK can carry several tickers (share classes). First wins, and the
    // ordering is the query's, which is stable — good enough for attributing a
    // Form 4, and not good enough to be the only record, which is why the
    // filing keeps its own CIK.
    if (!byCik.has(r.cik)) byCik.set(r.cik, r.ticker);
  }
  return { byTicker, byCik };
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

export async function runEdgarFilings(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly maxFilers?: number } = {}
): Promise<SubPhaseCount> {
  const ruleId = captureRuleId(
    db, host, 'edgar_filings',
    { forms: [...REPORT_FORMS], lookbackDays: FILINGS_LOOKBACK_DAYS, funds: 'excluded' },
    'Submissions index for a rolling slice of operating-company filers.'
  );
  const { byTicker } = cikMap(db);
  if (byTicker.size === 0) return skipped('no CIKs known yet — raw_ticker_reference has none');

  // Funds file no 10-K/10-Q, so their submissions can only ever store nothing — and a
  // trust's thousands of fund filings made every one of them read as capped (v1.1.275).
  // One filer per CIK: iShares Trust stands behind seven universe tickers and was
  // fetched six times in one run.
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
  const entries = [...byTicker.entries()]
    .filter(([ticker]) => !funds.has(ticker))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .filter(([, cik]) => (seenCik.has(cik) ? false : (seenCik.add(cik), true)));

  // A rolling slice keyed on the trading date: every filer is visited within a
  // fixed number of days without a stored cursor to fall out of step.
  const maxFilers = opts.maxFilers ?? 20;
  const dayIndex = Math.floor(Date.parse(`${run.tradingDate}T00:00:00Z`) / 86_400_000);
  const start = (dayIndex * maxFilers) % Math.max(entries.length, 1);
  const slice = [...entries, ...entries].slice(start, Math.min(start + maxFilers, start + entries.length));

  const since = addDays(run.tradingDate, -FILINGS_LOOKBACK_DAYS);
  // What is already stored for this CIK, so a re-pull skips it instead of
  // throwing. `raw_edgar_filing` is UNIQUE on `accession_no` alone, and the
  // transaction is the whole response — so one already-seen filing discards
  // every NEW filing beside it and reports as a parse failure. The slice is
  // keyed on the trading date, so any day with two collector runs asks the
  // identical twenty filers and hits this: HSY on 2026-09-22, stored at 17:05
  // and re-asked at 20:47.
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
  const ruleId = captureRuleId(db, host, 'edgar_facts', { trigger: 'new_report_filing' }, 'Company facts for filers with an unharvested report filing.');

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
      endpoint: '/api/xbrl/companyfacts/CIK{cik}.json', slug: 'edgar-companyfacts',
      params: { cik }, response, captureRuleId: ruleId,
      recipe: recipes.companyFacts({ cik, since })
    });

    if (result.parseStatus === 'ok') stored += result.rowsWritten;
    else failed++;
  }

  return { stored, calls, failed };
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
): Promise<SubPhaseCount & { readonly indexed: number }> {
  const ruleId = captureRuleId(db, host, 'insider', { source: 'edgar_full_index' }, 'Daily Form 4 sweep from the EDGAR full index.');
  const { byCik } = cikMap(db);

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
  const limit = opts.maxFilings ?? 100;

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

    // The index itself writes no domain rows — it is a routing document, archived
    // for provenance so the set of filings we chose from is recoverable.
    const indexResult = captureResponse({
      host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'edgar',
      endpoint: '/Archives/edgar/daily-index/form.idx', slug: 'edgar-form-index',
      params: { date: indexDate }, response: indexResponse, captureRuleId: ruleId
    });

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

      const url = `https://www.sec.gov/Archives/${filing.path}`;
      const response = await host.httpGet(url, EDGAR_HEADERS);
      calls++;

      const result = captureResponse({
        host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'edgar',
        endpoint: '/Archives/edgar/data/{cik}/{accession}.txt', slug: 'edgar-form4',
        params: { cik: filing.cik, accession: filing.accessionNo },
        response, captureRuleId: ruleId,
        recipe: recipes.form4({ accessionNo: filing.accessionNo, tickerByCik: byCik, derivatives: true })
      });

      if (result.parseStatus === 'ok') stored += result.rowsWritten;
      else failed++;
    }
  }

  return { stored, calls, failed, indexed };
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
  } = {}
): Promise<EventsPhaseResult> {
  const attempt = async (
    name: string,
    fn: () => Promise<SubPhaseCount>
  ): Promise<SubPhaseCount> => {
    try {
      return await fn();
    } catch (err) {
      if (host.signal.aborted) throw err;
      opts.onError?.(name, err);
      return { ...EMPTY, failed: 1, skipped: err instanceof Error ? err.message : String(err) };
    }
  };

  return {
    earnings: await attempt('earnings', () => runEarningsSweep(host, db, run)),
    etradeEarnings: await attempt('earnings-etrade', () => runEtradeEarnings(host, db, run)),
    indexQuotes: await attempt('index-quotes', () => runIndexQuotes(host, db, run)),
    treasury: await attempt('treasury', () => runTreasuryYields(host, db, run)),
    macroCalendar: await attempt('macro-calendar', () => runMacroCalendar(host, db, run, opts)),
    filings: await attempt('edgar-filings', () => runEdgarFilings(host, db, run)),
    facts: await attempt('edgar-facts', () => runEdgarFacts(host, db, run)),
    shortInterest: await attempt('short-interest', () => runShortInterest(host, db, run, opts)),
    recommendations: await attempt('recommendations', () => runRecommendations(host, db, run, opts)),
    insider: await attempt('insider', () => runInsiderSweep(host, db, run))
  };
}
