import type { SqliteLike } from '../db/sqlite-like.js';
import type { OperatorHost } from '../collector/host.js';
import type { CheckDefinition, Distribution } from './check.js';
import { primaryThreshold } from './check.js';
import { cleanDayStreak } from './gate.js';
import { OperatorActionRefused } from './operator.js';
import { unverifiedColumns } from '../dictionary/index.js';
import { backfillQueueClear } from '../collector/backfill.js';
import {
  REPLAY_MAX_AGE_TRADING_DAYS,
  latestReplayPerDate,
  sessionsSincePassingReplay
} from './checks/replay.js';

/**
 * Pilot exit — 03 §8, 05 §6, B10a.
 *
 * The pilot generation becomes production when it has run 20 clean trading days
 * AND a person has reviewed what the gate could not judge for itself: which
 * checks never fired, whether the working thresholds sit anywhere near the data
 * they were set against, and what each domain actually looks like. This module
 * computes the checklist, records the rulings, and performs the promotion.
 *
 * **Every condition is enforced here, not in the view.** The promote button is
 * disabled until the checklist is met, but `promoteToProduction` recomputes the
 * checklist and refuses on its own — a rule enforced by the form is enforced only
 * for the callers who use the form (the conviction bands the AI-review path wrote
 * around).
 */

export const PILOT_CLEAN_DAYS = 20;

export type RulingReview = 'zero_fire' | 'threshold';
export type ZeroFireDecision = 'keep' | 'fix' | 'drop';
export type ThresholdDecision = 'confirm' | 'move' | 'unmeasurable';
export type RulingDecision = ZeroFireDecision | ThresholdDecision;

const DECISIONS: Readonly<Record<RulingReview, readonly RulingDecision[]>> = {
  zero_fire: ['keep', 'fix', 'drop'],
  threshold: ['confirm', 'move', 'unmeasurable']
};

export interface Ruling {
  readonly rulingId: number;
  readonly decision: RulingDecision;
  readonly note: string;
  readonly proposedThreshold: number | null;
  readonly ruledAt: string;
  readonly ruledBy: string;
}

interface RegistryRow {
  check_id: string;
  registry_version: number;
  domain: string;
  default_severity: string;
  description: string;
  tested_quantity: string | null;
  tested_unit: string | null;
  thresholds_json: string;
  evaluated_total: number;
  fired_total: number;
}

function currentRegistry(db: SqliteLike): readonly RegistryRow[] {
  return db
    .prepare(
      `SELECT check_id, registry_version, domain, default_severity, description, tested_quantity, tested_unit,
              thresholds_json, evaluated_total, fired_total
         FROM qa_check_registry WHERE valid_to IS NULL ORDER BY check_id`
    )
    .all() as RegistryRow[];
}

function latestRuling(db: SqliteLike, checkId: string, version: number, review: RulingReview): Ruling | null {
  const r = db
    .prepare(
      `SELECT ruling_id, decision, note, proposed_threshold, ruled_at, ruled_by FROM qa_check_ruling
        WHERE check_id = ? AND registry_version = ? AND review = ?
        ORDER BY ruled_at DESC, ruling_id DESC LIMIT 1`
    )
    .get(checkId, version, review) as
    | { ruling_id: number; decision: RulingDecision; note: string; proposed_threshold: number | null; ruled_at: string; ruled_by: string }
    | undefined;
  return r
    ? { rulingId: r.ruling_id, decision: r.decision, note: r.note, proposedThreshold: r.proposed_threshold, ruledAt: r.ruled_at, ruledBy: r.ruled_by }
    : null;
}

// ── QC-952: the zero-fire review ─────────────────────────────────────────────

export interface ZeroFireItem {
  readonly checkId: string;
  readonly registryVersion: number;
  readonly domain: string;
  readonly severity: string;
  readonly description: string;
  readonly evaluatedTotal: number;
  readonly ruling: Ruling | null;
}

/**
 * Every check in force that has never fired, with its ruling if it has one.
 *
 * Listed with `evaluatedTotal` because zero fires over ten evaluations and zero
 * over ten thousand are different findings — the second is either a clean
 * system or a check that cannot fire, and that is what the ruling decides.
 */
