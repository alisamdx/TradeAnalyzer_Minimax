// E*Trade deep links.
//
// These are plain web URLs, not API calls — no auth, no rate limiter, nothing to sign. They exist
// so a pick in an email or a view is one tap away from the place the order actually gets placed.
//
// BOTH links point at `/e/t/invest/quotesandresearch`, which is E*Trade's PUBLIC quotes page: the
// `content` parameter picks the tab (absent = Snapshot, `3` = Options chain). The symbol is
// case-insensitive here; lowercase is used because that is what has shipped since the brief report
// first carried a chain link.
//
// DO NOT use the logged-in quote page `https://us.etrade.com/etx/mkt/quotes?symbol=X#/snapshot`,
// even though that is the URL in the address bar of a signed-in session. Hitting it without a
// session redirects to login with the target DOUBLE-ENCODED —
// `TARGET=...%2Fetx%2Fmkt%2Fquotes%253Fsymbol%253DMKC` — so `%3F` arrives as a literal character
// rather than a query separator, the page parses no symbol, and it renders
// "We couldn't find the symbol 'NULL'". An email link is opened from a phone as often as not, and
// a cold click is exactly the case that breaks. Verified 2026-09-04.
//
// Callers building HTML must escape the returned URL (the options URL contains a bare `&`).

const QUOTES_PAGE = 'https://us.etrade.com/e/t/invest/quotesandresearch';

/** Snapshot tab — price, bid/ask, day and 52-week range, fundamentals. Public, no login. */
export function etradeQuoteUrl(ticker: string): string {
  return `${QUOTES_PAGE}?sym=${encodeURIComponent(ticker.toLowerCase())}`;
}

/** Same page with the option-chain tab selected (`content=3`). Public, no login. */
export function etradeOptionsUrl(ticker: string): string {
  return `${QUOTES_PAGE}?content=3&sym=${encodeURIComponent(ticker.toLowerCase())}`;
}

/**
 * The options URL with `&` escaped, for embedding straight into an HTML attribute in a builder
 * that has no escaper of its own. (`etradeQuoteUrl` needs no equivalent — it has no `&`.)
 */
export function etradeOptionsHref(ticker: string): string {
  return etradeOptionsUrl(ticker).replace(/&/g, '&amp;');
}
