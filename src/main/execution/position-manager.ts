// Position management loop (Requirements/v2-execution 03-lifecycle §3.3).
//
// Each cycle, evaluates the exit policy for every open position and acts: protective exits
// (stop / defensive) close automatically; discretionary exits (profit target / planned)
// either auto-close (if the user opted in) or raise an exit proposal for approval. Wired
// into the ExecutionCore market-cycle hook. Protective exits never wait for approval
// (§0.3 invariant).

import type { DbHandle } from '../db/connection.js';
import type { ExecCloseReason } from '../../shared/types.js';
import type { LegSpec } from './execution-broker.js';
import type { RiskGovernor } from './risk-governor.js';
import type { OrderManager, ApproveResult } from './order-manager.js';
import { ExitPolicy, type ManagedPositionView } from './exit-policy.js';
import { etDateString } from './market-hours.js';

/** Management mode: 'live' acts on decisions; 'dry_run' only records would-be exits. */
export type ManagementMode = 'live' | 'dry_run';

interface PosRow {
  id: number;
  ticker: string;
  strategy: string;
  structure: string;
  legs_json: string;
  contracts: number;
  entry_net_credit: number | null;
  max_loss: number;
  current_mark: number | null;
  opened_at: string;
}

interface ExitProposalRow {
  id: number;
  status: string;
  position_id: number | null;
  close_reason: string | null;
}

export interface ManagementOutcome {
  positionId: number;
  action: 'closed' | 'proposed' | 'none';
  reason: ExecCloseReason | null;
}

export class ManagementLoop {
  constructor(
    private readonly db: DbHandle,
    private readonly governor: RiskGovernor,
    private readonly orderManager: OrderManager,
    private readonly exitPolicy: ExitPolicy = new ExitPolicy()
  ) {}

  async runOnce(now: Date, mode: ManagementMode = 'live'): Promise<ManagementOutcome[]> {
    const config = this.governor.getConfig();
    const rows = this.db.prepare("SELECT * FROM exec_positions WHERE status = 'open'").all() as PosRow[];
    const outcomes: ManagementOutcome[] = [];

    for (const row of rows) {
      const decision = this.exitPolicy.evaluate(this.toView(row), config, now);
      if (!decision) {
        outcomes.push({ positionId: row.id, action: 'none', reason: null });
        continue;
      }

      // Dry-run touches nothing — record the would-be exit and move on (spec 08 §2.4).
      if (mode === 'dry_run') {
        this.logDryRunExit(row, decision.reason, now);
        outcomes.push({ positionId: row.id, action: 'none', reason: decision.reason });
        continue;
      }

      // Unattended auto-fires discretionary exits too (protective always auto). Otherwise the
      // per-action exit modes decide.
      const auto =
        decision.cls === 'protective' ||
        config.automationMode === 'unattended' ||
        (decision.reason === 'profit_target' ? config.profitTargetMode : config.timeExitMode) === 'auto';

      if (auto) {
        await this.orderManager.submitClose(row.id, decision.reason, now);
        this.governor.audit('exit_fired', {
          refTable: 'exec_positions',
          refId: row.id,
          detail: { reason: decision.reason, cls: decision.cls },
        });
        outcomes.push({ positionId: row.id, action: 'closed', reason: decision.reason });
      } else {
        const created = this.createExitProposal(row, decision.reason, now);
        outcomes.push({ positionId: row.id, action: created ? 'proposed' : 'none', reason: decision.reason });
      }
    }
    return outcomes;
  }

  /** Approve a discretionary exit proposal → submit the close. */
  async approveExitProposal(proposalId: number, now: Date): Promise<ApproveResult> {
    const p = this.db
      .prepare("SELECT id, status, position_id, close_reason FROM exec_proposals WHERE id = ? AND kind = 'exit'")
      .get(proposalId) as ExitProposalRow | undefined;
    if (!p) return { ok: false, orderId: null, reason: 'not_found' };
    if (p.status !== 'pending') return { ok: false, orderId: null, reason: 'not_pending' };
    if (p.position_id == null) return { ok: false, orderId: null, reason: 'no_position' };
    this.db.prepare("UPDATE exec_proposals SET status = 'approved' WHERE id = ?").run(proposalId);
    return this.orderManager.submitClose(p.position_id, (p.close_reason as ExecCloseReason) ?? 'manual', now);
  }

  /** Record a would-be exit to exec_dry_run_log, deduped per ET-date+position so a re-evaluated
   *  cycle doesn't log it every tick. */
  private logDryRunExit(row: PosRow, reason: ExecCloseReason, now: Date): void {
    const etDate = etDateString(now);
    const dup = this.db
      .prepare("SELECT 1 FROM exec_dry_run_log WHERE et_date = ? AND kind = 'exit' AND ticker = ? AND reason = ?")
      .get(etDate, row.ticker, reason);
    if (dup) return;
    this.db
      .prepare(
        `INSERT INTO exec_dry_run_log (at, et_date, kind, ticker, strategy, structure, legs_json, net_credit, max_loss, contracts, reason)
         VALUES (?, ?, 'exit', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        now.toISOString(),
        etDate,
        row.ticker,
        row.strategy,
        row.structure,
        row.legs_json,
        row.current_mark,
        row.max_loss,
        row.contracts,
        reason
      );
  }

  private createExitProposal(row: PosRow, reason: ExecCloseReason, now: Date): boolean {
    const existing = this.db
      .prepare("SELECT id FROM exec_proposals WHERE kind = 'exit' AND position_id = ? AND status = 'pending'")
      .get(row.id);
    if (existing) return false; // one pending exit proposal per position

    const config = this.governor.getConfig();
    const expiresAt = new Date(now.getTime() + config.proposalShelfLifeMin * 60_000).toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO exec_proposals
           (created_at, expires_at, status, kind, ticker, strategy, structure, legs_json,
            net_credit, max_loss, contracts, position_id, close_reason)
         VALUES (?, ?, 'pending', 'exit', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        now.toISOString(),
        expiresAt,
        row.ticker,
        row.strategy,
        row.structure,
        row.legs_json,
        row.current_mark,
        row.max_loss,
        row.contracts,
        row.id,
        reason
      );
    this.governor.audit('exit_proposed', {
      refTable: 'exec_proposals',
      refId: Number(info.lastInsertRowid),
      detail: { positionId: row.id, reason },
    });
    return true;
  }

  private toView(row: PosRow): ManagedPositionView {
    const legs = JSON.parse(row.legs_json) as LegSpec[];
    return {
      id: row.id,
      entryNetCredit: row.entry_net_credit,
      currentMark: row.current_mark,
      openedAt: row.opened_at,
      expiry: legs[0]?.expiry ?? '',
    };
  }
}
