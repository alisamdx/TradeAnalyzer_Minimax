// Pure risk-governor decision logic (Requirements/v2-execution/02-risk-governor §2.4–2.5).
//
// No I/O, no DB, no broker — just the maths and the fail-closed gate, so the safety core
// can be tested exhaustively and deterministically. The stateful `RiskGovernor`
// (risk-governor.ts) assembles a context from the DB + broker and calls these.

import type { ExecConfig, ExecGateResult, ExecStructure, EngineState } from '../../shared/types.js';

const EPSILON = 1e-6;

// ── Position sizing (§2.4) ────────────────────────────────────────────────────

export interface SizingLimits {
  perTradeRiskDollar: number; // maxRiskPerTradePct% × capitalCeiling
  remainingDeployableDollar: number; // capitalCeiling − capitalDeployed
}

export interface SizingResult {
  contracts: number;
  reason: string | null; // null when contracts ≥ 1
}

/**
 * Contracts = floor(perTradeRisk / maxLossPerContract), also capped by remaining
 * deployable capital — the tighter constraint wins (§2.4). Rejects (0 contracts) when
 * even one contract breaches the per-trade risk cap.
 */
export function sizePosition(maxLossPerContract: number, limits: SizingLimits): SizingResult {
  if (!(maxLossPerContract > 0)) {
    return { contracts: 0, reason: 'invalid_max_loss' };
  }
  const byRisk = Math.floor(limits.perTradeRiskDollar / maxLossPerContract);
  const byCapital = Math.floor(Math.max(0, limits.remainingDeployableDollar) / maxLossPerContract);
  const contracts = Math.max(0, Math.min(byRisk, byCapital));
  if (contracts < 1) {
    return { contracts: 0, reason: byRisk < 1 ? 'exceeds_per_trade_risk' : 'insufficient_capital' };
  }
  return { contracts, reason: null };
}

// ── Drawdown-scaled risk (FR-SEY-2, 06-seykota-risk-extensions) ───────────────

/**
 * Size multiplier to apply to the per-trade risk budget given the current closed-equity
 * drawdown. Returns 1 (no throttle) when the feature is off (`drawdownThrottlePct <= 0`) or
 * the drawdown is below the threshold; otherwise the configured factor, clamped to [0, 1]
 * (0 = no new entries during deep drawdown; ≥1 = effectively no throttle). Pure.
 */
export function drawdownThrottleFactor(drawdownPct: number, config: ExecConfig): number {
  if (!(config.drawdownThrottlePct > 0)) return 1;
  if (drawdownPct < config.drawdownThrottlePct) return 1;
  const f = config.drawdownThrottleFactor;
  if (!(f > 0)) return 0;
  return f < 1 ? f : 1;
}

// ── Pre-trade gate (§2.5) ─────────────────────────────────────────────────────

export interface GateContext {
  config: ExecConfig;
  engineState: EngineState;
  killSwitchTripped: boolean;
  dayLossPct: number; // current day loss as a positive % of ceiling (0 if flat/up)
  openPositions: Array<{ ticker: string; strategy: string; maxLoss: number; sector?: string | null }>;
  capitalDeployed: number;
  buyingPowerAvailable: number;
  brokerConnected: boolean;
  /** Drawdown-throttled per-trade risk % (FR-SEY-2). Defaults to config.maxRiskPerTradePct. */
  effectiveMaxRiskPct?: number;
}

export interface GateCandidate {
  ticker: string;
  strategy: string;
  structure: ExecStructure;
  isDefinedRisk: boolean;
  contracts: number; // already sized
  maxLossPerContract: number;
  sector?: string | null; // correlation bucket (FR-SEY-1); null/undefined = unmapped → uncapped
}

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * The ordered, fail-closed pre-trade gate. ALL checks must pass. The first failing check
 * supplies the reject reason. Pure — every input is in `ctx`/`cand`. Evaluated at proposal
 * creation and re-evaluated immediately before submission (§2.5).
 */
