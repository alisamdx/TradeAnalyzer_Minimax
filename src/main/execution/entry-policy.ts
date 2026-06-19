// Entry policy (Requirements/v2-execution 03-lifecycle §3.2).
//
// Turns eligible brief picks into priced, risk-gated proposals awaiting approval
// (semi-auto). Operates on a normalized PickInput so it's decoupled from the v1 brief
// internals and fully testable against the mock broker. The pick → proposal pipeline:
// filter → price at the venue → size → pre-trade gate → persist exec_proposals.

import type { DbHandle } from '../db/connection.js';
import type { ExecConfig, ExecStructure } from '../../shared/types.js';
import type { ExecutionBroker, LegSpec } from './execution-broker.js';
import type { GateCandidate } from './risk-gate.js';
import type { RiskGovernor } from './risk-governor.js';
import { etDateString, etMinutesOfDay, hhmmToMinutes } from './market-hours.js';

/** A normalized candidate from the daily brief (inflection at launch). */
export interface PickInput {
  ticker: string;
  strategy: string; // 'inflection'
  structure: ExecStructure; // short-put-vertical | short-call-vertical
  legs: LegSpec[];
  compositeScore: number;
  criticVerdict: 'pass' | 'caution' | 'flag' | null;
  hasAdequateLiquidity: boolean;
  earningsBeforeExpiry: boolean;
  maxLossPerContract: number; // defined-risk $ per contract
  sourceBriefId: number | null;
}

export interface FilterResult {
  accepted: boolean;
  reason: string | null;
}

export interface EntryOutcome {
  ticker: string;
  proposalId: number | null; // set when a proposal was created
  rejected: string | null; // reason when not
}

export class EntryPolicy {
  constructor(
    private readonly db: DbHandle,
    private readonly governor: RiskGovernor
  ) {}

  /** Configurable pre-pricing filters (§3.2). */
  filterPick(pick: PickInput, config: ExecConfig, now: Date): FilterResult {
    const rej = (reason: string): FilterResult => ({ accepted: false, reason });
    if (!config.eligibleStrategies.includes(pick.strategy)) return rej('strategy_not_eligible');
    // Inflection-direction guard (FR-SEY-3 follow-up): the bear-call/down-breakout side is a
    // validated net loser. short-put-vertical = up (bull put), short-call-vertical = down.
    if (pick.strategy === 'inflection') {
      const dir = pick.structure === 'short-call-vertical' ? 'down' : pick.structure === 'short-put-vertical' ? 'up' : null;
      if (dir && config.inflectionDirection !== 'both' && config.inflectionDirection !== dir) return rej('inflection_direction');
    }
    if (pick.criticVerdict !== 'pass' && pick.criticVerdict !== 'caution') return rej('critic_verdict');
    // Per-strategy composite floor (composites aren't comparable across strategies); falls back
    // to the global floor when a strategy has no override.
    const floor = config.minCompositeByStrategy[pick.strategy] ?? config.minCompositeScore;
    if (pick.compositeScore < floor) return rej('below_min_composite');
    if (!pick.hasAdequateLiquidity) return rej('inadequate_liquidity');
    if (config.avoidEarningsBeforeExpiry && pick.earningsBeforeExpiry) return rej('earnings_before_expiry');
    const mins = etMinutesOfDay(now);
    if (mins < hhmmToMinutes(config.entryWindowStart) || mins >= hhmmToMinutes(config.entryWindowEnd)) {
      return rej('outside_entry_window');
    }
    return { accepted: true, reason: null };
  }

