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
  /**
   * At most this many open positions per sector (operator, 2026-09-19, 08 S9). Simulated in the shadow
   * report (spread-mode-settle.ts); the `on` mode enforces it when built. Not applied to shadow picks.
   */
  maxOpenPerSector: 3,
} as const;

/** Keys in the `settings` table. */
export const SPREAD_MODE_SETTING_KEYS = {
  mode: 'bullPutSpreadMode',
  maxLossPerPosition: 'bullPutSpreadMaxLossPerPosition',
  maxOpenPositions: 'bullPutSpreadMaxOpenPositions',
  maxOpenPerSector: 'bullPutSpreadMaxOpenPerSector',
} as const;

/** Bounds the Settings screen and `writeSpreadModeSettings` both enforce. */
export const SPREAD_MODE_LIMITS = {
  maxLossPerPosition: { min: 50, max: 1_000_000 },
  maxOpenPositions: { min: 1, max: 100 },
  maxOpenPerSector: { min: 1, max: 100 },
} as const;

/**
 * `off` — nothing runs. `shadow` — computed and stored after each brief, no panel, no email.
 * `on` (panel + email) is designed (08 §3.9) but not built: it is built when the §4 enable gate passes.
 */
export type SpreadModeSwitch = 'off' | 'shadow';

/**
 * The candidate pools the mode builds spreads from, run side by side in shadow (08 S11, v1.1.301).
 *
 * `wheel` is the incumbent — and every number in the #43 study was measured on wheel-selected names, so
 * that evidence is a statement about spreads *on stocks the wheel screen liked*. `income` is the
 * challenger: no ownership weight at all, where wheel spends 21% on fundamentals + leverage because an
 * assigned CSP means you own the stock, which a defined-risk spread never does.
 *
 * Both run because switching would forfeit the comparison permanently, the same way the `iv_history`
 * splice joined two sources with zero overlapping days and left nothing able to separate them.
 */
export const SPREAD_MODE_POOLS = ['wheel', 'income'] as const;
export type SpreadPool = (typeof SPREAD_MODE_POOLS)[number];

/**
 * The pool the 08 §4 enable gate is judged on. It stays `wheel` while the comparison runs: letting the
 * gate follow whichever arm looks better would change what it measures mid-sample, which is the seam the
 * whole exercise exists to avoid.
 */
export const SPREAD_GATE_POOL: SpreadPool = 'wheel';

export interface SpreadModeSettings {
  mode: SpreadModeSwitch;
  maxLossPerPosition: number;
  maxOpenPositions: number;
  /** At most this many open positions per sector. Simulated in the shadow report; `on` will enforce it. */
  maxOpenPerSector: number;
}

/**
 * Operator defaults. Max loss per position set by the operator 2026-09-19 (08 §6 Q1): 10% of a
 * $25,000 account = $2,500 (was the study's $1,000 placeholder). Max open positions is still the
 * placeholder, and is guidance only until the `on` mode enforces it.
 */
export const SPREAD_MODE_DEFAULTS: SpreadModeSettings = {
  mode: 'shadow',
  maxLossPerPosition: 2500,
  maxOpenPositions: 10,
  maxOpenPerSector: 3,
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
  /**
   * Contracts at the per-position budget. **Zero means the budget could not afford one**, which `shadow`
   * records rather than rejects (08 §3.5, S10) so the evidence survives; `on` rejects instead, so a stored
   * zero is by construction a shadow row and is the affordability flag. Never a divisor.
   */
  contracts: number;
  /** `contracts × maxLoss × 100` — so zero for a pick the budget could not afford. */
  totalMaxLoss: number;
  /** Null for an ETF, which has no earnings. */
  earningsDate: string | null;
  criticVerdict: 'pass' | 'caution' | null;
}

export interface SpreadModeResult {
  mode: SpreadModeSwitch;
  /** Which candidate pool this run built from. */
  pool: SpreadPool;
  briefGeneratedAt: string | null;
  considered: number;
  picks: SpreadModePick[];
  rejections: Array<{ ticker: string; reason: string }>;
  rowsWritten: number;
  /** Set when the run itself failed; the brief is never affected. */
  error: string | null;
}

// ── Shadow report (src/main/services/spread-mode-settle.ts; the Spread Shadow view) ──────────────

/** One shadow position as the settler sees it. Per share. */
export interface ShadowPick {
  id: number;
  asOfDate: string;
  slot: 'intraday' | 'after_close';
  ticker: string;
  expiration: string;
  spot: number;
  shortStrike: number;
  longStrike: number;
  netCredit: number;
  maxLoss: number;
}

export type SpreadSettlement =
  | { status: 'open'; marks: number; gaps: number; lastMarkDate: string | null; lastMidDebit: number | null }
  | { status: 'target'; exitDate: string; exitSlot: string; exitDebit: number; returnOnMaxLoss: number; daysHeld: number; marks: number; gaps: number }
  | { status: 'expired'; exitDate: string; expiryClose: number; exitDebit: number; returnOnMaxLoss: number; daysHeld: number; marks: number; gaps: number }
  | { status: 'unsettleable'; reason: string; marks: number; gaps: number };

