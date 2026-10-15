import type { IngestContext, IngestedRowSpec } from '../collector/capture.js';

/**
 * Ingestion for bars, quotes and corporate actions — 04 §2.3.
 *
 * All pure, all given no database handle. Determinism here is what makes replay
 * reproducible at the byte level (AC-4): a fixture in gives fixed rows out.
 */

/** One row an ingestion module produces, optionally with rows that depend on it. */
export type IngestedRow = IngestedRowSpec;

/** `ok` when present, `omitted` when the provider left it out (02 §0.3). */
function statusFor(v: unknown): 'ok' | 'omitted' {
  return v === null || v === undefined ? 'omitted' : 'ok';
}

/**
 * Polygon's daily `v`, exactly as sent, or null when there is no usable number.
 *
 * **It is fractional, routinely** — the count includes fractional-share trades.
 * The first version asserted integrality, treated a fraction as a provider
 * surprise, computed `invalid`, discarded it and wrote `volume.value ?? 0`. So
 * every fractional bar stored a plausible, wrong **zero** with nothing marking
 * it: gen-001's AAPL read `volume 0` beside `transactions 1,225,501`. That
 * zero then made QC-205 evaluate nothing on every run (it skips a zero median)
 * and made the chain subset's dollar volume `close × 0`, so it admitted nobody.
 * The old app's `leg.volume ?? 0`, re-made one layer down.
 */
export function volumeOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** ms epoch to a New York trading date. */
export function msEpochToEtDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(ms));
}

interface PolygonBar {
  t?: number; o?: number; h?: number; l?: number; c?: number;
  v?: number; vw?: number; n?: number;
}

export function makeBarIngest(opts: {
  readonly ticker: string;
  readonly fetchKind: 'backfill' | 'daily' | 'refetch_discontinuity' | 'refetch_manual';
  readonly adjustedAsOf: string;
  /** The date whose bar is not yet settled; anything on it is stored non-final. */
  readonly provisionalDate?: string;
}) {
  return (body: string, ctx: IngestContext): readonly IngestedRow[] => {
    const parsed = JSON.parse(body) as { results?: PolygonBar[] };
    const bars = parsed.results ?? [];
    const rows: IngestedRow[] = [];

    for (const b of bars) {
      if (typeof b.t !== 'number' || typeof b.c !== 'number') continue;
      const tradeDate = msEpochToEtDate(b.t);

      rows.push({
        table: 'raw_daily_bar',
        values: {
          run_id: ctx.runId,
          as_of_date: tradeDate,
          observed_at: ctx.observedAt,
          capture_rule_id: ctx.captureRuleId,
          ticker: opts.ticker,
          trade_date: tradeDate,
          open: b.o ?? b.c,
          high: b.h ?? b.c,
          low: b.l ?? b.c,
          close: b.c,
          // Null, never 0, when absent: "not reported" and "did not trade" are
          // different facts, and only one of them is a reason to refuse admission.
          volume: volumeOrNull(b.v),
          vwap: typeof b.vw === 'number' ? b.vw : null,
          transactions: typeof b.n === 'number' ? b.n : null,
          // The whole series is adjusted as of THIS fetch. That is the fact that
          // makes a later split visible as a discontinuity instead of invisible
          // as a silent rescale.
          adjusted_as_of: opts.adjustedAsOf,
          fetch_kind: opts.fetchKind,
          is_final: opts.provisionalDate === tradeDate ? 0 : 1
        }
      });
    }
    return rows;
  };
}

interface PolygonSnapshotTicker {
  ticker?: string;
  lastTrade?: { p?: number; s?: number; t?: number };
  lastQuote?: { p?: number; s?: number; P?: number; S?: number; t?: number };
  day?: { o?: number; h?: number; l?: number; c?: number; v?: number; vw?: number };
  prevDay?: { c?: number };
  updated?: number;
}

/** ns epoch to an ISO timestamp with the New York offset. */
export function nsEpochToEt(ns: number | undefined): string | null {
  if (typeof ns !== 'number' || !Number.isFinite(ns)) return null;
  const ms = ns > 1e15 ? ns / 1e6 : ns;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const utcMs = Date.UTC(
    Number(g('year')), Number(g('month')) - 1, Number(g('day')),
    Number(g('hour')) % 24, Number(g('minute')), Number(g('second'))
  );
  const offMin = Math.round((utcMs - d.getTime()) / 60_000);
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}` +
    `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** One snapshot call covers the whole universe, so this yields many rows. */
