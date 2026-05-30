// Read-only access to the TraderAgent SQLite database.
// Opens a separate DB handle; never writes to this DB from TradeAnalyzer
// (agent:close-trade spawns the agent CLI instead).

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import type {
  AgentTrade, AgentLesson, AgentRecommendation, AgentMemorySnapshot, AgentStatus,
  AgentTheoryCheck, AgentDashboard, AgentNativeLesson
} from '@shared/types.js';

interface TradeRow {
  id: number; ticker: string; mode: string; strategy: string;
  strike: number; expiration: string; dte_at_entry: number;
  entry_premium: number; capital_required: number;
  composite_score: number; rank_at_entry: number; rationale: string;
  status: string; entry_date: string; close_date: string | null;
  actual_pl: number | null; close_reason: string | null;
  target_pl: number | null; max_loss: number | null;
  annualized_return: number | null;
  entry_price: number | null; last_price: number | null;
  current_option_mid: number | null;
}

interface LessonRow {
  id: number; trade_id: number; gap_cause: string;
  gap_amount_usd: number; gap_pct: number; narrative: string; created_at: string;
}

interface RecommendationRow {
  id: number; category: string; severity: string;
  description: string; proposed_change: string; status: string; created_at: string;
}

interface MemoryRow {
  id: number;
  weights_json: string;
  win_rate_by_mode_json: string;
  top_lessons_json: string;
  trade_count: number;
  confidence: number;
  created_at: string;
}

export class AgentDbService {
  private db: InstanceType<typeof Database> | null = null;
  private dbPath = '';

  open(path: string): boolean {
    if (!path || !existsSync(path)) {
      this.db = null;
      this.dbPath = '';
      return false;
    }
    if (this.db && this.dbPath === path) return true;
    try {
      this.db?.close();
      this.db = new Database(path, { readonly: true, fileMustExist: true });
      this.dbPath = path;
      return true;
    } catch {
      this.db = null;
      this.dbPath = '';
      return false;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.dbPath = '';
  }

  isOpen(): boolean { return this.db !== null; }

  getStatus(): AgentStatus {
    if (!this.db) return { dbExists: false, openTrades: 0, closedTrades: 0, totalPl: 0, winRate: 0, lastRunAt: null, confidence: 0 };

    const open = (this.db.prepare("SELECT COUNT(*) AS n FROM agent_trades WHERE status = 'open'").get() as { n: number }).n;
    const closed = (this.db.prepare("SELECT COUNT(*) AS n FROM agent_trades WHERE status IN ('closed','expired')").get() as { n: number }).n;
    const plRow = this.db.prepare("SELECT SUM(actual_pl) AS total FROM agent_trades WHERE status IN ('closed','expired') AND actual_pl IS NOT NULL").get() as { total: number | null };
    const winRow = this.db.prepare("SELECT SUM(CASE WHEN actual_pl >= 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS wr FROM agent_trades WHERE status IN ('closed','expired') AND actual_pl IS NOT NULL").get() as { wr: number | null };
    const lastRun = this.db.prepare("SELECT run_date FROM scout_runs ORDER BY id DESC LIMIT 1").get() as { run_date: string } | undefined;
    const mem = this.db.prepare("SELECT confidence FROM agent_memory ORDER BY id DESC LIMIT 1").get() as { confidence: number } | undefined;
    const confidence = mem?.confidence ?? 0;

    return {
      dbExists: true,
      openTrades: open,
      closedTrades: closed,
      totalPl: plRow.total ?? 0,
      winRate: winRow.wr ?? 0,
      lastRunAt: lastRun?.run_date ?? null,
      confidence
    };
  }

  getTrades(statusFilter?: 'open' | 'closed' | 'all'): AgentTrade[] {
    if (!this.db) return [];
    const where = statusFilter === 'open'
      ? "WHERE t.status = 'open'"
      : statusFilter === 'closed'
      ? "WHERE t.status IN ('closed','expired')"
      : '';

    // Detect whether the v2 price-tracking columns exist (added by migration 002)
    const cols = (this.db.prepare('PRAGMA table_info(agent_trades)').all() as Array<{ name: string }>).map((c) => c.name);
    const hasPriceCols = cols.includes('entry_price');
    const priceSelect = hasPriceCols
      ? 't.entry_price, t.last_price'
      : 'NULL AS entry_price, NULL AS last_price';

    // Join latest theory check for current_option_mid (one row per trade after review phase)
    const tcExists = (this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_theory_checks'"
    ).get() as { name: string } | undefined)?.name;
    const tcJoin = tcExists
      ? `LEFT JOIN (
           SELECT trade_id, current_option_mid
           FROM agent_theory_checks
           WHERE id IN (SELECT MAX(id) FROM agent_theory_checks GROUP BY trade_id)
         ) tc ON tc.trade_id = t.id`
      : '';
    const tcSelect = tcExists ? ', tc.current_option_mid' : ', NULL AS current_option_mid';

    const rows = this.db.prepare(`
      SELECT t.id, t.ticker, t.mode, t.strategy, t.strike, t.expiration,
             t.dte_at_entry, t.entry_premium, t.capital_required,
             t.composite_score, t.rank_at_entry, t.rationale,
             t.status, t.entry_date, t.close_date, t.actual_pl, t.close_reason,
             p.target_pl, p.max_loss, p.annualized_return,
             ${priceSelect}${tcSelect}
      FROM agent_trades t
      LEFT JOIN agent_trade_projections p ON p.trade_id = t.id
      ${tcJoin}
      ${where}
      ORDER BY t.id DESC
    `).all() as TradeRow[];

    return rows.map((r) => ({
      id: r.id, ticker: r.ticker, mode: r.mode, strategy: r.strategy,
      strike: r.strike, expiration: r.expiration, dteAtEntry: r.dte_at_entry,
      entryPremium: r.entry_premium, capitalRequired: r.capital_required,
      compositeScore: r.composite_score, rankAtEntry: r.rank_at_entry,
      rationale: r.rationale, status: r.status as AgentTrade['status'],
      entryDate: r.entry_date, closeDate: r.close_date,
      actualPl: r.actual_pl, closeReason: r.close_reason,
      targetPl: r.target_pl, maxLoss: r.max_loss, annualizedReturn: r.annualized_return,
      entryPrice: r.entry_price, lastPrice: r.last_price,
      currentOptionMid: r.current_option_mid
    }));
  }

