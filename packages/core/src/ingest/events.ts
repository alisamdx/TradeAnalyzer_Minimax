import type { IngestContext, IngestedRowSpec } from '../collector/capture.js';
import { secondsEpochToEt } from './options.js';

/**
 * Phase-8 ingestion for the feed-shaped sources — earnings, index quotes,
 * treasury yields, short interest and analyst recommendations (02 §7, §8, §11,
 * §12).
 *
 * Pure and database-free like every other ingestion module (04 §2.3): a fixture
 * in gives fixed rows out, which is what makes replay byte-reproducible (AC-4).
 */

/** `ok` when present, `omitted` when the provider left it out (02 §0.3). */
function statusFor(v: unknown): 'ok' | 'omitted' {
  return v === null || v === undefined ? 'omitted' : 'ok';
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ── earnings and the estimates that ride along with them ───────────────────

interface FinnhubEarningsRow {
  symbol?: string;
  date?: string;
  hour?: string;
  year?: number;
  quarter?: number;
  epsEstimate?: number | null;
  epsActual?: number | null;
  revenueEstimate?: number | null;
  revenueActual?: number | null;
}

/**
 * Finnhub's `hour` is `bmo`, `amc`, or — on 47 % of universe reports, measured
 * 2026-09-06 over 520 of them — the **empty string**. `dmh` was never seen.
 *
 * The empty string is not a fourth enum member; it is the provider's way of
 * saying it does not know. Storing it verbatim would put a value in the column
 * that every `report_time IS NULL` filter silently misses, which is the same
 * shape as `Boolean("n")` reading true: nothing throws, and the wrong answer is
 * plausible.
 */
export function finnhubHourToReportTime(v: unknown): {
  value: 'bmo' | 'amc' | 'dmh' | null;
  status: 'ok' | 'omitted' | 'invalid';
} {
  if (typeof v !== 'string' || v.trim() === '') return { value: null, status: 'omitted' };
  const normalised = v.trim().toLowerCase();
  if (normalised === 'bmo' || normalised === 'amc' || normalised === 'dmh') {
    return { value: normalised, status: 'ok' };
  }
  // A value we do not recognise is a provider change, and it is reported as
  // one rather than mapped to the nearest member.
  return { value: null, status: 'invalid' };
}

/**
 * The Finnhub earnings calendar — **two tables from one response**.
 *
 * `raw_analyst_estimate` exists because the dedicated estimate endpoints are
 * premium (403, measured 2026-09-06) but the free calendar carries
 * `epsEstimate` and `revenueEstimate` per scheduled report, covering 517 of 520
 * universe reports. Writing both here is what makes that "no extra call" true.
 *
 * A row with neither estimate produces no estimate row at all, rather than a row
 * of nulls — an absent consensus is not a consensus of nothing.
 */
export function makeEarningsIngest(opts: {
  readonly sweepFrom: string;
  readonly sweepTo: string;
  /** Only these tickers are stored; the calendar is all-market. */
  readonly universe?: ReadonlySet<string>;
}) {
  return (body: string, ctx: IngestContext): readonly IngestedRowSpec[] => {
    const parsed = JSON.parse(body) as { earningsCalendar?: FinnhubEarningsRow[] };
    const rows: IngestedRowSpec[] = [];

    for (const e of parsed.earningsCalendar ?? []) {
      if (!e.symbol || !e.date) continue;
      if (opts.universe && !opts.universe.has(e.symbol)) continue;

      const reportTime = finnhubHourToReportTime(e.hour);
      const epsEstimate = numberOrNull(e.epsEstimate);
      const revenueEstimate = numberOrNull(e.revenueEstimate);

      rows.push({
        table: 'raw_earnings_event',
        values: {
          run_id: ctx.runId,
          as_of_date: ctx.asOfDate,
          observed_at: ctx.observedAt,
          capture_rule_id: ctx.captureRuleId,
          ticker: e.symbol,
          report_date: e.date,
          report_time: reportTime.value,
          report_time_status: reportTime.status,
          fiscal_year: typeof e.year === 'number' ? e.year : null,
          fiscal_quarter: typeof e.quarter === 'number' ? e.quarter : null,
          eps_estimate: epsEstimate,
          eps_estimate_status: statusFor(epsEstimate),
          eps_actual: numberOrNull(e.epsActual),
          eps_actual_status: statusFor(numberOrNull(e.epsActual)),
          revenue_estimate: revenueEstimate,
          revenue_estimate_status: statusFor(revenueEstimate),
          revenue_actual: numberOrNull(e.revenueActual),
          revenue_actual_status: statusFor(numberOrNull(e.revenueActual)),
          source: 'finnhub',
          sweep_from: opts.sweepFrom,
          sweep_to: opts.sweepTo,
          is_confirmed: null
        }
      });

      if (epsEstimate === null && revenueEstimate === null) continue;
      if (typeof e.year !== 'number' || typeof e.quarter !== 'number') continue;

      rows.push({
        table: 'raw_analyst_estimate',
        values: {
          run_id: ctx.runId,
          as_of_date: ctx.asOfDate,
          observed_at: ctx.observedAt,
          capture_rule_id: ctx.captureRuleId,
          ticker: e.symbol,
          fiscal_period: `${e.year}Q${e.quarter}`,
          eps_estimate_avg: epsEstimate,
          eps_estimate_avg_status: statusFor(epsEstimate),
          revenue_estimate_avg: revenueEstimate,
          revenue_estimate_avg_status: statusFor(revenueEstimate),
          source: 'finnhub'
        }
      });
    }
    return rows;
  };
}

/**
 * E*Trade's `nextEarningDate` as ISO, or null when it is empty — which is how E*Trade says no
 * date is announced (the existing app's `earnings-refresh` reads 82 such tickers on 2026-09-18).
 *
 * The format is `MM/DD/YYYY`, per the existing app's parser of the same field; ISO is accepted
 * too. Anything else **throws**: the response is then indexed as a parse failure, so a format
 * change surfaces instead of storing a wrong date or quietly storing none. The date is stored as
 * observed — E*Trade's UTC artefact (a Thursday-evening report read as Saturday) is QC-604's to
 * flag, and a raw table that corrects its source cannot be replayed.
 */
export function etradeEarningDate(v: unknown): string | null {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (mdy) return `${mdy[3]}-${mdy[1]!.padStart(2, '0')}-${mdy[2]!.padStart(2, '0')}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  throw new Error(`unrecognised E*Trade nextEarningDate: ${JSON.stringify(v)}`);
}

/**
 * E*Trade's next earnings date for ONE ticker, from `/v1/market/quote/{t}?detailFlag=ALL&
 * requireEarningsDate=true` — the collector's second earnings source (v1.1.270).
 *
 * Keyed on the ticker ASKED, never the symbol in the body (v1.1.257: a provider's symbol is its
 * claim about what it answered). No announced date writes no row: an absent date is not a date.
 */
export function makeEtradeEarningsIngest(opts: { readonly ticker: string }) {
  return (body: string, ctx: IngestContext): readonly IngestedRowSpec[] => {
    const parsed = JSON.parse(body) as {
      QuoteResponse?: { QuoteData?: { All?: { nextEarningDate?: unknown } }[] };
    };
    const date = etradeEarningDate(parsed.QuoteResponse?.QuoteData?.[0]?.All?.nextEarningDate);
    if (date === null) return [];
    return [
      {
        table: 'raw_earnings_event',
        values: {
          run_id: ctx.runId,
          as_of_date: ctx.asOfDate,
          observed_at: ctx.observedAt,
          capture_rule_id: ctx.captureRuleId,
          ticker: opts.ticker,
          report_date: date,
          report_time: null,
          report_time_status: 'omitted',
          fiscal_year: null,
          fiscal_quarter: null,
          eps_estimate: null,
          eps_estimate_status: 'omitted',
          eps_actual: null,
          eps_actual_status: 'omitted',
          revenue_estimate: null,
          revenue_estimate_status: 'omitted',
          revenue_actual: null,
          revenue_actual_status: 'omitted',
          source: 'etrade',
          sweep_from: null,
          sweep_to: null,
          is_confirmed: null
        }
      }
    ];
  };
}

/** Finnhub's bulk calendar caps at 1,500 and drops the EARLIEST dates (P8). */
export const FINNHUB_BULK_CAP = 1500;

export function earningsResponseAtCap(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { earningsCalendar?: unknown[] };
    return (parsed.earningsCalendar?.length ?? 0) >= FINNHUB_BULK_CAP;
  } catch {
    return false;
  }
}

// ── index quotes ───────────────────────────────────────────────────────────

interface EtradeQuoteData {
  All?: {
    lastTrade?: number; open?: number; high?: number; low?: number; previousClose?: number;
  };
  dateTimeUTC?: number;
  Product?: { symbol?: string };
}

/**
 * E*Trade index quotes. All five `All.*` names were confirmed live 2026-09-07,
 * as was the symbol `VIX` itself (`VIX.X` is rejected as invalid).
 *
 * `dateTimeUTC` is epoch **seconds**, like `timeStamp` on a chain — read as
 * milliseconds it lands in January 1970, which at least fails loudly.
 */
export function makeIndexQuoteIngest(opts: { readonly symbol: string }) {
  return (body: string, ctx: IngestContext): readonly IngestedRowSpec[] => {
    const parsed = JSON.parse(body) as { QuoteResponse?: { QuoteData?: EtradeQuoteData[] } };
    const rows: IngestedRowSpec[] = [];

    for (const q of parsed.QuoteResponse?.QuoteData ?? []) {
      const all = q.All;
      const last = numberOrNull(all?.lastTrade);

      // The session fields share one status, so they are all-or-nothing by
      // construction: the constraint permits no partial group, and pretending
      // otherwise would throw inside the capture transaction and surface as a
      // generic parse failure rather than as the missing field it is.
      const session = {
        open: numberOrNull(all?.open),
        high: numberOrNull(all?.high),
        low: numberOrNull(all?.low),
        prev_close: numberOrNull(all?.previousClose)
      };
      const sessionOk = Object.values(session).every((v) => v !== null);

      rows.push({
        table: 'raw_index_quote',
        values: {
          run_id: ctx.runId,
          as_of_date: ctx.asOfDate,
          observed_at: ctx.observedAt,
          capture_rule_id: ctx.captureRuleId,
          symbol: q.Product?.symbol ?? opts.symbol,
          last,
          last_status: last === null ? 'omitted' : 'ok',
          open: sessionOk ? session.open : null,
          high: sessionOk ? session.high : null,
          low: sessionOk ? session.low : null,
          prev_close: sessionOk ? session.prev_close : null,
          session_status: sessionOk ? 'ok' : 'omitted',
          provider_timestamp: secondsEpochToEt(q.dateTimeUTC)
        }
      });
    }
    return rows;
  };
}

// ── treasury par yield curve ───────────────────────────────────────────────

/**
 * The published header names, read from the live CSV on 2026-09-07:
 *
 * `Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"`
 *
 * Note `1.5 Month` spells the word out where every other tenor abbreviates —
 * which is exactly why the mapping is by **name** and not by column position.
 * A positional reader survives a renamed header and silently mislabels a whole
 * curve; a name reader drops the column and QC-902 reports fewer than 14 tenors.
 */
const TREASURY_HEADER_TO_TENOR: Readonly<Record<string, string>> = {
  '1 mo': '1M', '1.5 month': '1.5M', '1.5 mo': '1.5M', '2 mo': '2M', '3 mo': '3M',
  '4 mo': '4M', '6 mo': '6M', '1 yr': '1Y', '2 yr': '2Y', '3 yr': '3Y',
  '5 yr': '5Y', '7 yr': '7Y', '10 yr': '10Y', '20 yr': '20Y', '30 yr': '30Y'
};

export function parseCsvLine(line: string): readonly string[] {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cell += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

/** `09/04/2026` -> `2026-09-04`. */
export function mmddyyyyToDate(text: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/**
 * The whole year's curve in one fetch, which is why the daily pull is naturally
 * idempotent and a backfill is the identical call.
 *
 * Published as **percent** (3.91) and divided by 100 here, once, per 02 §0.1 —
 * the conversion happens at ingestion and nowhere else, so no reader ever has to
 * know which scale it is holding.
 */
export function ingestTreasuryYields(body: string, ctx: IngestContext): readonly IngestedRowSpec[] {
  const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0] as string);
  const tenorByIndex = new Map<number, string>();
  for (const [i, name] of header.entries()) {
    const tenor = TREASURY_HEADER_TO_TENOR[name.toLowerCase()];
    if (tenor) tenorByIndex.set(i, tenor);
  }

  const rows: IngestedRowSpec[] = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const curveDate = mmddyyyyToDate(cells[0] ?? '');
    if (curveDate === null) continue;

    for (const [i, tenor] of tenorByIndex) {
      const raw = cells[i];
      if (raw === undefined || raw === '') continue;
      const percent = Number(raw);
      if (!Number.isFinite(percent)) continue;

      rows.push({
        table: 'raw_treasury_yield',
        values: {
          run_id: ctx.runId,
          as_of_date: ctx.asOfDate,
          observed_at: ctx.observedAt,
          capture_rule_id: ctx.captureRuleId,
          curve_date: curveDate,
          tenor,
          yield: percent / 100,
          source: 'treasury'
        }
      });
    }
  }
  return rows;
}

// ── analyst recommendations ────────────────────────────────────────────────

interface FinnhubRecommendation {
  symbol?: string; period?: string;
  strongBuy?: number; buy?: number; hold?: number; sell?: number; strongSell?: number;
}

/**
 * Finnhub `/stock/recommendation` — confirmed free 2026-09-06, four months per call.
 *
 * `refusedSymbols` names answers the operator has ruled a **different issuer**
 * (`ref_provider_symbol_ruling`), and like the Form 4 widening it is carried in
 * the RECIPE rather than read from the table at replay time. A parser that
 * stores FEWER rows than are already stored breaks replay equality (AC-4 /
 * QC-951) exactly as one storing more does, and a ruling made today must not
 * retroactively change what a response captured last week parsed to. A
 * pre-ruling response's stored recipe has no `refusedSymbols` key and replays
 * to the rows it produced then; the rows it produced stay as evidence of what
 * Finnhub answered, which is what `provider_symbol` is for.
 *
 * Absence is UNRULED, not allowed-by-default-forever: an unruled mismatch is
 * stored and QC-909 reports it, because dropping a row on no evidence would
 * hide a feed gap behind silence.
 */
export function makeRecommendationIngest(opts: {
  readonly ticker: string;
  readonly refusedSymbols?: readonly string[];
}) {
  return (body: string, ctx: IngestContext): readonly IngestedRowSpec[] => {
    const parsed = JSON.parse(body) as FinnhubRecommendation[];
    if (!Array.isArray(parsed)) return [];

    const refused = new Set(opts.refusedSymbols ?? []);
    return parsed
      .filter((r) => typeof r.period === 'string' && r.period.length > 0)
      // A ruled different issuer writes nothing, so the asked ticker reads as
      // having no coverage — which is true, and QC-905 reports it as the gap it
      // is. The alternative is LLYVA and LLYVK quietly carrying FWONA's ratings.
      .filter((r) => !(typeof r.symbol === 'string' && refused.has(r.symbol)))
      .map((r) => ({
        table: 'raw_analyst_recommendation',
        values: {
          run_id: ctx.runId,
          as_of_date: ctx.asOfDate,
          observed_at: ctx.observedAt,
          capture_rule_id: ctx.captureRuleId,
          // What we asked, never what came back: Finnhub resolves some tickers to another listing
          // (GOOG -> GOOGL, LLYVA -> FWONA), and keying on its answer filed rows under tickers
          // nobody asked about. Its symbol is kept beside it for QC-909.
          ticker: opts.ticker,
          provider_symbol: r.symbol ?? null,
          period_month: r.period,
          // A count the provider omits is zero ratings of that kind, which is a
          // different fact from "no data" — but Finnhub sends all five on every
          // row, so an absent one is a provider change worth not smoothing over.
          strong_buy: r.strongBuy ?? 0,
          buy: r.buy ?? 0,
          hold: r.hold ?? 0,
          sell: r.sell ?? 0,
          strong_sell: r.strongSell ?? 0
        }
      }));
  };
}

// ── short interest ─────────────────────────────────────────────────────────

interface PolygonShortInterest {
  ticker?: string; settlement_date?: string; short_interest?: number;
  avg_daily_volume?: number; days_to_cover?: number;
}

/**
 * Short interest, from Polygon's `/stocks/v1/short-interest`. Finnhub's endpoint
 * is premium (403, measured 2026-09-06); Polygon's is on the plan — verified live
 * on 2026-09-14 (67,386 rows, newest settlement 2026-09-14). FINRA's own file
 * stays the fallback if that ever changes.
 *
 * `days_to_cover` is stored only when the source publishes it and is
 * deliberately never computed here: a derived value belongs in stage 2 where
 * its derivation carries a version.
 */
export function ingestShortInterest(body: string, ctx: IngestContext): readonly IngestedRowSpec[] {
  const parsed = JSON.parse(body) as { results?: PolygonShortInterest[] };
  return (parsed.results ?? [])
    .filter((s) => s.ticker && s.settlement_date && typeof s.short_interest === 'number')
    .map((s) => ({
      table: 'raw_short_interest',
      values: {
        run_id: ctx.runId,
        as_of_date: ctx.asOfDate,
        observed_at: ctx.observedAt,
        capture_rule_id: ctx.captureRuleId,
        ticker: s.ticker,
        settlement_date: s.settlement_date,
        short_interest: s.short_interest,
        avg_daily_volume: numberOrNull(s.avg_daily_volume),
        days_to_cover: numberOrNull(s.days_to_cover),
        source: 'polygon'
      }
    }));
}
