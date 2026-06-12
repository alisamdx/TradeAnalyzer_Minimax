// Beta computation from local historical_prices — no API cost.
// Beta = cov(stock daily returns, SPY daily returns) / var(SPY daily returns)
// over the last ~252 trading days, joined on date.
// see docs/formulas.md#beta

import type { DbHandle } from '../db/connection.js';

/** Minimum overlapping return observations for a meaningful beta. */
const MIN_OBSERVATIONS = 200;
/** Lookback window of joined close pairs (252 trading days ≈ 1 year). */
const LOOKBACK_ROWS = 253; // 253 closes → 252 returns

/**
 * Beta from paired daily returns. Pure function (unit-tested).
 * Returns null when there is not enough data or market variance is ~0.
 */
export function computeBeta(
  stockReturns: number[],
  marketReturns: number[],
  minObservations = MIN_OBSERVATIONS,
): number | null {
  const n = Math.min(stockReturns.length, marketReturns.length);
  if (n < minObservations) return null;

  let meanS = 0, meanM = 0;
  for (let i = 0; i < n; i++) { meanS += stockReturns[i]!; meanM += marketReturns[i]!; }
  meanS /= n; meanM /= n;

  let cov = 0, varM = 0;
  for (let i = 0; i < n; i++) {
    const ds = stockReturns[i]! - meanS;
    const dm = marketReturns[i]! - meanM;
    cov += ds * dm;
    varM += dm * dm;
  }
  if (varM < 1e-12) return null;
  return cov / varM;
}

export class BetaService {
  constructor(private readonly db: DbHandle) {}

  /**
   * 1-year daily beta vs SPY from local bars. Null when either series is too
   * short (new listings, sparse backfill) — never a synthesized value.
   */
  getBeta(ticker: string): number | null {
    try {
      type Row = { date: string; c: number };
      const sql = `
        SELECT date, COALESCE(adjusted_close, close) AS c
        FROM historical_prices
        WHERE ticker = ? AND COALESCE(adjusted_close, close) > 0
        ORDER BY date DESC LIMIT ?
      `;
      const stock = (this.db.prepare(sql).all(ticker.toUpperCase(), LOOKBACK_ROWS) as Row[]).reverse();
      const spy = (this.db.prepare(sql).all('SPY', LOOKBACK_ROWS) as Row[]).reverse();
      if (stock.length < MIN_OBSERVATIONS + 1 || spy.length < MIN_OBSERVATIONS + 1) return null;

      const spyByDate = new Map(spy.map(r => [r.date, r.c]));
      // Join on date so holidays/gaps in either series can't misalign returns.
      const pairsS: number[] = [];
      const pairsM: number[] = [];
      let prevS: number | null = null, prevM: number | null = null;
      for (const row of stock) {
        const m = spyByDate.get(row.date);
        if (m === undefined) continue;
        if (prevS !== null && prevM !== null) {
          pairsS.push(row.c / prevS - 1);
          pairsM.push(m / prevM - 1);
        }
        prevS = row.c; prevM = m;
      }

      const beta = computeBeta(pairsS, pairsM);
      return beta !== null ? Math.round(beta * 100) / 100 : null;
    } catch {
      return null;
    }
  }
}
