/**
 * `derived_iv30_daily` — own-computed 30-day constant-maturity ATM implied
 * volatility (NewApp 02 §13, 04 §7.3, Q7).
 *
 * **The only derived table in stage 1**, and the reason it exists at all is that
 * IV rank is computed from a *window* of history: without an own-computed series
 * starting on day one, rank would depend permanently on a purchased bootstrap,
 * and the existing app's experience of splicing two IV sources with no overlap
 * is precisely what this rebuild is trying not to repeat.
 *
 * A **pure function of stored snapshot rows** (P4), deliberately. Nothing here
 * reads the database, calls a provider or looks at a clock, so the same inputs
 * give the same row forever and a stored value can be recomputed and compared
 * rather than trusted. Its inputs (`near_expiration`, `far_expiration`,
 * `near_iv`, `far_iv`) are stored beside the output for the same reason.
 *
 * **A gap is declared, never guessed.** `insufficient_expirations` and
 * `no_atm_quotes` are answers; an extrapolated number would not be. This is the
 * whole of the method's error handling — there is no fallback that produces a
 * value from data that cannot support one.
 */

/**
 * Bumped whenever the method changes — never a silent recompute (P4).
 *
 * A stored row records which version produced it, so two rows computed under
 * different methods can never be pooled without noticing.
 */
export const IV30_DERIVATION_VERSION = 1;

/** Constant maturity, in calendar days. DTE is calendar days here as everywhere. */
export const TARGET_DTE = 30;

/** The range `raw_option_contract_snapshot.iv` is already asserted against. */
const IV_MIN = 0;
const IV_MAX = 5;

export interface Iv30ContractRow {
  readonly expirationDate: string;
  readonly strike: number;
  readonly right: 'call' | 'put';
  readonly iv: number | null;
  readonly ivStatus: string;
}

export interface Iv30Input {
  readonly ticker: string;
  readonly asOfDate: string;
  readonly underlyingPrice: number;
  readonly contracts: readonly Iv30ContractRow[];
}

export interface Iv30Row {
  readonly ticker: string;
  readonly asOfDate: string;
  readonly iv30: number | null;
  readonly iv30Status: 'ok' | 'omitted' | 'invalid';
  readonly nearExpiration: string | null;
  readonly farExpiration: string | null;
  readonly nearIv: number | null;
  readonly farIv: number | null;
  readonly derivationVersion: number;
  readonly status: 'ok' | 'insufficient_expirations' | 'no_atm_quotes';
}

/**
 * Calendar days between two `YYYY-MM-DD` dates, **entirely in UTC**.
 *
 * One time base, start to finish. Mixing a local-clock weekday with a
 * `toISOString()` serialisation is what shifted every generated expiration onto
 * Saturday in the existing app and starved its agent of contracts for ten days
 * (CLAUDE.md). Nothing here touches the local clock, so there is no second base
 * for it to disagree with.
 */
function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  const from = Date.UTC(fy!, fm! - 1, fd!);
  const to = Date.UTC(ty!, tm! - 1, td!);
  return Math.round((to - from) / 86_400_000);
}

/**
 * At-the-money IV for one expiration: the **mid of call and put** at each of the
 * two strikes bracketing spot, interpolated across strike to spot itself.
 *
 * **Both legs are required at a strike for that strike to count**, and that is a
 * deliberate reading of an under-specified line. 02 §13 says "ATM = strikes
 * bracketing `underlying_price`, mid-IV of call and put" without saying what to
 * do when only one side quotes an IV. Falling back to the single available leg
 * would produce a number that is *sometimes* a call/put mid and *sometimes* a
 * one-sided reading, with nothing in the row to say which — and a quantity whose
 * definition varies invisibly between rows is the shape this project has been
 * bitten by repeatedly. Refusing yields `no_atm_quotes`, which is a fact the
 * status column can carry.
 *
 * The subset this runs over is chosen for liquidity, so both legs quoting at ATM
 * is the ordinary case; if measurement later shows otherwise, that is a
 * `derivation_version` bump, which is what the column is for.
 */
function atmIv(
  contracts: readonly Iv30ContractRow[],
  spot: number
): { iv: number } | { iv: null; reason: 'no_atm_quotes' } {
  const byStrike = new Map<number, { call?: number; put?: number }>();
  for (const c of contracts) {
    if (c.ivStatus !== 'ok' || c.iv === null || c.iv <= IV_MIN || c.iv >= IV_MAX) continue;
    const entry = byStrike.get(c.strike) ?? {};
    entry[c.right] = c.iv;
    byStrike.set(c.strike, entry);
  }

  const usable = [...byStrike.entries()]
    .filter(([, v]) => v.call !== undefined && v.put !== undefined)
    .map(([strike, v]) => ({ strike, mid: (v.call! + v.put!) / 2 }))
    .sort((a, b) => a.strike - b.strike);

  if (usable.length === 0) return { iv: null, reason: 'no_atm_quotes' };

  const below = [...usable].reverse().find((s) => s.strike <= spot);
  const above = usable.find((s) => s.strike >= spot);

  // Spot outside the quoted strike range is not an ATM reading. Clamping to the
  // nearest strike would silently substitute a deep-ITM or deep-OTM vol for an
  // at-the-money one, which is exactly the kind of quiet substitution the status
  // column exists to avoid.
  if (!below || !above) return { iv: null, reason: 'no_atm_quotes' };
  if (below.strike === above.strike) return { iv: below.mid };

  const w = (spot - below.strike) / (above.strike - below.strike);
  return { iv: below.mid + w * (above.mid - below.mid) };
}

