import type { SqliteLike } from '../db/sqlite-like.js';

/**
 * The CIK every EDGAR lookup uses for a ticker (v1.1.331): SEC's own map where the latest capture
 * lists the ticker, else Polygon's reference CIK.
 *
 * One definition, as SQL, because it is read in two places that must never disagree: the collector
 * (which CIK to ask EDGAR about, and which ticker a filing belongs to) and the checks that join facts
 * and filings back to tickers (QC-603, QC-701, QC-702). Polygon gave FWONA, LLYVA and LLYVK the stale
 * CIK 0000869614 — the old Liberty Media Corporation, no 10-Q or 10-K — so every one of those lookups
 * was asked of the wrong filer.
 *
 * Only the LATEST SEC capture counts: a ticker SEC has stopped listing falls back to Polygon rather
 * than to an old SEC row, so a delisted or re-registered ticker cannot keep a CIK SEC no longer gives it.
 *
 * `tickerExpr` is a SQL expression naming the ticker (a column reference); it is interpolated, never
 * user input.
 */
export function effectiveCikSql(tickerExpr: string): string {
  return `COALESCE(
      (SELECT s.cik FROM raw_sec_ticker_map s
        WHERE s.ticker = ${tickerExpr}
          AND s.source_response_id = (SELECT MAX(source_response_id) FROM raw_sec_ticker_map)),
      (SELECT r.cik FROM raw_ticker_reference r WHERE r.ticker = ${tickerExpr} ORDER BY r.row_id DESC LIMIT 1))`;
}

/** Every active universe ticker's effective CIK, in ticker order. Tickers with none are omitted. */
export function effectiveCikByTicker(db: SqliteLike): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT u.ticker, ${effectiveCikSql('u.ticker')} AS cik
         FROM (SELECT DISTINCT ticker FROM ref_universe_membership WHERE valid_to IS NULL) u
        ORDER BY u.ticker`
    )
    .all() as { ticker: string; cik: string | null }[];
  const out = new Map<string, string>();
  for (const r of rows) if (r.cik) out.set(r.ticker, r.cik);
  return out;
}
