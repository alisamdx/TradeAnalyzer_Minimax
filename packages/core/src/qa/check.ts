import type { SqliteLike } from '../db/sqlite-like.js';

/**
 * What a check is — 03 §1.1, §3, §4.
 *
 * **The shape of this API is the P10 mechanism.** A magnitude check does not
 * decide whether it fired and report a boolean; it returns *every value it
 * measured*, and the framework computes the distribution, the near-boundary
 * count and the extreme keys from that. A check therefore **cannot** record
 * fires without also recording the distribution they came from — which is the
 * only way to tell a check that never fires from a check that cannot fire.
 *
 * The existing app shipped a conviction gate whose tested quantity could never
 * approach its threshold. It rejected 0 of 39 eligible picks over 62 briefs and
 * nobody noticed, because a gate that never fires is indistinguishable from a
 * gate nothing violates — unless you can see the distance to the boundary.
 */

export type Severity = 'info' | 'warning' | 'blocking';

/** The automatic remediations the gate may request (03 §6). Anything else is an operator action. */
export type RemediationCode = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7';

export interface CheckContext {
  readonly db: SqliteLike;
  readonly runId: number;
  readonly tradingDate: string;
  readonly observedAt: string;
}

/** One thing the check looked at. */
export interface Evaluation {
  /** Ticker, osi_symbol, order id or date, per 03 §5.3. */
  readonly key: string;
  /**
   * The magnitude compared against the threshold. **Required for a magnitude
   * check even when it did not fire** — the non-firing values are the
   * distribution, and the distribution is the point.
   */
  readonly value?: number;
  readonly fired: boolean;
  /** One line for the email and the exception detail. Only read when `fired`. */
  readonly detail?: string | undefined;
  readonly evidence?: Readonly<Record<string, unknown>> | undefined;
  /** Trading days this finding makes unusable. Defaults to the run's trading date. */
  readonly affects?: readonly string[] | undefined;
  /**
   * For an evaluation that did NOT fire: how to record closing an open finding with this key,
   * when the check itself holds the evidence that the finding was wrong (v1.1.277). QC-204 sets
   * it on a verified genuine move — the data was right and the check was wrong to flag it — so the
   * gate records `false_positive` with the check's reason, not `data_corrected`, which would say
   * the data had been fixed. QC-501, an alias of QC-204, sets it to close its own finding the way
   * QC-204's was closed (v1.1.278), `data_corrected` included — the evidence is QC-204's record.
   */
  readonly closesAs?: {
    readonly kind: 'data_corrected' | 'provider_fixed' | 'false_positive' | 'rule_changed';
    readonly note: string;
  } | undefined;
}

export interface CheckDefinition {
  readonly id: string;
  readonly domain: string;
  readonly severity: Severity;
  readonly description: string;
  readonly readsTables: readonly string[];
  /**
   * The name of the magnitude compared against the threshold. **Null means the
   * check tests a predicate, not a magnitude** — QC-001 through QC-005 are true
   * or false: a row either has provenance or it does not. That is the one
   * declared null meaning here, per P3, and the framework enforces the pairing:
   * a magnitude check must return values, a predicate check must not.
   */
  readonly testedQuantity: string | null;
  readonly testedUnit: string | null;
  /** Thresholds in force. Stored on the registry row, never a literal in the condition. */
  readonly thresholds: Readonly<Record<string, number>>;
  /**
   * How the threshold got its value, kept visible so nobody has to remember:
   *
   * - `measured` — from real data, with the evidence named.
   * - `working` — a placeholder, to be set from the pilot's own distributions.
   * - `structural` — zero by definition. "Any crossed quote at all is a
   *   finding" is not a number anyone chose, so calling it `working` would put
   *   it in the pilot's threshold-review queue forever.
   * - `not_applicable` — the check tests a predicate and has no magnitude.
   */
  readonly thresholdBasis: 'measured' | 'working' | 'structural' | 'not_applicable';
  /** Why the threshold is where it is, when it was measured. */
  readonly thresholdEvidence?: string;
  /** Which remediation the gate may request when this fires. */
  readonly remediation?: RemediationCode;
  /**
   * The shape of every key this check produces NOW, declared when its keying has changed
   * (v1.1.273). An open finding of this check that has stopped firing and whose key does not
   * match can never fire again — the check no longer produces keys like it — so the gate
   * resolves it as `rule_changed`, with actor `gate` and one event per finding. QC-410 was
   * keyed per contract until v1.1.252 and per ticker since, which left 11,468 contract-keyed
   * findings open with nothing able to close them: auto-resolve needs a successful
   * remediation, and there is none for a finding about a key that no longer exists. Findings
   * still firing are never retired, whatever their key.
   */
  readonly keyShape?: { readonly pattern: RegExp; readonly note: string };
  /**
   * Promotes the finding to blocking when the fired fraction exceeds this — a
   * cross-source drift is a warning per ticker and blocking when it affects
   * enough of them (03 §2).
   */
  readonly promoteToBlockingAtFiredFraction?: number;
  /**
   * Promotes when a fired evaluation's own **value** exceeds this.
   *
   * Distinct from the fired-fraction rule, and needed because some checks
   * aggregate to a single evaluation whose value already *is* the rate — the
   * invalid-IV fraction, the chain error rate. For those, "how many evaluations
   * fired" is always one and carries no information, so the fraction rule can
   * only ever promote everything or nothing. Both rules may be set; either one
   * promoting is enough.
   */
  readonly promoteToBlockingAtValue?: number;
  /**
   * `false` exempts the check from the consecutive-runs escalation (03 §5.4) (v1.1.328). This is for a
   * check that reports a persistent PROVIDER property, which is already handled per key where it is
   * consumed and cannot be fixed on this side. For such a check, "fired again tonight" is the expected
   * state, not new evidence. QC-410 (E*Trade Greeks computed off the wrong price, 60–80 tickers a
   * night) escalated about 25 tickers to blocking, and that held the chains domain `unusable`
   * permanently. It was the gate-wide RED that v1.1.252 had removed, back again one ticker at a time.
   * Findings already escalated drop to their base severity. Value and fraction promotion still apply.
   */
  readonly escalatesOnRepeat?: boolean;
  run(ctx: CheckContext): readonly Evaluation[];
}

