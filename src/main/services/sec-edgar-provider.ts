// SEC EDGAR XBRL fundamentals provider.
// Replaces the plan-restricted Polygon /vX/reference/financials endpoint.
// Free, no API key required. SEC rate limit: 10 req/s; the SEC asks that the
// User-Agent declare a contact address — built by `edgar-identity.ts`, the one
// module both EDGAR callers use (v1.1.227). This file used to hard-code
// `trader@local`, an address nobody could be reached at.
// see docs/formulas.md for formula context

import type { PolygonFinancials } from './fundamentals-computer.js';
import { edgarFetch } from './edgar-identity.js';
import { filingInstanceName, parseFilingInstance, type InstanceFact } from '@tradeanalyzer/core';

const EDGAR_BASE = 'https://data.sec.gov';

// ─── CIK resolution ───────────────────────────────────────────────────────────
// company_tickers.json is ~500 KB. Fetched once per process and cached in memory.

let _cikCache: Map<string, { cikPadded: string; title: string }> | null = null;

export async function resolveEdgarCik(ticker: string): Promise<{ cikPadded: string; title: string }> {
  if (!_cikCache) {
    const r = await edgarFetch('https://www.sec.gov/files/company_tickers.json');
    if (!r.ok) throw new Error(`SEC company_tickers.json HTTP ${r.status}`);
    const raw = await r.json() as Record<string, { cik_str: number | string; ticker: string; title: string }>;
    _cikCache = new Map();
    for (const entry of Object.values(raw)) {
      const cikNum = typeof entry.cik_str === 'string' ? parseInt(entry.cik_str, 10) : entry.cik_str;
      _cikCache.set(entry.ticker.toUpperCase(), {
        cikPadded: String(cikNum).padStart(10, '0'),
        title: entry.title,
      });
    }
  }
  const info = _cikCache.get(ticker.toUpperCase());
  if (!info) throw new Error(
    `"${ticker}" not found in SEC company_tickers.json (${_cikCache.size} tickers indexed — OTC/foreign tickers may not be listed)`
  );
  return info;
}

// ─── EDGAR entry type ─────────────────────────────────────────────────────────

export interface EdgarEntry {
  /** Period start — present on duration facts (income/CF), absent on instants (balance sheet). */
  start?: string;
  end: string;
  val: number;
  fp: string;
  form: string;
  filed: string;
}

/** Most-recent entry by `end` date for the given form type (10-K or 10-Q). */
export function pickEdgarLatest(entries: EdgarEntry[], form: '10-K' | '10-Q'): EdgarEntry | null {
  return [...entries].filter(e => e.form === form).sort((a, b) => b.end.localeCompare(a.end))[0] ?? null;
}

// ─── Concept name lists ───────────────────────────────────────────────────────
// Each role lists concept names in fallback order. "Most-recent annual date wins"
// heuristic handles ASC-606-style transitions (e.g. Revenues → RevenueFromContract…).

