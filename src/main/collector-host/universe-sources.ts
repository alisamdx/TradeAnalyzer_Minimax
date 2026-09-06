import type { runUniverseSeed } from '@tradeanalyzer/core';

/**
 * Where the universe lists come from — NewApp 04 §4.1, capture rule `universe`.
 *
 * Host-side configuration rather than `core` logic: the *rule* ("these three
 * lists define the universe") is versioned in `meta_capture_rule`, but which
 * endpoint answers for each list is an environment detail, and putting it in
 * `core` would make the library know about a provider account.
 *
 * The measured expectation is **~1,089 distinct tickers** across ~1,587 rows:
 * the three lists overlap almost entirely. Discovery recorded 1,587 as the
 * universe size and every section inherited it until it was measured — the
 * figure was a row count, not a ticker count.
 */
type Sources = Parameters<typeof runUniverseSeed>[1]['sources'];

/** Polygon returns index constituents paged; every page carries `results[].ticker`. */
function parseTickers(body: string): readonly string[] {
  const parsed = JSON.parse(body) as { results?: { ticker?: string }[] };
  const tickers = (parsed.results ?? [])
    .map((r) => r.ticker)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
  if (tickers.length === 0) {
    // An empty list is refused rather than returned. `universe_seed` reconciles
    // membership against what it is given, so an empty set would close every
    // existing member — a total wipe caused by a shape change in a response.
    throw new Error('Universe list response contained no tickers.');
  }
  return tickers;
}

export const NEW_APP_UNIVERSE_SOURCES: Sources = [
  {
    listSource: 'sp500',
    endpoint: '/v3/reference/tickers',
    params: { market: 'stocks', active: 'true', limit: '1000', type: 'CS' },
    parse: parseTickers
  },
  {
    listSource: 'etf_list',
    endpoint: '/v3/reference/tickers',
    params: { market: 'stocks', active: 'true', limit: '1000', type: 'ETF' },
    parse: parseTickers
  }
];
