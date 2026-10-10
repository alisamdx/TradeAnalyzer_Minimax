/**
 * Daily closes (and, when asked, `iv_history`) for a list of tickers, served through
 * GET /diagnostics/price-series so study scripts never open `trade-analyzer.sqlite` themselves
 * (see brief-history-panel.ts for why). First caller: scripts/fr-expiry-realized-ab.mjs.
 *
 * Returns the rows the script's SQL selected, unchanged in meaning: `[date, close]` ordered by
 * date within [from, to], and `[date, atm_iv]` exactly as stored with `atm_iv > 0` (the caller
 * decides percent vs decimal). A ticker with no rows is present with an empty list, not absent,
 * so "asked and nothing stored" is visible. `maxPx` is MAX(date) across the whole table, which
 * is what the script used to bound its panel.
 *
 * Read-only: SELECTs only.
 */

import type { PanelDb } from './settled-csp-panel';

export type SeriesBar = readonly [string, number];
export type SeriesIv = readonly [string, number];

export interface PriceSeriesPanel {
  readonly maxPx: string | null;
  readonly bars: Readonly<Record<string, readonly SeriesBar[]>>;
  readonly iv: Readonly<Record<string, readonly SeriesIv[]>> | null;
}

/** Most tickers one request may ask for; the fr-* panels top out around 600. */
export const MAX_SERIES_TICKERS = 2000;

export function priceSeriesPanel(
  db: PanelDb,
  tickers: readonly string[],
  from: string,
  to: string,
  includeIv: boolean,
): PriceSeriesPanel {
  const maxPx = (db.prepare('SELECT MAX(date) AS d FROM historical_prices').get() as { d: string | null } | undefined)?.d ?? null;
  const barsStmt = db.prepare('SELECT date, close FROM historical_prices WHERE ticker = ? AND date >= ? AND date <= ? ORDER BY date');
  const ivStmt = db.prepare('SELECT date, atm_iv FROM iv_history WHERE ticker = ? AND atm_iv > 0 ORDER BY date');

  const bars: Record<string, SeriesBar[]> = {};
  const iv: Record<string, SeriesIv[]> = {};
  for (const ticker of new Set(tickers)) {
    bars[ticker] = (barsStmt.all(ticker, from, to) as { date: string; close: number }[]).map((b) => [b.date, b.close] as const);
    if (includeIv) iv[ticker] = (ivStmt.all(ticker) as { date: string; atm_iv: number }[]).map((r) => [r.date, r.atm_iv] as const);
  }
  return { maxPx, bars, iv: includeIv ? iv : null };
}
