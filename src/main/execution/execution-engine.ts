// The execution engine assembly (Requirements/v2-execution §1.2, Phase 4 glue + Phase 5).
//
// Wires the governor, broker, order manager, entry/exit policy, management loop, and the
// headless core into one object, and exposes a small facade the IPC/control-API layers call.
// The broker is injected so the same assembly runs the mock (tests/dev) or the IBKR adapter
// (Phase 6) — paper vs live is a config of the broker, never a branch here. Constructing it
// does nothing risky: the engine starts `stopped`, no broker connection, no orders.

import type { DbHandle } from '../db/connection.js';
import type { ExecConfig } from '../../shared/types.js';
import type { ExecutionBroker } from './execution-broker.js';
import { RiskGovernor } from './risk-governor.js';
import { OrderManager, type ApproveResult } from './order-manager.js';
import { EntryPolicy, type EntryOutcome, type PickInput } from './entry-policy.js';
import { ExitPolicy } from './exit-policy.js';
import { ManagementLoop } from './position-manager.js';
import { ExecutionCore, type CoreEvent, type CoreHealth, type StartResult } from './execution-core.js';
import { loadInflectionPickInputs } from './brief-entry-source.js';

export interface ExecutionEngineOptions {
  holidays?: ReadonlySet<string>;
  watchdogMaxGapMs?: number;
  now?: () => Date;
}

export interface EngineStateView {
  engineState: ReturnType<RiskGovernor['getEngineState']>;
  killSwitch: { tripped: boolean; reason: string | null };
  executionMode: ExecConfig['executionMode'];
  drawdownPct: number;
  health: CoreHealth;
}

export class ExecutionEngine {
  readonly governor: RiskGovernor;
  readonly orderManager: OrderManager;
  readonly entryPolicy: EntryPolicy;
  readonly management: ManagementLoop;
  readonly core: ExecutionCore;
  private readonly now: () => Date;

  constructor(
    private readonly db: DbHandle,
    private readonly broker: ExecutionBroker,
    opts: ExecutionEngineOptions = {}
  ) {
    this.now = opts.now ?? (() => new Date());
    this.governor = new RiskGovernor(db);
    this.orderManager = new OrderManager(db, broker, this.governor);
    this.orderManager.wire();
    this.entryPolicy = new EntryPolicy(db, this.governor);
    this.management = new ManagementLoop(db, this.governor, this.orderManager, new ExitPolicy());
    this.core = new ExecutionCore(db, broker, this.governor, opts);
    // Each market-open cycle: manage open positions (§3.3), then look for new entries from the
    // latest brief (§3.2). Entries run on the cycle — not at brief-commit — so the entry window,
    // caps, and live re-pricing apply; the daily cap stops repeats across cycles.
    this.core.setMarketCycleHook(async (now) => {
      await this.management.runOnce(now);
      await this.tryGenerateEntries(now);
    });
  }

  // ── lifecycle / control ──
  startEngine(): Promise<StartResult> {
    return this.core.startEngine();
  }
  stopEngine(): void {
    this.core.stopEngine();
  }
  pauseEngine(): void {
    this.core.pauseEngine();
  }
  tripKillSwitch(): void {
    this.governor.tripKillSwitch('manual');
  }
  clearKillSwitch(): void {
    this.governor.clearKillSwitch();
  }
  runCycle() {
    return this.core.runCycle();
  }
  onEvent(cb: (e: CoreEvent) => void): void {
    this.core.onEvent(cb);
  }

  // ── entries ──
  generateEntries(picks: PickInput[]): Promise<EntryOutcome[]> {
    return this.entryPolicy.generateEntries(picks, this.broker, this.now());
  }

  /** Generate entry proposals from the latest committed inflection brief (semi-auto). The
   *  entry-window / caps / critic / composite filters are enforced by EntryPolicy, and each
   *  proposal is re-priced against the live IBKR chain — so a stale brief never trades a stale
   *  price. No-op when the broker is disconnected or no brief/picks exist. */
  generateEntriesFromLatestBrief(now: Date = this.now()): Promise<EntryOutcome[]> {
    if (!this.broker.isConnected()) return Promise.resolve([]);
    const { picks } = loadInflectionPickInputs(this.db, now);
    if (picks.length === 0) return Promise.resolve([]);
    return this.entryPolicy.generateEntries(picks, this.broker, now);
  }

  /** Cycle-safe wrapper: entry generation must never throw into the management cycle. */
  private async tryGenerateEntries(now: Date): Promise<void> {
    try {
      await this.generateEntriesFromLatestBrief(now);
    } catch (e) {
      console.error('[execution] entry generation error:', e instanceof Error ? e.message : e);
    }
  }

  // ── approvals (route by proposal kind) ──
  async approveProposal(proposalId: number): Promise<ApproveResult> {
    const kind = (this.db.prepare('SELECT kind FROM exec_proposals WHERE id = ?').get(proposalId) as { kind: string } | undefined)?.kind;
    if (!kind) return { ok: false, orderId: null, reason: 'not_found' };
    return kind === 'exit'
      ? this.management.approveExitProposal(proposalId, this.now())
      : this.orderManager.approveProposal(proposalId, this.now());
  }

  rejectProposal(proposalId: number): { ok: boolean } {
    const info = this.db
      .prepare("UPDATE exec_proposals SET status = 'rejected', reject_reason = 'user_rejected' WHERE id = ? AND status = 'pending'")
      .run(proposalId);
    if (info.changes > 0) this.governor.audit('proposal_user_rejected', { refTable: 'exec_proposals', refId: proposalId });
    return { ok: info.changes > 0 };
  }

  // ── reads (for the control surface) ──
  getState(): EngineStateView {
    const rs = this.governor.getRiskState();
    return {
      engineState: rs.engineState,
      killSwitch: { tripped: rs.killSwitchTripped, reason: rs.killSwitchReason },
      executionMode: this.governor.getConfig().executionMode,
      drawdownPct: this.governor.getDrawdownPct(),
      health: this.core.getHealth(),
    };
  }
  getConfig(): ExecConfig {
    return this.governor.getConfig();
  }
  updateConfig(patch: Partial<ExecConfig>): ExecConfig {
    return this.governor.updateConfig(patch);
  }
  getRiskState() {
    return this.governor.getRiskState();
  }
  getPositions() {
    return this.db
      .prepare(
        `SELECT id, ticker, strategy, structure, contracts, max_loss, entry_net_credit, current_mark,
                current_pnl, status, opened_at, closed_at, close_reason
         FROM exec_positions WHERE status != 'closed' ORDER BY opened_at DESC`
      )
      .all();
  }
  getProposals() {
    return this.db
      .prepare(
        `SELECT id, created_at, expires_at, status, kind, ticker, strategy, structure, net_credit,
                max_loss, contracts, position_id, close_reason
         FROM exec_proposals WHERE status = 'pending' ORDER BY created_at DESC`
      )
      .all();
  }
  getAudit(limit = 100) {
    const n = Math.min(Math.max(limit, 1), 1000);
    return this.db.prepare('SELECT id, at, event, ref_table, ref_id, detail_json FROM exec_audit_log ORDER BY id DESC LIMIT ?').all(n);
  }
}
