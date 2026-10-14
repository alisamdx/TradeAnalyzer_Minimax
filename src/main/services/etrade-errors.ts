/**
 * E*Trade API error messages: one format, built and parsed in the same file.
 *
 * `etradeGet` throws a plain `Error` whose message carries the HTTP status and the first
 * 300 bytes of E*Trade's error envelope. Callers decide on that message, so the format and
 * its parser live together here — a reader that drifts from the writer fails silently.
 */

/** The message `etradeGet` throws for a non-2xx response. */
export function etradeApiErrorMessage(status: number, path: string, body: string): string {
  return `E*Trade API error (${status}) at ${path}: ${body.slice(0, 300)}`;
}

/**
 * The E*Trade application error code in a thrown error, or null.
 *
 * Only an HTTP 400 carrying a numeric `<code>` qualifies. E*Trade can only send one after
 * it has accepted the request's OAuth signature and looked the request up, so the answer is
 * about the REQUEST, never about the token: a dormant token surfaces as a 401 or a killed
 * stream, never as an application code. Measured over 2026-10 (990 such responses):
 * 10032 "No options are available for this symbol" and 10033 "The symbol entered is
 * invalid", XML-bodied even on JSON requests.
 */
export function etradeApplicationErrorCode(err: unknown): string | null {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!message.startsWith('E*Trade API error (400)')) return null;
  const match = /<code>\s*(\d+)\s*<\/code>/.exec(message) ?? /"code"\s*:\s*"?(\d+)/.exec(message);
  return match ? match[1]! : null;
}

/**
 * Codes that answer for the whole ticker on that day, whatever expiration was asked.
 * 10031 (no chain for one expiration) is deliberately absent: it is about the date, not
 * the symbol. Verified 2026-09-14..10-13 in `logs/api`: no symbol that drew 10032 or 10033
 * returned a 200 chain on the same day, on any of 21 trading days.
 */
export const TICKER_WIDE_NO_OPTIONS_CODES: ReadonlySet<string> = new Set(['10032', '10033']);
