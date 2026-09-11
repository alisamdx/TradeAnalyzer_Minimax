import {
  checksFor,
  pilotExitStatus,
  promoteConfirmationText,
  promoteToProduction,
  recordCheckRuling,
  recordDomainInspection,
  thresholdReview,
  zeroFireReview,
  type Ruling,
  type RulingDecision,
  type SqliteLike
} from '@tradeanalyzer/core';
import { currentDb } from './generation.js';
import { operatorHost } from './operator.js';
import type {
  PilotListDto,
  PilotNeverFiredDto,
  PilotRulingDto,
  PilotStatusDto,
  PilotThresholdDto
} from '../shared/types.js';

/**
 * The pilot-exit view's main-process half — 03 §8, 05 §6, B10a.
 *
 * Every rule lives in `core` (`pilot-exit.ts`): which rulings fit which check,
 * what the checklist requires, the typed confirmation. This file only reshapes
 * `core`'s answers into the UI's vocabulary (AC-13 — the renderer names no
 * column, so `decision` arrives as `choice` and `review` as `list`).
 */

const db = (): SqliteLike => currentDb() as unknown as SqliteLike;

function ruling(r: Ruling | null): PilotRulingDto | null {
  return r
    ? { choice: r.decision, note: r.note, proposed: r.proposedThreshold, at: r.ruledAt, by: r.ruledBy }
    : null;
}

export function pilotStatus(): PilotStatusDto {
  const d = db();
  const s = pilotExitStatus(d, checksFor(d));
  return {
    generationNo: s.generationNo,
    generationStatus: s.generationStatus,
    promotedAt: s.pilotExitAt,
    lastEvaluatedDate: s.lastEvaluatedDate,
    streak: s.streak,
    streakTarget: s.streakTarget,
    conditions: s.conditions.map((c) => ({ key: c.key, met: c.met, detail: c.detail })),
    canPromote: s.canPromote,
    inspections: s.inspections.map((i) => ({ domain: i.domain, lastAt: i.lastAt, note: i.note })),
    replay: {
      sessionsSincePassing: s.replay.sessionsSincePassing,
      lastPassingAt: s.replay.lastPassingAt,
      differentDates: [...s.replay.differentDates]
    },
    confirmation: s.generationNo === null ? '' : promoteConfirmationText(s.generationNo)
  };
}

export function neverFired(): readonly PilotNeverFiredDto[] {
  return zeroFireReview(db()).map((z) => ({
    checkId: z.checkId,
    version: z.registryVersion,
    domain: z.domain,
    severity: z.severity,
    description: z.description,
    evaluatedTotal: z.evaluatedTotal,
    ruling: ruling(z.ruling)
  }));
}

export function thresholds(): readonly PilotThresholdDto[] {
  const d = db();
  return thresholdReview(d, checksFor(d)).map((t) => ({
    checkId: t.checkId,
    version: t.registryVersion,
    domain: t.domain,
    quantity: t.testedQuantity,
    unit: t.testedUnit,
    limit: t.threshold,
    basis: t.basis,
    needsRuling: t.needsRuling,
    runs: t.runs,
    n: t.n,
    min: t.min,
    max: t.max,
    p50: t.p50,
    p90: t.p90,
    p99: t.p99,
    nearBoundary: t.nearBoundary,
    decorative: t.decorative,
    bulkAgainst: t.bulkAgainst,
    extremes: t.extremes.map((e) => ({ key: e.key, value: e.value, runId: e.runId })),
    ruling: ruling(t.ruling)
  }));
}

export function rule(list: PilotListDto, checkId: string, choice: string, note: string, proposed: number | null): number {
  const d = db();
  return recordCheckRuling(d, operatorHost(), checksFor(d), {
    checkId,
    review: list === 'neverFired' ? 'zero_fire' : 'threshold',
    // `core` refuses a choice that does not answer the review, so the cast
    // carries no trust: an unknown value is refused there with its reason.
    decision: choice as RulingDecision,
    note,
    ...(proposed === null ? {} : { proposedThreshold: proposed })
  });
}

export function inspect(domain: string, note: string | null): number {
  return recordDomainInspection(db(), operatorHost(), { domain, ...(note ? { note } : {}) });
}

export function promote(confirmation: string): PilotStatusDto {
  const d = db();
  promoteToProduction(d, operatorHost(), checksFor(d), { confirmation });
  return pilotStatus();
}