export function zeroFireReview(db: SqliteLike): readonly ZeroFireItem[] {
  return currentRegistry(db)
    .filter((r) => r.fired_total === 0)
    .sort((a, b) => b.evaluated_total - a.evaluated_total || a.check_id.localeCompare(b.check_id))
    .map((r) => ({
      checkId: r.check_id,
      registryVersion: r.registry_version,
      domain: r.domain,
      severity: r.default_severity,
      description: r.description,
      evaluatedTotal: r.evaluated_total,
      ruling: latestRuling(db, r.check_id, r.registry_version, 'zero_fire')
    }));
}

// ── QC-955: the threshold review ─────────────────────────────────────────────

/** `lo`–`hi` bounds on a pooled quantile. */
export interface Bounds {
  readonly lo: number;
  readonly hi: number;
}

export type ShapeVerdict = 'yes' | 'no' | 'maybe';

export interface ThresholdItem {
  readonly checkId: string;
  readonly registryVersion: number;
  readonly domain: string;
  readonly testedQuantity: string;
  readonly testedUnit: string | null;
  readonly threshold: number | null;
  readonly basis: CheckDefinition['thresholdBasis'];
  /** True for a `working` (†) threshold — the ones 03 §8 step 2 requires a ruling on. */
  readonly needsRuling: boolean;
  /** Runs under this registry version that recorded a distribution. */
  readonly runs: number;
  readonly n: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly p50: Bounds | null;
  readonly p90: Bounds | null;
  readonly p99: Bounds | null;
  readonly nearBoundary: number;
  /** p99 below half the threshold: no observation came near it (the DINO shape). */
  readonly decorative: ShapeVerdict | null;
  /** p50 within ±25 % of the threshold: it fires on ordinary data (the liquidity-score shape). */
  readonly bulkAgainst: ShapeVerdict | null;
  readonly extremes: readonly { readonly key: string; readonly value: number; readonly runId: number }[];
  readonly ruling: Ruling | null;
}

/**
 * The pooled distribution of every magnitude check against its threshold.
 *
 * **The pooled quantiles are reported as BOUNDS, not estimates.** Each run
 * stores a summary (`p50`, `p90`, `p99`) rather than every value, and a pooled
 * quantile cannot be recovered from per-run quantiles. It can be bounded
 * exactly, though: the pooled distribution is a mixture of the runs', so its
 * q-quantile lies between the smallest and largest per-run q-quantile. The two
 * QC-955 shapes are then answered `yes` only when the whole bound satisfies the
 * rule, `no` only when none of it does, and `maybe` otherwise — so an
 * approximation can never be presented as a finding. Only runs under the
 * version in force are pooled: an older version measured against a different
 * threshold.
 */