export function evaluateGate(ctx: GateContext, cand: GateCandidate): ExecGateResult {
  const { config } = ctx;
  const totalMaxLoss = cand.contracts * cand.maxLossPerContract;
  const effectiveRiskPct = ctx.effectiveMaxRiskPct ?? config.maxRiskPerTradePct;
  const perTradeLimit = (effectiveRiskPct / 100) * config.capitalCeiling;
  const tickerCount = ctx.openPositions.filter((p) => p.ticker === cand.ticker).length;
  const strategyCount = ctx.openPositions.filter((p) => p.strategy === cand.strategy).length;
  // Sector cap (FR-SEY-1): only constrains when enabled AND the candidate maps to a bucket.
  const sectorCap = config.maxPositionsPerSector;
  const sectorActive = sectorCap != null && cand.sector != null;
  const sectorCount = sectorActive ? ctx.openPositions.filter((p) => p.sector != null && p.sector === cand.sector).length : 0;

  const checks: Check[] = [
    {
      name: 'engine_running',
      passed: ctx.engineState === 'running',
      detail: `engine=${ctx.engineState}`,
    },
    {
      name: 'broker_connected',
      passed: ctx.brokerConnected,
      detail: ctx.brokerConnected ? 'connected' : 'disconnected',
    },
    {
      name: 'defined_risk_eligible',
      passed: cand.isDefinedRisk && config.eligibleStrategies.includes(cand.strategy),
      detail: !cand.isDefinedRisk
        ? 'not defined-risk'
        : config.eligibleStrategies.includes(cand.strategy)
          ? 'ok'
          : `strategy '${cand.strategy}' not in [${config.eligibleStrategies.join(',')}]`,
    },
    {
      name: 'per_trade_risk',
      passed: totalMaxLoss <= perTradeLimit + EPSILON && cand.contracts >= 1,
      detail: `maxLoss ${totalMaxLoss.toFixed(2)} vs limit ${perTradeLimit.toFixed(2)}`,
    },
    {
      name: 'max_concurrent',
      passed: ctx.openPositions.length < config.maxConcurrentPositions,
      detail: `${ctx.openPositions.length}/${config.maxConcurrentPositions}`,
    },
    {
      name: 'per_ticker',
      passed: tickerCount < config.maxPositionsPerTicker,
      detail: `${cand.ticker}: ${tickerCount}/${config.maxPositionsPerTicker}`,
    },
    {
      name: 'per_strategy',
      passed: config.maxPositionsPerStrategy == null || strategyCount < config.maxPositionsPerStrategy,
      detail:
        config.maxPositionsPerStrategy == null
          ? 'off'
          : `${cand.strategy}: ${strategyCount}/${config.maxPositionsPerStrategy}`,
    },
    {
      name: 'per_sector',
      passed: !sectorActive || sectorCount < (sectorCap as number),
      detail: !sectorActive
        ? sectorCap == null
          ? 'off'
          : `${cand.ticker} sector unmapped`
        : `${cand.sector}: ${sectorCount}/${sectorCap}`,
    },
    {
      name: 'capital_ceiling',
      passed: ctx.capitalDeployed + totalMaxLoss <= config.capitalCeiling + EPSILON,
      detail: `deployed ${ctx.capitalDeployed.toFixed(2)} + ${totalMaxLoss.toFixed(2)} vs ${config.capitalCeiling.toFixed(2)}`,
    },
    {
      name: 'buying_power',
      passed: ctx.buyingPowerAvailable >= totalMaxLoss - EPSILON,
      detail: `available ${ctx.buyingPowerAvailable.toFixed(2)} vs required ${totalMaxLoss.toFixed(2)}`,
    },
    {
      name: 'daily_loss',
      passed: !ctx.killSwitchTripped && ctx.dayLossPct < config.dailyLossTripPct,
      detail: ctx.killSwitchTripped
        ? 'kill switch tripped'
        : `day loss ${ctx.dayLossPct.toFixed(2)}% vs trip ${config.dailyLossTripPct}%`,
    },
  ];

  const firstFail = checks.find((c) => !c.passed) ?? null;
  return {
    passed: firstFail === null,
    checks: checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail })),
    rejectReason: firstFail ? firstFail.name : null,
  };
}
