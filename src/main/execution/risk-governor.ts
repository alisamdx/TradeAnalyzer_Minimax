// The stateful risk governor (Requirements/v2-execution/02-risk-governor).
//
// The single source of risk truth: owns exec_config + exec_risk_state, the engine state
// machine, the kill switch, day-P&L accounting, COID generation, and the append-only
// audit log. Assembles a context from the DB + broker and runs the pure pre-trade gate
// (risk-gate.ts). Every state change commits atomically with its audit entry.

import { randomUUID } from 'node:crypto';
import type { DbHandle } from '../db/connection.js';
import { withTransaction } from '../db/connection.js';
import type { ExecConfig, ExecRiskState, EngineState } from '../../shared/types.js';
import type { ExecutionBroker } from './execution-broker.js';
import { evaluateGate, sizePosition, type GateCandidate, type GateContext, type SizingResult } from './risk-gate.js';

interface ConfigRow {
  execution_mode: string;
  capital_ceiling: number;
  max_risk_per_trade_pct: number;
  max_concurrent_positions: number;
  daily_loss_trip_pct: number;
  max_positions_per_ticker: number;
  max_positions_per_strategy: number | null;
  eligible_strategies: string;
  proposal_shelf_life_min: number;
  min_composite_score: number;
  max_new_entries_per_day: number;
  max_new_entries_per_week: number;
  avoid_earnings_before_expiry: number;
  entry_window_start: string;
  entry_window_end: string;
  reprice_tolerance_pct: number;
  updated_at: string;
}

interface RiskStateRow {
  engine_state: EngineState;
  kill_switch_tripped: number;
  kill_switch_reason: string | null;
  capital_deployed: number;
  day_realized_pnl: number;
  day_unrealized_pnl: number;
  day_anchor_date: string | null;
  updated_at: string;
}

const CONFIG_COLUMN: Record<keyof ExecConfig, string> = {
  executionMode: 'execution_mode',
  capitalCeiling: 'capital_ceiling',
  maxRiskPerTradePct: 'max_risk_per_trade_pct',
  maxConcurrentPositions: 'max_concurrent_positions',
  dailyLossTripPct: 'daily_loss_trip_pct',
  maxPositionsPerTicker: 'max_positions_per_ticker',
  maxPositionsPerStrategy: 'max_positions_per_strategy',
  eligibleStrategies: 'eligible_strategies',
  proposalShelfLifeMin: 'proposal_shelf_life_min',
  minCompositeScore: 'min_composite_score',
  maxNewEntriesPerDay: 'max_new_entries_per_day',
  maxNewEntriesPerWeek: 'max_new_entries_per_week',
  avoidEarningsBeforeExpiry: 'avoid_earnings_before_expiry',
  entryWindowStart: 'entry_window_start',
  entryWindowEnd: 'entry_window_end',
  repriceTolerancePct: 'reprice_tolerance_pct',
  updatedAt: 'updated_at',
};

export interface AuditOptions {
  refTable?: string;
  refId?: number;
  detail?: unknown;
}

export class RiskGovernor {
  constructor(private readonly db: DbHandle) {}

  // ── config ────────────────────────────────────────────────────────────────

  getConfig(): ExecConfig {
    const r = this.db.prepare('SELECT * FROM exec_config WHERE id = 1').get() as ConfigRow;
    return {
      executionMode: r.execution_mode === 'live' ? 'live' : 'paper',
      capitalCeiling: r.capital_ceiling,
      maxRiskPerTradePct: r.max_risk_per_trade_pct,
      maxConcurrentPositions: r.max_concurrent_positions,
      dailyLossTripPct: r.daily_loss_trip_pct,
      maxPositionsPerTicker: r.max_positions_per_ticker,
      maxPositionsPerStrategy: r.max_positions_per_strategy,
      eligibleStrategies: r.eligible_strategies
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      proposalShelfLifeMin: r.proposal_shelf_life_min,
      minCompositeScore: r.min_composite_score,
      maxNewEntriesPerDay: r.max_new_entries_per_day,
      maxNewEntriesPerWeek: r.max_new_entries_per_week,
      avoidEarningsBeforeExpiry: r.avoid_earnings_before_expiry === 1,
      entryWindowStart: r.entry_window_start,
      entryWindowEnd: r.entry_window_end,
      repriceTolerancePct: r.reprice_tolerance_pct,
      updatedAt: r.updated_at,
    };
  }