export function thresholdReview(
  db: SqliteLike,
  checks: readonly CheckDefinition[]
): readonly ThresholdItem[] {
  const defs = new Map(checks.map((c) => [c.id, c]));
  const results = db.prepare(
    `SELECT r.run_id, r.distribution_json, r.extreme_keys_json
       FROM qa_check_result r
      WHERE r.check_id = ? AND r.registry_version = ? AND r.distribution_json IS NOT NULL
      ORDER BY r.run_id`
  );

  const out: ThresholdItem[] = [];
  for (const row of currentRegistry(db)) {
    if (row.tested_quantity === null) continue;
    const def = defs.get(row.check_id);
    if (!def) continue; // registered once, not in force in this build
    const thresholds = JSON.parse(row.thresholds_json) as Record<string, number>;
    const first = Object.values(thresholds)[0];
    const threshold = typeof first === 'number' ? first : primaryThreshold(def);

    const perRun = results.all(row.check_id, row.registry_version) as {
      run_id: number; distribution_json: string; extreme_keys_json: string | null;
    }[];
    const dists: Distribution[] = [];
    const extremes: { key: string; value: number; runId: number }[] = [];
    for (const r of perRun) {
      dists.push(JSON.parse(r.distribution_json) as Distribution);
      for (const e of r.extreme_keys_json ? (JSON.parse(r.extreme_keys_json) as { key: string; value: number }[]) : []) {
        if (typeof e.value === 'number') extremes.push({ key: e.key, value: e.value, runId: r.run_id });
      }
    }

    const bound = (pick: (d: Distribution) => number): Bounds | null =>
      dists.length === 0
        ? null
        : { lo: Math.min(...dists.map(pick)), hi: Math.max(...dists.map(pick)) };
    const p50 = bound((d) => d.p50);
    const p99 = bound((d) => d.p99);
    const judgeable = threshold !== null && threshold > 0;

    out.push({
      checkId: row.check_id,
      registryVersion: row.registry_version,
      domain: row.domain,
      testedQuantity: row.tested_quantity,
      testedUnit: row.tested_unit,
      threshold,
      basis: def.thresholdBasis,
      needsRuling: def.thresholdBasis === 'working',
      runs: dists.length,
      n: dists.reduce((s, d) => s + d.n, 0),
      min: dists.length ? Math.min(...dists.map((d) => d.min)) : null,
      max: dists.length ? Math.max(...dists.map((d) => d.max)) : null,
      p50,
      p90: bound((d) => d.p90),
      p99,
      nearBoundary: dists.reduce((s, d) => s + d.nearBoundary, 0),
      decorative:
        !judgeable || p99 === null
          ? null
          : p99.hi < threshold / 2 ? 'yes' : p99.lo >= threshold / 2 ? 'no' : 'maybe',
      bulkAgainst:
        !judgeable || p50 === null
          ? null
          : p50.lo >= threshold * 0.75 && p50.hi <= threshold * 1.25
            ? 'yes'
            : p50.hi < threshold * 0.75 || p50.lo > threshold * 1.25 ? 'no' : 'maybe',
      extremes: extremes.sort((a, b) => b.value - a.value).slice(0, 20),
      ruling: latestRuling(db, row.check_id, row.registry_version, 'threshold')
    });
  }
  return out;
}

// ── rulings and inspections ──────────────────────────────────────────────────

/**
 * Records a pilot-exit ruling on a check (03 §8 steps 1–2).
 *
 * Refused when the ruling does not fit the check — a zero-fire ruling on a check
 * that has fired, a threshold ruling on a threshold that is not `working`, a
 * `move` with no value — because a ruling written against the wrong premise is
 * worse than none: it makes the checklist read as done.
 */