  getLessons(limit = 50): AgentLesson[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT id, trade_id, gap_cause, gap_amount_usd, gap_pct, narrative, created_at FROM agent_lessons ORDER BY id DESC LIMIT ?'
    ).all(limit) as LessonRow[];
    return rows.map((r) => ({
      id: r.id, tradeId: r.trade_id, gapCause: r.gap_cause,
      gapAmountUsd: r.gap_amount_usd, gapPct: r.gap_pct,
      narrative: r.narrative, createdAt: r.created_at
    }));
  }

  getRecommendations(): AgentRecommendation[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      "SELECT id, category, severity, description, proposed_change, status, created_at FROM agent_recommendations ORDER BY id DESC"
    ).all() as RecommendationRow[];
    return rows.map((r) => ({
      id: r.id, category: r.category, severity: r.severity,
      description: r.description, proposedChange: r.proposed_change,
      status: r.status, createdAt: r.created_at
    }));
  }

  getDashboardData(): AgentDashboard {
    const empty: AgentDashboard = {
      winRateByStrategy: {}, winRateByMode: {}, overallWinRate: 0, totalClosed: 0,
      totalDeployedCapital: 0, capitalByTicker: {}, capitalByStrategy: {},
      openPositionCount: 0, avgIv: null, avgDelta: null, avgDTE: null,
      estimatedDailyTheta: null, totalRealizedPl: 0, plByMonth: {}
    };
    if (!this.db) return empty;

    // ── Win rates ────────────────────────────────────────────────────────────
    const closedRows = this.db.prepare(`
      SELECT strategy, mode, actual_pl
      FROM agent_trades WHERE status IN ('closed','expired') AND actual_pl IS NOT NULL
    `).all() as Array<{ strategy: string; mode: string; actual_pl: number }>;

    const byStrategy: Record<string, { wins: number; total: number }> = {};
    const byMode:     Record<string, { wins: number; total: number }> = {};
    let totalWins = 0;

    for (const r of closedRows) {
      const win = r.actual_pl >= 0 ? 1 : 0;
      if (!byStrategy[r.strategy]) byStrategy[r.strategy] = { wins: 0, total: 0 };
      byStrategy[r.strategy]!.wins += win;
      byStrategy[r.strategy]!.total++;
      if (!byMode[r.mode]) byMode[r.mode] = { wins: 0, total: 0 };
      byMode[r.mode]!.wins += win;
      byMode[r.mode]!.total++;
      totalWins += win;
    }

    const winRateByStrategy: AgentDashboard['winRateByStrategy'] = {};
    for (const [k, v] of Object.entries(byStrategy)) {
      winRateByStrategy[k] = { wins: v.wins, total: v.total, winRate: v.wins / v.total };
    }
    const winRateByMode: AgentDashboard['winRateByMode'] = {};
    for (const [k, v] of Object.entries(byMode)) {
      winRateByMode[k] = { wins: v.wins, total: v.total, winRate: v.wins / v.total };
    }

    // ── P&L by month ─────────────────────────────────────────────────────────
    const plMonthRows = this.db.prepare(`
      SELECT strftime('%Y-%m', close_date) AS month, SUM(actual_pl) AS total
      FROM agent_trades
      WHERE status IN ('closed','expired') AND actual_pl IS NOT NULL AND close_date IS NOT NULL
        AND close_date >= date('now', '-6 months')
      GROUP BY month ORDER BY month ASC
    `).all() as Array<{ month: string; total: number }>;
    const plByMonth: Record<string, number> = {};
    for (const r of plMonthRows) plByMonth[r.month] = r.total;

    const totalPl = (this.db.prepare(
      "SELECT SUM(actual_pl) AS s FROM agent_trades WHERE status IN ('closed','expired') AND actual_pl IS NOT NULL"
    ).get() as { s: number | null }).s ?? 0;

    // ── Capital allocation (open positions) ───────────────────────────────────
    const openRows = this.db.prepare(
      "SELECT ticker, strategy, capital_required, entry_premium, dte_at_entry FROM agent_trades WHERE status='open'"
    ).all() as Array<{ ticker: string; strategy: string; capital_required: number; entry_premium: number; dte_at_entry: number }>;

    const capitalByTicker: Record<string, number> = {};
    const capitalByStrategy: Record<string, number> = {};
    let totalCapital = 0;
    let thetaSum = 0;
    let thetaCount = 0;

    for (const r of openRows) {
      capitalByTicker[r.ticker]   = (capitalByTicker[r.ticker]   ?? 0) + r.capital_required;
      capitalByStrategy[r.strategy] = (capitalByStrategy[r.strategy] ?? 0) + r.capital_required;
      totalCapital += r.capital_required;
      // Approximate theta: option value decays roughly linearly — premium / DTE per day
      if (r.dte_at_entry > 0) { thetaSum += r.entry_premium / r.dte_at_entry; thetaCount++; }
    }

    // ── IV / delta / DTE from latest theory checks ────────────────────────────
    const cols = (this.db.prepare('PRAGMA table_info(agent_theory_checks)').all() as Array<{ name: string }>).map(c => c.name);
    let avgIv: number | null = null, avgDelta: number | null = null, avgDTE: number | null = null;
    if (cols.length > 0) {
      const tcRows = this.db.prepare(`
        SELECT tc.current_delta, tc.iv_at_check, tc.current_dte
        FROM agent_theory_checks tc
        JOIN agent_trades t ON t.id = tc.trade_id
        WHERE t.status = 'open'
      `).all() as Array<{ current_delta: number | null; iv_at_check: number | null; current_dte: number | null }>;

      const ivVals    = tcRows.map(r => r.iv_at_check).filter((v): v is number => v != null);
      const deltaVals = tcRows.map(r => r.current_delta).filter((v): v is number => v != null);
      const dteVals   = tcRows.map(r => r.current_dte).filter((v): v is number => v != null && v > 0);

      if (ivVals.length > 0)    avgIv    = ivVals.reduce((a, b) => a + b, 0) / ivVals.length;
      if (deltaVals.length > 0) avgDelta = deltaVals.reduce((a, b) => a + b, 0) / deltaVals.length;
      if (dteVals.length > 0)   avgDTE   = dteVals.reduce((a, b) => a + b, 0) / dteVals.length;
    }

    return {
      winRateByStrategy, winRateByMode,
      overallWinRate: closedRows.length > 0 ? totalWins / closedRows.length : 0,
      totalClosed: closedRows.length,
      totalDeployedCapital: totalCapital,
      capitalByTicker, capitalByStrategy,
      openPositionCount: openRows.length,
      avgIv, avgDelta, avgDTE,
      estimatedDailyTheta: thetaCount > 0 ? thetaSum : null,
      totalRealizedPl: totalPl, plByMonth
    };
  }

  getLiveRecommendations(): AgentRecommendation[] {
    if (!this.db) return [];
    const recs: AgentRecommendation[] = [];
    const now = new Date().toISOString();
    let idCounter = -1;

    // Detect whether the v2 price-tracking columns exist (added by migration 002)
    const priceCols = (this.db.prepare('PRAGMA table_info(agent_trades)').all() as Array<{ name: string }>).map(c => c.name);
    const hasPriceCols = priceCols.includes('entry_price');

    const lrTcExists = (this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_theory_checks'"
    ).get() as { name: string } | undefined)?.name;
    const lrTcJoin = lrTcExists
      ? `LEFT JOIN (
           SELECT trade_id, current_option_mid
           FROM agent_theory_checks
           WHERE id IN (SELECT MAX(id) FROM agent_theory_checks GROUP BY trade_id)
         ) tc ON tc.id = agent_trades.id`
      : '';

    interface OpenRow {
      id: number; ticker: string; strategy: string; strike: number;
      expiration: string; capital_required: number; entry_premium: number;
      last_price: number | null; current_option_mid: number | null;
    }
    const openTrades = this.db.prepare(
      `SELECT id, ticker, strategy, strike, expiration, capital_required, entry_premium,
       ${hasPriceCols ? 'last_price' : 'NULL AS last_price'},
       ${lrTcExists
         ? '(SELECT current_option_mid FROM agent_theory_checks WHERE trade_id = agent_trades.id ORDER BY id DESC LIMIT 1)'
         : 'NULL'
       } AS current_option_mid
       FROM agent_trades WHERE status = 'open'`
    ).all() as OpenRow[];

    if (openTrades.length > 0) {
      // ── 1. Expiry clustering ───────────────────────────────────────────────
      const byWeek: Record<string, string[]> = {};
      for (const t of openTrades) {
        const d = new Date(t.expiration + 'T12:00:00Z');
        const dow = d.getUTCDay();
        const mon = new Date(d);
        mon.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
        const key = mon.toISOString().slice(0, 10);
        (byWeek[key] ??= []).push(t.ticker);
      }
      for (const [week, tickers] of Object.entries(byWeek)) {
        if (tickers.length >= 3) {
          recs.push({
            id: idCounter--, category: 'Expiry Concentration',
            severity: tickers.length >= 4 ? 'high' : 'medium',
            description: `${tickers.length} positions expire the week of ${week}: ${tickers.join(', ')}. Simultaneous expiry creates concentrated assignment and roll risk.`,
            proposedChange: 'Stagger expirations across different weeks when opening new positions.',
            status: 'live', createdAt: now
          });
        }
      }

      // ── 2. Capital concentration by ticker ────────────────────────────────
      const totalCapital = openTrades.reduce((s, t) => s + t.capital_required, 0);
      if (totalCapital > 0) {
        const byTicker: Record<string, number> = {};
        for (const t of openTrades) byTicker[t.ticker] = (byTicker[t.ticker] ?? 0) + t.capital_required;
        for (const [ticker, cap] of Object.entries(byTicker)) {
          const pct = cap / totalCapital;
          if (pct > 0.35) {
            recs.push({
              id: idCounter--, category: 'Capital Concentration',
              severity: pct > 0.55 ? 'high' : 'medium',
              description: `${ticker} represents ${(pct * 100).toFixed(0)}% of deployed capital ($${cap.toLocaleString(undefined, { maximumFractionDigits: 0 })}). Single-stock concentration risk.`,
              proposedChange: `Avoid adding more ${ticker} positions until existing ones close. Target ≤ 30% in any single name.`,
              status: 'live', createdAt: now
            });
          }
        }
      }
    }

    // ── 3. Stale scout pipeline ────────────────────────────────────────────
    const lastScout = this.db.prepare(
      'SELECT run_date FROM scout_runs ORDER BY id DESC LIMIT 1'
    ).get() as { run_date: string } | undefined;
    if (lastScout) {
      const daysSince = Math.round((Date.now() - new Date(lastScout.run_date).getTime()) / 86400000);
      if (daysSince > 7) {
        recs.push({
          id: idCounter--, category: 'Scout Cadence',
          severity: daysSince > 14 ? 'high' : 'low',
          description: `Last scout was ${daysSince} days ago (${lastScout.run_date}). Opportunity pipeline may be stale.`,
          proposedChange: 'Run the scout phase to refresh candidates with current market conditions.',
          status: 'live', createdAt: now
        });
      }
    }

    // ── 4. Win rate below threshold (needs ≥ 5 closed trades) ────────────
    const stats = this.db.prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN actual_pl < 0 THEN 1 ELSE 0 END) AS losses FROM agent_trades WHERE status IN ('closed','expired') AND actual_pl IS NOT NULL"
    ).get() as { total: number; losses: number };
    if (stats.total >= 5) {
      const lossRate = stats.losses / stats.total;
      if (lossRate > 0.4) {
        recs.push({
          id: idCounter--, category: 'Win Rate',
          severity: lossRate > 0.6 ? 'high' : 'medium',
          description: `Win rate is ${((1 - lossRate) * 100).toFixed(0)}% over ${stats.total} closed trades — loss rate of ${(lossRate * 100).toFixed(0)}% exceeds 40% threshold.`,
          proposedChange: 'Review entry criteria in the active strategy. Consider raising the minimum composite score or tightening delta/DTE filters.',
          status: 'live', createdAt: now
        });
      }
    }

    // ── 5. Per-trade action recommendations (stock vs strike, not premium) ──
    for (const t of openTrades) {
      const dte = Math.max(0, Math.round((new Date(t.expiration + 'T21:00:00Z').getTime() - Date.now()) / 86400000));
      const isCall = t.strategy.toLowerCase().includes('call');
      // dist > 0 = OTM (safe), dist < 0 = ITM (at risk); only meaningful when last_price present
      const dist = t.last_price != null
        ? (isCall ? (t.strike - t.last_price) / t.strike : (t.last_price - t.strike) / t.strike)
        : null;

      // Close Now: ≥ 50% of premium captured (uses theory check option mid)
      if (t.current_option_mid != null && t.entry_premium > 0) {
        const captured = (t.entry_premium - t.current_option_mid) / t.entry_premium;
        if (captured >= 0.5) {
          const capPct = (captured * 100).toFixed(0);
          const plPerContract = ((t.entry_premium - t.current_option_mid) * 100).toFixed(2);
          recs.push({
            id: idCounter--, category: 'Close Now',
            severity: captured >= 0.75 ? 'high' : 'medium',
            description: `${t.ticker} ${t.strategy} $${t.strike}: option entered at $${t.entry_premium.toFixed(2)}, now at $${t.current_option_mid.toFixed(2)} — ${capPct}% of premium captured ($${plPerContract}/contract profit).`,
            proposedChange: `Buy back the $${t.strike} option to lock in the $${plPerContract} gain per contract and redeploy capital.`,
            status: 'live', createdAt: now
          });
          continue; // don't also fire Roll for the same trade
        }
      }

      // Roll: DTE ≤ 14
      if (dte <= 14) {
        const sev = dte <= 7 ? 'high' : 'medium';
        const itmNote = dist != null && dist < 0
          ? ` — stock is ${(Math.abs(dist) * 100).toFixed(1)}% ITM ($${t.last_price!.toFixed(2)} vs $${t.strike} strike)`
          : '';
        recs.push({
          id: idCounter--, category: 'Roll',
          severity: sev,
          description: `${t.ticker} ${t.strategy} $${t.strike} (exp ${t.expiration}): ${dte} DTE${itmNote}.`,
          proposedChange: `Roll out 30-45 days${dist != null && dist < 0 ? ' and consider rolling down the strike' : ''} to reduce assignment risk and collect more premium.`,
          status: 'live', createdAt: now
        });
        continue;
      }

      // Defend: stock at or through the strike with DTE remaining
      if (dist != null && dist < 0.03) {
        const isITM = dist < 0;
        const pct = (Math.abs(dist) * 100).toFixed(1);
        recs.push({
          id: idCounter--, category: isITM ? 'Defend' : 'Monitor',
          severity: isITM ? (Math.abs(dist) > 0.05 ? 'high' : 'medium') : 'low',
          description: `${t.ticker} ${t.strategy} $${t.strike}: stock at $${t.last_price!.toFixed(2)} is ${isITM ? `${pct}% ITM` : `${pct}% OTM but within 3% of strike`} with ${dte} DTE remaining.`,
          proposedChange: isITM
            ? `Roll down/out to reduce delta exposure. Consider buying a hedge or accepting assignment if the stock thesis is intact.`
            : `Monitor closely. Prepare to roll if stock breaks through the $${t.strike} strike.`,
          status: 'live', createdAt: now
        });
      }
    }

    // Sort: high → medium → low
    const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return recs.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  }

  getNativeLessons(): AgentNativeLesson[] {
    if (!this.db) return [];
    const lessons: AgentNativeLesson[] = [];
    const now = new Date().toISOString();
    let id = -1000;

    const cols = (this.db.prepare('PRAGMA table_info(agent_trades)').all() as Array<{ name: string }>).map(c => c.name);
    const hasPriceCols = cols.includes('entry_price');

    // ── 1. Expiry-risk loss & profit-target-reached ─────────────────────────
    interface OpenRow2 {
      id: number; ticker: string; strategy: string; strike: number;
      expiration: string; entry_premium: number; entry_date: string;
      dte_at_entry: number; last_price: number | null;
    }
    const openTrades = this.db.prepare(`
      SELECT id, ticker, strategy, strike, expiration, entry_premium, entry_date, dte_at_entry,
             ${hasPriceCols ? 'last_price' : 'NULL AS last_price'}
      FROM agent_trades WHERE status = 'open'
    `).all() as OpenRow2[];

    for (const t of openTrades) {
      const dte = Math.max(0, Math.round((new Date(t.expiration + 'T21:00:00Z').getTime() - Date.now()) / 86400000));
      const isCall = t.strategy.toLowerCase().includes('call');
      // dist > 0 = OTM (safe), dist < 0 = ITM (at risk)
      const dist = t.last_price != null
        ? (isCall ? (t.strike - t.last_price) / t.strike : (t.last_price - t.strike) / t.strike)
        : null;

      // Consider-close: ≥ 50% of premium captured (requires theory check option mid)
      // Checked via theory_checks join below — skip here if no current_option_mid

      // Expiry risk: ≤ 14 DTE and stock near or through the strike
      if (dte <= 14 && dist != null && dist < 0.05) {
        const isITM = dist < 0;
        const pct = (Math.abs(dist) * 100).toFixed(1);
        lessons.push({
          id: id--, type: 'expiry_risk', severity: dte <= 7 ? 'high' : 'medium',
          title: `${t.ticker}: ${dte} DTE — stock ${isITM ? 'ITM' : 'near strike'}`,
          narrative: `${t.ticker} ${t.strategy} $${t.strike} (exp ${t.expiration}): ${dte} days left, stock at $${t.last_price!.toFixed(2)} is ${isITM ? `${pct}% ITM (through the strike)` : `${pct}% OTM but within 5% of the strike`}. ${isITM ? 'Assignment risk is high — roll or close immediately.' : 'Monitor closely; prepare to roll if stock moves further against the position.'}`,
          ticker: t.ticker, tradeId: t.id, createdAt: now
        });
      }
    }

    // ── 2. Strike breach from theory checks ─────────────────────────────────
    const tcExists = (this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_theory_checks'"
    ).get() as { name: string } | undefined)?.name;

    if (tcExists) {
      const breachRows = this.db.prepare(`
        SELECT tc.trade_id, tc.current_stock_price, t.ticker, t.strategy, t.strike, t.expiration, t.mode
        FROM agent_theory_checks tc
        JOIN agent_trades t ON t.id = tc.trade_id
        WHERE t.status = 'open' AND tc.current_stock_price IS NOT NULL
          AND (
            (t.strategy IN ('cash_secured_put','wheel','leaps_csp') AND tc.current_stock_price < t.strike)
            OR
            (t.strategy IN ('covered_call','bull_call_spread') AND tc.current_stock_price > t.strike)
          )
      `).all() as Array<{
        trade_id: number; current_stock_price: number; ticker: string;
        strategy: string; strike: number; expiration: string; mode: string;
      }>;

      for (const r of breachRows) {
        const pct = Math.abs((r.current_stock_price - r.strike) / r.strike * 100);
        const dir = r.current_stock_price < r.strike ? 'below' : 'above';
        lessons.push({
          id: id--, type: 'strike_breach', severity: pct > 5 ? 'high' : 'medium',
          title: `${r.ticker}: Stock through strike — position is ITM`,
          narrative: `${r.ticker} is trading at $${r.current_stock_price.toFixed(2)}, which has crossed the $${r.strike} strike (${pct.toFixed(1)}% ${dir}). The ${r.strategy} is in-the-money — evaluate rolling to a lower/later strike, defending with a spread, or accepting assignment.`,
          ticker: r.ticker, tradeId: r.trade_id, createdAt: now
        });
      }

      // ── 3b. Profit target: ≥ 50% of premium captured per theory check ─────
      const profitRows = this.db.prepare(`
        SELECT tc.trade_id, tc.current_option_mid, t.ticker, t.strategy, t.strike,
               t.entry_premium, t.expiration
        FROM agent_theory_checks tc
        JOIN agent_trades t ON t.id = tc.trade_id
        WHERE t.status = 'open'
          AND tc.current_option_mid IS NOT NULL
          AND t.entry_premium > 0
          AND (t.entry_premium - tc.current_option_mid) / t.entry_premium >= 0.5
          AND tc.id IN (SELECT MAX(id) FROM agent_theory_checks GROUP BY trade_id)
      `).all() as Array<{
        trade_id: number; current_option_mid: number; ticker: string; strategy: string;
        strike: number; entry_premium: number; expiration: string;
      }>;
      for (const r of profitRows) {
        const captured = (r.entry_premium - r.current_option_mid) / r.entry_premium;
        const plPerContract = ((r.entry_premium - r.current_option_mid) * 100).toFixed(2);
        lessons.push({
          id: id--, type: 'profit_target', severity: captured >= 0.75 ? 'medium' : 'low',
          title: `${r.ticker}: ${(captured * 100).toFixed(0)}% of premium captured — consider closing`,
          narrative: `${r.ticker} ${r.strategy} $${r.strike}: option entered at $${r.entry_premium.toFixed(2)}, now at $${r.current_option_mid.toFixed(2)} — ${(captured * 100).toFixed(0)}% captured ($${plPerContract}/contract profit). Closing here locks in the gain and frees capital for a fresh entry.`,
          ticker: r.ticker, tradeId: r.trade_id, createdAt: now
        });
      }

      // ── 4. Stale position: open 60+ days with no theory check ─────────────
      const staleRows = this.db.prepare(`
        SELECT t.id, t.ticker, t.strategy, t.entry_date, t.expiration
        FROM agent_trades t
        WHERE t.status = 'open'
          AND t.entry_date < date('now', '-60 days')
          AND NOT EXISTS (SELECT 1 FROM agent_theory_checks c WHERE c.trade_id = t.id)
      `).all() as Array<{ id: number; ticker: string; strategy: string; entry_date: string; expiration: string }>;

      for (const r of staleRows) {
        const daysOpen = Math.round((Date.now() - new Date(r.entry_date).getTime()) / 86400000);
        lessons.push({
          id: id--, type: 'stale_position', severity: 'low',
          title: `${r.ticker}: Open ${daysOpen} days, no theory check`,
          narrative: `${r.ticker} ${r.strategy} (entered ${r.entry_date}) has been open for ${daysOpen} days without a theory validation. Run the review phase to verify the original thesis still holds before expiry (${r.expiration}).`,
          ticker: r.ticker, tradeId: r.id, createdAt: now
        });
      }
    }

    // ── 3. Strategy losing streak: last 3 closed trades same strategy all lost
    const recentClosed = this.db.prepare(`
      SELECT strategy, actual_pl FROM agent_trades
      WHERE status IN ('closed','expired') AND actual_pl IS NOT NULL
      ORDER BY id DESC LIMIT 30
    `).all() as Array<{ strategy: string; actual_pl: number }>;

    const byStratLast3: Record<string, number[]> = {};
    for (const r of recentClosed) {
      if (!byStratLast3[r.strategy]) byStratLast3[r.strategy] = [];
      if (byStratLast3[r.strategy]!.length < 3) byStratLast3[r.strategy]!.push(r.actual_pl);
    }
    for (const [strat, pls] of Object.entries(byStratLast3)) {
      if (pls.length >= 3 && pls.every(p => p < 0)) {
        const totalLoss = pls.reduce((a, b) => a + b, 0);
        lessons.push({
          id: id--, type: 'strategy_losing_streak', severity: 'high',
          title: `${strat}: 3 consecutive losses`,
          narrative: `The last 3 closed ${strat} trades all lost (total: -$${Math.abs(totalLoss).toFixed(2)}). Consider pausing new entries in this strategy. Review: are entry deltas too high? Is IV at entry consistently too low? Did earnings proximity factor in?`,
          createdAt: now
        });
      }
    }

    // Sort by severity
    const sevOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return lessons.sort((a, b) => (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3));
  }

  getTheoryChecks(limit = 100): AgentTheoryCheck[] {
    if (!this.db) return [];
    // Check if table exists (migration may not have run yet)
    const tableExists = (this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_theory_checks'"
    ).get() as { name: string } | undefined)?.name;
    if (!tableExists) return [];

    const rows = this.db.prepare(`
      SELECT c.id, c.trade_id, c.trade_status, c.verdict, c.narrative,
             c.current_stock_price, c.current_option_mid, c.current_delta,
             c.current_dte, c.iv_at_check, c.checked_at,
             t.ticker, t.strategy, t.strike, t.expiration, t.entry_premium
      FROM agent_theory_checks c
      JOIN agent_trades t ON t.id = c.trade_id
      ORDER BY c.checked_at DESC LIMIT ?
    `).all(limit) as Array<{
      id: number; trade_id: number; trade_status: string; verdict: string; narrative: string;
      current_stock_price: number | null; current_option_mid: number | null;
      current_delta: number | null; current_dte: number | null; iv_at_check: number | null;
      checked_at: string; ticker: string; strategy: string; strike: number;
      expiration: string; entry_premium: number;
    }>;

    return rows.map((r) => ({
      id: r.id, tradeId: r.trade_id, tradeStatus: r.trade_status,
      verdict: r.verdict as AgentTheoryCheck['verdict'],
      narrative: r.narrative,
      currentStockPrice: r.current_stock_price,
      currentOptionMid: r.current_option_mid,
      currentDelta: r.current_delta,
      currentDTE: r.current_dte,
      ivAtCheck: r.iv_at_check,
      checkedAt: r.checked_at,
      ticker: r.ticker, strategy: r.strategy, strike: r.strike,
      expiration: r.expiration, entryPremium: r.entry_premium
    }));
  }

  deleteTrade(id: number): void {
    if (!this.dbPath) throw new Error('No database open');
    // Open a separate writable connection — the main handle is readonly
    const writeDb = new Database(this.dbPath);
    try {
      writeDb.transaction(() => {
        writeDb.prepare('DELETE FROM agent_trade_alerts WHERE trade_id = ?').run(id);
        writeDb.prepare('DELETE FROM agent_trade_events WHERE trade_id = ?').run(id);
        writeDb.prepare('DELETE FROM agent_trade_projections WHERE trade_id = ?').run(id);
        writeDb.prepare('DELETE FROM agent_trade_inputs WHERE trade_id = ?').run(id);
        writeDb.prepare('DELETE FROM agent_lessons WHERE trade_id = ?').run(id);
        writeDb.prepare("DELETE FROM agent_theory_checks WHERE trade_id = ?").run(id);
        const result = writeDb.prepare('DELETE FROM agent_trades WHERE id = ?').run(id);
        if (result.changes === 0) throw new Error(`Trade #${id} not found`);
      })();
    } finally {
      writeDb.close();
    }
  }

  getMemory(): AgentMemorySnapshot | null {
    if (!this.db) return null;
    const row = this.db.prepare(
      'SELECT id, weights_json, win_rate_by_mode_json, top_lessons_json, trade_count, confidence, created_at FROM agent_memory ORDER BY id DESC LIMIT 1'
    ).get() as MemoryRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      weights: row.weights_json ? (JSON.parse(row.weights_json) as Record<string, number>) : {},
      winRateByMode: row.win_rate_by_mode_json ? (JSON.parse(row.win_rate_by_mode_json) as Record<string, number>) : {},
      tradeCount: row.trade_count ?? 0,
      confidence: row.confidence ?? 0,
      topLessons: row.top_lessons_json ? (JSON.parse(row.top_lessons_json) as string[]) : [],
      savedAt: row.created_at
    };
  }
}