  updateConfig(patch: Partial<ExecConfig>): ExecConfig {
    const cols: string[] = [];
    const vals: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch) as Array<[keyof ExecConfig, unknown]>) {
      if (key === 'updatedAt') continue;
      const col = CONFIG_COLUMN[key];
      if (!col) continue;
      cols.push(`${col} = ?`);
      if (key === 'eligibleStrategies') vals.push((value as string[]).join(','));
      else if (typeof value === 'boolean') vals.push(value ? 1 : 0);
      else vals.push(value as string | number | null);
    }
    if (cols.length > 0) {
      cols.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
      this.db.prepare(`UPDATE exec_config SET ${cols.join(', ')} WHERE id = 1`).run(...vals);
    }
    return this.getConfig();
  }

  // ── risk state ──────────────────────────────────────────────────────────────

  getRiskState(): ExecRiskState {
    const r = this.db.prepare('SELECT * FROM exec_risk_state WHERE id = 1').get() as RiskStateRow;
    return {
      engineState: r.engine_state,
      killSwitchTripped: r.kill_switch_tripped === 1,
      killSwitchReason: r.kill_switch_reason,
      capitalDeployed: r.capital_deployed,
      dayRealizedPnl: r.day_realized_pnl,
      dayUnrealizedPnl: r.day_unrealized_pnl,
      dayAnchorDate: r.day_anchor_date,
      updatedAt: r.updated_at,
    };
  }

  getEngineState(): EngineState {
    return (this.db.prepare('SELECT engine_state FROM exec_risk_state WHERE id = 1').get() as {
      engine_state: EngineState;
    }).engine_state;
  }

  // ── engine state machine (§2.7) ──────────────────────────────────────────────
  // `start` must be followed by reconcile-before-act in the core loop (§1.8/§2.7).

  start(): void {
    withTransaction(this.db, () => {
      const s = this.getEngineState();
      if (s === 'running') return;
      if (s === 'kill_tripped') {
        throw new Error('cannot start while the kill switch is tripped — clear it first');
      }
      this.transitionEngine(s, 'running', {}, 'start');
    });
  }

  /** Hard stop (§0.37): the engine ceases all activity. Always allowed. */
  stop(): void {
    withTransaction(this.db, () => {
      const s = this.getEngineState();
      if (s === 'stopped') return;
      this.transitionEngine(s, 'stopped', {}, 'stop');
    });
  }

  /** Optional soft pause: no new entries, keeps managing open positions. */
  pause(): void {
    withTransaction(this.db, () => {
      const s = this.getEngineState();
      if (s === 'paused') return;
      if (s !== 'running') throw new Error(`cannot pause from '${s}'`);
      this.transitionEngine(s, 'paused', {}, 'pause');
    });
  }

  /** Safety halt — halt new entries, keep managing (§2.6). Persisted; manual clear only. */
  tripKillSwitch(reason: string): void {
    withTransaction(this.db, () => this.doTrip(reason));
  }

  /** Manual clear (§2.6) — re-arms to running. Never auto-clears. */
  clearKillSwitch(): void {
    withTransaction(this.db, () => {
      const s = this.getEngineState();
      if (s !== 'kill_tripped') {
        if (this.getRiskState().killSwitchTripped) {
          this.writeState({ kill_switch_tripped: 0, kill_switch_reason: null });
        }
        return;
      }
      this.transitionEngine(s, 'running', { kill_switch_tripped: 0, kill_switch_reason: null }, 'clear_kill_switch');
      this.audit('kill_cleared', { detail: { from: s } });
    });
  }

  // ── capital + day P&L ─────────────────────────────────────────────────────────

  /** Recompute deployed capital = Σ max_loss of positions still holding capital. */
  recomputeDeployed(): number {
    const deployed = (this.db
      .prepare("SELECT COALESCE(SUM(max_loss), 0) AS d FROM exec_positions WHERE status IN ('open','closing','needs_attention')")
      .get() as { d: number }).d;
    this.writeState({ capital_deployed: deployed });
    return deployed;
  }

  /**
   * Update day P&L (realized + unrealized), resetting at a new session anchor, and trip
   * the kill switch if the day loss reaches the configured % of the ceiling (§2.6).
   */
  updateDayPnl(realizedPnl: number, unrealizedPnl: number, today: string): void {
    withTransaction(this.db, () => {
      const rs = this.getRiskState();
      const patch: Record<string, string | number | null> = {
        day_realized_pnl: realizedPnl,
        day_unrealized_pnl: unrealizedPnl,
      };
      if (rs.dayAnchorDate !== today) patch.day_anchor_date = today;
      this.writeState(patch);

      const cfg = this.getConfig();
      const lossPct = dayLossPctFrom(realizedPnl, unrealizedPnl, cfg.capitalCeiling);
      const state = this.getEngineState();
      if (lossPct >= cfg.dailyLossTripPct && !this.getRiskState().killSwitchTripped && state !== 'stopped') {
        this.doTrip('daily_loss');
      }
    });
  }

  dayLossPct(): number {
    const rs = this.getRiskState();
    return dayLossPctFrom(rs.dayRealizedPnl, rs.dayUnrealizedPnl, this.getConfig().capitalCeiling);
  }

  // ── sizing + gate ─────────────────────────────────────────────────────────────

  sizeEntry(maxLossPerContract: number): SizingResult {
    const cfg = this.getConfig();
    const deployed = this.recomputeDeployed();
    return sizePosition(maxLossPerContract, {
      perTradeRiskDollar: (cfg.maxRiskPerTradePct / 100) * cfg.capitalCeiling,
      remainingDeployableDollar: cfg.capitalCeiling - deployed,
    });
  }

  async checkEntry(cand: GateCandidate, broker: ExecutionBroker) {
    const cfg = this.getConfig();
    const rs = this.getRiskState();
    const deployed = this.recomputeDeployed();
    const openPositions = (this.db
      .prepare("SELECT ticker, strategy, max_loss FROM exec_positions WHERE status IN ('open','closing','needs_attention')")
      .all() as Array<{ ticker: string; strategy: string; max_loss: number }>).map((r) => ({
      ticker: r.ticker,
      strategy: r.strategy,
      maxLoss: r.max_loss,
    }));

    const connected = broker.isConnected();
    const buyingPowerAvailable = connected ? (await broker.getBuyingPower()).available : 0;

    const ctx: GateContext = {
      config: cfg,
      engineState: rs.engineState,
      killSwitchTripped: rs.killSwitchTripped,
      dayLossPct: dayLossPctFrom(rs.dayRealizedPnl, rs.dayUnrealizedPnl, cfg.capitalCeiling),
      openPositions,
      capitalDeployed: deployed,
      buyingPowerAvailable,
      brokerConnected: connected,
    };

    const result = evaluateGate(ctx, cand);
    this.audit(result.passed ? 'gate_pass' : 'gate_reject', {
      detail: { ticker: cand.ticker, strategy: cand.strategy, contracts: cand.contracts, reason: result.rejectReason },
    });
    return result;
  }

  // ── COID + audit ──────────────────────────────────────────────────────────────

  /** A unique client order id — the idempotency key written before any broker send (§2.8). */
  newClientOrderId(): string {
    return `ta_${randomUUID()}`;
  }

  audit(event: string, opts: AuditOptions = {}): void {
    this.db
      .prepare('INSERT INTO exec_audit_log (event, ref_table, ref_id, detail_json) VALUES (?, ?, ?, ?)')
      .run(event, opts.refTable ?? null, opts.refId ?? null, JSON.stringify(opts.detail ?? {}));
  }

  // ── internals (no transaction — callers wrap) ──────────────────────────────────

  private doTrip(reason: string): void {
    const s = this.getEngineState();
    if (s === 'kill_tripped') return; // keep the first reason
    if (s !== 'running' && s !== 'paused') return; // nothing to halt
    this.transitionEngine(s, 'kill_tripped', { kill_switch_tripped: 1, kill_switch_reason: reason }, 'trip');
    this.audit('kill_tripped', { detail: { reason, from: s } });
  }

  private transitionEngine(
    from: EngineState,
    to: EngineState,
    extra: Record<string, string | number | null>,
    action: string
  ): void {
    this.writeState({ engine_state: to, ...extra });
    this.audit('engine_state', { detail: { from, to, action } });
  }

  private writeState(patch: Record<string, string | number | null>): void {
    const cols = Object.keys(patch);
    if (cols.length === 0) return;
    const setClause = [...cols.map((c) => `${c} = ?`), "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"].join(', ');
    this.db.prepare(`UPDATE exec_risk_state SET ${setClause} WHERE id = 1`).run(...cols.map((c) => patch[c]!));
  }
}

/** Day loss as a positive % of the ceiling; 0 when flat or up. */
function dayLossPctFrom(realized: number, unrealized: number, ceiling: number): number {
  const pnl = realized + unrealized;
  return pnl >= 0 || ceiling <= 0 ? 0 : (-pnl / ceiling) * 100;
}
