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
 * The format: root left-aligned in **6** characters padded with **dashes**,
 * `YYMMDD`, `C` or `P`, then the strike in thousandths as **8** digits —
 * `ACGL--260918C00095000`.
 *
 * **It padded with SPACES until 2026-09-15, and the warning above describes
 * exactly what happened.** The OCC specification pads with spaces and this
 * comment claimed a real response did too; E*Trade sends dashes. Measured that
 * night against captured bytes: `raw_option_contract_snapshot.osi_symbol`
 * (E*Trade's `osiKey`, stored verbatim) held `ACGL--260918C00095000` and
 * `BMNR--270115P00095000`, while `ref_sticky_contract.osi_symbol` (built here)
 * held `AIZ   261016C00280000`. So the equality join in QC-409 could not match
 * for **any** root shorter than six characters: every pin was unhonoured, the
 * count only ever grew (267 → 415 in a day, one per new recommendation), and
 * `sticky_reason` was never stamped on a captured contract.
 *
 * Nothing threw, and every test agreed with the bug, because each fixture spelt
 * `osiKey` the way this function did — a reader tested against a fixture written
 * from the reader. The test that means anything here uses a symbol copied out of
 * a provider response; see `osi.test.ts`.
 */

/** The character E*Trade pads a short root with. Measured, not specified. */
export const OSI_PAD = '-';

/** True of a symbol built by the pre-2026-09-15 space-padding, which matches nothing. */
export function hasLegacySpacePadding(osi: string): boolean {
  return osi.includes(' ');
}

/**
 * The six-character root E*Trade sends for a ticker: alphanumerics only, then
 * dash-padded.
 *
 * **A class-share dot is not part of it.** Measured 2026-09-18: every one of
 * 8,850 BRK.B contracts in `raw_option_contract_snapshot` arrived as `BRKB--…`,
 * while the pins built here read `BRK.B-…` — so QC-409 reported both BRK.B pins
 * unhonoured on a night their chain had been fetched and stored. OCC roots are
 * alphanumeric by specification; BRK.B is the only dotted ticker in the chain
 * subset, so the dot is the measured case and the rest is the specification.
 */
export function osiRoot(ticker: string): string {
  return ticker.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6).padEnd(6, OSI_PAD);
}

export function osiSymbol(args: {
  readonly ticker: string;
  /** `YYYY-MM-DD`. */
  readonly expiration: string;
  readonly side: 'call' | 'put';
  readonly strike: number;
}): string {
  const root = osiRoot(args.ticker);

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
