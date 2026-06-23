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
import { EntryPolicy, type EntryMode, type EntryOutcome, type PickInput } from './entry-policy.js';
import { ExitPolicy } from './exit-policy.js';
import { ManagementLoop, type ManagementOutcome } from './position-manager.js';
import { ExecutionCore, type CoreEvent, type CoreHealth, type StartResult } from './execution-core.js';
import { loadBriefPickInputs } from './brief-entry-source.js';
import { etDateString } from './market-hours.js';

/** A per-action / digest notification the engine raises; the concrete sink (email + OS push) is
 *  injected so the engine has no Electron/SMTP dependency (and tests get a no-op). */
export interface ExecNotification {
  kind: 'entry' | 'exit' | 'kill_trip' | 'eod_digest';
  title: string;
  body: string;
  html?: string;
}
export interface ExecNotifier {
  notify(n: ExecNotification): void | Promise<void>;
}

/** An OPEN/CLOSE order stuck pre-ack (`pending`/`submitted`) longer than this is treated as
 *  silently dropped by the broker and reconciled (cancelled; the entry's cap slot freed). A
 *  healthy IBKR order acks in ~1–2s, so this is generously above any normal ack latency. */
const STALE_ORDER_MS = 90_000;

export interface ExecutionEngineOptions {
  holidays?: ReadonlySet<string>;
  watchdogMaxGapMs?: number;
  now?: () => Date;
  /** Sink for per-action + digest notifications. Defaults to a no-op (tests/headless-less). */
  notifier?: ExecNotifier;
  /** When true, startEngine starts the management/entry loop timer (index.ts sets this; tests omit). */
  enableCycleLoop?: boolean;
  /** Called when the "armed" state (running + unattended + paper) changes — index.ts toggles the
   *  OS power-save blocker so an all-day run doesn't sleep. */
  onArmedChange?: (armed: boolean) => void;
}

export interface EngineStateView {
  engineState: ReturnType<RiskGovernor['getEngineState']>;
  killSwitch: { tripped: boolean; reason: string | null };
  executionMode: ExecConfig['executionMode'];
  automationMode: ExecConfig['automationMode'];
  armed: boolean; // running + unattended + paper (auto-entry active)
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
  private readonly notifier: ExecNotifier;
  private readonly enableCycleLoop: boolean;
  private readonly onArmedChange?: (armed: boolean) => void;
  private lastArmed = false;
  private lastMarketOpen = false;
  private lastDigestDate: string | null = null;

  constructor(
    private readonly db: DbHandle,
    private readonly broker: ExecutionBroker,
    opts: ExecutionEngineOptions = {}
  ) {
    this.now = opts.now ?? (() => new Date());
    this.notifier = opts.notifier ?? { notify: () => {} };
    this.enableCycleLoop = opts.enableCycleLoop ?? false;
    this.onArmedChange = opts.onArmedChange;
    this.governor = new RiskGovernor(db);
    this.orderManager = new OrderManager(db, broker, this.governor);
    this.orderManager.wire();
    this.entryPolicy = new EntryPolicy(db, this.governor);
    this.management = new ManagementLoop(db, this.governor, this.orderManager, new ExitPolicy());
    this.core = new ExecutionCore(db, broker, this.governor, opts);
    // Each market-open cycle: manage open positions (§3.3), then look for new entries from the
    // latest brief (§3.2). Entries run on the cycle — not at brief-commit — so the entry window,
    // caps, and live re-pricing apply; the daily cap stops repeats across cycles. The automation
    // mode (semi/dry_run/unattended) decides whether entries auto-approve and exits auto-fire.
    this.core.setMarketCycleHook(async (now) => {
      const config = this.governor.getConfig();
      const mode: EntryMode = config.automationMode === 'dry_run' ? 'dry_run' : 'live';
      // Sweep silently-dropped orders first so their cap slots free before this cycle's entry pass.
      await this.orderManager.reconcileStaleOrders(now, STALE_ORDER_MS);
      const exits = await this.management.runOnce(now, mode);
      if (mode === 'live') await this.notifyExits(exits);
      await this.tryGenerateEntries(now, mode, config);
    });
    // Internal observer: EOD digest on market-close + kill-trip notification + armed tracking.
    this.core.onEvent((e) => this.onCoreEvent(e));
  }