export function ingestSnapshot(body: string, ctx: IngestContext): readonly IngestedRow[] {
  const parsed = JSON.parse(body) as { tickers?: PolygonSnapshotTicker[] };
  const rows: IngestedRow[] = [];

  for (const t of parsed.tickers ?? []) {
    if (!t.ticker) continue;
    const quoteOk = t.lastQuote?.p !== undefined && t.lastQuote?.P !== undefined;
    const dayOk = t.day?.c !== undefined;

    rows.push({
      table: 'raw_eod_quote',
      values: {
        run_id: ctx.runId,
        as_of_date: ctx.asOfDate,
        observed_at: ctx.observedAt,
        capture_rule_id: ctx.captureRuleId,
        ticker: t.ticker,
        last: t.lastTrade?.p ?? null,
        last_status: statusFor(t.lastTrade?.p),
        last_size: t.lastTrade?.s ?? null,
        last_size_status: statusFor(t.lastTrade?.s),
        bid: quoteOk ? t.lastQuote?.p : null,
        bid_size: quoteOk ? (t.lastQuote?.s ?? null) : null,
        ask: quoteOk ? t.lastQuote?.P : null,
        ask_size: quoteOk ? (t.lastQuote?.S ?? null) : null,
        quote_status: quoteOk ? 'ok' : 'omitted',
        day_open: dayOk ? (t.day?.o ?? null) : null,
        day_high: dayOk ? (t.day?.h ?? null) : null,
        day_low: dayOk ? (t.day?.l ?? null) : null,
        day_close: dayOk ? t.day?.c : null,
        day_volume: dayOk ? (t.day?.v ?? null) : null,
        day_vwap: dayOk ? (t.day?.vw ?? null) : null,
        day_status: dayOk ? 'ok' : 'omitted',
        prev_close: t.prevDay?.c ?? null,
        prev_close_status: statusFor(t.prevDay?.c),
        quote_time: nsEpochToEt(t.lastQuote?.t),
        trade_time: nsEpochToEt(t.lastTrade?.t),
        snapshot_updated: nsEpochToEt(t.updated) ?? ctx.observedAt
      }
    });
  }
  return rows;
}

// ── E*Trade equity quotes (QC-303's bid/ask) ───────────────────────────────

interface EtradeEquityQuote {
  dateTimeUTC?: unknown;
  quoteStatus?: unknown;
  ahFlag?: unknown;
  All?: {
    bid?: unknown; bidSize?: unknown; bidTime?: unknown;
    ask?: unknown; askSize?: unknown; askTime?: unknown;
  };
  Product?: { symbol?: unknown };
}

/** E*Trade's `ahFlag` is the STRING `"true"`/`"false"` (live 2026-10-14). `Boolean("false")` is true. */
export function etradeTrueFalseToFlag(v: unknown): number | null {
  if (v === true || v === 'true') return 1;
  if (v === false || v === 'false') return 0;
  return null;
}

/**
 * E*Trade's `bidTime`/`askTime`: an ET wall-clock string with a zone label,
 * `19:59:57 EDT 10-14-2026` (live 2026-10-14). The label carries the offset, so
 * no timezone arithmetic is needed — and none should be: re-deriving it would be
 * a second opinion on a fact the provider already stated.
 */
