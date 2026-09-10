import type { IngestContext } from '../collector/capture.js';
import type { IngestedRowSpec } from '../collector/capture.js';

/**
 * Ingestion for `ext_iv_history` — IVolatility `/equities/eod/ivx` (04 §7.3, Q17).
 *
 * Pure and handed no database, like every ingest module: a fixture in gives
 * fixed rows out, forever, which is what makes replay reproducible (AC-4).
 *
 * **The unit is the whole risk here, and it is NOT established by a live read.**
 * NewApp's rule is that a parser is written after reading a real response, and
 * this one could not be — the subscription is a spend decision that has not been
 * taken. What exists instead is the existing app's evidence, and it is worth
 * stating exactly how strong it is:
 *
 * - `ivolatility-provider.ts` says in its own comment *"We don't know the exact
 *   field names until we test the API"* and tries nine candidate keys per field.
 * - `iv-history-service.ts:484` stores `row.iv30 * 100` into a percentage
 *   column, so the existing app treats the value as a **fraction**.
 * - Roughly 262k rows were loaded that way across a year and produced IV ranks
 *   nobody reported as absurd.
 *
 * That is good corroboration and it is not a measurement. So this parser
 * **refuses to guess**: it stores the number exactly as it arrives, and the job
 * reports how many fell outside the fraction band beside how many were stored.
 * Nothing is rescaled and nothing is dropped.
 *
 * **Specifically, it does NOT copy the existing parser's `n > 2 ? n / 100 : n`
 * heuristic.** A magnitude-based unit guess is untestable and fails silently in
 * the one case that matters: 200%+ implied vol is ordinary for a biotech binary
 * or a squeezed meme name, so that rule corrupts precisely the highest-vol
 * tickers — the ones a premium seller cares most about — and leaves a plausible
 * number behind. If IVolatility turns out to send percentages, every row of the
 * first load fails the band at once and says so, which is the loud failure this
 * trades for.
 */

/** 02 §0.1 stores fractions. There is deliberately no ×100 anywhere in this file. */
const IV_MIN = 0;
const IV_MAX = 5;

/** The field names the existing app found, most specific first. */
const IV30_KEYS = [
  '30d IV Mean',
  '30d IV Call',
  'iv30',
  'ivx30',
  'ivx_30d',
  'iv_30',
  'iv30d',
  'ivxm1',
  'iv1m'
] as const;

const DATE_KEYS = ['date', 'tradeDate', 'trade_date', 'Date', 'quoteDate'] as const;

/** The envelopes the existing app had to cope with. A bare array is one of them. */
const ARRAY_KEYS = ['data', 'rows', 'results', 'records', 'ivx'] as const;

export const IVX_METHOD_NOTE =
  'IVolatility IVX: vendor-computed 30-day constant-maturity at-the-money implied volatility, ' +
  'as an as-of-date snapshot. NOT the same construction as `derived_iv30_daily`, which ' +
  'interpolates total variance between the expirations bracketing 30 days from our own chain ' +
  'snapshots — the overlap therefore compares two methods, not two vendors.';

export function extractRows(raw: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw.filter(isRecord);
  if (!isRecord(raw)) return [];
  for (const key of ARRAY_KEYS) {
    const v = raw[key];
    if (Array.isArray(v)) return v.filter(isRecord);
  }
  return [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

function pickDate(row: Record<string, unknown>): string | null {
  for (const k of DATE_KEYS) {
    const v = row[k];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  }
  return null;
}

/**
 * The raw `iv30` **exactly as sent**, with no rescaling of any kind.
 *
 * A numeric string is parsed because JSON numbers arriving as strings is a
 * formatting choice, not a unit change. What is never done is inferring the
 * unit from the magnitude.
 */
export function pickIv30(row: Record<string, unknown>): number | null {
  for (const k of IV30_KEYS) {
    const v = row[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

export interface IvBootstrapIngestArgs {
  readonly ticker: string;
  readonly source: string;
  /** Written to every row so a lapsed subscription's data still says how it was made. */
  readonly methodNote?: string;
}

/**
 * Builds the ingest module for one ticker's date range.
 *
 * One response covers a whole range for a symbol, so a single call yields many
 * rows — which is why the bootstrap is roughly one call per ticker rather than
 * one per ticker-day.
 */
export function makeIvBootstrapIngest(args: IvBootstrapIngestArgs) {
  return (body: string, ctx: IngestContext): readonly IngestedRowSpec[] => {
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      // A body that is not JSON is a parse failure, reported as zero rows. The
      // archived response is still on disk to be looked at.
      return [];
    }

    const out: IngestedRowSpec[] = [];
    for (const row of extractRows(raw)) {
      const date = pickDate(row);
      if (date === null) continue; // a row with no date cannot be paired with anything

      const iv = pickIv30(row);
      if (iv === null) continue; // the tenor is genuinely absent for this day

      // **Out of band is stored, not corrected and not dropped.** Dropping
      // would make a systematic unit error look like sparse coverage;
      // correcting it would make the error invisible. The row goes in as sent
      // and the job reports `outOfBandCount` beside the row count, so a load
      // where the two are equal reads as what it is — a unit problem, not a
      // data-quality one.
      out.push({
        table: 'ext_iv_history',
        values: {
          run_id: ctx.runId,
          as_of_date: ctx.asOfDate,
          observed_at: ctx.observedAt,
          capture_rule_id: ctx.captureRuleId,
          source_response_id: ctx.sourceResponseId,
          ticker: args.ticker,
          date,
          iv30: iv,
          source: args.source,
          method_note: args.methodNote ?? IVX_METHOD_NOTE,
          load_run_id: ctx.runId,
          // **Loading is not accepting** (04 §7.3). Written explicitly rather
          // than defaulted, at the one place that could blur the distinction.
          accepted: 0,
          accepted_at: null,
          accepted_note: null
        }
      });
    }
    return out;
  };
}

/**
 * How many of a parsed response's values fall outside the fraction band.
 *
 * Exposed so the job can report it as a **count** rather than leaving the
 * operator to notice. A load where this equals the row count is not a data
 * quality problem, it is a unit problem, and those want opposite responses.
 */
export function outOfBandCount(raw: unknown): { total: number; outOfBand: number } {
  let total = 0;
  let outOfBand = 0;
  for (const row of extractRows(raw)) {
    const iv = pickIv30(row);
    if (iv === null) continue;
    total += 1;
    if (!(iv > IV_MIN && iv < IV_MAX)) outOfBand += 1;
  }
  return { total, outOfBand };
}