/**
 * Interpolates **total variance linearly in time**, then converts back to a
 * volatility — the standard constant-maturity construction, and not the same
 * thing as interpolating the volatilities.
 *
 * `iv² · t` is the total variance to an expiration. Interpolating that quantity
 * and dividing by the target horizon preserves the invariant worth stating:
 * when both bracketing expirations carry the same vol, the answer is that vol
 * exactly, whatever the two maturities are. Interpolating vols directly happens
 * to satisfy that too, but diverges as soon as the term structure is not flat,
 * and it is variance that is additive in time.
 */
function interpolateVariance(
  nearIv: number,
  nearDte: number,
  farIv: number,
  farDte: number
): number {
  const nearVar = nearIv * nearIv * nearDte;
  const farVar = farIv * farIv * farDte;
  const w = (TARGET_DTE - nearDte) / (farDte - nearDte);
  const targetVar = nearVar + w * (farVar - nearVar);
  return Math.sqrt(targetVar / TARGET_DTE);
}

function gap(
  input: Iv30Input,
  status: 'insufficient_expirations' | 'no_atm_quotes'
): Iv30Row {
  return {
    ticker: input.ticker,
    asOfDate: input.asOfDate,
    iv30: null,
    iv30Status: 'omitted',
    nearExpiration: null,
    farExpiration: null,
    nearIv: null,
    farIv: null,
    derivationVersion: IV30_DERIVATION_VERSION,
    status
  };
}

/**
 * One ticker, one day, one row — including the days on which the answer is that
 * there is no answer.
 */
export function deriveIv30(input: Iv30Input): Iv30Row {
  // Expirations strictly in the future. A same-day expiration has zero time
  // value and its IV is meaningless as a term-structure point; an expiration in
  // the past is a data fault, and neither may become a bracketing endpoint.
  const byExpiration = new Map<string, Iv30ContractRow[]>();
  for (const c of input.contracts) {
    if (daysBetween(input.asOfDate, c.expirationDate) <= 0) continue;
    const list = byExpiration.get(c.expirationDate) ?? [];
    list.push(c);
    byExpiration.set(c.expirationDate, list);
  }

  // Only expirations that actually yield an ATM reading can serve as endpoints —
  // "there is an expiration at 24 days" is not the same as "we can price ATM
  // there", and choosing the endpoint before checking would turn a quotes
  // problem into a silently wrong interpolation over a further-out pair.
  const points = [...byExpiration.entries()]
    .map(([expiration, contracts]) => ({
      expiration,
      dte: daysBetween(input.asOfDate, expiration),
      atm: atmIv(contracts, input.underlyingPrice)
    }))
    .filter((p): p is { expiration: string; dte: number; atm: { iv: number } } => p.atm.iv !== null)
    .sort((a, b) => a.dte - b.dte);

  if (points.length === 0) {
    // Nothing could be priced at ATM anywhere in the chain. Distinguished from
    // "the chain had no usable pair", because they need different remedies:
    // this one is a quote-quality problem, the other a coverage problem.
    return gap(input, byExpiration.size === 0 ? 'insufficient_expirations' : 'no_atm_quotes');
  }

  const exact = points.find((p) => p.dte === TARGET_DTE);
  if (exact) {
    // A listed expiration sitting exactly on the horizon needs no interpolation,
    // and both stored endpoints are that expiration — the inputs still describe
    // how the number was reached.
    return {
      ticker: input.ticker,
      asOfDate: input.asOfDate,
      iv30: exact.atm.iv,
      iv30Status: inRange(exact.atm.iv) ? 'ok' : 'invalid',
      nearExpiration: exact.expiration,
      farExpiration: exact.expiration,
      nearIv: exact.atm.iv,
      farIv: exact.atm.iv,
      derivationVersion: IV30_DERIVATION_VERSION,
      status: 'ok'
    };
  }

  const near = [...points].reverse().find((p) => p.dte < TARGET_DTE);
  const far = points.find((p) => p.dte > TARGET_DTE);

  // **Never extrapolate.** A chain whose expirations all sit on one side of 30
  // days cannot say what 30-day vol is, and inventing it from the term structure
  // would produce a number indistinguishable from a measured one.
  if (!near || !far) return gap(input, 'insufficient_expirations');

  const iv30 = interpolateVariance(near.atm.iv, near.dte, far.atm.iv, far.dte);

  return {
    ticker: input.ticker,
    asOfDate: input.asOfDate,
    iv30: Number.isFinite(iv30) ? iv30 : null,
    iv30Status: Number.isFinite(iv30) && inRange(iv30) ? 'ok' : 'invalid',
    nearExpiration: near.expiration,
    farExpiration: far.expiration,
    nearIv: near.atm.iv,
    farIv: far.atm.iv,
    derivationVersion: IV30_DERIVATION_VERSION,
    status: 'ok'
  };
}

function inRange(iv: number): boolean {
  return iv > IV_MIN && iv < IV_MAX;
}
