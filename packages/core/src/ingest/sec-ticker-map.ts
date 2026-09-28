import type { IngestContext, IngestedRowSpec } from '../collector/capture.js';
import { zeroPadCik } from './raw-ticker-reference.js';

/** Where SEC publishes its ticker → CIK map. One file, every registrant with a ticker. */
export const SEC_TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers.json';

/** SEC spells a class share with a dash (`BRK-B`); the universe uses a dot (`BRK.B`). */
export function secTickerToOurs(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/-/g, '.');
}

/**
 * SEC `company_tickers.json` → `raw_sec_ticker_map`, for the universe only (v1.1.331).
 *
 * The body is an OBJECT keyed "0", "1", … — not an array — whose values are
 * `{ cik_str: number, ticker: string, title: string }`. `cik_str` is a number despite its name,
 * so it is zero-padded here to match every other CIK in the schema. Measured 2026-09-27: it maps
 * FWONA to 1560385 and LLYVA/LLYVK to 2078416, where Polygon has 0000869614 for all three.
 *
 * Filtered to `universe` because the file lists ~10,000 registrants and nothing reads the rest;
 * the recipe carries the universe so a replay parses the same subset. One CIK per ticker: if SEC
 * ever lists a ticker twice, the first wins and the rest are dropped, since the natural key is
 * `(ticker, observed_at)`.
 */
export function makeSecTickerMapIngest(opts: { readonly universe: ReadonlySet<string> }) {
  return (body: string, ctx: IngestContext): readonly IngestedRowSpec[] => {
    const parsed = JSON.parse(body) as Record<string, { cik_str?: unknown; ticker?: unknown; title?: unknown }>;
    const rows: IngestedRowSpec[] = [];
    const seen = new Set<string>();
    for (const entry of Object.values(parsed ?? {})) {
      if (typeof entry?.ticker !== 'string' || entry.ticker.trim() === '') continue;
      const ticker = secTickerToOurs(entry.ticker);
      if (!opts.universe.has(ticker) || seen.has(ticker)) continue;
      const cik = zeroPadCik(entry.cik_str === undefined || entry.cik_str === null ? undefined : String(entry.cik_str));
      if (cik === null) continue;
      seen.add(ticker);
      rows.push({
        table: 'raw_sec_ticker_map',
        values: {
          run_id: ctx.runId,
          as_of_date: ctx.asOfDate,
          observed_at: ctx.observedAt,
          capture_rule_id: ctx.captureRuleId,
          ticker,
          cik,
          registrant: typeof entry.title === 'string' ? entry.title : ''
        }
      });
    }
    return rows;
  };
}
