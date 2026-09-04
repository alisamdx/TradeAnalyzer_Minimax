// E*Trade deep links.
//
// These are plain web URLs, not API calls — no auth, no rate limiter, nothing to sign. They exist
// so a pick in an email or a view is one tap away from the place the order actually gets placed.
//
// The two pages are NOT interchangeable and the casing differs between them, which is why this is
// a module rather than a string literal repeated at each call site:
//  - the snapshot quote page wants the symbol UPPERCASE
//  - the quotes-and-research options page (content=3 is the option-chain tab) wants it lowercase
//
// Callers building HTML must escape the returned URL (the options URL contains a bare `&`).

/** Snapshot quote page — price, chart, fundamentals. */
export function etradeQuoteUrl(ticker: string): string {
  return `https://us.etrade.com/etx/mkt/quotes?symbol=${encodeURIComponent(ticker.toUpperCase())}#/snapshot`;
}

/** Quotes & Research with the option-chain tab selected (`content=3`). */
export function etradeOptionsUrl(ticker: string): string {
  return `https://us.etrade.com/e/t/invest/quotesandresearch?content=3&sym=${encodeURIComponent(ticker.toLowerCase())}`;
}

/**
 * The options URL with `&` escaped, for embedding straight into an HTML attribute in a builder
 * that has no escaper of its own. (`etradeQuoteUrl` needs no equivalent — it has no `&`.)
 */
export function etradeOptionsHref(ticker: string): string {
  return etradeOptionsUrl(ticker).replace(/&/g, '&amp;');
}
