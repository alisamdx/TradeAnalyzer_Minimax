import type Database from 'better-sqlite3';
import type { BacktestConfig, BacktestTrade, BacktestProgressEvent } from '@shared/types.js';
import { computeMetrics, type EquityPoint } from './backtest-metrics.js';

type DbHandle = ReturnType<typeof import('better-sqlite3').default>;

interface PriceBar { date: string; open: number; high: number; low: number; close: number; volume: number }

// ─── Black-Scholes Math ───────────────────────────────────────────────────────

function cdfNorm(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const p = 0.3275911;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const poly = ((((a[4]! * t + a[3]!) * t + a[2]!) * t + a[1]!) * t + a[0]!) * t;
  const y = 1 - poly * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

function bsPrice(S: number, K: number, T: number, r: number, sigma: number, side: 'call' | 'put'): number {
  if (T <= 0 || sigma <= 0) return Math.max(0, side === 'call' ? S - K : K - S);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (side === 'call') return S * cdfNorm(d1) - K * Math.exp(-r * T) * cdfNorm(d2);
  return K * Math.exp(-r * T) * cdfNorm(-d2) - S * cdfNorm(-d1);
}

function bsDelta(S: number, K: number, T: number, r: number, sigma: number, side: 'call' | 'put'): number {
  if (T <= 0 || sigma <= 0) return side === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return side === 'call' ? cdfNorm(d1) : cdfNorm(d1) - 1;
}

function findStrikeForDelta(S: number, T: number, sigma: number, targetDelta: number, side: 'call' | 'put', r = 0.02): number {
  let bestStrike = S;
  let bestDiff = Infinity;
  // Search 60%–140% of spot in 0.5% steps
  for (let i = 0; i <= 160; i++) {
    const pct = 0.60 + (i / 160) * 0.80;
    const strike = Math.round(S * pct * 2) / 2; // nearest $0.50
    const delta = Math.abs(bsDelta(S, strike, T, r, sigma, side));
    const diff = Math.abs(delta - targetDelta);
    if (diff < bestDiff) { bestDiff = diff; bestStrike = strike; }
  }
  return bestStrike;
}

function rollingVol(closes: number[], windowDays = 20): number {
  const slice = closes.slice(-Math.min(windowDays + 1, closes.length));
  if (slice.length < 3) return 0.30;
  const returns: number[] = [];
  for (let i = 1; i < slice.length; i++) returns.push(Math.log(slice[i]! / slice[i - 1]!));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.max(0.05, Math.sqrt(variance * 252)); // floor at 5% vol
}

function addCalendarDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return (new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86_400_000;
}

// ─── Engine State ─────────────────────────────────────────────────────────────

interface OpenPosition {
  tradeId: number;
  side: 'put' | 'call';
  strike: number;
  entryPremium: number;
  entryDate: string;
  expiration: string;
  capitalReserved: number;
}

export class BacktestEngine {
  private cancelToken = { cancelled: false };

  constructor(private db: DbHandle) {}

  cancel(): void { this.cancelToken.cancelled = true; }
  resetCancel(): void { this.cancelToken.cancelled = false; }

  // ── Public API ────────────────────────────────────────────────────────────

  createConfig(cfg: Omit<BacktestConfig, 'id' | 'createdAt'>): number {
    const result = this.db.prepare(`
      INSERT INTO backtest_configs
        (name, strategy, ticker, start_date, end_date, starting_capital,
         dte_target, delta_target, profit_target_pct, stop_loss_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cfg.name, cfg.strategy, cfg.ticker.toUpperCase(),
      cfg.startDate, cfg.endDate, cfg.startingCapital,
      cfg.dteTarget, cfg.deltaTarget, cfg.profitTargetPct, cfg.stopLossPct
    );
    return result.lastInsertRowid as number;
  }

  listConfigs(): BacktestConfig[] {
    return (this.db.prepare('SELECT * FROM backtest_configs ORDER BY created_at DESC').all() as any[])
      .map(r => this.rowToConfig(r));
  }

  deleteConfig(configId: number): void {
    this.db.prepare('DELETE FROM backtest_configs WHERE id = ?').run(configId);
  }

  listRuns(configId?: number): import('@shared/types.js').BacktestRun[] {
    const rows = configId
      ? this.db.prepare(`
          SELECT r.*, c.name, c.strategy, c.ticker, c.start_date, c.end_date,
                 c.starting_capital, c.dte_target, c.delta_target, c.profit_target_pct,
                 c.stop_loss_pct, c.created_at as cfg_created_at
          FROM backtest_runs r JOIN backtest_configs c ON c.id = r.config_id
          WHERE r.config_id = ? ORDER BY r.created_at DESC
        `).all(configId) as any[]
      : this.db.prepare(`
          SELECT r.*, c.name, c.strategy, c.ticker, c.start_date, c.end_date,
                 c.starting_capital, c.dte_target, c.delta_target, c.profit_target_pct,
                 c.stop_loss_pct, c.created_at as cfg_created_at
          FROM backtest_runs r JOIN backtest_configs c ON c.id = r.config_id
          ORDER BY r.created_at DESC LIMIT 50
        `).all() as any[];
    return rows.map(r => this.rowToRun(r));
  }

  getRun(runId: number): import('@shared/types.js').BacktestRun | null {
    const r = this.db.prepare(`
      SELECT r.*, c.name, c.strategy, c.ticker, c.start_date, c.end_date,
             c.starting_capital, c.dte_target, c.delta_target, c.profit_target_pct,
             c.stop_loss_pct, c.created_at as cfg_created_at
      FROM backtest_runs r JOIN backtest_configs c ON c.id = r.config_id
      WHERE r.id = ?
    `).get(runId) as any;
    return r ? this.rowToRun(r) : null;
  }

  getMetrics(runId: number): import('@shared/types.js').BacktestMetrics | null {
    const r = this.db.prepare('SELECT * FROM backtest_metrics WHERE run_id = ?').get(runId) as any;
    if (!r) return null;
    return {
      runId: r.run_id,
      netPnl: r.net_pnl,
      totalReturnPct: r.total_return_pct,
      annualizedReturnPct: r.annualized_return_pct,
      maxDrawdownPct: r.max_drawdown_pct,
      sharpeRatio: r.sharpe_ratio,
      winRate: r.win_rate,
      totalTrades: r.total_trades,
      winningTrades: r.winning_trades,
      losingTrades: r.losing_trades,
      avgTradePnl: r.avg_trade_pnl,
      avgDaysHeld: r.avg_days_held,
      equityCurve: JSON.parse(r.equity_curve_json),
      computedAt: r.computed_at
    };
  }

  getTrades(runId: number): BacktestTrade[] {
    return (this.db.prepare('SELECT * FROM backtest_trades WHERE run_id = ? ORDER BY entry_date').all(runId) as any[])
      .map(r => this.rowToTrade(r));
  }

  deleteRun(runId: number): void {
    this.db.prepare('DELETE FROM backtest_runs WHERE id = ?').run(runId);
  }

  simulate(
    configId: number,
    onProgress: (evt: BacktestProgressEvent) => void
  ): { runId: number } {
    this.resetCancel();

    // Load config
    const cfgRow = this.db.prepare('SELECT * FROM backtest_configs WHERE id = ?').get(configId) as any;
    if (!cfgRow) throw new Error(`Backtest config ${configId} not found`);
    const cfg = this.rowToConfig(cfgRow);

    // Create run record
    const runRow = this.db.prepare(`
      INSERT INTO backtest_runs (config_id, status, started_at)
      VALUES (?, 'running', datetime('now'))
    `).run(configId);
    const runId = runRow.lastInsertRowid as number;

    try {
      // Load historical bars (need a wider window for vol computation)
      const volLookback = addCalendarDays(cfg.startDate, -60);
      const allBars = this.db.prepare(`
        SELECT date, open, high, low, close, volume
        FROM historical_prices
        WHERE ticker = ? AND date >= ? AND date <= ?
        ORDER BY date ASC
      `).all(cfg.ticker, volLookback, cfg.endDate) as PriceBar[];

      // Filter to simulation range
      const simBars = allBars.filter(b => b.date >= cfg.startDate && b.date <= cfg.endDate);

      if (simBars.length < 10) {
        throw new Error(
          `Insufficient price data for ${cfg.ticker} between ${cfg.startDate} and ${cfg.endDate}. ` +
          `Got ${simBars.length} bars — run Data Sync to fetch history first.`
        );
      }

      this.db.prepare('UPDATE backtest_runs SET total_days = ? WHERE id = ?').run(simBars.length, runId);

      // Run simulation
      const { trades, equityCurve } = this.runSimulation(cfg, runId, simBars, allBars, onProgress);

      // Compute and persist metrics
      const metrics = computeMetrics(runId, trades, equityCurve, cfg.startingCapital);
      this.persistMetrics(metrics);

      // Mark run complete
      this.db.prepare(`
        UPDATE backtest_runs SET status = 'completed', completed_at = datetime('now'), simulated_days = ?
        WHERE id = ?
      `).run(simBars.length, runId);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.db.prepare(`
        UPDATE backtest_runs SET status = 'failed', completed_at = datetime('now'), error_msg = ?
        WHERE id = ?
      `).run(msg, runId);
      throw err;
    }

    return { runId };
  }

  // ── Simulation Loop ───────────────────────────────────────────────────────

  private runSimulation(
    cfg: BacktestConfig,
    runId: number,
    simBars: PriceBar[],
    allBars: PriceBar[],
    onProgress: (evt: BacktestProgressEvent) => void
  ): { trades: BacktestTrade[]; equityCurve: EquityPoint[] } {
    const R = 0.02; // risk-free rate
    const insertTrade = this.db.prepare(`
      INSERT INTO backtest_trades
        (run_id, ticker, strategy, side, entry_date, expiration, strike, entry_premium,
         exit_date, exit_premium, exit_reason, pnl, stock_shares, stock_cost_basis, capital_required)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateTrade = this.db.prepare(`
      UPDATE backtest_trades
      SET exit_date = ?, exit_premium = ?, exit_reason = ?, pnl = ?, stock_shares = ?, stock_cost_basis = ?
      WHERE id = ?
    `);

    let capital = cfg.startingCapital;
    let shares = 0;
    let costBasis = 0;
    let wheelPhase: 'csp' | 'cc' = 'csp'; // only used for Wheel strategy
    let openPos: OpenPosition | null = null;
    const trades: BacktestTrade[] = [];
    const equityCurve: EquityPoint[] = [];
    const closes: number[] = allBars.slice(0, allBars.findIndex(b => b.date === simBars[0]!.date) + 1).map(b => b.close);

    for (let i = 0; i < simBars.length; i++) {
      if (this.cancelToken.cancelled) {
        this.db.prepare(`UPDATE backtest_runs SET status = 'cancelled', completed_at = datetime('now') WHERE id = ?`).run(runId);
        break;
      }

      const bar = simBars[i]!;
      const S = bar.close;
      closes.push(S);

      const sigma = rollingVol(closes, 20);
      const equity = capital + shares * S;

      // ── Check open position ──────────────────────────────────────────────
      if (openPos) {
        const daysLeft = daysBetween(bar.date, openPos.expiration);
        const T = Math.max(0, daysLeft / 365);
        const currentOptPrice = bsPrice(S, openPos.strike, T, R, sigma, openPos.side);
        const premCollected = openPos.entryPremium * 100;
        const buybackCost = currentOptPrice * 100;
        const pnlSoFar = premCollected - buybackCost;

        const expired = bar.date >= openPos.expiration;
        const profitHit = pnlSoFar >= premCollected * (cfg.profitTargetPct / 100);
        const stopHit = buybackCost >= premCollected * (cfg.stopLossPct / 100);

        if (expired || profitHit || stopHit) {
          let exitReason: BacktestTrade['exitReason'];
          let exitPremium: number;
          let tradePnl: number;
          let newShares = shares;
          let newCostBasis = costBasis;

          if (expired) {
            const itm = openPos.side === 'put' ? S < openPos.strike : S > openPos.strike;
            if (itm && openPos.side === 'put') {
              // Put assigned — buy stock at strike
              exitReason = 'assigned';
              exitPremium = openPos.strike - S; // intrinsic
              tradePnl = premCollected - exitPremium * 100;
              capital += openPos.capitalReserved; // release reserved capital
              capital -= openPos.strike * 100;   // buy stock at strike
              newShares = shares + 100;
              newCostBasis = openPos.strike;
              wheelPhase = 'cc';
            } else if (itm && openPos.side === 'call') {
              // Call assigned — sell stock at strike
              exitReason = 'assigned';
              exitPremium = S - openPos.strike; // intrinsic
              tradePnl = (openPos.strike - costBasis) * 100 + premCollected;
              capital += openPos.strike * 100;
              newShares = shares - 100;
              newCostBasis = 0;
              wheelPhase = 'csp';
            } else {
              exitReason = 'expiration';
              exitPremium = 0;
              tradePnl = premCollected;
              capital += openPos.capitalReserved;
            }
          } else if (profitHit) {
            exitReason = 'profit_target';
            exitPremium = currentOptPrice;
            tradePnl = pnlSoFar;
            capital += openPos.capitalReserved + tradePnl; // release + keep profit
          } else {
            exitReason = 'stop_loss';
            exitPremium = currentOptPrice;
            tradePnl = pnlSoFar; // negative
            capital += openPos.capitalReserved + tradePnl; // release - loss
          }

          updateTrade.run(bar.date, exitPremium, exitReason, tradePnl, newShares, newCostBasis || null, openPos.tradeId);
          shares = newShares;
          costBasis = newCostBasis;

          const t = this.getTrade(openPos.tradeId);
          if (t) trades.push(t);
          openPos = null;
        }
      }

      // ── Open new position if none ────────────────────────────────────────
      if (!openPos) {
        const side: 'put' | 'call' = this.getSide(cfg.strategy, wheelPhase);

        // CC requires owning stock first
        if (side === 'call' && shares < 100) {
          // No stock to write calls against — stay idle
        } else {
          const expirationDate = addCalendarDays(bar.date, cfg.dteTarget);
          const T = cfg.dteTarget / 365;
          const strike = findStrikeForDelta(S, T, sigma, cfg.deltaTarget, side, R);
          const optPrice = bsPrice(S, strike, T, R, sigma, side);

          if (optPrice < 0.05) {
            // Premium too low to be meaningful — skip
          } else {
            const capitalRequired = side === 'put' ? strike * 100 : 0;
            if (capital >= capitalRequired) {
              capital -= capitalRequired; // reserve cash for put (CC requires no cash)
              capital += optPrice * 100;  // collect premium upfront

              const row = insertTrade.run(
                runId, cfg.ticker, cfg.strategy, side,
                bar.date, expirationDate, strike, optPrice,
                null, null, null, null, shares, costBasis || null, capitalRequired
              );
              openPos = {
                tradeId: row.lastInsertRowid as number,
                side, strike, entryPremium: optPrice,
                entryDate: bar.date, expiration: expirationDate,
                capitalReserved: capitalRequired
              };
            }
          }
        }
      }

      // ── Equity snapshot every 5 bars ──────────────────────────────────
      if (i % 5 === 0 || i === simBars.length - 1) {
        const currentEquity = capital + shares * S;
        equityCurve.push({ date: bar.date, equity: currentEquity });

        onProgress({
          runId,
          simulatedDays: i + 1,
          totalDays: simBars.length,
          currentDate: bar.date,
          currentEquity,
          openTrades: openPos ? 1 : 0
        });
      }
    }

    // Close any open position at end of simulation
    if (openPos) {
      const lastBar = simBars.at(-1)!;
      const S = lastBar.close;
      const tradePnl = openPos.side === 'put'
        ? (openPos.entryPremium * 100) - Math.max(0, openPos.strike - S) * 100
        : (openPos.entryPremium * 100) - Math.max(0, S - openPos.strike) * 100;
      updateTrade.run(lastBar.date, null, 'expiration', tradePnl, shares, costBasis || null, openPos.tradeId);
      capital += openPos.capitalReserved + tradePnl;
      const t = this.getTrade(openPos.tradeId);
      if (t) trades.push(t);
    }

    // Ensure last equity point
    if (equityCurve.length === 0 || equityCurve.at(-1)!.date !== simBars.at(-1)!.date) {
      equityCurve.push({ date: simBars.at(-1)!.date, equity: capital + shares * simBars.at(-1)!.close });
    }

    return { trades, equityCurve };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private getSide(strategy: BacktestConfig['strategy'], wheelPhase: 'csp' | 'cc'): 'put' | 'call' {
    if (strategy === 'CSP') return 'put';
    if (strategy === 'CC') return 'call';
    return wheelPhase === 'csp' ? 'put' : 'call'; // Wheel
  }

  private getTrade(id: number): BacktestTrade | null {
    const r = this.db.prepare('SELECT * FROM backtest_trades WHERE id = ?').get(id) as any;
    return r ? this.rowToTrade(r) : null;
  }

  private persistMetrics(m: import('@shared/types.js').BacktestMetrics): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO backtest_metrics
        (run_id, net_pnl, total_return_pct, annualized_return_pct, max_drawdown_pct,
         sharpe_ratio, win_rate, total_trades, winning_trades, losing_trades,
         avg_trade_pnl, avg_days_held, equity_curve_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      m.runId, m.netPnl, m.totalReturnPct, m.annualizedReturnPct, m.maxDrawdownPct,
      m.sharpeRatio, m.winRate, m.totalTrades, m.winningTrades, m.losingTrades,
      m.avgTradePnl, m.avgDaysHeld, JSON.stringify(m.equityCurve)
    );
  }

  private rowToConfig(r: any): BacktestConfig {
    return {
      id: r.id,
      name: r.name,
      strategy: r.strategy,
      ticker: r.ticker,
      startDate: r.start_date,
      endDate: r.end_date,
      startingCapital: r.starting_capital,
      dteTarget: r.dte_target,
      deltaTarget: r.delta_target,
      profitTargetPct: r.profit_target_pct,
      stopLossPct: r.stop_loss_pct,
      createdAt: r.created_at
    };
  }

  private rowToRun(r: any): import('@shared/types.js').BacktestRun {
    return {
      id: r.id,
      configId: r.config_id,
      status: r.status,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      errorMsg: r.error_msg,
      totalDays: r.total_days,
      simulatedDays: r.simulated_days,
      createdAt: r.created_at,
      config: {
        id: r.config_id,
        name: r.name,
        strategy: r.strategy,
        ticker: r.ticker,
        startDate: r.start_date,
        endDate: r.end_date,
        startingCapital: r.starting_capital,
        dteTarget: r.dte_target,
        deltaTarget: r.delta_target,
        profitTargetPct: r.profit_target_pct,
        stopLossPct: r.stop_loss_pct,
        createdAt: r.cfg_created_at
      }
    };
  }

  private rowToTrade(r: any): BacktestTrade {
    return {
      id: r.id,
      runId: r.run_id,
      ticker: r.ticker,
      strategy: r.strategy,
      side: r.side,
      entryDate: r.entry_date,
      expiration: r.expiration,
      strike: r.strike,
      entryPremium: r.entry_premium,
      exitDate: r.exit_date,
      exitPremium: r.exit_premium,
      exitReason: r.exit_reason,
      pnl: r.pnl,
      stockShares: r.stock_shares,
      stockCostBasis: r.stock_cost_basis,
      capitalRequired: r.capital_required
    };
  }
}
