import { describe, it, expect } from 'vitest';
import { sizePosition, evaluateGate, drawdownThrottleFactor, type GateContext, type GateCandidate } from '../src/main/execution/risk-gate.js';
import type { ExecConfig } from '../src/shared/types.js';

// Phase 2: the pure risk-gate logic (no I/O). Exhaustive — every check, every fail path.

const CONFIG: ExecConfig = {
  executionMode: 'paper',
  capitalCeiling: 10000,
  maxRiskPerTradePct: 5, // $500 per trade
  maxConcurrentPositions: 5,
  dailyLossTripPct: 10,
  maxPositionsPerTicker: 1,
  maxPositionsPerStrategy: null,
  eligibleStrategies: ['inflection'],
  proposalShelfLifeMin: 120,
  drawdownThrottlePct: 0,
  drawdownThrottleFactor: 0.5,
  maxPositionsPerSector: null,
  minCompositeScore: 70,
  maxNewEntriesPerDay: 1,
  maxNewEntriesPerWeek: 3,
  avoidEarningsBeforeExpiry: true,
  entryWindowStart: '10:00',
  entryWindowEnd: '15:00',
  repriceTolerancePct: 10,
  stopMultiple: 2,
  defensiveDte: 2,
  profitTargetPct: 50,
  holdDays: 5,
  timeExitDte: 0,
  profitTargetMode: 'propose',
  timeExitMode: 'propose',
  updatedAt: '2026-06-14T00:00:00.000Z',
};

function passingCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    config: CONFIG,
    engineState: 'running',
    killSwitchTripped: false,
    dayLossPct: 0,
    openPositions: [],
    capitalDeployed: 0,
    buyingPowerAvailable: 100000,
    brokerConnected: true,
    ...overrides,
  };
}

function passingCand(overrides: Partial<GateCandidate> = {}): GateCandidate {
  return {
    ticker: 'AAA',
    strategy: 'inflection',
    structure: 'short-put-vertical',
    isDefinedRisk: true,
    contracts: 1,
    maxLossPerContract: 350, // ≤ $500 per-trade limit
    ...overrides,
  };
}

describe('sizePosition (§2.4)', () => {
  it('sizes by per-trade risk', () => {
    expect(sizePosition(350, { perTradeRiskDollar: 500, remainingDeployableDollar: 10000 })).toEqual({
      contracts: 1,
      reason: null,
    });
    expect(sizePosition(100, { perTradeRiskDollar: 500, remainingDeployableDollar: 10000 }).contracts).toBe(5);
  });

  it('rejects when one contract exceeds the per-trade cap', () => {
    expect(sizePosition(600, { perTradeRiskDollar: 500, remainingDeployableDollar: 10000 })).toEqual({
      contracts: 0,
      reason: 'exceeds_per_trade_risk',
    });
  });

  it('is capped by remaining deployable capital', () => {
    expect(sizePosition(350, { perTradeRiskDollar: 500, remainingDeployableDollar: 200 })).toEqual({
      contracts: 0,
      reason: 'insufficient_capital',
    });
  });

  it('guards an invalid (non-positive) max loss', () => {
    expect(sizePosition(0, { perTradeRiskDollar: 500, remainingDeployableDollar: 10000 }).reason).toBe('invalid_max_loss');
  });
});

