import type { SqliteLike } from '../../db/sqlite-like.js';
import type { CollectorHost } from '../host.js';
import { throwIfCancelled } from '../host.js';
import { captureResponse } from '../capture.js';
import { recipes } from '../../ingest/recipes.js';
import { captureRuleId, type RunHandle } from '../run.js';
import { earningsResponseAtCap } from '../../ingest/events.js';
import { BLS_RELEASES, FOMC_CALENDAR_URL, blsScheduleUrl } from '../../ingest/macro-calendar.js';
import { parseDailyFormIndex, dailyFormIndexUrl, submissionsAtCap } from '../../ingest/edgar.js';
import { previousTradingDay } from '../trading-calendar.js';
import { sweepPolygonPages } from '../paged.js';

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
export async function runEdgarFilings(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly maxFilers?: number } = {}
): Promise<SubPhaseCount> {
  const ruleId = captureRuleId(db, host, 'edgar_filings', { forms: [...REPORT_FORMS] }, 'Submissions index for a rolling slice of filers.');
  const { byTicker } = cikMap(db);
  if (byTicker.size === 0) return skipped('no CIKs known yet — raw_ticker_reference has none');

  // A rolling slice keyed on the trading date: every filer is visited within a
  // fixed number of days without a stored cursor to fall out of step.
  const maxFilers = opts.maxFilers ?? 20;
  const entries = [...byTicker.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const dayIndex = Math.floor(Date.parse(`${run.tradingDate}T00:00:00Z`) / 86_400_000);
  const start = (dayIndex * maxFilers) % Math.max(entries.length, 1);
  const slice = [...entries, ...entries].slice(start, start + maxFilers);

  const since = addDays(run.tradingDate, -EVENTS_RULE.factsLookbackDays);
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
      recipe: recipes.submissions({ cik, ticker, since, forms: REPORT_FORMS })
    });

    if (result.parseStatus === 'ok') stored += result.rowsWritten;
    else failed++;
  }

  return { stored, calls, failed };
}

/**
 * XBRL facts, pulled for filers whose newest stored report filing has no facts
 * yet — filing-triggered rather than clock-triggered, so a quiet quarter costs
 * nothing.
 */
export async function runEdgarFacts(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly maxFilers?: number } = {}
): Promise<SubPhaseCount> {
  const ruleId = captureRuleId(db, host, 'edgar_facts', { trigger: 'new_report_filing' }, 'Company facts for filers with an unharvested report filing.');

  const pending = db
    .prepare(
      `SELECT DISTINCT f.cik
         FROM raw_edgar_filing f
        WHERE f.form IN ('10-K', '10-Q', '20-F', '40-F')
          AND NOT EXISTS (
                SELECT 1 FROM raw_edgar_fact x WHERE x.accession_no = f.accession_no
              )
        ORDER BY f.filed_date DESC
        LIMIT ?`
    )
    .all(opts.maxFilers ?? 10) as { cik: string }[];

  if (pending.length === 0) return skipped('no filing without harvested facts');

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

/** Short interest — weekly, and the one domain with no confirmed free source. */
export async function runShortInterest(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly force?: boolean } = {}
): Promise<SubPhaseCount> {
  if (!opts.force && !dueForCadence(db, '%short-interest%', run.tradingDate, EVENTS_RULE.shortInterestCadenceDays)) {
    return skipped(`not due — cadence is ${EVENTS_RULE.shortInterestCadenceDays} days`);
  }

  const ruleId = captureRuleId(db, host, 'short_interest', { cadenceDays: EVENTS_RULE.shortInterestCadenceDays }, 'Short interest for the chain subset, weekly.');
  const tickers = subsetMembers(db);
  if (tickers.length === 0) return skipped('chain subset is empty');

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
  // that is harmless today is still a cap, and this path has never yet returned a
  // live 200 — so the first response that clears the short-interest verify note
  // must not be one we trusted without checking.
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
      response, captureRuleId: ruleId, recipe: recipes.recommendations({ ticker })
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
  let indexDate = run.tradingDate;
  host.progress('insider', 0, 1, 'full index');
  let indexResponse = await host.httpGet(dailyFormIndexUrl(indexDate), EDGAR_HEADERS);

  if (indexResponse.status === 404) {
    const previous = previousTradingDay(db, run.tradingDate);
    if (previous !== null) {
      indexDate = previous;
      host.progress('insider', 0, 1, `full index (${indexDate}, today's not yet published)`);
      indexResponse = await host.httpGet(dailyFormIndexUrl(indexDate), EDGAR_HEADERS);
    }
  }

  // The index itself writes no domain rows — it is a routing document, archived
  // for provenance so the set of filings we chose from is recoverable.
  const indexResult = captureResponse({
    host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'edgar',
    endpoint: '/Archives/edgar/daily-index/form.idx', slug: 'edgar-form-index',
    params: { date: indexDate }, response: indexResponse, captureRuleId: ruleId
  });

  if (indexResult.parseStatus !== 'ok' || !indexResponse.body) {
    return { stored: 0, calls: 1, failed: 1, indexed: 0 };
  }

  const form4s = parseDailyFormIndex(indexResponse.body).filter(
    (f) => f.formType === '4' && byCik.has(f.cik)
  );

  let stored = 0;
  let calls = 1;
  let failed = 0;
  const limit = opts.maxFilings ?? 100;

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
      recipe: recipes.form4({ accessionNo: filing.accessionNo, tickerByCik: byCik })
    });

    if (result.parseStatus === 'ok') stored += result.rowsWritten;
    else failed++;
  }

  return { stored, calls, failed, indexed: form4s.length };
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
