// Bull put spread mode — profile, settings and result types.
// Design: NewApp/requirements/08-bull-put-spread-mode.md. Formulas: docs/formulas.md#bull-put-spread-mode

/** The trade profile, from the #43 study (model-priced, one replay — see 08 §2). */
export const SPREAD_MODE_PROFILE = {
  dteMin: 21,
  dteMax: 35,
  dteTarget: 30,
  // 0.20–0.40, nearest 0.30 (v1.1.292): the 0.25–0.35 band was narrower than one strike step in delta on
  // many names, so no strike fell inside it (12 of 80 first-week rejections on liquid DVN/EOG/COP/MDT).
  deltaMin: 0.20,
  deltaMax: 0.40,
  deltaTarget: 0.30,
  /** Long put distance below the SHORT strike, as a fraction of spot. */
  // The #43 study took the strike NEAREST short − 5% of spot. A 5–7.5% band rejected CF-like grids ($5 strikes at
  // ~$120: 4% or 8.3%, neither inside) — 13 of 80 first-week rejections. 3–10% bounds the nearest-strike rule (v1.1.292).
  wingMinPct: 0.03,
  wingMaxPct: 0.10,
  wingTargetPct: 0.05,
  /** Round-trip slippage (open + close, both legs) as a share of the mid credit. */
  maxCostShare: 0.25,
  minNetCredit: 0.05,
  /** Take profit when the spread can be bought back for this fraction of the net credit. */
  takeProfitAtDebitFraction: 0.5,
  topN: 5,
} as const;

/** Keys in the `settings` table. */
export const SPREAD_MODE_SETTING_KEYS = {
  mode: 'bullPutSpreadMode',
  maxLossPerPosition: 'bullPutSpreadMaxLossPerPosition',
  maxOpenPositions: 'bullPutSpreadMaxOpenPositions',
} as const;

/**
 * `off` — nothing runs. `shadow` — computed and stored after each brief, no panel, no email.
 * `on` (panel + email) is designed (08 §3.9) but not built: it is built when the §4 enable gate passes.
 */
export type SpreadModeSwitch = 'off' | 'shadow';

export interface SpreadModeSettings {
  mode: SpreadModeSwitch;
  maxLossPerPosition: number;
  maxOpenPositions: number;
}

/** Operator defaults (approved 2026-09-13): the study's placeholders until real numbers are set. */
export const SPREAD_MODE_DEFAULTS: SpreadModeSettings = {
  mode: 'shadow',
  maxLossPerPosition: 1000,
  maxOpenPositions: 10,
};

export interface SpreadLegQuote {
  strike: number;
  bid: number;
  ask: number;
  delta: number | null;
  openInterest: number | null;
}

/** Per share unless named total*. */
export interface SpreadConstruction {
  short: SpreadLegQuote;
  long: SpreadLegQuote;
  width: number;
  shortFill: number;
  longFill: number;
  midCredit: number;
  netCredit: number;
  maxLoss: number;
  returnOnRisk: number;
  breakeven: number;
  costShare: number;
  takeProfitDebit: number;
}

export interface SpreadModePick extends SpreadConstruction {
  ticker: string;
  rank: number;
  expiration: string;
  dte: number;
  spot: number;
  contracts: number;
  totalMaxLoss: number;
  /** Null for an ETF, which has no earnings. */
  earningsDate: string | null;
  criticVerdict: 'pass' | 'caution' | null;
}

export interface SpreadModeResult {
  mode: SpreadModeSwitch;
  briefGeneratedAt: string | null;
  considered: number;
  picks: SpreadModePick[];
  rejections: Array<{ ticker: string; reason: string }>;
  rowsWritten: number;
  /** Set when the run itself failed; the brief is never affected. */
  error: string | null;
}
