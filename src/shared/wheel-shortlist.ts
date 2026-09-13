// Wheel Shortlist — shapes shared by the main process, the preload bridge and the renderer.
// Interim, advisory. see NewApp/requirements/07-opportunity-engine.md §3, docs/formulas.md#wheel-shortlist

import type { OwnAtStrikeRead } from './own-at-strike.js';

/** The operator's profile (07 §1, D2–D4). Changing it is a decision, not a tuning knob. */
export const SHORTLIST_PROFILE = {
  deltaMin: 0.35,
  deltaMax: 0.45,
  dteMin: 14,
  dteMax: 30,
  /** D3: roll when in the money with this many days or fewer left. */
  rollTriggerDte: 7,
  topN: 5,
} as const;

export interface ShortlistContract {
  expiration: string;
  dte: number;
  strike: number;
  bid: number;
  ask: number;
  mid: number;
  /** |delta| of the put. */
  delta: number;
  openInterest: number | null;
  /** (ask − bid) ÷ mid × 100. */
  spreadPct: number;
  /** mid ÷ strike × 365 ÷ DTE × 100 — the ranking key. */
  premiumRocAnnualPct: number;
}

/**
 * How far down a D3 credit roll could go at TODAY's prices: in the next expiry 7–30 days after the
 * chosen one, the lowest same-or-lower strike whose mid still covers the chosen contract's mid.
 * A proxy — at a real roll the put is in the money and costs more to buy back.
 */
export interface ShortlistRollRoom {
  expiration: string;
  /** Null when no same-or-lower strike covers the buy-back at today's prices. */
  strike: number | null;
  dollarsLower: number | null;
  strikesLower: number;
}

export interface ShortlistEntry {
  ticker: string;
  spot: number | null;
  /** Which brief pools the ticker came from (`wheel`, `income`). */
  strategies: string[];
  contract: ShortlistContract;
  /** mid × 100, per contract. */
  creditPerContract: number;
  /** strike × 100, per contract. Shown, never filtered on (D4). */
  capitalRequired: number;
  /** |delta| × 100. */
  assignmentProbPct: number;
  /** Null when the roll expiry could not be priced. */
  rollRoom: ShortlistRollRoom | null;
  earningsDate: string;
  ownership: OwnAtStrikeRead | null;
  /** The brief critic's verdict where one exists (critic runs on brief picks only). */
  criticVerdict: 'pass' | 'caution' | null;
}

export interface ShortlistResult {
  briefGeneratedAt: string | null;
  considered: number;
  entries: ShortlistEntry[];
  rejections: Array<{ ticker: string; reason: string }>;
  noResultReason: string | null;
}