export interface ShadowPickRow extends ShadowPick {
  /** The candidate pool that produced this position (08 S11). */
  pool: SpreadPool;
  rank: number | null;
  dte: number | null;
  /** Later picks of the same ticker within EPISODE_DAYS of this entry, collapsed into it. */
  repeats: number;
  settlement: SpreadSettlement;
  /** From `constituents.sector`; null when unknown (each such ticker is its own bucket for the cap). */
  sector: string | null;
  /** True when a book capped at `maxOpenPerSector` would NOT have opened this position. */
  sectorCapSkipped: boolean;
  /**
   * False when one contract cost more than the per-position budget on the day it was picked, so a real
   * book could not have opened it. Shadow keeps these (08 S10) — they are evidence about the strategy,
   * whose return is a ratio, but not about this account. Stored as `contracts = 0`.
   */
  affordable: boolean;
}

/** One book's result: every position, or the sector-capped subset. */
export interface BookSummary {
  positions: number;
  settled: number;
  meanReturnOnMaxLoss: number | null;
  winRate: number | null;
}

/**
 * The leg-selection band, so a stored rejection can be re-judged under the rules that made it as well as
 * under today's. `SPREAD_MODE_PROFILE` is the current one; `parseLegBand` recovers the older one from the
 * rejection's own text. see spread-mode-settle.ts `diagnoseLegs`
 */
export interface LegBand {
  deltaMin: number;
  deltaMax: number;
  deltaTarget: number;
  wingMinPct: number;
  wingMaxPct: number;
}

export type LegCause =
  | 'no chain stored'
  | 'no underlying price'
  | 'chain carried no deltas'
  | 'no put in the Δ band'
  | 'Δ-band put not two-sided'
  | 'no strike in the wing range'
  | 'wing strike has no bid'
  // Both of these mean the stored chain yields two legs under TODAY'S band. They are split because the
  // answer to "why was it rejected, then" differs: the first is a rule change since, the second is not.
  // Before v1.1.299 they were one cause worded "(another expiry was chosen)", which became wrong the
  // commit after it was written — v1.1.292 widened the band, so the widened rules found legs on chains
  // the narrow rules had refused and every one of them was reported as an expiry choice.
  | 'the widened rules would now build it'
  | 'legs present (another expiry was chosen)';

export interface SpreadShadowReport {
  asOf: string;
  /** What Settings → Strategies has actually stored — not the defaults (v1.1.299). */
  settings: SpreadModeSettings;
  gate: {
    intradayCaptureDays: number;
    intradayCaptureDaysNeeded: number;
    settledPositions: number;
    settledPositionsNeeded: number;
    meanReturnOnMaxLoss: number | null;
    captureDaysMet: boolean;
    settledMet: boolean;
    meanPositive: boolean | null;
  };
  counts: { pickRows: number; positions: number; open: number; target: number; expired: number; unsettleable: number };
  winRate: number | null;
  medianDaysHeld: number | null;
  runs: Array<{ asOfDate: string; slot: string; pool: SpreadPool; picks: number; rejected: number }>;
  rejectionReasons: Array<{
    reason: string;
    n: number;
    tickers: Array<{ ticker: string; n: number }>;
    /** Only for the two missing-leg reasons: what the stored chain shows. */
    causes: Array<{ cause: LegCause; n: number }>;
  }>;
  /** The sector cap (08 S9) simulated over the same positions — shadow picks are not capped. */
  sectorCap: { cap: number; unknownSector: number; skipped: number; all: BookSummary; capped: BookSummary };
  /**
   * The per-position budget as a filter rather than a gate (08 S10). `affordable` is the subset a book at
   * `maxLossPerPosition` could actually have opened; the full book stays the §4 sample, because §4 measures
   * a per-share ratio and an unaffordable spread is still evidence about the strategy.
   */
  budget: { maxLossPerPosition: number; unaffordable: number; affordable: BookSummary };
  /**
   * The candidate pools run side by side (08 S11). `gatePool` is the one §4 is judged on; the others are
   * challengers reported beside it. `overlap` counts ticker+expiry pairs every pool picked — if it is
   * most of the book the two screens are not really choosing differently.
   */
  pools: {
    gatePool: SpreadPool;
    /**
     * First date every pool ran, and how many such dates there are. The arms started on different days,
     * so `books` covers **only** the paired window — and `pairedDays` is reported on its own so that
     * "no overlap yet" and "a clean comparison" cannot look alike. **A comparison read at
     * `pairedDays = 0` is not a weak result, it is no result.**
     */
    pairedFrom: string | null;
    pairedDays: number;
    /** Per pool, over the paired window only. */
    books: Array<{ pool: SpreadPool } & BookSummary>;
    overlap: number;
  };
  /** Currently open positions by sector and by expiry, largest first. */
  concentration: { bySector: Array<{ key: string; n: number }>; byExpiry: Array<{ key: string; n: number }> };
  /** Quality of the captures the settlements rest on (v1.1.297). */
  captureQuality: CaptureQualityReport;
  positions: ShadowPickRow[];
}

/** A capture-quality prompt to look at something; never a blocker. see spread-capture-quality.ts */
export interface CaptureQualityFinding {
  /** SC-1 capture stopped · SC-2 a live position was not re-quoted · SC-3 leg gaps · SC-4 unchanged quotes. */
  code: 'SC-1' | 'SC-2' | 'SC-3' | 'SC-4';
  severity: 'warning';
  detail: string;
  subjects: string[];
}

export interface CaptureQualityReport {
  captureDays: number;
  lastCaptureDate: string | null;
  /** Captures with both legs usable, and those missing one. */
  marks: number;
  gaps: number;
  gapRate: number | null;
  /** Captures a live position should have had (days the capture ran at all), and how many are absent. */
  expectedMarks: number;
  missingMarks: number;
  findings: CaptureQualityFinding[];
}
