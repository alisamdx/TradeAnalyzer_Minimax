import type { IngestContext } from '../collector/capture.js';

/**
 * Ingestion for `raw_ticker_reference` — Polygon `/v3/reference/tickers/{t}`.
 *
 * **Pure, and given no database handle** (04 §2.3). It cannot read or write
 * anything but its return value, which is what makes replay reproducible at the
 * byte level: a fixture in gives fixed rows out, forever.
 */

export interface IngestedRow {
  readonly table: string;
  readonly values: Readonly<Record<string, unknown>>;
}

interface PolygonTickerDetails {
  ticker?: string;
  name?: string;
  type?: string;
  primary_exchange?: string;
  sic_code?: string;
  sic_description?: string;
  market_cap?: number | null;
  weighted_shares_outstanding?: number | null;
  share_class_shares_outstanding?: number | null;
  cik?: string;
  composite_figi?: string;
  list_date?: string;
  active?: boolean;
}

/** Zero-pads a CIK to 10 digits, as EDGAR expects it (02 §2). */
export function zeroPadCik(cik: string | undefined): string | null {
  if (!cik) return null;
  const digits = cik.replace(/\D/g, '');
  return digits ? digits.padStart(10, '0') : null;
}

/**
 * Picks the share count and records **which field it came from**.
 *
 * Two different quantities wearing one column name is how a share count goes
 * quietly wrong, so the choice is stored per row rather than assumed. The
 * fallback is proven live on this plan (>= 95.8 % of the universe, measured
 * 2026-09-06), so the column populates regardless of how the primary resolves.
 */
export function pickShares(details: PolygonTickerDetails): {
  shares: number | null;
  source: 'weighted' | 'share_class' | null;
} {
  if (typeof details.weighted_shares_outstanding === 'number') {
    return { shares: details.weighted_shares_outstanding, source: 'weighted' };
  }
  if (typeof details.share_class_shares_outstanding === 'number') {
    return { shares: details.share_class_shares_outstanding, source: 'share_class' };
  }
  return { shares: null, source: null };
}

/** `ok` when present, `omitted` when the provider left it out (02 §0.3). */
function statusFor(value: unknown): 'ok' | 'omitted' {
  return value === null || value === undefined ? 'omitted' : 'ok';
}

export function ingestTickerReference(body: string, ctx: IngestContext): readonly IngestedRow[] {
  const parsed = JSON.parse(body) as { results?: PolygonTickerDetails };
  const d = parsed.results;
  if (!d?.ticker) return [];

  const { shares, source } = pickShares(d);
  const marketCap = typeof d.market_cap === 'number' ? d.market_cap : null;

  return [
    {
      table: 'raw_ticker_reference',
      values: {
        run_id: ctx.runId,
        as_of_date: ctx.asOfDate,
        observed_at: ctx.observedAt,
        capture_rule_id: ctx.captureRuleId,
        ticker: d.ticker,
        name: d.name ?? d.ticker,
        security_type: d.type ?? 'UNKNOWN',
        primary_exchange: d.primary_exchange ?? null,
        sic_code: d.sic_code ?? null,
        sic_description: d.sic_description ?? null,
        // Sector is derived from sic_code through the versioned ref_sic_sector
        // mapping, which does not exist until it is seeded. Null with a stated
        // meaning beats a guess.
        sector: null,
        market_cap: marketCap,
        market_cap_status: statusFor(marketCap),
        shares_outstanding: shares,
        shares_outstanding_status: statusFor(shares),
        shares_source: source,
        cik: zeroPadCik(d.cik),
        composite_figi: d.composite_figi ?? null,
        list_date: d.list_date ?? null,
        active: d.active === false ? 0 : 1,
        // Optionability is derived from the E*Trade expirations call, which is
        // made only for tickers already in the chain subset — so at reference
        // time it is genuinely not known, and `outside_window` says exactly
        // that. Writing 0 here would read as "does not list options".
        optionable: null,
        optionable_status: 'outside_window'
      }
    }
  ];
}