export function recordCheckRuling(
  db: SqliteLike,
  host: OperatorHost,
  checks: readonly CheckDefinition[],
  args: {
    readonly checkId: string;
    readonly review: RulingReview;
    readonly decision: RulingDecision;
    readonly note: string;
    readonly proposedThreshold?: number;
  }
): number {
  const note = args.note.trim();
  if (note.length === 0) throw new OperatorActionRefused('A ruling needs a note saying why.');
  if (!DECISIONS[args.review]?.includes(args.decision)) {
    throw new OperatorActionRefused(
      `"${args.decision}" does not answer the ${args.review} review; the choices are ${DECISIONS[args.review]?.join(', ') ?? 'none'}.`
    );
  }

  let evidence: unknown;
  let version: number;
  let unit: string | null = null;

  if (args.review === 'zero_fire') {
    const item = zeroFireReview(db).find((z) => z.checkId === args.checkId);
    if (!item) {
      throw new OperatorActionRefused(`${args.checkId} is not on the zero-fire list — it has fired, or it is not in force.`);
    }
    version = item.registryVersion;
    evidence = { evaluatedTotal: item.evaluatedTotal, firedTotal: 0 };
  } else {
    const item = thresholdReview(db, checks).find((t) => t.checkId === args.checkId);
    if (!item) throw new OperatorActionRefused(`${args.checkId} does not test a magnitude, so it has no threshold to review.`);
    if (!item.needsRuling) {
      throw new OperatorActionRefused(
        `${args.checkId}'s threshold is ${item.basis}, not working — only working (†) thresholds are reviewed at pilot exit.`
      );
    }
    version = item.registryVersion;
    unit = item.testedUnit;
    const { ruling: _ruling, ...shown } = item;
    evidence = shown;
  }

  const proposed = args.proposedThreshold;
  if (args.decision === 'move') {
    if (proposed === undefined || !Number.isFinite(proposed)) {
      throw new OperatorActionRefused('A "move" ruling must say where the threshold should go.');
    }
  } else if (proposed !== undefined) {
    throw new OperatorActionRefused(`Only a "move" ruling carries a proposed threshold, not "${args.decision}".`);
  }

  const info = db
    .prepare(
      `INSERT INTO qa_check_ruling
         (check_id, registry_version, review, decision, note, proposed_threshold, proposed_unit, evidence_json, ruled_at, ruled_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      args.checkId,
      version,
      args.review,
      args.decision,
      note,
      args.decision === 'move' ? (proposed as number) : null,
      args.decision === 'move' ? unit : null,
      JSON.stringify(evidence),
      host.nowET(),
      `${host.hostApp.name} ${host.hostApp.version}`
    );
  return Number(info.lastInsertRowid);
}

/** The gate's domains — the set `qa_domain_day_status` is written for. */
export function gateDomains(db: SqliteLike): readonly string[] {
  return (
    db.prepare('SELECT DISTINCT domain FROM qa_check_registry WHERE valid_to IS NULL ORDER BY domain').all() as { domain: string }[]
  ).map((r) => r.domain);
}

/** Records that a person looked at a domain (D5, 03 §8 step 3). Appends; never edits. */
export function recordDomainInspection(
  db: SqliteLike,
  host: OperatorHost,
  args: { readonly domain: string; readonly note?: string }
): number {
  if (!gateDomains(db).includes(args.domain)) {
    throw new OperatorActionRefused(`"${args.domain}" is not a domain the gate reports on.`);
  }
  const note = args.note?.trim();
  const info = db
    .prepare('INSERT INTO meta_domain_inspection (domain, inspected_at, inspected_by, note) VALUES (?,?,?,?)')
    .run(args.domain, host.nowET(), `${host.hostApp.name} ${host.hostApp.version}`, note ? note : null);
  return Number(info.lastInsertRowid);
}

// ── the checklist ────────────────────────────────────────────────────────────

export type ConditionKey =
  | 'status' | 'streak' | 'zero_fire' | 'thresholds' | 'inspections' | 'expired_review' | 'verify_notes'
  | 'backfill_queue' | 'replay';

export interface Condition {
  readonly key: ConditionKey;
  readonly met: boolean;
  readonly detail: string;
}

export interface PilotExitStatus {
  readonly generationNo: number | null;
  readonly generationStatus: string | null;
  readonly pilotExitAt: string | null;
  /** The last trading day the gate recorded anything for; the streak is measured up to it. */
  readonly lastEvaluatedDate: string | null;
  readonly streak: number;
  readonly streakTarget: number;
  readonly zeroFire: { readonly total: number; readonly ruled: number; readonly fix: number; readonly drop: number };
  readonly thresholds: { readonly needingRuling: number; readonly ruled: number; readonly moves: number };
  readonly inspections: readonly { readonly domain: string; readonly lastAt: string | null; readonly note: string | null }[];
  readonly expiredReview: number;
  readonly verifyNotes: number;
  readonly replay: {
    readonly sessionsSincePassing: number | null;
    readonly lastPassingAt: string | null;
    readonly differentDates: readonly string[];
  };
  readonly conditions: readonly Condition[];
  readonly canPromote: boolean;
}

/**
 * `options.verifyNotes` overrides the dictionary's own count of columns still
 * carrying a verify note. It exists for tests: the real dictionary decides it,
 * and a test of the promotion path cannot otherwise run while any note remains.
 */
export interface PilotExitOptions {
  readonly verifyNotes?: number;
}

export function pilotExitStatus(
  db: SqliteLike,
  checks: readonly CheckDefinition[],
  options: PilotExitOptions = {}
): PilotExitStatus {
  const gen = db
    .prepare('SELECT generation_no, status, pilot_exit_at FROM meta_generation ORDER BY generation_no DESC LIMIT 1')
    .get() as { generation_no: number; status: string; pilot_exit_at: string | null } | undefined;

  const lastEvaluatedDate = (db.prepare('SELECT MAX(trading_date) AS d FROM qa_domain_day_status').get() as { d: string | null }).d;
  const streak = lastEvaluatedDate === null ? 0 : cleanDayStreak(db, lastEvaluatedDate);

  const zero = zeroFireReview(db);
  const zeroRuled = zero.filter((z) => z.ruling !== null);
  const reviewable = thresholdReview(db, checks).filter((t) => t.needsRuling);
  const thresholdsRuled = reviewable.filter((t) => t.ruling !== null);

  const lastInspection = db.prepare(
    'SELECT inspected_at, note FROM meta_domain_inspection WHERE domain = ? ORDER BY inspected_at DESC, inspection_id DESC LIMIT 1'
  );
  const inspections = gateDomains(db).map((domain) => {
    const r = lastInspection.get(domain) as { inspected_at: string; note: string | null } | undefined;
    return { domain, lastAt: r?.inspected_at ?? null, note: r?.note ?? null };
  });
  const uninspected = inspections.filter((i) => i.lastAt === null).map((i) => i.domain);

  const expiredReview = (
    db.prepare("SELECT COUNT(*) AS n FROM qa_exception WHERE state = 'expired_review'").get() as { n: number }
  ).n;
  const verifyNotes = options.verifyNotes ?? unverifiedColumns().length;

  // `backfillQueueClear` has documented itself as "a precondition on the pilot's
  // clean-day streak (04 §7.2)" since B5 and was **referenced by nothing** — the
  // precondition existed in a comment and in no code path. An unruled
  // ticker-reuse candidate means the bar history for that symbol still splices
  // two companies, and every indicator across the boundary inherits it silently;
  // promoting on that certifies a generation known to be wrong.
  //
  // What it covers: `reviewQueue` selects `blocking` rows, and QC-204 and QC-205
  // are both declared `blocking` in `checks/bars.ts`, so every open finding from
  // either is outstanding here. (This comment said they were warnings that
  // promote by value — corrected 2026-09-12 against the definitions. QC-205
  // had also never evaluated a single step until then: see `volumeOrNull`.)
  const backfill = backfillQueueClear(db);

  const differentDates = [...latestReplayPerDate(db)]
    .filter(([, r]) => r.verdict === 'different')
    .map(([d]) => d)
    .sort();
  const age = lastEvaluatedDate === null ? null : sessionsSincePassingReplay(db, lastEvaluatedDate);
  const replayCurrent =
    age !== null && age.lastPassing !== null && age.sessions <= REPLAY_MAX_AGE_TRADING_DAYS && differentDates.length === 0;

  const conditions: Condition[] = [
    {
      key: 'status',
      met: gen?.status === 'pilot',
      detail: gen ? `gen-${gen.generation_no} is ${gen.status}` : 'this file has no meta_generation row'
    },
    {
      key: 'streak',
      met: streak >= PILOT_CLEAN_DAYS,
      detail: `${streak} of ${PILOT_CLEAN_DAYS} consecutive clean trading days${lastEvaluatedDate ? ` up to ${lastEvaluatedDate}` : ''}`
    },
    {
      key: 'zero_fire',
      met: zeroRuled.length === zero.length,
      detail: `${zeroRuled.length} of ${zero.length} never-fired checks ruled on`
    },
    {
      key: 'thresholds',
      met: thresholdsRuled.length === reviewable.length,
      detail: `${thresholdsRuled.length} of ${reviewable.length} working thresholds ruled on`
    },
    {
      key: 'inspections',
      met: uninspected.length === 0,
      detail: uninspected.length === 0 ? `all ${inspections.length} domains inspected` : `not yet inspected: ${uninspected.join(', ')}`
    },
    {
      key: 'expired_review',
      met: expiredReview === 0,
      detail: expiredReview === 0 ? 'no expired acceptance awaits a ruling' : `${expiredReview} expired acceptance(s) await a ruling`
    },
    {
      key: 'verify_notes',
      met: verifyNotes === 0,
      detail: verifyNotes === 0 ? 'every column has been observed in a live response' : `${verifyNotes} column(s) still carry a verify note`
    },
    {
      key: 'backfill_queue',
      met: backfill.clear,
      detail: backfill.clear
        ? 'no unruled bar-history finding'
        : `${backfill.outstanding.length} unruled bar-history finding(s): ` +
          backfill.outstanding.map((o) => `${o.checkId} ${o.key}`).join(', ')
    },
    {
      key: 'replay',
      met: replayCurrent,
      detail:
        differentDates.length > 0
          ? `latest replay differs for ${differentDates.join(', ')}`
          : age === null
            ? 'no daily run yet'
            : age.lastPassing === null
              ? 'no replay has passed yet'
              : `last passing replay ${age.sessions} session(s) ago (at most ${REPLAY_MAX_AGE_TRADING_DAYS})`
    }
  ];

  return {
    generationNo: gen?.generation_no ?? null,
    generationStatus: gen?.status ?? null,
    pilotExitAt: gen?.pilot_exit_at ?? null,
    lastEvaluatedDate,
    streak,
    streakTarget: PILOT_CLEAN_DAYS,
    zeroFire: {
      total: zero.length,
      ruled: zeroRuled.length,
      fix: zeroRuled.filter((z) => z.ruling?.decision === 'fix').length,
      drop: zeroRuled.filter((z) => z.ruling?.decision === 'drop').length
    },
    thresholds: {
      needingRuling: reviewable.length,
      ruled: thresholdsRuled.length,
      moves: thresholdsRuled.filter((t) => t.ruling?.decision === 'move').length
    },
    inspections,
    expiredReview,
    verifyNotes,
    replay: {
      sessionsSincePassing: age?.sessions ?? null,
      lastPassingAt: age?.lastPassing?.finishedAt ?? null,
      differentDates
    },
    conditions,
    canPromote: conditions.every((c) => c.met)
  };
}

/**
 * Promotes the pilot generation to production (03 §8 step 4).
 *
 * Recomputes the checklist and refuses, naming every unmet condition, unless all
 * hold. The UPDATE is conditional on `status = 'pilot'`, so a second click, or a
 * reset racing it, changes nothing. The checklist as it stood is stored on the
 * row: the status says the generation was promoted, the evidence says on what.
 */
export function promoteConfirmationText(generationNo: number): string {
  return `promote gen-${String(generationNo).padStart(3, '0')}`;
}

export function promoteToProduction(
  db: SqliteLike,
  host: OperatorHost,
  checks: readonly CheckDefinition[],
  args: { readonly confirmation: string },
  options: PilotExitOptions = {}
): PilotExitStatus {
  const status = pilotExitStatus(db, checks, options);
  if (status.generationNo !== null) {
    const expected = promoteConfirmationText(status.generationNo);
    // Checked first: a mistyped confirmation should say so, not list conditions.
    if (args.confirmation.trim() !== expected) {
      throw new OperatorActionRefused(`Type "${expected}" exactly to confirm the promotion.`);
    }
  }
  if (!status.canPromote) {
    const unmet = status.conditions.filter((c) => !c.met).map((c) => c.detail);
    throw new OperatorActionRefused(`Not promoted — ${unmet.join('; ')}.`);
  }
  const evidence = {
    ...status,
    zeroFireRulings: zeroFireReview(db).map((z) => ({ checkId: z.checkId, version: z.registryVersion, rulingId: z.ruling?.rulingId })),
    thresholdRulings: thresholdReview(db, checks)
      .filter((t) => t.needsRuling)
      .map((t) => ({ checkId: t.checkId, version: t.registryVersion, rulingId: t.ruling?.rulingId }))
  };
  const info = db
    .prepare(
      `UPDATE meta_generation SET status = 'production', pilot_exit_at = ?, pilot_exit_evidence_json = ?
        WHERE generation_no = ? AND status = 'pilot'`
    )
    .run(host.nowET(), JSON.stringify(evidence), status.generationNo);
  if (info.changes !== 1) throw new OperatorActionRefused('Not promoted — the generation is no longer in pilot.');
  return pilotExitStatus(db, checks, options);
}