export interface Distribution {
  readonly n: number;
  readonly min: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
  readonly threshold: number | null;
  /**
   * Evaluations within 25 % of the threshold.
   *
   * The number that answers "could this check ever fire". Zero near-boundary
   * evaluations across a large `n` means the threshold sits in an empty gap —
   * either nothing is wrong, or the check is decorative, and those two are
   * indistinguishable from the fired count alone.
   */
  readonly nearBoundary: number;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo] as number;
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

export function summarise(
  values: readonly number[],
  threshold: number | null
): Distribution | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const nearBoundary =
    threshold === null || threshold === 0
      ? 0
      : values.filter((v) => Math.abs(v - threshold) <= Math.abs(threshold) * 0.25).length;
  return {
    n: sorted.length,
    min: sorted[0] as number,
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1] as number,
    threshold,
    nearBoundary
  };
}

/** The single threshold a check's distribution is measured against, when it has one. */
export function primaryThreshold(def: CheckDefinition): number | null {
  const values = Object.values(def.thresholds);
  return values.length > 0 ? (values[0] as number) : null;
}

/**
 * Validates a check's own shape. Called for every registered check by a test,
 * so a malformed check is a build failure rather than a silently useless row.
 */
export function validateDefinition(def: CheckDefinition): readonly string[] {
  const problems: string[] = [];
  if (!/^QC-\d{3}$/.test(def.id)) problems.push(`${def.id}: id must look like QC-nnn`);
  if (def.description.trim().length < 20) problems.push(`${def.id}: description too thin`);
  if (def.readsTables.length === 0) problems.push(`${def.id}: declares no tables`);

  const isMagnitude = def.testedQuantity !== null;
  if (isMagnitude && def.testedUnit === null) {
    problems.push(`${def.id}: has a tested quantity but no unit for it`);
  }
  if (!isMagnitude && def.testedUnit !== null) {
    problems.push(`${def.id}: tests a predicate but declares a unit`);
  }
  if (isMagnitude && Object.keys(def.thresholds).length === 0) {
    problems.push(`${def.id}: measures ${def.testedQuantity} but declares no threshold to compare it against`);
  }
  if (isMagnitude && def.thresholdBasis === 'not_applicable') {
    problems.push(
      `${def.id}: a magnitude check must say where its threshold came from — measured, working, or structural`
    );
  }
  if (!isMagnitude && def.thresholdBasis !== 'not_applicable') {
    problems.push(`${def.id}: a predicate check has no threshold, so its basis must be not_applicable`);
  }
  if (def.thresholdBasis === 'measured' && !def.thresholdEvidence) {
    problems.push(`${def.id}: claims a measured threshold but names no evidence`);
  }
  return problems;
}
