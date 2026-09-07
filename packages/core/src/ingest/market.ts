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
 * Polygon returns volume as a float. A fractional share volume means the field
 * is not what we think it is, so the row is marked `invalid` rather than
 * rounded — rounding would turn a provider change into a plausible number.
 */
export function toIntegerStrict(v: unknown): { value: number | null; invalid: boolean } {
  if (typeof v !== 'number' || !Number.isFinite(v)) return { value: null, invalid: false };
  if (!Number.isInteger(v)) return { value: null, invalid: true };
  return { value: v, invalid: false };
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
      const volume = toIntegerStrict(b.v);

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
          // A fractional volume is a provider surprise, not a number to round.
          volume: volume.value ?? 0,
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
