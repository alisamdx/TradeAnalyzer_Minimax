// The headless execution core (Requirements/v2-execution §1.2, §1.8).
//
// Owns the broker + governor and runs the management cycle. It is the always-on engine the
// Electron control panel talks to (the control API/SSE in 3b wraps this). Safety posture:
// cold start reconciles BEFORE it will run (refuse-to-start on drift); a running cycle that
// finds drift trips the kill switch; entries/management only run during market hours; a
// disconnected broker fails closed. The entry/management policy itself is a hook the core
// calls when the market is open — filled in Phase 4.

import { EventEmitter } from 'node:events';
import type { DbHandle } from '../db/connection.js';
import type { ExecutionBroker } from './execution-broker.js';
import type { EngineState } from '../../shared/types.js';
import type { RiskGovernor } from './risk-governor.js';
import { reconcile, markNeedsAttention, type ReconcileResult } from './reconciliation.js';
import { isMarketOpen } from './market-hours.js';

export type CycleStatus =
  | 'ok'
  | 'skipped_not_running'
  | 'skipped_broker_disconnected'
  | 'skipped_market_closed'
  | 'tripped_reconcile';

export interface CycleResult {
  status: CycleStatus;
  at: string; // ISO
  marketOpen: boolean;
}

export interface CoreHealth {
  brokerConnected: boolean;
  lastCycleAt: string | null;
  healthy: boolean;
  degradedReason: string | null; // null when healthy
}

export interface StartResult {
  started: boolean;
  reason: string | null; // 'reconcile_mismatch' when refused
}

export type CoreEvent =
  | { type: 'engine_state'; state: EngineState }
  | { type: 'cycle'; result: CycleResult }
  | { type: 'health'; health: CoreHealth }
  | { type: 'reconcile_mismatch'; detail: ReconcileResult };

/** Called once per cycle while the market is open. Phase 4 wires entry + exit policy here. */
export type MarketCycleHook = (now: Date) => void | Promise<void>;

export interface ExecutionCoreOptions {
  holidays?: ReadonlySet<string>;
  watchdogMaxGapMs?: number; // default 5 min — health goes stale past this without a cycle
  now?: () => Date; // injectable clock (tests)
}

export class ExecutionCore {
  private readonly emitter = new EventEmitter();
  private readonly holidays: ReadonlySet<string> | undefined;
  private readonly watchdogMaxGapMs: number;
  private readonly now: () => Date;
  private lastCycleAt: string | null = null;
  private marketCycleHook: MarketCycleHook | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: DbHandle,
    private readonly broker: ExecutionBroker,
    private readonly governor: RiskGovernor,
    opts: ExecutionCoreOptions = {}
  ) {
    this.holidays = opts.holidays;
    this.watchdogMaxGapMs = opts.watchdogMaxGapMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => new Date());
    this.broker.onConnectionState(() => this.emit({ type: 'health', health: this.getHealth() }));
  }

  // ── events (consumed by the control-API SSE layer in 3b) ──
  onEvent(cb: (e: CoreEvent) => void): void {
    this.emitter.on('event', cb);
  }
  offEvent(cb: (e: CoreEvent) => void): void {
    this.emitter.off('event', cb);
  }
  private emit(e: CoreEvent): void {
    this.emitter.emit('event', e);
  }

  setMarketCycleHook(hook: MarketCycleHook | null): void {
    this.marketCycleHook = hook;
  }

  // ── lifecycle ──

  /** Connect, reconcile-before-act, and only then go running. Refuses to start on drift. */
  async startEngine(): Promise<StartResult> {
    if (!this.broker.isConnected()) await this.broker.connect();
    const rec = await reconcile(this.db, this.broker);
    if (!rec.consistent) {
      markNeedsAttention(this.db, rec.missingAtBroker);
      this.governor.audit('reconcile_mismatch', { detail: { ...rec, phase: 'cold_start' } });
      this.emit({ type: 'reconcile_mismatch', detail: rec });
      return { started: false, reason: 'reconcile_mismatch' };
    }
    this.governor.recomputeDeployed();
    this.governor.start();
    this.emit({ type: 'engine_state', state: this.governor.getEngineState() });
    return { started: true, reason: null };
  }

  stopEngine(): void {
    this.stopLoop();
    this.governor.stop();
    this.emit({ type: 'engine_state', state: this.governor.getEngineState() });
  }

  pauseEngine(): void {
    this.governor.pause();
    this.emit({ type: 'engine_state', state: this.governor.getEngineState() });
  }

  // ── the management cycle ──

  async runCycle(): Promise<CycleResult> {
    const now = this.now();
    const marketOpen = isMarketOpen(now, { holidays: this.holidays });

    if (this.governor.getEngineState() !== 'running') return this.cycle('skipped_not_running', now, marketOpen);

    if (!this.broker.isConnected()) {
      this.emit({ type: 'health', health: this.getHealth() });
      return this.cycle('skipped_broker_disconnected', now, marketOpen);
    }

    const rec = await reconcile(this.db, this.broker);
    if (!rec.consistent) {
      markNeedsAttention(this.db, rec.missingAtBroker);
      this.governor.tripKillSwitch('reconcile_mismatch');
      this.governor.audit('reconcile_mismatch', { detail: { ...rec, phase: 'cycle' } });
      this.lastCycleAt = now.toISOString();
      this.emit({ type: 'reconcile_mismatch', detail: rec });
      return this.cycle('tripped_reconcile', now, marketOpen);
    }

    this.governor.recomputeDeployed();
    if (marketOpen && this.marketCycleHook) await this.marketCycleHook(now);

    this.lastCycleAt = now.toISOString();
    return this.cycle(marketOpen ? 'ok' : 'skipped_market_closed', now, marketOpen);
  }

  // ── loop control ──

  startLoop(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runCycle();
    }, intervalMs);
  }

  stopLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── health watchdog (§1.8) ──

  getHealth(): CoreHealth {
    const connected = this.broker.isConnected();
    const gap = this.lastCycleAt ? this.now().getTime() - Date.parse(this.lastCycleAt) : Number.POSITIVE_INFINITY;
    let degradedReason: string | null = null;
    if (!connected) degradedReason = 'broker_disconnected';
    else if (gap >= this.watchdogMaxGapMs) degradedReason = 'stale_cycle';
    return { brokerConnected: connected, lastCycleAt: this.lastCycleAt, healthy: degradedReason === null, degradedReason };
  }

  private cycle(status: CycleStatus, now: Date, marketOpen: boolean): CycleResult {
    const result: CycleResult = { status, at: now.toISOString(), marketOpen };
    this.emit({ type: 'cycle', result });
    return result;
  }
}