export function etradeWallClockToEt(v: unknown): { value: string | null; status: 'ok' | 'omitted' | 'invalid' } {
  if (v === null || v === undefined || v === '') return { value: null, status: 'omitted' };
  const m = typeof v === 'string' ? /^(\d{2}):(\d{2}):(\d{2}) (EDT|EST) (\d{2})-(\d{2})-(\d{4})$/.exec(v.trim()) : null;
  if (!m) return { value: null, status: 'invalid' };
  const [, hh, mi, ss, zone, mo, dd, yyyy] = m;
  return { value: `${yyyy}-${mo}-${dd}T${hh}:${mi}:${ss}${zone === 'EDT' ? '-04:00' : '-05:00'}`, status: 'ok' };
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** ET timestamp from epoch SECONDS (E*Trade's `dateTimeUTC`). */
function secondsToEt(v: unknown): string | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? nsEpochToEt(v * 1000) : null;
}

/**
 * One batched E*Trade quote response (`/v1/market/quote/A,B,C`) to one row per
 * symbol asked. A result for a symbol that was not asked is dropped rather than
 * stored under its own name: the row is keyed on what was asked (v1.1.257), and
 * the phase counts asked-but-unanswered tickers from the rows that do exist.
 *
 * Each side's price has its own status, and sizes stand alone, so an after-hours
 * book showing only an ask keeps the ask.
 */
export function makeEtradeQuoteIngest(opts: { readonly symbols: readonly string[] }) {
  const asked = new Set(opts.symbols.map((s) => s.toUpperCase()));
  return (body: string, ctx: IngestContext): readonly IngestedRow[] => {
    const parsed = JSON.parse(body) as { QuoteResponse?: { QuoteData?: EtradeEquityQuote[] } };
    const rows: IngestedRow[] = [];
    const seen = new Set<string>();

    for (const q of parsed.QuoteResponse?.QuoteData ?? []) {
      const symbol = typeof q.Product?.symbol === 'string' ? q.Product.symbol.toUpperCase() : null;
      if (symbol === null || !asked.has(symbol) || seen.has(symbol)) continue;
      seen.add(symbol);

      const all = q.All ?? {};
      const bid = finiteOrNull(all.bid);
      const ask = finiteOrNull(all.ask);
      const bidTime = etradeWallClockToEt(all.bidTime);
      const askTime = etradeWallClockToEt(all.askTime);

      rows.push({
        table: 'raw_etrade_quote',
        values: {
          run_id: ctx.runId,
          as_of_date: ctx.asOfDate,
          observed_at: ctx.observedAt,
          capture_rule_id: ctx.captureRuleId,
          ticker: symbol,
          bid,
          bid_size: finiteOrNull(all.bidSize),
          bid_status: bid === null ? statusFor(all.bid) === 'ok' ? 'invalid' : 'omitted' : 'ok',
          ask,
          ask_size: finiteOrNull(all.askSize),
          ask_status: ask === null ? statusFor(all.ask) === 'ok' ? 'invalid' : 'omitted' : 'ok',
          bid_time: bidTime.value,
          bid_time_status: bidTime.status,
          ask_time: askTime.value,
          ask_time_status: askTime.status,
          ah_flag: etradeTrueFalseToFlag(q.ahFlag),
          provider_quote_state: typeof q.quoteStatus === 'string' && q.quoteStatus !== '' ? q.quoteStatus : null,
          provider_timestamp: secondsToEt(q.dateTimeUTC)
        }
      });
    }
    return rows;
  };
}

interface PolygonSplit {
  ticker?: string; execution_date?: string; split_from?: number; split_to?: number; id?: string;
}

export function ingestSplits(body: string, ctx: IngestContext): readonly IngestedRow[] {
  const parsed = JSON.parse(body) as { results?: PolygonSplit[] };
  return (parsed.results ?? [])
    .filter((s) => s.ticker && s.execution_date && s.id)
    .map((s) => ({
      table: 'raw_split',
      values: {
        run_id: ctx.runId,
        as_of_date: ctx.asOfDate,
        observed_at: ctx.observedAt,
        capture_rule_id: ctx.captureRuleId,
        ticker: s.ticker,
        execution_date: s.execution_date,
        split_from: s.split_from ?? 1,
        split_to: s.split_to ?? 1,
        provider_id: s.id
      }
    }));
}

interface PolygonDividend {
  ticker?: string; ex_dividend_date?: string; record_date?: string; pay_date?: string;
  declaration_date?: string; cash_amount?: number; currency?: string; frequency?: number;
  dividend_type?: string; id?: string;
}

export function ingestDividends(body: string, ctx: IngestContext): readonly IngestedRow[] {
  const parsed = JSON.parse(body) as { results?: PolygonDividend[] };
  return (parsed.results ?? [])
    .filter((d) => d.ticker && d.ex_dividend_date && d.id && typeof d.cash_amount === 'number')
    .map((d) => ({
      table: 'raw_dividend',
      values: {
        run_id: ctx.runId,
        as_of_date: ctx.asOfDate,
        observed_at: ctx.observedAt,
        capture_rule_id: ctx.captureRuleId,
        ticker: d.ticker,
        ex_dividend_date: d.ex_dividend_date,
        record_date: d.record_date ?? null,
        pay_date: d.pay_date ?? null,
        declaration_date: d.declaration_date ?? null,
        cash_amount: d.cash_amount,
        currency: d.currency ?? 'USD',
        frequency: typeof d.frequency === 'number' ? d.frequency : null,
        dividend_type: d.dividend_type ?? 'CD',
        provider_id: d.id
      }
    }));
}
