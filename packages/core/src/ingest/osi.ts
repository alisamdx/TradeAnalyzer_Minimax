/**
 * The OCC option symbol (OSI), constructed.
 *
 * **This is the one string in the hand-off that is built rather than received**,
 * and it has to match the `osiKey` E*Trade sends byte for byte — because
 * `ref_sticky_contract.osi_symbol` is matched against
 * `raw_option_contract_snapshot.osi_symbol` to decide what tomorrow's chain
 * phase captures. A padding difference would not throw: it would pin a contract
 * that never matches anything, so the sticky set would look populated and
 * capture nothing, which is the worst available failure.
 *
 * The format is taken from a real response, not from a specification:
 * `SPY   260918C00500000` — root left-aligned in **6** characters padded with
 * spaces, `YYMMDD`, `C` or `P`, then the strike in thousandths as **8** digits.
 */

export function osiSymbol(args: {
  readonly ticker: string;
  /** `YYYY-MM-DD`. */
  readonly expiration: string;
  readonly side: 'call' | 'put';
  readonly strike: number;
}): string {
  const root = args.ticker.toUpperCase().slice(0, 6).padEnd(6, ' ');

  const [y, m, d] = args.expiration.split('-');
  if (y === undefined || m === undefined || d === undefined) {
    throw new Error(`osiSymbol: expiration must be YYYY-MM-DD, got ${args.expiration}`);
  }
  const yymmdd = `${y.slice(2)}${m}${d}`;

  const cp = args.side === 'call' ? 'C' : 'P';

  // Thousandths, rounded rather than truncated: a strike stored as 42.499999
  // must not become 42.499. `Math.round` on the scaled value is the only step
  // where a float can drift, so it happens once and at the end.
  const thousandths = Math.round(args.strike * 1000);
  if (!Number.isFinite(thousandths) || thousandths < 0) {
    throw new Error(`osiSymbol: strike must be a non-negative number, got ${args.strike}`);
  }
  const strike = String(thousandths).padStart(8, '0');

  return `${root}${yymmdd}${cp}${strike}`;
}
