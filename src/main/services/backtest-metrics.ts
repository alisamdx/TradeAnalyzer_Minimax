import type { BacktestTrade, BacktestMetrics } from '@shared/types.js';

export interface EquityPoint { date: string; equity: number }

export function computeMetrics(
  runId: number,
  trades: BacktestTrade[],
  equityCurve: EquityPoint[],
  startingCapital: number
): BacktestMetrics {
  const closed = trades.filter(t => t.pnl !== null);
  const totalTrades = closed.length;
  const winningTrades = closed.filter(t => (t.pnl ?? 0) > 0).length;
  const losingTrades = closed.filter(t => (t.pnl ?? 0) <= 0).length;
  const netPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const avgTradePnl = totalTrades > 0 ? netPnl / totalTrades : 0;
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

  const avgDaysHeld = totalTrades > 0
    ? closed.reduce((s, t) => {
        if (!t.exitDate) return s;
        const ms = new Date(t.exitDate).getTime() - new Date(t.entryDate).getTime();
        return s + ms / 86_400_000;
      }, 0) / totalTrades
    : 0;

  const totalReturnPct = (netPnl / startingCapital) * 100;

  // Annualized return using equity curve date span
  let annualizedReturnPct = 0;
  if (equityCurve.length >= 2) {
    const days = (new Date(equityCurve.at(-1)!.date).getTime() - new Date(equityCurve[0]!.date).getTime()) / 86_400_000;
    if (days > 0) {
      annualizedReturnPct = (Math.pow(1 + totalReturnPct / 100, 365 / days) - 1) * 100;
    }
  }

  // Max drawdown from equity curve
  let maxDrawdownPct = 0;
  let peak = startingCapital;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  // Sharpe ratio from daily equity curve returns
  const sharpeRatio = computeSharpe(equityCurve);

  return {
    runId,
    netPnl,
    totalReturnPct,
    annualizedReturnPct,
    maxDrawdownPct,
    sharpeRatio,
    winRate,
    totalTrades,
    winningTrades,
    losingTrades,
    avgTradePnl,
    avgDaysHeld,
    equityCurve,
    computedAt: new Date().toISOString()
  };
}

function computeSharpe(equityCurve: EquityPoint[]): number {
  if (equityCurve.length < 3) return 0;
  const dailyRf = 0.02 / 252; // 2% annual risk-free rate
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1]!.equity;
    const curr = equityCurve[i]!.equity;
    if (prev > 0) returns.push(curr / prev - 1);
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return ((mean - dailyRf) / std) * Math.sqrt(252);
}