  // ── lifecycle / control ──
  /**
   * Start the engine. In LIVE mode, run a fail-closed broker preflight first: confirm the
   * account can actually place a defined-risk spread (§2.13) so a Level-1 / cash account never
   * goes live and sits silently getting every multi-leg order rejected. Paper is skipped — the
   * paper account has full permissions and we don't want to add a probe to the soak path.
   */
  async startEngine(): Promise<StartResult> {
    // Fail-closed broker preflight in PAPER **and** LIVE: connect, then confirm the account can
    // actually place a defined-risk spread (§2.13). Without this, an account lacking options spread
    // (multi-leg) permission arms and then silently gets EVERY combo rejected by IBKR — exactly the
    // failure that cost a long debug on a paper account with only CSP-level permission (2026-06-23).
    // Paper was previously skipped on the assumption it always has full permissions; that is false.
    // The mock broker always reports permission granted, so this is a no-op in tests/dev.
    if (!this.broker.isConnected()) {
      try {
        await this.broker.connect();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        this.governor.audit('preflight_connect_failed', { detail: { reason } });
        return { started: false, reason: `broker_connect_failed:${reason}` };
      }
    }
    const perm = await this.broker.checkSpreadPermission();
    if (!perm.ok) {
      this.governor.audit('preflight_permission_failed', { detail: perm });
      return { started: false, reason: `spread_permission:${perm.code}` };
    }
    this.governor.audit('preflight_permission_ok', { detail: perm });

    const result = await this.core.startEngine();
    if (result.started && this.enableCycleLoop) {
      const sec = this.governor.getConfig().cycleIntervalSec;
      this.core.startLoop(Math.max(1, sec) * 1000);
    }
    this.refreshArmed();
    return result;
  }
  stopEngine(): void {
    this.core.stopEngine();
    this.refreshArmed();
  }
  pauseEngine(): void {
    this.core.pauseEngine();
    this.refreshArmed();
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
  /**
   * Boot reconciliation (force-stopped-on-boot): the engine never restores a live broker
   * connection or cycle loop on restart, so a persisted 'running'/'paused' state is reset to
   * 'stopped' here at app boot. The operator must explicitly Start to reconnect. Emits an
   * engine_state event (so the UI updates) and refreshes the armed flag when it changes state.
   * Returns true if the persisted state was running/paused and got reset.
   */
  reconcileStateOnBoot(): boolean {
    const changed = this.governor.forceStopOnBoot();
    if (changed) this.core.emitEngineState();
    this.refreshArmed();
    return changed;
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
  generateEntriesFromLatestBrief(now: Date = this.now(), mode: EntryMode = 'live'): Promise<EntryOutcome[]> {
    if (!this.broker.isConnected()) return Promise.resolve([]);
    // Pull picks from every eligible strategy's latest brief — but only TODAY's brief (freshness
    // gate, spec 08 §3.2): the engine never acts on a stale prior-day brief. EntryPolicy then
    // filters + caps across the union.
    const { picks } = loadBriefPickInputs(this.db, this.governor.getConfig().eligibleStrategies, now, true);
    if (picks.length === 0) return Promise.resolve([]);
    return this.entryPolicy.generateEntries(picks, this.broker, now, mode);
  }

  /** Cycle-safe wrapper: entry generation must never throw into the management cycle. In
   *  unattended PAPER mode it auto-approves each fresh proposal (same gate path as a UI click);
   *  live always stays semi-auto (paper-only invariant). */
  private async tryGenerateEntries(now: Date, mode: EntryMode, config: ExecConfig): Promise<void> {
    try {
      const outcomes = await this.generateEntriesFromLatestBrief(now, mode);
      const autoEntry = config.automationMode === 'unattended' && config.executionMode === 'paper' && mode === 'live';
      if (!autoEntry) return;
      for (const o of outcomes) {
        if (o.proposalId == null) continue;
        const res = await this.orderManager.approveProposal(o.proposalId, now);
        if (res.ok) await this.notifyEntry(o.proposalId);
      }
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
    const config = this.governor.getConfig();
    return {
      engineState: rs.engineState,
      killSwitch: { tripped: rs.killSwitchTripped, reason: rs.killSwitchReason },
      executionMode: config.executionMode,
      automationMode: config.automationMode,
      armed: this.computeArmed(),
      drawdownPct: this.governor.getDrawdownPct(),
      health: this.core.getHealth(),
    };
  }
  getConfig(): ExecConfig {
    return this.governor.getConfig();
  }
  updateConfig(patch: Partial<ExecConfig>): ExecConfig {
    const config = this.governor.updateConfig(patch);
    this.refreshArmed(); // arming via the settings switch must toggle the power-save blocker
    return config;
  }
  /** Today's dry-run would-be decisions (newest first), for the control surface. */
  getDryRunLog(limit = 100) {
    const n = Math.min(Math.max(limit, 1), 1000);
    return this.db
      .prepare(
        `SELECT id, at, et_date, kind, ticker, strategy, structure, net_credit, max_loss, contracts, reason
         FROM exec_dry_run_log ORDER BY id DESC LIMIT ?`
      )
      .all(n);
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
  /**
   * Open + recently-closed positions, newest activity first — feeds the Trading Desk
   * Entries (opened today) and Exits (closed today) tabs (spec 08 §5.3). `getPositions`
   * stays open-only for the Positions tab / count badge.
   */
  getRecentPositions(limit = 200) {
    const n = Math.min(Math.max(limit, 1), 1000);
    return this.db
      .prepare(
        `SELECT id, ticker, strategy, structure, contracts, max_loss, entry_net_credit, current_mark,
                current_pnl, status, opened_at, closed_at, close_reason
         FROM exec_positions ORDER BY COALESCE(closed_at, opened_at) DESC LIMIT ?`
      )
      .all(n);
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

  // ── notifications + armed tracking ──
  private dispatch(n: ExecNotification): void {
    const config = this.governor.getConfig();
    if (n.kind !== 'eod_digest' && !config.notifyPerAction) return;
    void Promise.resolve(this.notifier.notify(n)).catch((e) =>
      console.error('[execution] notify error:', e instanceof Error ? e.message : e)
    );
  }

  private async notifyEntry(proposalId: number): Promise<void> {
    const p = this.db
      .prepare('SELECT ticker, strategy, structure, net_credit, contracts FROM exec_proposals WHERE id = ?')
      .get(proposalId) as
      | { ticker: string; strategy: string; structure: string; net_credit: number | null; contracts: number }
      | undefined;
    if (!p) return;
    this.dispatch({
      kind: 'entry',
      title: `Auto-entry: ${p.ticker} ${p.strategy}`,
      body: `${p.contracts}× ${p.structure} @ net ${p.net_credit ?? '—'} (auto-approved, paper)`,
    });
  }

  private async notifyExits(outcomes: ManagementOutcome[]): Promise<void> {
    for (const o of outcomes) {
      if (o.action !== 'closed') continue;
      const pos = this.db.prepare('SELECT ticker, strategy FROM exec_positions WHERE id = ?').get(o.positionId) as
        | { ticker: string; strategy: string }
        | undefined;
      this.dispatch({
        kind: 'exit',
        title: `Auto-exit: ${pos?.ticker ?? `#${o.positionId}`}`,
        body: `${pos?.strategy ?? ''} closed — ${o.reason ?? 'exit'}`,
      });
    }
  }

  private onCoreEvent(e: CoreEvent): void {
    if (e.type === 'engine_state' && e.state === 'kill_tripped') {
      const rs = this.governor.getRiskState();
      this.dispatch({
        kind: 'kill_trip',
        title: 'Kill switch tripped — new entries halted',
        body: `Reason: ${rs.killSwitchReason ?? 'unknown'}. Open positions are still managed; clear manually to resume.`,
      });
    }
    if (e.type === 'cycle') {
      // Market just closed → send the once-per-day EOD digest (armed only). The cycle hook only
      // runs while the market is open, so detect the open→closed transition here instead.
      if (this.lastMarketOpen && !e.result.marketOpen) this.maybeSendEodDigest();
      this.lastMarketOpen = e.result.marketOpen;
    }
    this.refreshArmed();
  }

  private maybeSendEodDigest(): void {
    const config = this.governor.getConfig();
    const today = etDateString(this.now());
    if (config.automationMode !== 'unattended' || !config.notifyEodDigest) return;
    if (this.lastDigestDate === today) return;
    this.lastDigestDate = today;

    const entries = this.db
      .prepare("SELECT ticker, strategy, structure, contracts, entry_net_credit FROM exec_positions WHERE substr(opened_at,1,10) = ? ORDER BY opened_at")
      .all(today) as Array<{ ticker: string; strategy: string; structure: string; contracts: number; entry_net_credit: number | null }>;
    const exits = this.db
      .prepare("SELECT ticker, close_reason, current_pnl FROM exec_positions WHERE status = 'closed' AND substr(closed_at,1,10) = ? ORDER BY closed_at")
      .all(today) as Array<{ ticker: string; close_reason: string | null; current_pnl: number | null }>;
    const rs = this.governor.getRiskState();

    const li = (s: string): string => `<li>${s}</li>`;
    const html =
      `<h2>Unattended paper — end of day ${today}</h2>` +
      `<p><b>Day P&amp;L:</b> realized ${rs.dayRealizedPnl.toFixed(2)}, unrealized ${rs.dayUnrealizedPnl.toFixed(2)}</p>` +
      `<h3>Entries (${entries.length})</h3><ul>` +
      (entries.map((e) => li(`${e.ticker} ${e.strategy} — ${e.contracts}× ${e.structure} @ ${e.entry_net_credit ?? '—'}`)).join('') || li('none')) +
      `</ul><h3>Exits (${exits.length})</h3><ul>` +
      (exits.map((e) => li(`${e.ticker} — ${e.close_reason ?? 'exit'} (P&amp;L ${e.current_pnl?.toFixed(2) ?? '—'})`)).join('') || li('none')) +
      `</ul>`;

    this.dispatch({
      kind: 'eod_digest',
      title: `Unattended paper — EOD ${today}: ${entries.length} entries, ${exits.length} exits`,
      body: `Day P&L realized ${rs.dayRealizedPnl.toFixed(2)} / unrealized ${rs.dayUnrealizedPnl.toFixed(2)}`,
      html,
    });
  }

  /** Armed = the auto-entry posture is active: engine running, unattended, and paper. */
  private computeArmed(): boolean {
    const config = this.governor.getConfig();
    return (
      this.governor.getEngineState() === 'running' &&
      config.automationMode === 'unattended' &&
      config.executionMode === 'paper'
    );
  }

  private refreshArmed(): void {
    const armed = this.computeArmed();
    if (armed === this.lastArmed) return;
    this.lastArmed = armed;
    this.onArmedChange?.(armed);
  }
}