export const EDGAR_FIELD_SPECS: ReadonlyArray<{ role: string; label: string; concepts: readonly string[] }> = [
  { role: 'revenue',      label: 'Revenue',               concepts: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'] },
  { role: 'net_income',   label: 'Net Income',            concepts: ['NetIncomeLoss', 'NetIncome', 'ProfitLoss'] },
  { role: 'op_income',    label: 'Operating Income',      concepts: ['OperatingIncomeLoss'] },
  { role: 'depreciation', label: 'Depreciation & Amort',  concepts: ['DepreciationDepletionAndAmortization', 'DepreciationAndAmortization', 'DepreciationAmortizationAndAccretionNet'] },
  { role: 'equity',       label: "Stockholders' Equity",  concepts: ['StockholdersEquity', 'StockholdersEquityAttributableToParent'] },
  { role: 'assets_cur',   label: 'Current Assets',        concepts: ['AssetsCurrent'] },
  { role: 'liab_cur',     label: 'Current Liabilities',   concepts: ['LiabilitiesCurrent'] },
  { role: 'debt_lt',      label: 'Long-term Debt',        concepts: ['LongTermDebt', 'LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations'] },
  { role: 'cash',         label: 'Cash & Equivalents',    concepts: ['CashAndCashEquivalentsAtCarryingValue', 'Cash', 'CashCashEquivalentsAndShortTermInvestments'] },
  { role: 'op_cf',        label: 'Operating Cash Flow',   concepts: ['NetCashProvidedByUsedInOperatingActivities'] },
  { role: 'capex',        label: 'CapEx',                  concepts: ['PaymentsToAcquirePropertyPlantAndEquipment', 'CapitalExpendituresIncurringObligation'] },
];

// ─── Internal helpers ─────────────────────────────────────────────────────────

type GaapConcept = { units: Record<string, EdgarEntry[]> };
type GaapFacts = Record<string, GaapConcept>;

/**
 * Pick the best concept for a field role using "most-recent annual date wins".
 * This correctly handles companies that migrated from an old concept to a new one
 * (e.g. Apple migrated revenue from `Revenues` to `RevenueFromContractWithCustomer…`
 * after ASC 606 adoption in 2019 — the old concept still has data back to 2004).
 */
/** A concept whose newest entry (any form) is older than this is abandoned —
 *  any active filer has a 10-Q or 10-K entry within ~120 days. 540 days gives
 *  generous slack and still rejects concepts last tagged years ago. */
const STALE_CONCEPT_DAYS = 540;

/** True when the concept's newest entry is too old to describe the present.
 *  ORCL's only `LongTermDebt` entry is a $0 value from FY2022 — serving that as
 *  "current debt" against current cash produced a fake net-cash position. */
export function conceptIsStale(entries: EdgarEntry[], now = Date.now()): boolean {
  const latest = latestEntry(entries);
  if (!latest) return true;
  return (now - Date.parse(latest.end)) / 86_400_000 > STALE_CONCEPT_DAYS;
}

function pickBestConcept(
  gaap: GaapFacts,
  concepts: readonly string[],
): { entries: EdgarEntry[]; unit: string } | null {
  interface Candidate { entries: EdgarEntry[]; unit: string; latestAnnualEnd: string }
  const candidates: Candidate[] = [];
  for (const concept of concepts) {
    const c = gaap[concept];
    if (!c?.units) continue;
    const unitEntry =
      Object.entries(c.units).find(([u]) => u === 'USD') ??
      Object.entries(c.units).find(([u]) => u === 'USD/shares') ??
      Object.entries(c.units)[0];
    if (!unitEntry) continue;
    const [unit, entries] = unitEntry;
    if (!entries?.length) continue;
    if (conceptIsStale(entries)) continue;  // null beats years-old data
    const annual = annualSeries(entries);
    if (annual.length === 0) continue;
    candidates.push({ entries, unit, latestAnnualEnd: annual[0]!.end });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.latestAnnualEnd.localeCompare(a.latestAnnualEnd));
  return { entries: candidates[0]!.entries, unit: candidates[0]!.unit };
}

/**
 * True annual series: one entry per fiscal year, sorted newest-first.
 *
 * Every 10-K re-reports the two prior fiscal years as comparatives, so the raw
 * entry list contains each year 2–3 times (FY25, FY24, FY24, FY23, FY23, FY23…).
 * Without dedupe, index N is NOT N years back — index 5 lands on FY-2, which
 * silently turned the 5Y CAGR into a 2-year change annualized over 5.
 *
 * - Dedupe by period `end`; the most recently `filed` entry wins (restatements).
 * - Duration facts (income/CF, have `start`) are kept only if the period is
 *   ~12 months (300–400 days — fiscal-week calendars produce 363/370-day years).
 *   Some filers tag quarterly comparatives in 10-Ks; those must not enter the
 *   annual series. Instant facts (balance sheet, no `start`) pass through.
 */
export function annualSeries(entries: EdgarEntry[]): EdgarEntry[] {
  const byEnd = new Map<string, EdgarEntry>();
  for (const e of entries) {
    if (e.form !== '10-K') continue;
    if (e.start) {
      const days = (Date.parse(e.end) - Date.parse(e.start)) / 86_400_000;
      if (days < 300 || days > 400) continue;
    }
    const prev = byEnd.get(e.end);
    if (!prev || e.filed > prev.filed) byEnd.set(e.end, e);
  }
  return [...byEnd.values()].sort((a, b) => b.end.localeCompare(a.end));
}

/** Most-recent entry regardless of form (10-Q preferred for balance-sheet currency).
 *  Ties on `end` break by latest `filed` so restated values win. */
function latestEntry(entries: EdgarEntry[]): EdgarEntry | null {
  return [...entries].sort(
    (a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed)
  )[0] ?? null;
}

/**
 * Synthetic entry list built by summing component concepts per reporting period.
 *
 * Modern filers (MSFT, GOOGL, ORCL) no longer tag a combined D&A concept in
 * us-gaap — they tag `Depreciation` and amortization parts separately, with the
 * combined cash-flow line often in a company extension namespace that
 * facts['us-gaap'] never exposes. Summing the parts recovers the combined value.
 *
 * - Periods are keyed by exact `start|end`; components filed together share
 *   period dates, so the join is exact.
 * - Each component list is deduped per period first (latest `filed` wins) so a
 *   comparative re-report can't be double-counted into the sum.
 * - A period is emitted only when the BASE concept has it; addon values join in
 *   when present. Base alone is acceptable for D&A: it understates the total,
 *   which overstates net-debt-to-EBITDA — the conservative direction for a
 *   leverage-risk signal.
 */
export function compositeEntries(
  base: EdgarEntry[],
  addons: ReadonlyArray<EdgarEntry[]>,
): EdgarEntry[] {
  const key = (e: EdgarEntry): string => `${e.start ?? ''}|${e.end}|${e.form}`;
  const dedupe = (list: EdgarEntry[]): Map<string, EdgarEntry> => {
    const m = new Map<string, EdgarEntry>();
    for (const e of list) {
      const k = key(e);
      const prev = m.get(k);
      if (!prev || e.filed > prev.filed) m.set(k, e);
    }
    return m;
  };
  const addonMaps = addons.map(dedupe);
  const out: EdgarEntry[] = [];
  for (const [k, b] of dedupe(base)) {
    let val = b.val;
    for (const am of addonMaps) {
      const a = am.get(k);
      if (a) val += a.val;
    }
    out.push({ ...b, val });
  }
  return out;
}

/** Addon concepts summed onto `Depreciation` when no combined D&A concept is current. */
const DA_COMPOSITE_ADDONS = [
  'AmortizationOfIntangibleAssets',
  'FinanceLeaseRightOfUseAssetAmortization',
] as const;

function durationDays(e: EdgarEntry): number {
  return e.start ? Math.round((Date.parse(e.end) - Date.parse(e.start)) / 86_400_000) : 0;
}

export interface TtmPair {
  current: { val: number; end: string };
  prior: { val: number; end: string } | null;
  /** 'ttm' = rolled forward with 10-Q YTD facts; 'fy' = plain fiscal-year values. */
  source: 'ttm' | 'fy';
}

/**
 * Trailing-twelve-month value pair for a duration concept (income/CF).
 *
 * Standard XBRL TTM roll-forward: TTM = FY + YTD(current) − YTD(prior year same
 * period). Without this, "TTM" is just the last 10-K — up to ~11 months stale for
 * companies early in their fiscal year (MSFT's FY ends in June).
 *
 * The prior-year TTM (YoY denominator) rolls the same way using the two-years-back
 * YTD, which appears as the comparative inside the year-ago 10-Q. TTM mode engages
 * only when the full chain exists (YTD, YTD−1y, YTD−2y); otherwise both values fall
 * back to consistent fiscal years — mixing a TTM numerator with an FY denominator
 * would misstate YoY growth by the stub-period difference.
 */
export function ttmPair(entries: EdgarEntry[]): TtmPair | null {
  const annual = annualSeries(entries);
  const fy = annual[0];
  if (!fy) return null;
  const fyPrev = annual[1] ?? null;

  // Current-year-to-date: the longest 10-Q duration fact starting after the FY end.
  // At a given period end both the single-quarter and the cumulative YTD fact may
  // exist — same end date, different start — so ties break by longest duration.
  const ytdCur = entries
    .filter(e => e.form === '10-Q' && e.start && e.start > fy.end && durationDays(e) >= 60)
    .sort((a, b) => b.end.localeCompare(a.end) || durationDays(b) - durationDays(a))[0] ?? null;

  // Same-duration fact ending N years before the reference (±15 days per year for
  // 52/53-week calendars). Comparatives come from any form.
  const matchYtd = (ref: EdgarEntry, yearsBack: number): EdgarEntry | null => {
    const refDur = durationDays(ref);
    const refEnd = Date.parse(ref.end);
    return entries
      .filter(e => {
        if (!e.start) return false;
        if (Math.abs(durationDays(e) - refDur) > 21) return false;
        const gapDays = (refEnd - Date.parse(e.end)) / 86_400_000;
        return gapDays >= 350 * yearsBack && gapDays <= 380 * yearsBack;
      })
      .sort((a, b) => b.filed.localeCompare(a.filed))[0] ?? null;
  };

  if (ytdCur && fyPrev) {
    const ytd1 = matchYtd(ytdCur, 1);
    const ytd2 = matchYtd(ytdCur, 2);
    if (ytd1 && ytd2) {
      return {
        current: { val: fy.val + ytdCur.val - ytd1.val, end: ytdCur.end },
        prior:   { val: fyPrev.val + ytd1.val - ytd2.val, end: ytd1.end },
        source: 'ttm',
      };
    }
  }

  return {
    current: { val: fy.val, end: fy.end },
    prior: fyPrev ? { val: fyPrev.val, end: fyPrev.end } : null,
    source: 'fy',
  };
}

type FilingEntry = NonNullable<PolygonFinancials['filings']>[0];

function mkFiling(
  endDate: string,
  is: {
    revenues?: number | null;
    net_income_loss?: number | null;
    operating_income_loss?: number | null;
    depreciation_and_amortization?: number | null;
  } | null,
  bs: {
    equity?: number | null;
    current_assets?: number | null;
    current_liabilities?: number | null;
    long_term_debt?: number | null;
    cash_and_cash_equivalents?: number | null;
  } | null,
  cf: {
    net_cash_flow_from_operating_activities?: number | null;
    capital_expenditures?: number | null;
  } | null,
): FilingEntry {
  const v = (n: number | null | undefined): { value: number } | undefined =>
    n != null ? { value: n } : undefined;
  return {
    date: endDate,
    start_date: endDate,
    end_date: endDate,
    financials: {
      income_statement: is ? {
        revenues:                      v(is.revenues),
        net_income_loss:               v(is.net_income_loss),
        operating_income_loss:         v(is.operating_income_loss),
        depreciation_and_amortization: v(is.depreciation_and_amortization),
      } : undefined,
      balance_sheet: bs ? {
        equity:                    v(bs.equity),
        current_assets:            v(bs.current_assets),
        current_liabilities:       v(bs.current_liabilities),
        long_term_debt:            v(bs.long_term_debt),
        cash_and_cash_equivalents: v(bs.cash_and_cash_equivalents),
      } : undefined,
      cash_flow_statement: cf ? {
        net_cash_flow_from_operating_activities: v(cf.net_cash_flow_from_operating_activities),
        capital_expenditures:                   v(cf.capital_expenditures),
      } : undefined,
    },
  };
}

// Shared empty placeholder — financials is undefined so sumTtm() skips it.
const EMPTY_FILING: FilingEntry = { date: '', start_date: '', end_date: '', financials: undefined };

// ─── Filings SEC's companyfacts omitted (v1.1.365) ───────────────────────────
//
// companyfacts is SEC's aggregate, built FROM each filing's XBRL instance, and it drops filings:
// most 10-Qs filed 2026-07-28/29 (AEP, CTSH, HCA, CLH, KO, Citi, …) were still absent 70+ days
// later. This provider read only companyfacts, so for those filers every TTM figure, growth rate
// and balance-sheet line silently stayed one quarter old — nothing failed, the numbers were just
// stale. The NewApp collector reads each filing's own instance as its primary source; this path
// reads the same instance, with the same parser (`parseFilingInstance` in core), whenever
// companyfacts looks a filing behind.

/**
 * Newest 10-Q/10-K period end older than this → check the filer's submissions for a report filing
 * companyfacts does not carry. A 10-Q is due 40–45 days after quarter end, so an up-to-date filer's
 * newest period ends at most ~136 days ago, and ~181 at a 10-K; 100 checks every truly late case and
 * costs one small submissions call on the rest.
 */
export const FILING_CHECK_AFTER_DAYS = 100;
/** Report filings read from their own instance per call — the newest two cover a 10-Q and a 10-K. */
const MAX_FILINGS_READ = 2;

/** Newest period end and newest filing date across every 10-Q/10-K entry companyfacts carries. */
export function newestReport(gaap: GaapFacts): { end: string | null; filed: string | null } {
  let end: string | null = null;
  let filed: string | null = null;
  for (const concept of Object.values(gaap)) {
    for (const entries of Object.values(concept.units ?? {})) {
      for (const e of entries) {
        if (e.form !== '10-Q' && e.form !== '10-K') continue;
        if (end === null || e.end > end) end = e.end;
        if (filed === null || e.filed > filed) filed = e.filed;
      }
    }
  }
  return { end, filed };
}

/**
 * Add one filing's own facts to companyfacts-shaped us-gaap facts, as companyfacts would have
 * carried them: every point keeps the filing's form and date, so `ttmPair`/`annualSeries` treat it
 * exactly like an aggregate entry. A point already present for that filing is not added twice.
 * Returns the number of points added.
 */
export function mergeFilingFacts(
  gaap: GaapFacts,
  facts: readonly InstanceFact[],
  filing: { form: '10-Q' | '10-K'; filed: string }
): number {
  let added = 0;
  for (const f of facts) {
    if (f.taxonomy !== 'us-gaap') continue;
    const concept = (gaap[f.concept] ??= { units: {} });
    const entries = (concept.units[f.unit] ??= []);
    const start = f.periodStart ?? undefined;
    if (entries.some((e) => e.end === f.periodEnd && e.start === start && e.form === filing.form && e.filed === filing.filed)) continue;
    entries.push({ ...(start !== undefined ? { start } : {}), end: f.periodEnd, val: f.value, fp: f.fiscalPeriod, form: filing.form, filed: filing.filed });
    added++;
  }
  return added;
}

/** The newest 10-Q/10-K filings in a submissions document filed after `after`, newest first. */
export function reportFilingsAfter(
  submissions: unknown,
  after: string
): { accession: string; form: '10-Q' | '10-K'; filed: string }[] {
  const recent = (submissions as { filings?: { recent?: Record<string, unknown> } })?.filings?.recent;
  const acc = recent?.['accessionNumber'];
  const form = recent?.['form'];
  const date = recent?.['filingDate'];
  if (!Array.isArray(acc) || !Array.isArray(form) || !Array.isArray(date)) return [];
  const out: { accession: string; form: '10-Q' | '10-K'; filed: string }[] = [];
  // Row count from the accession array, never zipped past a shorter companion (CLAUDE.md, EDGAR quirk).
  for (let i = 0; i < acc.length; i++) {
    const f = form[i];
    const d = date[i];
    if ((f === '10-Q' || f === '10-K') && typeof d === 'string' && d > after && typeof acc[i] === 'string') {
      out.push({ accession: acc[i] as string, form: f, filed: d });
    }
  }
  return out.sort((a, b) => b.filed.localeCompare(a.filed)).slice(0, MAX_FILINGS_READ);
}

/**
 * When companyfacts looks a filing behind, read the missing report filings' own instances into
 * `gaap`. Never throws: a failure leaves companyfacts' answer as it was, and every request is in
 * `logs/api/` through `edgarFetch`.
 */
async function addOmittedFilings(cikPadded: string, gaap: GaapFacts): Promise<void> {
  try {
    const { end, filed } = newestReport(gaap);
    if (end !== null && (Date.now() - Date.parse(`${end}T00:00:00Z`)) / 86_400_000 < FILING_CHECK_AFTER_DAYS) return;

    const subs = await edgarFetch(`${EDGAR_BASE}/submissions/CIK${cikPadded}.json`);
    if (!subs.ok) return;
    const missing = reportFilingsAfter(await subs.json(), filed ?? '0000-00-00');
    for (const m of missing) {
      const base = `https://www.sec.gov/Archives/edgar/data/${String(Number(cikPadded))}/${m.accession.replace(/-/g, '')}/`;
      const index = await edgarFetch(`${base}index.json`);
      if (!index.ok) continue;
      const instance = filingInstanceName(await index.text());
      if (instance === null) continue;
      const body = await edgarFetch(`${base}${instance}`);
      if (!body.ok) continue;
      mergeFilingFacts(gaap, parseFilingInstance(await body.text()), { form: m.form, filed: m.filed });
    }
  } catch {
    // companyfacts' own answer stands; the calls that failed are in logs/api/.
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetch SEC EDGAR XBRL fundamentals for a ticker and return them in the
 * PolygonFinancials shape expected by computeRatios().
 *
 * Filing array layout (20 slots, sparse):
 *   [0]  Current TTM — income statement + cash flow;
 *        most-recent balance sheet (10-Q preferred for currency over 10-K)
 *   [4]  Prior-year TTM — for YoY revenue/earnings growth
 *  [16]  Five-years-ago annual 10-K — for 5Y CAGR (sumFiveYearAgoTtm reads [16..19])
 * All other slots hold EMPTY_FILING (financials: undefined) so sumTtm() skips them.
 * Array length is always 20 so the `filings.length < 20` guard in sumFiveYearAgoTtm passes.
 *
 * Income/CF values at slots 0 and 4 are true TTM (FY rolled forward with 10-Q YTD
 * facts via ttmPair) when the quarterly chain exists; otherwise consistent fiscal
 * years. Slot 16 stays annual — the CAGR base predates reliable YTD comparatives.
 */
export async function getEdgarFundamentals(ticker: string): Promise<PolygonFinancials> {
  const { cikPadded, title } = await resolveEdgarCik(ticker);

  const r = await edgarFetch(`${EDGAR_BASE}/api/xbrl/companyfacts/CIK${cikPadded}.json`);
  if (!r.ok) throw new Error(`EDGAR companyfacts HTTP ${r.status} for ${ticker}`);

  const data = await r.json() as { facts?: { 'us-gaap'?: GaapFacts } };
  const gaap: GaapFacts = data.facts?.['us-gaap'] ?? {};
  // companyfacts drops filings (v1.1.365): fill a missing one from its own XBRL instance.
  await addOmittedFilings(cikPadded, gaap);

  // Resolve best concept + entries for every field role
  type ConceptResult = { entries: EdgarEntry[]; unit: string } | null;
  const resolved: Record<string, ConceptResult> = {};
  for (const spec of EDGAR_FIELD_SPECS) {
    resolved[spec.role] = pickBestConcept(gaap, spec.concepts);
  }

  // Composite D&A fallback: when no combined D&A concept is current, sum
  // Depreciation + amortization parts per period. Selection follows the same
  // most-recent-annual-wins rule as pickBestConcept — the composite replaces the
  // combined concept only when its annual series is strictly more recent (covers
  // both "no combined concept at all" and "combined concept abandoned years ago").
  {
    const baseDa = gaap['Depreciation']?.units?.['USD'] ?? [];
    if (baseDa.length > 0 && !conceptIsStale(baseDa)) {
      const synthetic = compositeEntries(
        baseDa,
        DA_COMPOSITE_ADDONS.map(c => gaap[c]?.units?.['USD'] ?? []),
      );
      const compositeAnnual = annualSeries(synthetic);
      if (compositeAnnual.length > 0) {
        const combined = resolved['depreciation'];
        const combinedEnd = combined ? (annualSeries(combined.entries)[0]?.end ?? '') : '';
        if (compositeAnnual[0]!.end > combinedEnd) {
          resolved['depreciation'] = { entries: synthetic, unit: 'USD' };
        }
      }
    }
  }

  function annuals(role: string): EdgarEntry[] {
    const c = resolved[role];
    return c ? annualSeries(c.entries) : [];
  }

  function annualVal(role: string, idx: number): number | null {
    return annuals(role)[idx]?.val ?? null;
  }

  function latestVal(role: string): number | null {
    const c = resolved[role];
    return c ? (latestEntry(c.entries)?.val ?? null) : null;
  }

  // TTM pair per duration role (income/CF): rolled forward with 10-Q YTD facts
  // when the full chain exists, consistent fiscal-year pair otherwise.
  const pairs = new Map<string, TtmPair | null>();
  function pair(role: string): TtmPair | null {
    if (!pairs.has(role)) {
      const c = resolved[role];
      pairs.set(role, c ? ttmPair(c.entries) : null);
    }
    return pairs.get(role) ?? null;
  }

  // Reference series for period end-dates (revenue first, fall back to net income)
  const refPair = pair('revenue') ?? pair('net_income');
  const refAnnuals = annuals('revenue').length > 0 ? annuals('revenue') : annuals('net_income');
  const today = new Date().toISOString().slice(0, 10);
  const endDate0  = refPair?.current.end ?? today;
  const endDate4  = refPair?.prior?.end ?? endDate0;
  // 5Y CAGR base: index 5 in the deduped series = exactly 5 fiscal years back.
  // No nearer fallback — a "5Y CAGR" computed from a 3–4 year base is mislabeled;
  // companies with shorter history (recent IPOs, concept transitions) get null,
  // which the scoring engine treats as a missing signal and reweights.
  const cagr5yIdx = refAnnuals.length >= 6 ? 5 : -1;
  const endDate16 = cagr5yIdx >= 0 ? (refAnnuals[cagr5yIdx]?.end ?? endDate0) : endDate0;

  // 20-element filing array — empty by default, filled at slots 0, 4, and 16
  const filings: FilingEntry[] = new Array(20).fill(EMPTY_FILING) as FilingEntry[];

  // Slot 0 — TTM income statement + CF, most-recent balance sheet
  filings[0] = mkFiling(
    endDate0,
    {
      revenues:                       pair('revenue')?.current.val      ?? null,
      net_income_loss:                pair('net_income')?.current.val   ?? null,
      operating_income_loss:          pair('op_income')?.current.val    ?? null,
      depreciation_and_amortization:  pair('depreciation')?.current.val ?? null,
    },
    {
      // Use most-recent entry (10-Q preferred — more current than the annual 10-K)
      equity:                    latestVal('equity'),
      current_assets:            latestVal('assets_cur'),
      current_liabilities:       latestVal('liab_cur'),
      long_term_debt:            latestVal('debt_lt'),
      cash_and_cash_equivalents: latestVal('cash'),
    },
    {
      net_cash_flow_from_operating_activities: pair('op_cf')?.current.val ?? null,
      capital_expenditures:                   pair('capex')?.current.val ?? null,
    },
  );

  // Slot 4 — prior-year TTM (YoY growth denominator)
  if (refPair?.prior) {
    filings[4] = mkFiling(
      endDate4,
      {
        revenues:                       pair('revenue')?.prior?.val      ?? null,
        net_income_loss:                pair('net_income')?.prior?.val   ?? null,
        operating_income_loss:          pair('op_income')?.prior?.val    ?? null,
        depreciation_and_amortization:  pair('depreciation')?.prior?.val ?? null,
      },
      null,
      {
        net_cash_flow_from_operating_activities: pair('op_cf')?.prior?.val ?? null,
        capital_expenditures:                   pair('capex')?.prior?.val ?? null,
      },
    );
  }

  // Slot 16 — five-years-ago annual (5Y CAGR numerator base)
  if (cagr5yIdx >= 0) {
    filings[16] = mkFiling(
      endDate16,
      {
        revenues:        annualVal('revenue',    cagr5yIdx),
        net_income_loss: annualVal('net_income', cagr5yIdx),
      },
      null,
      null,
    );
  }

  return {
    ticker: ticker.toUpperCase(),
    company_name: title,
    filings,
  };
}