  /** Price at the venue, size, gate, and persist a pending proposal (or report why not). */
  async buildProposal(pick: PickInput, broker: ExecutionBroker, now: Date): Promise<EntryOutcome> {
    const config = this.governor.getConfig();
    const quote = await broker.priceCombo(pick.legs);

    // Liquidity gate (§3.2): skip names whose combo bid/ask is too wide vs the credit — crossing
    // them bleeds the edge to slippage (AMAT ~23% live). Off when maxComboSpreadPct ≤ 0.
    if (config.maxComboSpreadPct > 0 && quote.mid > 0) {
      const relSpread = (quote.ask - quote.bid) / Math.abs(quote.mid);
      if (relSpread > config.maxComboSpreadPct) {
        return { ticker: pick.ticker, proposalId: null, rejected: 'wide_market' };
      }
    }

    const sizing = this.governor.sizeEntry(pick.maxLossPerContract);
    if (sizing.contracts < 1) return { ticker: pick.ticker, proposalId: null, rejected: sizing.reason };

    const cand: GateCandidate = {
      ticker: pick.ticker,
      strategy: pick.strategy,
      structure: pick.structure,
      isDefinedRisk: true,
      contracts: sizing.contracts,
      maxLossPerContract: pick.maxLossPerContract,
    };
    const gate = await this.governor.checkEntry(cand, broker);
    if (!gate.passed) return { ticker: pick.ticker, proposalId: null, rejected: gate.rejectReason };

    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + config.proposalShelfLifeMin * 60_000).toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO exec_proposals
           (created_at, expires_at, status, kind, ticker, strategy, structure, legs_json,
            net_credit, max_loss, contracts, source_brief_id, risk_check_json)
         VALUES (?, ?, 'pending', 'entry', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        createdAt,
        expiresAt,
        pick.ticker,
        pick.strategy,
        pick.structure,
        JSON.stringify(pick.legs),
        quote.netCredit,
        pick.maxLossPerContract,
        sizing.contracts,
        pick.sourceBriefId,
        JSON.stringify(gate)
      );
    const proposalId = Number(info.lastInsertRowid);
    this.governor.audit('proposal_created', {
      refTable: 'exec_proposals',
      refId: proposalId,
      detail: { ticker: pick.ticker, contracts: sizing.contracts, netCredit: quote.netCredit },
    });
    return { ticker: pick.ticker, proposalId, rejected: null };
  }

  /** Apply daily/weekly caps + filters across a batch, highest composite first. */
  async generateEntries(picks: PickInput[], broker: ExecutionBroker, now: Date): Promise<EntryOutcome[]> {
    const config = this.governor.getConfig();
    let dayUsed = this.countNewEntries(now, 'day');
    let weekUsed = this.countNewEntries(now, 'week');
    const outcomes: EntryOutcome[] = [];

    for (const pick of [...picks].sort((a, b) => b.compositeScore - a.compositeScore)) {
      if (dayUsed >= config.maxNewEntriesPerDay) {
        outcomes.push({ ticker: pick.ticker, proposalId: null, rejected: 'daily_cap' });
        continue;
      }
      if (weekUsed >= config.maxNewEntriesPerWeek) {
        outcomes.push({ ticker: pick.ticker, proposalId: null, rejected: 'weekly_cap' });
        continue;
      }
      const f = this.filterPick(pick, config, now);
      if (!f.accepted) {
        outcomes.push({ ticker: pick.ticker, proposalId: null, rejected: f.reason });
        continue;
      }
      const outcome = await this.buildProposal(pick, broker, now);
      outcomes.push(outcome);
      if (outcome.proposalId != null) {
        dayUsed += 1;
        weekUsed += 1;
      }
    }
    return outcomes;
  }

  /** Count entries already initiated (pending/approved proposals + non-closed positions). */
  private countNewEntries(now: Date, scope: 'day' | 'week'): number {
    const stamps = [
      ...(this.db
        .prepare("SELECT created_at AS t FROM exec_proposals WHERE kind = 'entry' AND status IN ('pending','approved')")
        .all() as Array<{ t: string }>).map((r) => r.t),
      ...(this.db.prepare("SELECT opened_at AS t FROM exec_positions WHERE status != 'closed'").all() as Array<{
        t: string;
      }>).map((r) => r.t),
    ];
    if (scope === 'day') {
      const today = etDateString(now);
      return stamps.filter((t) => etDateString(new Date(t)) === today).length;
    }
    const weekAgo = now.getTime() - 7 * 24 * 3_600_000;
    return stamps.filter((t) => Date.parse(t) >= weekAgo).length;
  }
}