describe('evaluateGate (§2.5)', () => {
  it('passes a clean candidate', () => {
    const r = evaluateGate(passingCtx(), passingCand());
    expect(r.passed).toBe(true);
    expect(r.rejectReason).toBeNull();
    expect(r.checks).toHaveLength(11);
  });

  const cases: Array<[string, GateContext, GateCandidate, string]> = [
    ['engine not running', passingCtx({ engineState: 'paused' }), passingCand(), 'engine_running'],
    ['broker disconnected', passingCtx({ brokerConnected: false }), passingCand(), 'broker_connected'],
    ['not defined-risk', passingCtx(), passingCand({ isDefinedRisk: false }), 'defined_risk_eligible'],
    ['strategy not eligible', passingCtx(), passingCand({ strategy: 'wheel' }), 'defined_risk_eligible'],
    ['per-trade risk exceeded', passingCtx(), passingCand({ maxLossPerContract: 600 }), 'per_trade_risk'],
    [
      'max concurrent reached',
      passingCtx({ openPositions: Array.from({ length: 5 }, (_, i) => ({ ticker: `T${i}`, strategy: 'inflection', maxLoss: 100 })) }),
      passingCand(),
      'max_concurrent',
    ],
    [
      'ticker already held',
      passingCtx({ openPositions: [{ ticker: 'AAA', strategy: 'inflection', maxLoss: 100 }] }),
      passingCand(),
      'per_ticker',
    ],
    ['capital ceiling breached', passingCtx({ capitalDeployed: 9800 }), passingCand(), 'capital_ceiling'],
    ['insufficient buying power', passingCtx({ buyingPowerAvailable: 100 }), passingCand(), 'buying_power'],
    ['daily loss at trip', passingCtx({ dayLossPct: 10 }), passingCand(), 'daily_loss'],
    ['kill switch tripped', passingCtx({ killSwitchTripped: true }), passingCand(), 'daily_loss'],
  ];

  for (const [label, ctx, cand, expectedReason] of cases) {
    it(`rejects: ${label} → ${expectedReason}`, () => {
      const r = evaluateGate(ctx, cand);
      expect(r.passed).toBe(false);
      expect(r.rejectReason).toBe(expectedReason);
    });
  }

  it('honours an enabled per-strategy cap', () => {
    const cfg: ExecConfig = { ...CONFIG, maxPositionsPerStrategy: 2 };
    const ctx = passingCtx({
      config: cfg,
      openPositions: [
        { ticker: 'B', strategy: 'inflection', maxLoss: 100 },
        { ticker: 'C', strategy: 'inflection', maxLoss: 100 },
      ],
    });
    expect(evaluateGate(ctx, passingCand()).rejectReason).toBe('per_strategy');
  });

  it('honours an enabled sector cap (FR-SEY-1)', () => {
    const cfg: ExecConfig = { ...CONFIG, maxPositionsPerSector: 2 };
    const ctx = passingCtx({
      config: cfg,
      openPositions: [
        { ticker: 'B', strategy: 'inflection', maxLoss: 100, sector: 'XLK' },
        { ticker: 'C', strategy: 'inflection', maxLoss: 100, sector: 'XLK' },
      ],
    });
    expect(evaluateGate(ctx, passingCand({ sector: 'XLK' })).rejectReason).toBe('per_sector');
    // A different sector is unaffected.
    expect(evaluateGate(ctx, passingCand({ sector: 'XLF' })).passed).toBe(true);
    // An unmapped candidate (no sector) is never capped.
    expect(evaluateGate(ctx, passingCand({ sector: null })).passed).toBe(true);
  });

  it('does not constrain by sector when the cap is off (null)', () => {
    const ctx = passingCtx({
      openPositions: [
        { ticker: 'B', strategy: 'inflection', maxLoss: 100, sector: 'XLK' },
        { ticker: 'C', strategy: 'inflection', maxLoss: 100, sector: 'XLK' },
      ],
    });
    expect(evaluateGate(ctx, passingCand({ sector: 'XLK' })).passed).toBe(true);
  });

  it('uses the throttled effectiveMaxRiskPct for the per-trade limit (FR-SEY-2)', () => {
    // $350 maxLoss passes at 5% ($500) but fails at a throttled 2.5% ($250).
    expect(evaluateGate(passingCtx(), passingCand()).passed).toBe(true);
    const ctx = passingCtx({ effectiveMaxRiskPct: 2.5 });
    expect(evaluateGate(ctx, passingCand()).rejectReason).toBe('per_trade_risk');
  });
});

describe('drawdownThrottleFactor (FR-SEY-2)', () => {
  const cfg = (pct: number, factor: number): ExecConfig => ({ ...CONFIG, drawdownThrottlePct: pct, drawdownThrottleFactor: factor });

  it('is 1 (no throttle) when disabled (pct = 0)', () => {
    expect(drawdownThrottleFactor(50, cfg(0, 0.5))).toBe(1);
  });
  it('is 1 below the threshold', () => {
    expect(drawdownThrottleFactor(9.9, cfg(10, 0.5))).toBe(1);
  });
  it('applies the factor at/above the threshold', () => {
    expect(drawdownThrottleFactor(10, cfg(10, 0.5))).toBe(0.5);
    expect(drawdownThrottleFactor(25, cfg(10, 0.5))).toBe(0.5);
  });
  it('clamps factor ≥ 1 to no-throttle and factor ≤ 0 to a full halt', () => {
    expect(drawdownThrottleFactor(20, cfg(10, 1.5))).toBe(1);
    expect(drawdownThrottleFactor(20, cfg(10, 0))).toBe(0);
  });
});
