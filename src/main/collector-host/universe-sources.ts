import type { Database } from 'better-sqlite3';
import type { runUniverseSeed } from '@tradeanalyzer/core';

/**
 * Where the universe lists come from — NewApp 04 §4.1, capture rule `universe`.
 *
 * Host-side configuration rather than `core` logic: the *rule* ("these three
 * lists define the universe") is versioned in `meta_capture_rule`, but which
 * source answers for each list is an environment detail, and putting it in
 * `core` would make the library know about this application's schema.
 *
 * **They come from this application's own `constituents` table** — 503 S&P 500,
 * 1,024 Russell 1000 and 60 ETFs, **1,089 distinct across 1,587 rows**, exactly
 * the figure 04 §4.1 records. The `constituents-refresh` job already maintains
 * them (Vanguard-first, with CSV import as the manual override), so the
 * collector reads what is already curated rather than re-deriving it.
 *
 * ---
 *
 * **This replaced a Polygon-query version on 2026-09-07, and the way it was
 * wrong is worth keeping written down.** The first version asked Polygon for
 * `market=stocks&type=CS` and `type=ETF` with `limit=1000`, under the list names
 * `sp500` and `etf_list`. Two independent faults, compounding:
 *
 * 1. **No index filter at all.** Polygon has no index-membership endpoint on
 *    this plan, so the query returned *every* US common stock — the names were
 *    aspirational, and nothing in the code or the response contradicted them.
 * 2. **No paging.** `limit=1000` returns one page; Polygon pages with
 *    `next_url`. The parser read a single `results[]` and stopped.
 *
 * Run live it produced **2,000 tickers in alphabetical order, A through DBND**,
 * including `AAAA`, `AACI` and every microcap in between — while **MSFT, NVDA,
 * TSLA, SPY, GOOGL, META, JPM, XOM and WMT were all absent.** Every call
 * returned HTTP 200 and the job reported success. It is the same
 * capped-response trap already recorded for Finnhub's earnings calendar: *a
 * response at the cap is not a complete answer*, and here nothing even looked at
 * the cap.
 *
 * The correct lists were never remote.
 */
type Sources = Parameters<typeof runUniverseSeed>[1]['sources'];

/** The three lists, and the `constituents.index_name` each reads. */
const LISTS = [
  { listSource: 'sp500', indexName: 'sp500' },
  { listSource: 'russell1000', indexName: 'russell1000' },
  { listSource: 'etf_list', indexName: 'etf' }
] as const;

/**
 * A list is refused when empty rather than returned.
 *
 * `universe_seed` reconciles membership against what it is given, so an empty
 * set would **close every existing member** — a total wipe caused by a table
 * that had not been refreshed yet. The seed has its own guard for losing every
 * list; this one keeps a single empty list from silently shrinking the universe.
 */
function readList(db: Database, indexName: string): readonly string[] {
  const rows = db
    .prepare('SELECT DISTINCT ticker FROM constituents WHERE index_name = ? ORDER BY ticker')
    .all(indexName) as { ticker: string }[];
  const tickers = rows.map((r) => r.ticker).filter((t) => typeof t === 'string' && t.length > 0);
  if (tickers.length === 0) {
    throw new Error(
      `constituents holds no tickers for index_name='${indexName}'. Refusing to return an empty ` +
        'list: membership reconciliation would read it as "every member of this list has left".'
    );
  }
  return tickers;
}

export function newAppUniverseSources(db: Database): Sources {
  const observedAt = new Date().toISOString();

  return LISTS.map(({ listSource, indexName }) => ({
    listSource,
    // Not a URL, and deliberately not shaped like one: this row in the archive
    // index should read as "the host's own list", not as a call that never
    // happened.
    endpoint: `host:constituents/${indexName}`,
    params: { index_name: indexName, source: 'constituents' },
    provider: 'host_app' as const,

    /**
     * Serialises what this application already holds.
     *
     * Still archived and digested like any provider response (P2, AC-1) — the
     * archive records *what we were given*, and the host's curated list as of
     * this moment is a legitimate answer to that. A later replay reads these
     * bytes rather than re-querying a table that will have moved on.
     */
    fetch: async () => {
      const tickers = readList(db, indexName);
      return {
        status: 200,
        body: JSON.stringify({ indexName, observedAt, count: tickers.length, tickers }),
        requestedAt: observedAt,
        respondedAt: new Date().toISOString()
      };
    },

    parse: (body: string): readonly string[] => {
      const parsed = JSON.parse(body) as { tickers?: unknown };
      const tickers = Array.isArray(parsed.tickers)
        ? parsed.tickers.filter((t): t is string => typeof t === 'string' && t.length > 0)
        : [];
      if (tickers.length === 0) {
        throw new Error(`Universe list '${indexName}' parsed to no tickers.`);
      }
      return tickers;
    }
  }));
}
