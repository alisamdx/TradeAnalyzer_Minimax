// PayoffView — Multi-leg strategy payoff visualizer.
// Builds an at-expiration P&L diagram from user-defined legs.
// Supports CSP, CC, Collar, Bull/Bear spreads, and arbitrary combos.
// Chain integration loads live strikes + mid-prices + Greeks from the IPC layer.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InfoTip } from '../components/InfoTip.js';
import type {
  PayoffLeg,
  SavedPayoffStrategy,
  PayoffAssessInput,
  PayoffAssessment,
  PretradeValidationResult,
  PretradeValidateInput,
  PretradeTradePurpose,
  OptionsChainExpirationSummary,
  OptionsChainViewData,
  OptionContract,
  Watchlist,
  WatchlistItem,
} from '@shared/types.js';
import { fixLegsForStrategy } from '@shared/payoff-fix.js';

// ─── Pure math helpers ────────────────────────────────────────────────────────

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function roundHalf(n: number): number {
  return Math.round(n * 2) / 2; // nearest $0.50
}

function addDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

function fmtDollar(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 10_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(2)}`;
}

function fmtPrice(v: number): string {
  return `$${v.toFixed(2)}`;
}

/** Nice round step for axis ticks. */
function niceStep(range: number, targetTicks = 5): number {
  if (range === 0) return 1;
  const rough = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(rough))));
  const candidates = [1, 2, 2.5, 5, 10].map(f => f * mag);
  return candidates.find(c => c >= rough) ?? candidates[candidates.length - 1]!;
}

/** Generate nice axis ticks covering [min, max]. */
function niceTicks(min: number, max: number, targetTicks = 5): number[] {
  const step = niceStep(max - min, targetTicks);
  const lo = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= max + step * 0.01; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  return ticks;
}

// ─── Payoff computation ───────────────────────────────────────────────────────

interface PayoffMetrics {
  prices: number[];
  pnls: number[];
  maxProfit: number | null;   // null = unlimited
  maxLoss: number | null;     // null = unlimited
  unlimitedProfit: boolean;
  unlimitedLoss: boolean;
  breakevenPrices: number[];
  netDelta: number | null;
  netTheta: number | null;
  netVega: number | null;
  /** Net credit (+) or debit (-) for the whole position. */
  netPremium: number;
}

function computePayoffMetrics(legs: PayoffLeg[], spot: number): PayoffMetrics {
  const N = 200;
  const priceMin = spot * 0.50;
  const priceMax = spot * 1.55;

  const prices = Array.from({ length: N }, (_, i) =>
    priceMin + (i / (N - 1)) * (priceMax - priceMin)
  );

  const pnls = prices.map(S => {
    let total = 0;
    for (const leg of legs) {
      const qty = leg.quantity;
      if (leg.type === 'stock') {
        // premium = entry price for stock
        total += (leg.side === 'buy' ? 1 : -1) * (S - leg.premium) * qty * 100;
        continue;
      }
      const intrinsic = leg.type === 'call'
        ? Math.max(0, S - leg.strike)
        : Math.max(0, leg.strike - S);
      total += (leg.side === 'buy'
        ? (intrinsic - leg.premium)
        : (leg.premium - intrinsic)) * qty * 100;
    }
    return total;
  });

  // Net premium (positive = net credit received)
  const netPremium = legs.reduce((sum, leg) => {
    if (leg.type === 'stock') return sum;
    return sum + (leg.side === 'sell' ? 1 : -1) * leg.premium * leg.quantity * 100;
  }, 0);

  // Compute P&L at price = $0 (stock bankruptcy floor).
  // Stock price cannot go below $0, so left-side risk is always finite — only
  // the right side (uncovered short calls) can be truly unlimited.
  const pnlAtZero = legs.reduce((total, leg) => {
    const qty = leg.quantity;
    if (leg.type === 'stock') return total + (leg.side === 'buy' ? 1 : -1) * (0.01 - leg.premium) * qty * 100;
    const intrinsic = leg.type === 'call' ? 0 : (leg.strike - 0.01); // calls worthless at $0
    return total + (leg.side === 'buy'
      ? (intrinsic - leg.premium)
      : (leg.premium - intrinsic)) * qty * 100;
  }, 0);

  // Only check right-side slope for unlimited — left side is bounded by $0 floor.
  // Removing lSlope from both checks fixes false "∞" on short-put strategies
  // (CSP, straddle downside, jade/big lizard, etc.) where max loss is stock → $0.
  const rSlope = (pnls[N - 1]! - pnls[N - 6]!);
  const slopeThreshold = spot * 0.5;

  const unlimitedProfit = rSlope > slopeThreshold;   // still rising at high price (long call / long stock)
  const unlimitedLoss   = rSlope < -slopeThreshold;  // still falling at high price (uncovered short call / short stock)

  // Include pnlAtZero so max loss reflects the true downside (stock going bankrupt)
  const maxPnl = Math.max(...pnls, pnlAtZero);
  const minPnl = Math.min(...pnls, pnlAtZero);

  // Breakeven prices (zero crossings via linear interpolation)
  const breakevenPrices: number[] = [];
  for (let i = 1; i < N; i++) {
    const a = pnls[i - 1]!;
    const b = pnls[i]!;
    if (a * b <= 0 && Math.abs(a - b) > 1e-10) {
      const t = -a / (b - a);
      breakevenPrices.push(prices[i - 1]! + t * (prices[i]! - prices[i - 1]!));
    }
  }

  // Net Greeks — only meaningful when all legs have data; fall back to null
  const hasAllDelta = legs.every(l => l.type === 'stock' || l.delta != null);
  const hasAllTheta = legs.every(l => l.type === 'stock' || l.theta != null);
  const hasAllVega  = legs.every(l => l.type === 'stock' || l.vega != null);

  const netDelta = hasAllDelta ? legs.reduce((sum, leg) => {
    if (leg.type === 'stock') return sum + (leg.side === 'buy' ? 1 : -1) * leg.quantity;
    // delta is signed (positive for calls, negative for puts in standard convention)
    return sum + (leg.side === 'buy' ? 1 : -1) * (leg.delta ?? 0) * leg.quantity;
  }, 0) : null;

  const netTheta = hasAllTheta ? legs.reduce((sum, leg) => {
    if (leg.type === 'stock' || leg.theta == null) return sum;
    return sum + (leg.side === 'buy' ? 1 : -1) * leg.theta * leg.quantity * 100;
  }, 0) : null;

  const netVega = hasAllVega ? legs.reduce((sum, leg) => {
    if (leg.type === 'stock' || leg.vega == null) return sum;
    return sum + (leg.side === 'buy' ? 1 : -1) * leg.vega * leg.quantity * 100;
  }, 0) : null;

  return {
    prices, pnls,
    maxProfit: unlimitedProfit ? null : maxPnl,
    maxLoss:   unlimitedLoss   ? null : minPnl,
    unlimitedProfit,
    unlimitedLoss,
    breakevenPrices,
    netDelta, netTheta, netVega, netPremium,
  };
}

// ─── Black-Scholes pricer (for risk matrix pre-expiry cells) ─────────────────
// see docs/formulas.md#black-scholes

function normCdf(x: number): number {
  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * (Math.abs(x) / Math.SQRT2));
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + sign * y);
}

function bsPrice(S: number, K: number, T: number, r: number, sigma: number, type: 'call' | 'put'): number {
  if (T <= 0 || S <= 0 || K <= 0) {
    return type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
  }
  const sq = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sq);
  const d2 = d1 - sigma * sq;
  if (type === 'call') return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

// ─── Risk Matrix helpers ──────────────────────────────────────────────────────

function selectMatrixColumns(
  expirations: OptionsChainExpirationSummary[],
  legExpiries: string[], // fallback when chain not loaded
): string[] {
  // Chain loaded: use real expiry dates (rule: all ≤45 DTE, min 10)
  if (expirations.length > 0) {
    const sorted = [...expirations]
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const todayMs = Date.now();
    const within45 = sorted.filter(e => {
      const dte = (new Date(e.date).getTime() - todayMs) / 86_400_000;
      return dte >= 0 && dte <= 45;
    });
    const cols = within45.length >= 10 ? within45 : sorted.slice(0, 10);
    return cols.map(e => e.date);
  }

  // No chain: generate synthetic weekly columns so the time dimension is visible
  // even when legs were added manually. Columns go from ~1 week out to leg expiry.
  const furthest = legExpiries.filter(Boolean).sort().pop();
  if (!furthest) return [];
  const todayMs = Date.now();
  const totalDays = Math.round((new Date(furthest).getTime() - todayMs) / 86_400_000);
  if (totalDays <= 0) return [furthest];

  // Interval: weekly for ≤60 DTE, bi-weekly beyond
  const step = totalDays <= 60 ? 7 : 14;
  const cols: string[] = [];
  for (let d = step; d < totalDays; d += step) {
    cols.push(new Date(todayMs + d * 86_400_000).toISOString().slice(0, 10));
    if (cols.length >= 9) break; // cap at 9 intermediates + expiry = 10
  }
  cols.push(furthest); // always end at the actual expiry
  return cols;
}

function selectMatrixStrikes(
  chainData: { contracts: { strike: number }[] } | null,
  spotNum: number,
  legStrikes: number[], // option leg strikes — always included in range
): number[] {
  // Base range: ±25% of spot. Extended to cover all leg strikes so the risk
  // picture is never cut off (e.g. short put at $290 when stock is at $395).
  const spotLo = spotNum * 0.75, spotHi = spotNum * 1.25;
  const lo = legStrikes.length
    ? Math.min(spotLo, Math.min(...legStrikes) * 0.85)
    : spotLo;
  const hi = legStrikes.length
    ? Math.max(spotHi, Math.max(...legStrikes) * 1.15)
    : spotHi;

  if (chainData && chainData.contracts.length > 0) {
    const strikes = [...new Set(chainData.contracts.map(c => c.strike))]
      .filter(k => k >= lo && k <= hi)
      .sort((a, b) => a - b);
    if (strikes.length >= 3) return strikes;
  }
  // Fallback: synthetic strikes at a round interval
  const ref = Math.min(spotNum, ...legStrikes.filter(Boolean));
  const interval = ref > 500 ? 10 : ref > 100 ? 5 : ref > 50 ? 2.5 : 1;
  const synLo = Math.floor(lo / interval) * interval;
  const synHi = Math.ceil(hi  / interval) * interval;
  const result: number[] = [];
  for (let k = synLo; k <= synHi + 0.001; k += interval) result.push(Math.round(k * 100) / 100);
  return result;
}

const BS_RISK_FREE = 0.045;
const BS_FALLBACK_IV = 0.30;

function computeMatrixCell(legs: PayoffLeg[], S: number, colDateStr: string): number {
  const colMs = new Date(colDateStr).getTime();
  let total = 0;
  for (const leg of legs) {
    const qty = leg.quantity;
    const sign = leg.side === 'buy' ? 1 : -1;
    if (leg.type === 'stock') {
      total += sign * (S - leg.premium) * qty * 100;
      continue;
    }
    const T = (new Date(leg.expiry).getTime() - colMs) / (365.25 * 86_400_000);
    const theoretical = T <= 0
      ? (leg.type === 'call' ? Math.max(0, S - leg.strike) : Math.max(0, leg.strike - S))
      : bsPrice(S, leg.strike, T, BS_RISK_FREE, leg.iv ?? BS_FALLBACK_IV, leg.type);
    total += sign * (theoretical - leg.premium) * qty * 100;
  }
  return total;
}

function atExpiryPnl(legs: PayoffLeg[], S: number): number {
  let total = 0;
  for (const leg of legs) {
    const qty = leg.quantity;
    const sign = leg.side === 'buy' ? 1 : -1;
    if (leg.type === 'stock') { total += sign * (S - leg.premium) * qty * 100; continue; }
    const intrinsic = leg.type === 'call' ? Math.max(0, S - leg.strike) : Math.max(0, leg.strike - S);
    total += sign * (intrinsic - leg.premium) * qty * 100;
  }
  return total;
}

// ─── Per-leg scenario helpers ─────────────────────────────────────────────────

interface LegScenario {
  leg: PayoffLeg;
  theoretical: number;   // per-share theoretical price at (S, colDate)
  pnl: number;           // total P&L for this leg
  action: 'take_profit' | 'consider_close' | 'close_loss' | 'watch' | 'hold';
  actionLabel: string;
}

function computeLegScenarios(legs: PayoffLeg[], S: number, colDateStr: string): LegScenario[] {
  const colMs = new Date(colDateStr).getTime();
  return legs.map(leg => {
    const qty  = leg.quantity;
    const sign = leg.side === 'buy' ? 1 : -1;

    if (leg.type === 'stock') {
      const pnl = sign * (S - leg.premium) * qty * 100;
      return { leg, theoretical: S, pnl, action: 'hold', actionLabel: pnl >= 0 ? 'Hold — gain' : 'Hold — loss' };
    }

    const T = (new Date(leg.expiry).getTime() - colMs) / (365.25 * 86_400_000);
    const theoretical = T <= 0
      ? (leg.type === 'call' ? Math.max(0, S - leg.strike) : Math.max(0, leg.strike - S))
      : bsPrice(S, leg.strike, T, BS_RISK_FREE, leg.iv ?? BS_FALLBACK_IV, leg.type);

    const pnl      = sign * (theoretical - leg.premium) * qty * 100;
    const capacity = leg.premium * qty * 100; // total premium per side (always positive)

    let action: LegScenario['action'] = 'hold';
    let actionLabel = 'Hold';

    if (leg.side === 'sell') {
      const profitPct = capacity > 0 ? (pnl / capacity) * 100 : 0;
      if (profitPct >= 80) {
        action = 'take_profit'; actionLabel = `✓ Take profits — ${profitPct.toFixed(0)}% collected`;
      } else if (profitPct >= 50) {
        action = 'consider_close'; actionLabel = `✓ Consider closing — ${profitPct.toFixed(0)}% collected`;
      } else if (pnl < 0 && Math.abs(pnl) >= capacity) {
        action = 'close_loss'; actionLabel = `⚠ Close — loss exceeds premium collected`;
      } else if (pnl < 0 && Math.abs(pnl) >= capacity * 0.5) {
        action = 'watch'; actionLabel = `⚡ Watch — ${Math.abs(profitPct).toFixed(0)}% of premium at risk`;
      } else {
        actionLabel = profitPct >= 0
          ? `Hold — ${profitPct.toFixed(0)}% collected`
          : `Hold — ${Math.abs(profitPct).toFixed(0)}% at risk`;
      }
    } else {
      // Buy (protection / long)
      const entryDebit = leg.premium * qty * 100;
      if (pnl > entryDebit * 0.5) {
        action = 'take_profit'; actionLabel = `✓ Hedge profitable — can close`;
      } else if (pnl < 0) {
        actionLabel = 'Hold — protection active';
      } else {
        actionLabel = 'Hold';
      }
    }

    return { leg, theoretical, pnl, action, actionLabel };
  });
}

function actionColor(action: LegScenario['action']): string {
  switch (action) {
    case 'take_profit':    return '#22c55e';
    case 'consider_close': return '#86efac';
    case 'close_loss':     return '#ef4444';
    case 'watch':          return '#f59e0b';
    default:               return '#94a3b8';
  }
}

// ─── Risk Matrix Table component ──────────────────────────────────────────────

function RiskMatrixTable({
  legs, spotNum, chainExpirations, chainData, hasIv, earningsDate,
}: {
  legs: PayoffLeg[];
  spotNum: number;
  chainExpirations: OptionsChainExpirationSummary[];
  chainData: { contracts: { strike: number }[] } | null;
  hasIv: boolean;
  earningsDate?: string | null;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const legStrikes  = useMemo(
    () => legs.filter(l => l.type !== 'stock').map(l => l.strike),
    [legs],
  );
  const legExpiries = useMemo(
    () => [...new Set(legs.filter(l => l.type !== 'stock').map(l => l.expiry))],
    [legs],
  );
  const expiryDates = useMemo(
    () => selectMatrixColumns(chainExpirations, legExpiries),
    [chainExpirations, legExpiries],
  );
  const colDates    = useMemo(() => [today, ...expiryDates], [today, expiryDates]);
  const strikes     = useMemo(
    () => selectMatrixStrikes(chainData, spotNum, legStrikes),
    [chainData, spotNum, legStrikes],
  );

  // Selected cell for leg breakdown panel
  const [selectedCell, setSelectedCell] = useState<{ ri: number; ci: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const spotRowRef   = useRef<HTMLTableRowElement>(null);

  // Full 2D grid: [strikeIdx][colIdx]
  const grid = useMemo(
    () => strikes.map(S => colDates.map(d => computeMatrixCell(legs, S, d))),
    [legs, strikes, colDates],
  );

  // At-expiry P&L per row (for Zone column)
  const expiryPnls = useMemo(() => strikes.map(S => atExpiryPnl(legs, S)), [legs, strikes]);

  // Color scale bounds across entire grid
  const allVals = grid.flat();
  const maxVal = Math.max(...allVals, 0.01);
  const minVal = Math.min(...allVals, -0.01);

  function cellBg(val: number): string {
    if (val > 0) return `rgba(34,197,94,${(0.12 + 0.55 * Math.min(1, val / maxVal)).toFixed(2)})`;
    return `rgba(239,68,68,${(0.12 + 0.55 * Math.min(1, val / minVal)).toFixed(2)})`;
  }

  function fmtCell(val: number): string {
    const sign = val >= 0 ? '+' : '';
    if (Math.abs(val) >= 10_000) return `${sign}$${(val / 1_000).toFixed(0)}k`;
    if (Math.abs(val) >= 1_000)  return `${sign}$${(val / 1_000).toFixed(1)}k`;
    return `${sign}$${val.toFixed(0)}`;
  }

  const isSynthetic = chainExpirations.length === 0;

  // Find the column index nearest to the earnings date
  const earningsColIdx = useMemo(() => {
    if (!earningsDate) return -1;
    const eMs = new Date(earningsDate).getTime();
    let best = -1, bestDiff = Infinity;
    colDates.forEach((d, i) => {
      const diff = Math.abs(new Date(d).getTime() - eMs);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    });
    return best;
  }, [earningsDate, colDates]);

  function fmtColHeader(dateStr: string, idx: number): React.ReactNode {
    if (idx === 0) return 'Today';
    const d = new Date(`${dateStr}T12:00:00Z`);
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const dte = Math.round((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
    const isEarnings = idx === earningsColIdx;
    return (
      <>
        {label}
        {isSynthetic && !isEarnings && <span style={{ color: '#6b7280', fontSize: 8 }}>~</span>}
        {isEarnings && <span style={{ fontSize: 9, marginLeft: 2 }}>📅</span>}
        <br/>
        <span style={{ color: '#475569', fontSize: 9 }}>{dte}d</span>
      </>
    );
  }

  function zoneLabel(pnl: number, allExpiry: number[]): string {
    const mx = Math.max(...allExpiry), mn = Math.min(...allExpiry);
    if (Math.abs(pnl - mx) < 0.5) return '★ Max Profit';
    if (Math.abs(pnl - mn) < 0.5) return '✕ Max Loss';
    if (Math.abs(pnl) < 5)        return '— Breakeven';
    return pnl > 0 ? '✓ Profit' : '✗ Loss';
  }

  function zoneColor(label: string): string {
    if (label.includes('Max Profit') || label.includes('Profit')) return '#22c55e';
    if (label.includes('Max Loss')   || label.includes('Loss'))   return '#ef4444';
    if (label.includes('Breakeven'))                              return '#fbbf24';
    return '#94a3b8';
  }

  // Row nearest to current spot
  const spotRowIdx = strikes.reduce(
    (best, k, i) => Math.abs(k - spotNum) < Math.abs(strikes[best]! - spotNum) ? i : best, 0,
  );

  // Scroll so the spot row is vertically centred whenever strikes change
  useEffect(() => {
    const container = containerRef.current;
    const row = spotRowRef.current;
    if (!container || !row) return;
    container.scrollTop = row.offsetTop - container.clientHeight / 2 + row.offsetHeight / 2;
  }, [spotRowIdx]);

  // Set of leg strikes for row highlighting
  const legStrikeSet = useMemo(() => new Set(legStrikes.map(k => k.toFixed(2))), [legStrikes]);

  // Leg breakdown for the selected cell.
  //
  // **Above the early return, and it has to be.** This used to sit below the
  // `strikes.length === 0 || legs.length === 0` guard, so the component called
  // 11 hooks on an empty render and 12 once legs existed. React matches hook
  // state POSITIONALLY, so the transition from empty to populated — the normal
  // path through this screen, since the empty state is what you see before
  // adding a leg — shifts every hook after the boundary. That is either
  // "rendered more hooks than during the previous render" or, worse, a hook
  // silently reading another hook's slot. Its own body already returns null
  // when there is nothing selected, so calling it unconditionally costs a
  // comparison and changes no behaviour.
  const legScenarios = useMemo(() => {
    if (!selectedCell) return null;
    const S = strikes[selectedCell.ri];
    const d = colDates[selectedCell.ci];
    if (S === undefined || d === undefined) return null;
    return { S, d, scenarios: computeLegScenarios(legs, S, d) };
  }, [selectedCell, strikes, colDates, legs]);

  if (strikes.length === 0 || legs.length === 0) {
    return <div style={{ color: '#64748b', padding: 24, textAlign: 'center' }}>Add legs and a spot price to generate the risk matrix.</div>;
  }

  const thStyle: React.CSSProperties = {
    padding: '5px 10px', textAlign: 'right', color: '#64748b',
    fontWeight: 600, fontSize: 10, letterSpacing: 0.5, whiteSpace: 'nowrap',
    borderBottom: '1px solid #1e293b', background: '#0a0f1a',
    position: 'sticky', top: 0, zIndex: 2,
  };

  const handleCellClick = (ri: number, ci: number) => {
    setSelectedCell(prev => (prev?.ri === ri && prev?.ci === ci) ? null : { ri, ci });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div ref={containerRef} style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 440, border: '1px solid #1e293b', borderRadius: selectedCell ? '6px 6px 0 0' : 6 }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, textAlign: 'right' }}>Strike</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>vs Spot</th>
              {colDates.map((d, i) => {
                const isExpiry   = i === colDates.length - 1;
                const isEarnings = i === earningsColIdx;
                return (
                  <th key={d} style={{ ...thStyle, textAlign: 'right', minWidth: 68,
                    color: isExpiry ? '#fbbf24' : isEarnings ? '#f59e0b' : '#64748b',
                    borderLeft: isExpiry ? '2px solid #374151' : isEarnings ? '2px solid #f59e0b55' : '1px solid #1e293b',
                    background: isEarnings ? 'rgba(245,158,11,0.07)' : '#0a0f1a',
                  }}>
                    {fmtColHeader(d, i)}
                  </th>
                );
              })}
              <th style={{ ...thStyle, textAlign: 'left', borderLeft: '2px solid #374151', color: '#94a3b8' }}>Zone</th>
            </tr>
          </thead>
          <tbody>
            {strikes.map((strike, ri) => {
              const isSpot     = ri === spotRowIdx;
              const isLegStrike = legStrikeSet.has(strike.toFixed(2));
              const row = grid[ri]!;
              const expPnl = expiryPnls[ri]!;
              const zone  = zoneLabel(expPnl, expiryPnls);

              return (
                <tr key={strike} ref={isSpot ? spotRowRef : undefined} style={{
                  outline: isSpot ? '2px solid #3b82f6' : isLegStrike ? '1px solid #f59e0b55' : undefined,
                  outlineOffset: isSpot ? '-2px' : '-1px',
                }}>
                  <td style={{ padding: '3px 10px', textAlign: 'right', color: isLegStrike ? '#fbbf24' : '#e2e8f0', fontWeight: (isSpot || isLegStrike) ? 700 : 400, borderRight: '1px solid #1e293b', whiteSpace: 'nowrap' }}>
                    ${strike.toFixed(2)}
                    {isSpot      && <span style={{ color: '#3b82f6', marginLeft: 4, fontSize: 9 }}>◀ spot</span>}
                    {isLegStrike && !isSpot && <span style={{ color: '#f59e0b', marginLeft: 4, fontSize: 9 }}>◀ strike</span>}
                  </td>
                  <td style={{ padding: '3px 8px', textAlign: 'right', color: strike >= spotNum ? '#22c55e' : '#ef4444', borderRight: '1px solid #1e293b' }}>
                    {strike >= spotNum ? '+' : ''}{((strike - spotNum) / spotNum * 100).toFixed(1)}%
                  </td>
                  {row.map((pnl, ci) => {
                    const isSelected = selectedCell?.ri === ri && selectedCell?.ci === ci;
                    return (
                      <td
                        key={ci}
                        onClick={() => handleCellClick(ri, ci)}
                        style={{
                          padding: '3px 10px', textAlign: 'right', cursor: 'pointer',
                          background: isSelected ? '#1d4ed8' : cellBg(pnl),
                          color: '#f1f5f9', fontWeight: isSelected ? 700 : 500,
                          borderLeft: ci === colDates.length - 1 ? '2px solid #374151' : ci === earningsColIdx ? '2px solid #f59e0b55' : '1px solid #1e293b',
                          outline: isSelected ? '2px solid #93c5fd' : ci === earningsColIdx ? '1px solid #f59e0b33' : undefined,
                          outlineOffset: isSelected ? '-2px' : '-1px',
                        }}
                        title={ci === earningsColIdx ? '📅 Earnings — click to see leg breakdown' : 'Click to see leg-by-leg breakdown'}
                      >
                        {fmtCell(pnl)}
                      </td>
                    );
                  })}
                  <td style={{ padding: '3px 12px', borderLeft: '2px solid #374151', color: zoneColor(zone), whiteSpace: 'nowrap', fontSize: 10 }}>
                    {zone}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {(isSynthetic || !hasIv) && (
          <div style={{ padding: '6px 12px', fontSize: 10, color: '#64748b', borderTop: '1px solid #1e293b', background: '#0a0f1a', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {isSynthetic && <span>~ Date columns are estimated weekly intervals — load the options chain for real expiry dates.</span>}
            {!hasIv      && <span>⚠ IV not set on some legs — intermediate values use {Math.round(BS_FALLBACK_IV * 100)}% estimate. Load from chain or enter IV on the leg for accuracy.</span>}
          </div>
        )}
      </div>

      {/* ── Leg breakdown panel ── */}
      {legScenarios && (
        <div style={{ border: '1px solid #1e293b', borderTop: '2px solid #1d4ed8', borderRadius: '0 0 6px 6px', background: '#0a0f1a', padding: '10px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>
              Scenario: ${legScenarios.S.toFixed(2)} · {
                legScenarios.d === today ? 'Today' :
                new Date(`${legScenarios.d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
              }
            </span>
            <span style={{ fontSize: 11, color: (() => { const n = legScenarios.scenarios.reduce((s,x) => s + x.pnl, 0); return n >= 0 ? '#22c55e' : '#ef4444'; })(), fontWeight: 600 }}>
              Net {fmtCell(legScenarios.scenarios.reduce((s, x) => s + x.pnl, 0))}
            </span>
            <button
              onClick={() => setSelectedCell(null)}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}
            >×</button>
          </div>

          <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
            <thead>
              <tr style={{ color: '#64748b', fontSize: 10 }}>
                <th style={{ textAlign: 'left',  padding: '2px 8px 4px 0', fontWeight: 600 }}>Leg</th>
                <th style={{ textAlign: 'right', padding: '2px 8px 4px',   fontWeight: 600 }}>Entry</th>
                <th style={{ textAlign: 'right', padding: '2px 8px 4px',   fontWeight: 600 }}>Current</th>
                <th style={{ textAlign: 'right', padding: '2px 8px 4px',   fontWeight: 600 }}>P&L</th>
                <th style={{ textAlign: 'left',  padding: '2px 0   4px 8px', fontWeight: 600 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {legScenarios.scenarios.map((sc, i) => (
                <tr key={i} style={{ borderTop: i > 0 ? '1px solid #1e293b' : undefined }}>
                  <td style={{ padding: '4px 8px 4px 0', color: '#cbd5e1', whiteSpace: 'nowrap' }}>
                    {sc.leg.label}
                  </td>
                  <td style={{ padding: '4px 8px', textAlign: 'right', color: '#94a3b8' }}>
                    {sc.leg.type === 'stock' ? `$${sc.leg.premium.toFixed(2)}` : `$${sc.leg.premium.toFixed(2)}/sh`}
                  </td>
                  <td style={{ padding: '4px 8px', textAlign: 'right', color: '#94a3b8' }}>
                    {sc.leg.type === 'stock' ? `$${sc.theoretical.toFixed(2)}` : `$${sc.theoretical.toFixed(2)}/sh`}
                  </td>
                  <td style={{ padding: '4px 8px', textAlign: 'right', fontWeight: 600, color: sc.pnl >= 0 ? '#22c55e' : '#ef4444' }}>
                    {fmtCell(sc.pnl)}
                  </td>
                  <td style={{ padding: '4px 0 4px 8px', color: actionColor(sc.action), whiteSpace: 'nowrap' }}>
                    {sc.actionLabel}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Lizard hedge leg selection ───────────────────────────────────────────────
// For Jade/Big/Reverse lizard strategies, the buy (hedge) leg must be at the
// furthest available strike where: shortCredit ≥ spreadWidth (no upside/downside risk).

const LIZARD_HEDGE_SLUGS = new Set([
  'jade-lizard', 'big-lizard', 'reverse-jade-lizard', 'reverse-big-lizard',
]);

function findLizardHedgePayoff(
  contracts: OptionContract[],
  side: 'call' | 'put',
  sellStrike: number,
  shortCreditPerShare: number,
): OptionContract | null {
  const candidates = contracts
    .filter(c => side === 'call' ? c.strike > sellStrike : c.strike < sellStrike)
    .sort((a, b) => side === 'call' ? a.strike - b.strike : b.strike - a.strike);

  if (!candidates.length) return null;

  let bestValid: OptionContract | null = null;
  for (const c of candidates) {
    const spreadWidth = side === 'call' ? c.strike - sellStrike : sellStrike - c.strike;
    const mid         = (c.bid + c.ask) / 2;
    if (shortCreditPerShare - mid >= spreadWidth) {
      bestValid = c;
    } else {
      break; // monotonically harder beyond this point
    }
  }
  return bestValid ?? candidates[0] ?? null;
}

// Fills a set of template legs from a loaded options chain.
// For lizard strategies the hedge leg uses smart strike selection;
// all other legs use nearest-to-template-strike matching.
function fillLegsFromChain(
  slug:         string,
  templateLegs: PayoffLeg[],
  getChain:     (templateExpiry: string) => OptionsChainViewData | undefined,
  getRealExpiry:(templateExpiry: string) => string | undefined,
): PayoffLeg[] {
  const isLizard = LIZARD_HEDGE_SLUGS.has(slug);
  const result:   PayoffLeg[] = [];

  for (const leg of templateLegs) {
    if (leg.type === 'stock') { result.push(leg); continue; }

    const realExpiry = getRealExpiry(leg.expiry);
    const chain      = getChain(leg.expiry);
    if (!realExpiry || !chain) { result.push(leg); continue; }

    const contracts = chain.contracts.filter(c => c.side === leg.type);
    if (!contracts.length) { result.push(leg); continue; }

    let nearest: OptionContract | null = null;

    if (isLizard && leg.side === 'buy') {
      // Compute short credit from legs already filled in this pass
      const shortCredit = result
        .filter(l => l.type !== 'stock' && l.side === 'sell')
        .reduce((s, l) => s + l.premium, 0);
      const sellLeg = result.find(l => l.type === leg.type && l.side === 'sell');
      if (sellLeg) {
        nearest = findLizardHedgePayoff(contracts, leg.type, sellLeg.strike, shortCredit);
      }
    }

    // Fallback: nearest strike to template target
    if (!nearest) {
      nearest = contracts.reduce<OptionContract | null>((best, c) =>
        best === null ? c : Math.abs(c.strike - leg.strike) < Math.abs(best.strike - leg.strike) ? c : best,
      null);
    }

    if (!nearest) { result.push(leg); continue; }

    const mid     = Math.max(0, parseFloat(((nearest.bid + nearest.ask) / 2).toFixed(2)));
    const sideStr = leg.side === 'buy' ? 'Buy' : 'Sell';
    const typeStr = leg.type.charAt(0).toUpperCase() + leg.type.slice(1);
    const qtyStr  = leg.quantity > 1 ? ` ${leg.quantity}` : '';
    result.push({
      ...leg,
      strike:  nearest.strike,
      expiry:  realExpiry,
      premium: mid,
      delta:   nearest.delta ?? leg.delta,
      theta:   nearest.theta ?? null,
      vega:    nearest.vega  ?? null,
      iv:      nearest.iv    ?? null,
      label:   `${sideStr}${qtyStr} ${typeStr} $${nearest.strike}`,
    });
  }

  return result;
}

// ─── Strategy templates (all 31 Strategy Lab strategies) ─────────────────────

interface StrategyTemplate {
  slug: string;
  name: string;
  category: string;
  build: (spot: number) => PayoffLeg[];
}

const TEMPLATE_CATEGORY_LABELS: Record<string, string> = {
  'neutral-bullish':  'Neutral / Bullish Bias',
  'neutral-bearish':  'Neutral / Bearish Bias',
  'neutral':          'Neutral',
  'bullish':          'Bullish',
  'bearish':          'Bearish',
  'omnidirectional':  'Complex',
};
const TEMPLATE_CATEGORY_ORDER = ['neutral-bullish', 'neutral-bearish', 'neutral', 'bullish', 'bearish', 'omnidirectional'] as const;

// Leg builder — premium: 0 for options so user fills from chain (shows orange)
const mkLeg = (
  side: PayoffLeg['side'], type: PayoffLeg['type'],
  strike: number, dte: number, delta: number | null,
  qty = 1, labelOverride?: string,
): PayoffLeg => {
  const s = type === 'stock' ? 0 : roundHalf(strike);
  const baseLabel = type === 'stock'
    ? (side === 'buy' ? 'Long 100 shares' : 'Short 100 shares')
    : `${side === 'buy' ? 'Buy' : 'Sell'}${qty > 1 ? ` ${qty}` : ''} ${type.charAt(0).toUpperCase() + type.slice(1)} $${s}`;
  return {
    id: genId(), side, type, strike: s, expiry: addDays(dte),
    premium: type === 'stock' ? strike : 0,
    quantity: qty, delta, theta: null, vega: null, iv: null,
    label: labelOverride ?? baseLabel,
  };
};

const ALL_TEMPLATES: StrategyTemplate[] = [
  // ── Neutral / Bullish Bias ───────────────────────────────────────────────
  {
    slug: 'short-naked-put', name: 'Short Naked Put (CSP)', category: 'neutral-bullish',
    build: s => [mkLeg('sell', 'put', s * 0.95, 45, -0.30)],
  },
  {
    slug: 'short-put-vertical', name: 'Short Put Vertical', category: 'neutral-bullish',
    build: s => [mkLeg('sell', 'put', s * 0.95, 45, -0.30), mkLeg('buy', 'put', s * 0.90, 45, -0.15)],
  },
  {
    slug: 'jade-lizard', name: 'Jade Lizard', category: 'neutral-bullish',
    build: s => [
      mkLeg('sell', 'put',  s * 0.95, 45, -0.30),
      mkLeg('sell', 'call', s * 1.05, 45,  0.25),
      mkLeg('buy',  'call', s * 1.10, 45,  0.15),
    ],
  },
  // ── Neutral / Bearish Bias ───────────────────────────────────────────────
  {
    slug: 'short-naked-call', name: 'Short Naked Call', category: 'neutral-bearish',
    build: s => [mkLeg('sell', 'call', s * 1.05, 45, 0.25)],
  },
  {
    slug: 'short-call-vertical', name: 'Short Call Vertical', category: 'neutral-bearish',
    build: s => [mkLeg('sell', 'call', s * 1.05, 45, 0.25), mkLeg('buy', 'call', s * 1.10, 45, 0.15)],
  },
  {
    slug: 'reverse-jade-lizard', name: 'Reverse Jade Lizard', category: 'neutral-bearish',
    build: s => [
      mkLeg('buy',  'put',  s * 0.90, 45, -0.15),
      mkLeg('sell', 'put',  s * 0.95, 45, -0.30),
      mkLeg('sell', 'call', s * 1.05, 45,  0.25),
    ],
  },
  // ── Neutral ──────────────────────────────────────────────────────────────
  {
    slug: 'short-strangle', name: 'Short Strangle', category: 'neutral',
    build: s => [mkLeg('sell', 'put', s * 0.90, 45, -0.16), mkLeg('sell', 'call', s * 1.10, 45, 0.16)],
  },
  {
    slug: 'short-straddle', name: 'Short Straddle', category: 'neutral',
    build: s => [mkLeg('sell', 'put', Math.round(s), 30, -0.50), mkLeg('sell', 'call', Math.round(s), 30, 0.50)],
  },
  {
    slug: 'iron-condor', name: 'Iron Condor', category: 'neutral',
    build: s => [
      mkLeg('buy',  'put',  s * 0.85, 45, -0.10),
      mkLeg('sell', 'put',  s * 0.92, 45, -0.20),
      mkLeg('sell', 'call', s * 1.08, 45,  0.20),
      mkLeg('buy',  'call', s * 1.15, 45,  0.10),
    ],
  },
  {
    slug: 'dynamic-width-iron-condor', name: 'Dynamic Width Iron Condor', category: 'neutral',
    build: s => [
      mkLeg('buy',  'put',  s * 0.82, 45, -0.08),
      mkLeg('sell', 'put',  s * 0.90, 45, -0.20),
      mkLeg('sell', 'call', s * 1.10, 45,  0.20),
      mkLeg('buy',  'call', s * 1.18, 45,  0.08),
    ],
  },
  {
    slug: 'iron-fly', name: 'Iron Fly', category: 'neutral',
    build: s => {
      const atm = Math.round(s);
      return [
        mkLeg('buy',  'put',  s * 0.90, 30, -0.15),
        mkLeg('sell', 'put',  atm,      30, -0.50),
        mkLeg('sell', 'call', atm,      30,  0.50),
        mkLeg('buy',  'call', s * 1.10, 30,  0.15),
      ];
    },
  },
  // ── Bullish ──────────────────────────────────────────────────────────────
  {
    slug: 'covered-call', name: 'Covered Call', category: 'bullish',
    build: s => [mkLeg('buy', 'stock', s, 0, null), mkLeg('sell', 'call', s * 1.05, 30, 0.25)],
  },
  {
    slug: 'long-call-vertical', name: 'Long Call Vertical', category: 'bullish',
    build: s => [mkLeg('buy', 'call', Math.round(s), 45, 0.50), mkLeg('sell', 'call', s * 1.05, 45, 0.25)],
  },
  {
    slug: 'big-lizard', name: 'Big Lizard', category: 'bullish',
    build: s => {
      const atm = Math.round(s);
      return [mkLeg('sell', 'put', atm, 45, -0.50), mkLeg('sell', 'call', atm, 45, 0.50), mkLeg('buy', 'call', s * 1.10, 45, 0.15)];
    },
  },
  {
    slug: 'poor-mans-covered-call', name: "Poor Man's Covered Call (PMCC)", category: 'bullish',
    build: s => [
      mkLeg('buy',  'call', s * 0.80, 90, 0.80, 1, `Buy Call $${roundHalf(s * 0.80)} (deep ITM, 90d)`),
      mkLeg('sell', 'call', s * 1.10, 30, 0.20),
    ],
  },
  {
    slug: 'call-calendar', name: 'Call Calendar', category: 'bullish',
    build: s => {
      const atm = Math.round(s);
      return [
        mkLeg('sell', 'call', atm, 30, 0.50, 1, `Sell Call $${atm} (30d)`),
        mkLeg('buy',  'call', atm, 60, 0.50, 1, `Buy Call $${atm} (60d)`),
      ];
    },
  },
  {
    slug: 'call-butterfly', name: 'Call Butterfly', category: 'bullish',
    build: s => {
      const atm  = Math.round(s);
      const wing = Math.round(s * 0.05);
      return [
        mkLeg('buy',  'call', atm - wing, 45, 0.65),
        mkLeg('sell', 'call', atm,        45, 0.50, 2),
        mkLeg('buy',  'call', atm + wing, 45, 0.35),
      ];
    },
  },
  {
    slug: 'call-zebra', name: 'Call Zebra', category: 'bullish',
    build: s => [
      mkLeg('buy',  'call', Math.round(s), 45, 0.65, 2),
      mkLeg('sell', 'call', s * 1.10,      45, 0.20),
    ],
  },
  // ── Bearish ──────────────────────────────────────────────────────────────
  {
    slug: 'long-put-vertical', name: 'Long Put Vertical', category: 'bearish',
    build: s => [mkLeg('buy', 'put', Math.round(s), 45, -0.50), mkLeg('sell', 'put', s * 0.95, 45, -0.25)],
  },
  {
    slug: 'covered-put', name: 'Covered Put', category: 'bearish',
    build: s => [mkLeg('sell', 'stock', s, 0, null), mkLeg('sell', 'put', s * 0.95, 30, -0.25)],
  },
  {
    slug: 'reverse-big-lizard', name: 'Reverse Big Lizard', category: 'bearish',
    build: s => {
      const atm = Math.round(s);
      return [mkLeg('sell', 'put', atm, 45, -0.50), mkLeg('sell', 'call', atm, 45, 0.50), mkLeg('buy', 'put', s * 0.90, 45, -0.15)];
    },
  },
  {
    slug: 'poor-mans-covered-put', name: "Poor Man's Covered Put (PMCP)", category: 'bearish',
    build: s => [
      mkLeg('buy',  'put', s * 1.20, 90, -0.80, 1, `Buy Put $${roundHalf(s * 1.20)} (deep ITM, 90d)`),
      mkLeg('sell', 'put', s * 0.90, 30, -0.20),
    ],
  },
  {
    slug: 'put-calendar', name: 'Put Calendar', category: 'bearish',
    build: s => {
      const atm = Math.round(s);
      return [
        mkLeg('sell', 'put', atm, 30, -0.50, 1, `Sell Put $${atm} (30d)`),
        mkLeg('buy',  'put', atm, 60, -0.50, 1, `Buy Put $${atm} (60d)`),
      ];
    },
  },
  {
    slug: 'put-butterfly', name: 'Put Butterfly', category: 'bearish',
    build: s => {
      const atm  = Math.round(s);
      const wing = Math.round(s * 0.05);
      return [
        mkLeg('buy',  'put', atm + wing, 45, -0.65),
        mkLeg('sell', 'put', atm,        45, -0.50, 2),
        mkLeg('buy',  'put', atm - wing, 45, -0.35),
      ];
    },
  },
  {
    slug: 'put-zebra', name: 'Put Zebra', category: 'bearish',
    build: s => [
      mkLeg('buy',  'put', Math.round(s), 45, -0.65, 2),
      mkLeg('sell', 'put', s * 0.90,      45, -0.20),
    ],
  },
  // ── Complex / Omnidirectional ────────────────────────────────────────────
  {
    slug: 'put-front-ratio', name: 'Put Front Ratio', category: 'omnidirectional',
    build: s => [
      mkLeg('buy',  'put', s * 0.95, 45, -0.30),
      mkLeg('sell', 'put', s * 0.90, 45, -0.20, 2),
    ],
  },
  {
    slug: 'call-front-ratio', name: 'Call Front Ratio', category: 'omnidirectional',
    build: s => [
      mkLeg('buy',  'call', s * 1.05, 45, 0.30),
      mkLeg('sell', 'call', s * 1.10, 45, 0.15, 2),
    ],
  },
  {
    slug: 'put-broken-wing-butterfly', name: 'Put Broken Wing Butterfly', category: 'omnidirectional',
    build: s => {
      const atm = Math.round(s);
      return [
        mkLeg('buy',  'put', atm + Math.round(s * 0.05), 45, -0.65),
        mkLeg('sell', 'put', atm,                         45, -0.50, 2),
        mkLeg('buy',  'put', atm - Math.round(s * 0.12), 45, -0.12),
      ];
    },
  },
  {
    slug: 'call-broken-wing-butterfly', name: 'Call Broken Wing Butterfly', category: 'omnidirectional',
    build: s => {
      const atm = Math.round(s);
      return [
        mkLeg('buy',  'call', atm - Math.round(s * 0.05), 45, 0.65),
        mkLeg('sell', 'call', atm,                          45, 0.50, 2),
        mkLeg('buy',  'call', atm + Math.round(s * 0.12), 45, 0.12),
      ];
    },
  },
  {
    slug: 'call-broken-heart-butterfly', name: 'Call Broken Heart Butterfly', category: 'omnidirectional',
    build: s => {
      const atm = Math.round(s);
      return [
        mkLeg('buy',  'call', atm - Math.round(s * 0.10), 45, 0.70),
        mkLeg('sell', 'call', atm,                          45, 0.50, 2),
        mkLeg('buy',  'call', atm + Math.round(s * 0.05), 45, 0.30),
      ];
    },
  },
  {
    slug: 'put-broken-heart-butterfly', name: 'Put Broken Heart Butterfly', category: 'omnidirectional',
    build: s => {
      const atm = Math.round(s);
      return [
        mkLeg('buy',  'put', atm + Math.round(s * 0.10), 45, -0.70),
        mkLeg('sell', 'put', atm,                          45, -0.50, 2),
        mkLeg('buy',  'put', atm - Math.round(s * 0.05), 45, -0.30),
      ];
    },
  },
];

// ─── Strategy formula rules ──────────────────────────────────────────────────

interface RuleResult {
  label:  string;
  detail: string;
  pass:   boolean | null; // null = informational only
}

function computeStrategyRules(
  strategyName: string,
  legs: PayoffLeg[],
  spot: number,
): RuleResult[] {
  if (!legs.length || spot <= 0) return [];

  const opts      = legs.filter(l => l.type !== 'stock');
  const puts      = opts.filter(l => l.type === 'put').sort((a, b) => a.strike - b.strike);
  const calls     = opts.filter(l => l.type === 'call').sort((a, b) => a.strike - b.strike);
  const sellPuts  = puts.filter(l => l.side === 'sell');
  const buyPuts   = puts.filter(l => l.side === 'buy');
  const sellCalls = calls.filter(l => l.side === 'sell');
  const buyCalls  = calls.filter(l => l.side === 'buy');

  // Net credit per share (positive = credit received)
  const creditPerShare = opts.reduce((sum, l) =>
    sum + (l.side === 'sell' ? 1 : -1) * l.premium, 0);

  const f = (v: number) => `$${Math.abs(v).toFixed(2)}`;

  const profitTarget = (pct: number): RuleResult => ({
    label:  `Profit target (${pct}% of credit)`,
    detail: creditPerShare > 0.001
      ? `Close at ${f(creditPerShare * pct / 100)}/sh  ($${(creditPerShare * pct).toFixed(0)}/contract)`
      : 'Enter premiums to see target',
    pass: null,
  });

  const otmRule = (leg: PayoffLeg, dir: 'below' | 'above'): RuleResult => {
    const ok = dir === 'below' ? leg.strike < spot : leg.strike > spot;
    return {
      label:  `${leg.type === 'put' ? 'Put' : 'Call'} strike OTM`,
      detail: `$${leg.strike} ${dir === 'below' ? '<' : '>'} spot $${spot.toFixed(2)}`,
      pass:   ok,
    };
  };

  const atmRule = (leg: PayoffLeg): RuleResult => {
    const pct = Math.abs(leg.strike / spot - 1) * 100;
    const ok = pct <= 4;
    return {
      label:  `${leg.type === 'put' ? 'Put' : 'Call'} strike near ATM`,
      detail: `$${leg.strike} is ${pct.toFixed(1)}% from spot (target ≤ 4%)`,
      pass:   ok,
    };
  };

  const creditVsSpread = (spreadWidth: number, side: 'call' | 'put'): RuleResult => {
    const ok = creditPerShare >= spreadWidth;
    return {
      label:  `Credit ≥ ${side} spread width (no ${side === 'call' ? 'upside' : 'downside'} risk)`,
      detail: `Credit ${f(creditPerShare)}/sh ${ok ? '≥' : '<'} spread width ${f(spreadWidth)}/sh`,
      pass:   ok,
    };
  };

  const minCreditRule = (spreadWidth: number): RuleResult => {
    const minCredit = spreadWidth / 3;
    const ok = creditPerShare >= minCredit;
    return {
      label:  'Credit ≥ ⅓ of spread width',
      detail: `${f(creditPerShare)}/sh vs min ${f(minCredit)}/sh (⅓ of ${f(spreadWidth)} spread)`,
      pass:   ok,
    };
  };

  const n = strategyName;

  if (n === 'Jade Lizard' || n === 'Big Lizard') {
    const sc = sellCalls[0], bc = buyCalls[0], sp = sellPuts[0];
    if (!sc || !bc || !sp) return [];
    const width = bc.strike - sc.strike;
    return [
      creditVsSpread(width, 'call'),
      ...(n === 'Jade Lizard' ? [otmRule(sp, 'below')] : [atmRule(sp), atmRule(sc)]),
      profitTarget(n === 'Big Lizard' ? 25 : 50),
    ];
  }

  if (n === 'Reverse Jade Lizard' || n === 'Reverse Big Lizard') {
    const sc = sellCalls[0], sp = sellPuts[0], bp = buyPuts[0];
    if (!sc || !sp || !bp) return [];
    const width = sp.strike - bp.strike;
    return [
      creditVsSpread(width, 'put'),
      ...(n === 'Reverse Jade Lizard' ? [otmRule(sc, 'above')] : [atmRule(sp), atmRule(sc)]),
      profitTarget(n === 'Reverse Big Lizard' ? 25 : 50),
    ];
  }

  if (n === 'Iron Condor' || n === 'Dynamic Width Iron Condor') {
    const sp = sellPuts[0], bp = buyPuts[0], sc = sellCalls[0], bc = buyCalls[0];
    if (!sp || !bp || !sc || !bc) return [];
    const width = Math.max(sp.strike - bp.strike, bc.strike - sc.strike);
    return [minCreditRule(width), otmRule(sp, 'below'), otmRule(sc, 'above'), profitTarget(50)];
  }

  if (n === 'Iron Fly') {
    const sp = sellPuts[0], sc = sellCalls[0];
    if (!sp || !sc) return [];
    return [atmRule(sp), atmRule(sc), profitTarget(25)];
  }

  if (n === 'Short Strangle') {
    const sp = sellPuts[0], sc = sellCalls[0];
    if (!sp || !sc) return [];
    return [otmRule(sp, 'below'), otmRule(sc, 'above'), profitTarget(50)];
  }

  if (n === 'Short Straddle') {
    const sp = sellPuts[0], sc = sellCalls[0];
    if (!sp || !sc) return [];
    return [atmRule(sp), atmRule(sc), profitTarget(25)];
  }

  if (n === 'Cash-Secured Put') {
    const sp = sellPuts[0];
    if (!sp) return [];
    return [otmRule(sp, 'below'), profitTarget(50)];
  }

  if (n === 'Covered Call') {
    const sc = sellCalls[0];
    if (!sc) return [];
    return [otmRule(sc, 'above'), profitTarget(50)];
  }

  if (n === 'Bull Put Spread (Short Put Vertical)') {
    const sp = sellPuts[0], bp = buyPuts[0];
    if (!sp || !bp) return [];
    return [minCreditRule(sp.strike - bp.strike), profitTarget(50)];
  }

  if (n === 'Bear Call Spread (Short Call Vertical)') {
    const sc = sellCalls[0], bc = buyCalls[0];
    if (!sc || !bc) return [];
    return [minCreditRule(bc.strike - sc.strike), profitTarget(50)];
  }

  if (n === 'Bull Call Spread') {
    const bc = buyCalls[0], sc = sellCalls[0];
    if (!bc || !sc) return [];
    const width = sc.strike - bc.strike;
    const debit = Math.abs(creditPerShare);
    const maxGain = width - debit;
    return [
      { label: 'Max profit = Spread − Debit', detail: `${f(width)} − ${f(debit)} = max ${f(maxGain)}/sh`, pass: maxGain > 0 },
      { label: 'Profit target (50% of max profit)', detail: maxGain > 0 ? `Close at ${f(maxGain * 0.5)}/sh ($${(maxGain * 50).toFixed(0)}/contract)` : '—', pass: null },
    ];
  }

  if (n === 'Bear Put Spread') {
    const bp = buyPuts[0], sp = sellPuts[0];
    if (!bp || !sp) return [];
    const width = bp.strike - sp.strike;
    const debit = Math.abs(creditPerShare);
    const maxGain = width - debit;
    return [
      { label: 'Max profit = Spread − Debit', detail: `${f(width)} − ${f(debit)} = max ${f(maxGain)}/sh`, pass: maxGain > 0 },
      { label: 'Profit target (50% of max profit)', detail: maxGain > 0 ? `Close at ${f(maxGain * 0.5)}/sh ($${(maxGain * 50).toFixed(0)}/contract)` : '—', pass: null },
    ];
  }

  if (n === 'Naked Call') {
    return [
      { label: '⚠ Unlimited upside risk', detail: 'No cap on loss if stock rises — requires margin', pass: null },
      profitTarget(50),
    ];
  }

  return [];
}

// ─── Strategy formula panel component ────────────────────────────────────────

function StrategyFormulaPanel({ strategyName, legs, spot, chainContracts, onFix }: {
  strategyName: string;
  legs:         PayoffLeg[];
  spot:         number;
  chainContracts?: OptionContract[];
  onFix?:       (legs: PayoffLeg[], note: string) => void;
}) {
  const rules = computeStrategyRules(strategyName, legs, spot);
  if (!rules.length) return null;

  // Offer a one-click Fix only when a rule is failing AND we can narrow the wing to pass it.
  const hasFailing = rules.some(r => r.pass === false);
  const fix = hasFailing && onFix ? fixLegsForStrategy(strategyName, legs, chainContracts) : null;

  return (
    <div style={{
      background: '#08111a',
      border: '1px solid #1e3a5f',
      borderRadius: 5,
      padding: '8px 10px',
      marginTop: 4,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: 1 }}>
          📐 Rules
        </div>
        {fix && onFix && (
          <button
            onClick={() => onFix(fix.legs, fix.note)}
            title={`Narrow the protective wing to satisfy the rule — keeps your short strike. ${fix.note}`}
            style={{
              fontSize: 10, fontWeight: 700, color: '#fbbf24', background: 'transparent',
              border: '1px solid #b45309', borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
            }}>
            🔧 Fix
          </button>
        )}
      </div>
      {rules.map((rule, i) => (
        <div key={i} style={{
          marginBottom: i < rules.length - 1 ? 7 : 0,
          paddingBottom: i < rules.length - 1 ? 7 : 0,
          borderBottom: i < rules.length - 1 ? '1px solid #111827' : 'none',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
            <span style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.3 }}>{rule.label}</span>
            {rule.pass !== null && (
              <span style={{ fontSize: 13, fontWeight: 700, color: rule.pass ? '#22c55e' : '#ef4444', marginLeft: 6, flexShrink: 0 }}>
                {rule.pass ? '✓' : '✗'}
              </span>
            )}
          </div>
          <div style={{ fontSize: 10, color: '#475569', lineHeight: 1.4 }}>{rule.detail}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Strategy recognition ─────────────────────────────────────────────────────

interface StrategyInfo {
  name: string;
  description: string;
  color: string;        // accent border/badge color
  partial?: boolean;    // still building the strategy
}

function recognizeStrategy(legs: PayoffLeg[]): StrategyInfo | null {
  if (legs.length === 0) return null;

  const opts       = legs.filter(l => l.type !== 'stock');
  const stocks     = legs.filter(l => l.type === 'stock');
  const puts       = opts.filter(l => l.type === 'put').sort((a, b) => a.strike - b.strike);
  const calls      = opts.filter(l => l.type === 'call').sort((a, b) => a.strike - b.strike);
  const sellPuts   = puts.filter(l => l.side === 'sell');
  const buyPuts    = puts.filter(l => l.side === 'buy');
  const sellCalls  = calls.filter(l => l.side === 'sell');
  const buyCalls   = calls.filter(l => l.side === 'buy');
  const longStock  = stocks.filter(l => l.side === 'buy');
  const shortStock = stocks.filter(l => l.side === 'sell');

  // Quantity totals — handles legs with quantity > 1
  const tBC = buyCalls.reduce((n, l) => n + l.quantity, 0);
  const tSC = sellCalls.reduce((n, l) => n + l.quantity, 0);
  const tBP = buyPuts.reduce((n, l) => n + l.quantity, 0);
  const tSP = sellPuts.reduce((n, l) => n + l.quantity, 0);

  // Expand legs by quantity for multi-unit strike analysis
  const expandByQty = (ls: PayoffLeg[]) =>
    ls.flatMap(l => Array.from({ length: l.quantity }, () => l)).sort((a, b) => a.strike - b.strike);

  // Two strikes are near-same (within 3% relative)
  const nearEq = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b) < 0.03;

  // ── Single option leg ─────────────────────────────────────────────────────
  if (opts.length === 1 && stocks.length === 0) {
    const l = opts[0]!;
    if (l.side === 'sell' && l.type === 'put')
      return { name: 'Cash-Secured Put', description: 'Collect premium; buy stock at strike if assigned', color: '#22c55e' };
    if (l.side === 'sell' && l.type === 'call')
      return { name: 'Naked Call', description: '⚠ Unlimited upside risk — requires margin', color: '#ef4444' };
    if (l.side === 'buy' && l.type === 'call')
      return { name: 'Long Call', description: 'Bullish; profit above breakeven, risk = premium paid', color: '#3b82f6' };
    if (l.side === 'buy' && l.type === 'put')
      return { name: 'Long Put', description: 'Bearish; profit below breakeven, risk = premium paid', color: '#f97316' };
  }
  if (opts.length === 0 && stocks.length === 1) {
    const l = stocks[0]!;
    return { name: l.side === 'buy' ? 'Long Stock' : 'Short Stock', description: 'Directional equity position', color: '#94a3b8' };
  }

  // ── Stock + option combinations ───────────────────────────────────────────
  if (longStock.length === 1 && tSC === 1 && opts.length === 1)
    return { name: 'Covered Call', description: 'Capped upside; premium reduces effective cost basis', color: '#22c55e' };
  if (longStock.length === 1 && tBP === 1 && opts.length === 1)
    return { name: 'Protective Put', description: 'Stock with a floor; unlimited upside, limited downside', color: '#3b82f6' };
  if (longStock.length === 1 && tBP === 1 && tSC === 1 && opts.length === 2)
    return { name: 'Collar', description: 'Protected between put (floor) and call (cap)', color: '#8b5cf6' };
  if (shortStock.length === 1 && tSP === 1 && opts.length === 1)
    return { name: 'Covered Put', description: 'Short stock with obligation to buy back at put strike if assigned', color: '#f97316' };

  // ── Pure option strategies (no stock) ────────────────────────────────────
  if (stocks.length > 0) {
    // Unrecognized stock + options combo
    const netPremS = legs.reduce((s, l) => s + (l.side === 'sell' ? 1 : -1) * l.premium, 0);
    return { name: 'Custom Strategy', description: netPremS >= 0 ? 'Net credit position' : 'Net debit position', color: '#94a3b8' };
  }

  // ── Calendar spreads (same strike/type, different expiries) ──────────────
  if (opts.length === 2) {
    const [a, b] = opts;
    if (a && b && a.type === b.type && a.side !== b.side
        && nearEq(a.strike, b.strike) && a.expiry !== b.expiry) {
      return {
        name: a.type === 'call' ? 'Call Calendar' : 'Put Calendar',
        description: 'Sell near-term, buy far-term at same strike; profits from time-decay differential',
        color: '#8b5cf6',
      };
    }
  }

  // ── Two-option single-type strategies ─────────────────────────────────────
  if (tBC === 1 && tSC === 1 && tBP === 0 && tSP === 0) {
    const bc = buyCalls[0]!, sc = sellCalls[0]!;
    if (bc.expiry !== sc.expiry && bc.strike / sc.strike < 0.92)
      return { name: "Poor Man's Covered Call", description: 'Deep ITM long call (diagonal) + short OTM call; synthetic covered call at lower capital', color: '#22c55e' };
    return bc.strike < sc.strike
      ? { name: 'Bull Call Spread', description: 'Defined-risk bullish; max profit at or above short call', color: '#22c55e' }
      : { name: 'Bear Call Spread (Short Call Vertical)', description: 'Credit spread; profit if stock stays below long call', color: '#f97316' };
  }

  if (tBP === 1 && tSP === 1 && tBC === 0 && tSC === 0) {
    const bp = buyPuts[0]!, sp = sellPuts[0]!;
    if (bp.expiry !== sp.expiry && bp.strike / sp.strike > 1.10)
      return { name: "Poor Man's Covered Put", description: 'Deep ITM long put (diagonal) + short OTM put; synthetic covered put at lower capital', color: '#ef4444' };
    return bp.strike > sp.strike
      ? { name: 'Bear Put Spread', description: 'Defined-risk bearish; max profit at or below short put', color: '#ef4444' }
      : { name: 'Bull Put Spread (Short Put Vertical)', description: 'Credit spread; profit if stock stays above short put', color: '#22c55e' };
  }

  if (tSP === 1 && tSC === 1 && tBP === 0 && tBC === 0) {
    const sp = sellPuts[0]!, sc = sellCalls[0]!;
    return nearEq(sp.strike, sc.strike)
      ? { name: 'Short Straddle', description: 'Max profit at strike; sells both ATM put and call', color: '#f97316' }
      : { name: 'Short Strangle', description: 'Profit if stock stays between the two short strikes', color: '#f97316' };
  }

  if (tBP === 1 && tBC === 1 && tSP === 0 && tSC === 0) {
    const bp = buyPuts[0]!, bc = buyCalls[0]!;
    return nearEq(bp.strike, bc.strike)
      ? { name: 'Long Straddle', description: 'Profit on large move either direction; unlimited potential', color: '#3b82f6' }
      : { name: 'Long Strangle', description: 'Profit on large move either direction; lower cost than straddle', color: '#3b82f6' };
  }

  // ── Zebra (2 long + 1 short, same type) ──────────────────────────────────
  if (tBC === 2 && tSC === 1 && tBP === 0 && tSP === 0) {
    const sc = sellCalls[0]!;
    if (expandByQty(buyCalls).every(l => l.strike <= sc.strike))
      return { name: 'Call Zebra', description: 'Buy 2 calls near ATM, sell 1 OTM call; leveraged bullish with defined max loss', color: '#22c55e' };
  }

  if (tBP === 2 && tSP === 1 && tBC === 0 && tSC === 0) {
    const sp = sellPuts[0]!;
    if (expandByQty(buyPuts).every(l => l.strike >= sp.strike))
      return { name: 'Put Zebra', description: 'Buy 2 puts near ATM, sell 1 OTM put; leveraged bearish with defined max loss', color: '#ef4444' };
  }

  // ── Front ratios (1 long + 2 short, same type) ────────────────────────────
  if (tBC === 1 && tSC === 2 && tBP === 0 && tSP === 0) {
    const bc = buyCalls[0]!;
    if (expandByQty(sellCalls).every(l => l.strike > bc.strike))
      return { name: 'Call Front Ratio', description: 'Buy 1 lower call, sell 2 higher calls; max profit near short strike, unlimited upside risk', color: '#f97316' };
  }

  if (tBP === 1 && tSP === 2 && tBC === 0 && tSC === 0) {
    const bp = buyPuts[0]!;
    if (expandByQty(sellPuts).every(l => l.strike < bp.strike))
      return { name: 'Put Front Ratio', description: 'Buy 1 higher put, sell 2 lower puts; max profit near short strike, unlimited downside risk', color: '#f97316' };
  }

  // ── 3-leg mixed put + call strategies ────────────────────────────────────
  if (tSP === 1 && tSC === 1 && tBC === 1 && tBP === 0) {
    const sp = sellPuts[0]!, sc = sellCalls[0]!, bc = buyCalls[0]!;
    if (bc.strike > sc.strike) {
      return nearEq(sp.strike, sc.strike)
        ? { name: 'Big Lizard', description: 'Short ATM straddle + long OTM call; large credit, no upside risk', color: '#8b5cf6' }
        : { name: 'Jade Lizard', description: 'Short OTM put + short call spread; no upside risk when credit ≥ call spread width', color: '#8b5cf6' };
    }
  }

  if (tSC === 1 && tSP === 1 && tBP === 1 && tBC === 0) {
    const sc = sellCalls[0]!, sp = sellPuts[0]!, bp = buyPuts[0]!;
    if (bp.strike < sp.strike) {
      return nearEq(sp.strike, sc.strike)
        ? { name: 'Reverse Big Lizard', description: 'Short ATM straddle + long OTM put; large credit, no downside risk', color: '#8b5cf6' }
        : { name: 'Reverse Jade Lizard', description: 'Short OTM call + short put spread; no downside risk when credit ≥ put spread width', color: '#8b5cf6' };
    }
  }

  // ── Butterfly families (2 buy + 2 sell, same type) ────────────────────────
  if (tBC === 2 && tSC === 2 && tBP === 0 && tSP === 0) {
    const allBC = expandByQty(buyCalls);
    const allSC = expandByQty(sellCalls);
    if (allBC.length >= 2 && allSC.length >= 2) {
      const bcLow = allBC[0]!, bcHigh = allBC[allBC.length - 1]!, scMid = allSC[0]!;
      if (bcLow.strike < scMid.strike && bcHigh.strike > scMid.strike) {
        const lWing = scMid.strike - bcLow.strike;
        const rWing = bcHigh.strike - scMid.strike;
        const sym = Math.abs(lWing - rWing) / scMid.strike < 0.03;
        return sym
          ? { name: 'Call Butterfly', description: 'Max profit at middle strike; defined risk, typically low-cost debit', color: '#8b5cf6' }
          : { name: 'Call Broken Wing Butterfly', description: 'Asymmetric butterfly; can be structured for a net credit with wider outer wing', color: '#8b5cf6' };
      }
    }
  }

  if (tBP === 2 && tSP === 2 && tBC === 0 && tSC === 0) {
    const allBP = expandByQty(buyPuts);
    const allSP = expandByQty(sellPuts);
    if (allBP.length >= 2 && allSP.length >= 2) {
      const bpLow = allBP[0]!, bpHigh = allBP[allBP.length - 1]!, spMid = allSP[0]!;
      if (bpLow.strike < spMid.strike && bpHigh.strike > spMid.strike) {
        const lWing = spMid.strike - bpLow.strike;
        const rWing = bpHigh.strike - spMid.strike;
        const sym = Math.abs(lWing - rWing) / spMid.strike < 0.03;
        return sym
          ? { name: 'Put Butterfly', description: 'Max profit at middle strike; defined risk, typically low-cost debit', color: '#8b5cf6' }
          : { name: 'Put Broken Wing Butterfly', description: 'Asymmetric butterfly; can be structured for a net credit with wider outer wing', color: '#8b5cf6' };
      }
    }
  }

  // ── Iron Condor / Iron Fly ────────────────────────────────────────────────
  if (tBP === 1 && tSP === 1 && tSC === 1 && tBC === 1) {
    const bp = buyPuts[0]!, sp = sellPuts[0]!, sc = sellCalls[0]!, bc = buyCalls[0]!;
    if (bp.strike < sp.strike && sp.strike <= sc.strike && sc.strike < bc.strike) {
      return nearEq(sp.strike, sc.strike)
        ? { name: 'Iron Fly', description: 'Max profit at middle strike; defined risk both sides, large credit', color: '#8b5cf6' }
        : { name: 'Iron Condor', description: 'Profit if stock stays between short strikes; defined risk both sides', color: '#8b5cf6' };
    }
  }

  // ── Partial / building state ──────────────────────────────────────────────
  if ((tSP > 0 || tSC > 0) && opts.length <= 3)
    return { name: 'Building…', description: 'Add more legs to complete the strategy', color: '#64748b', partial: true };

  // ── Generic fallback ──────────────────────────────────────────────────────
  const netPrem = legs.reduce((s, l) => s + (l.side === 'sell' ? 1 : -1) * l.premium, 0);
  return {
    name: 'Custom Strategy',
    description: netPrem >= 0 ? 'Net credit position' : 'Net debit position',
    color: '#94a3b8',
  };
}

// ─── Payoff SVG chart ─────────────────────────────────────────────────────────

const PAD = { t: 12, r: 20, b: 24, l: 52 };
const SVG_W = 560;
const SVG_H = 120;
const PLOT_W = SVG_W - PAD.l - PAD.r;
const PLOT_H = SVG_H - PAD.t - PAD.b;

function PayoffChart({
  metrics, spot,
}: {
  metrics: PayoffMetrics;
  spot: number;
}) {
  const { prices, pnls, breakevenPrices } = metrics;
  const priceMin = prices[0]!;
  const priceMax = prices[prices.length - 1]!;

  const rawPnlMin = Math.min(...pnls);
  const rawPnlMax = Math.max(...pnls);
  const pnlPad = Math.max(Math.abs(rawPnlMax - rawPnlMin) * 0.12, 50);
  const pnlMin = rawPnlMin - pnlPad;
  const pnlMax = rawPnlMax + pnlPad;

  const toX = (p: number) => PAD.l + ((p - priceMin) / (priceMax - priceMin)) * PLOT_W;
  const toY = (v: number) => PAD.t + (1 - (v - pnlMin) / (pnlMax - pnlMin)) * PLOT_H;

  const zeroY  = toY(0);
  const spotX  = toX(spot);

  // Curve polyline string
  const curvePts = prices.map((p, i) => `${toX(p).toFixed(1)},${toY(pnls[i]!).toFixed(1)}`).join(' ');

  // Closed polygon for area fill (curve + return along zero line)
  const rightX = toX(priceMax).toFixed(1);
  const leftX  = toX(priceMin).toFixed(1);
  const polyPts = `${curvePts} ${rightX},${zeroY.toFixed(1)} ${leftX},${zeroY.toFixed(1)}`;

  // Y-axis ticks
  const yTicks = niceTicks(pnlMin, pnlMax, 5).filter(v => v >= pnlMin && v <= pnlMax);
  // X-axis ticks (price)
  const xTicks = niceTicks(priceMin, priceMax, 5).filter(v => v >= priceMin && v <= priceMax);

  // Clip IDs — unique per render to avoid SVG conflicts if multiple charts ever exist
  const clipAbove = 'payoff-clip-above';
  const clipBelow = 'payoff-clip-below';

  // ── Mouse tooltip ──────────────────────────────────────────────────────────
  const svgRef = useRef<SVGSVGElement>(null);
  const [tip, setTip] = useState<{ svgX: number; price: number; pnl: number } | null>(null);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    // Map screen coordinates to SVG viewBox coordinates
    const svgX = ((e.clientX - rect.left) / rect.width)  * SVG_W;
    if (svgX < PAD.l || svgX > PAD.l + PLOT_W) { setTip(null); return; }

    // Invert toX to get price
    const price = priceMin + ((svgX - PAD.l) / PLOT_W) * (priceMax - priceMin);

    // Interpolate P&L between the two bracketing data points
    const idx = prices.findIndex(p => p >= price);
    let pnl: number;
    if (idx <= 0)              pnl = pnls[0]!;
    else if (idx >= prices.length) pnl = pnls[pnls.length - 1]!;
    else {
      const t = (price - prices[idx - 1]!) / (prices[idx]! - prices[idx - 1]!);
      pnl = pnls[idx - 1]! + t * (pnls[idx]! - pnls[idx - 1]!);
    }

    setTip({ svgX, price, pnl });
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      style={{ width: '100%', display: 'block', cursor: 'crosshair' }}
      aria-label="Payoff diagram"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setTip(null)}
    >
      <defs>
        {/* Green region: above zero line */}
        <clipPath id={clipAbove}>
          <rect x={PAD.l} y={PAD.t} width={PLOT_W} height={Math.max(0, zeroY - PAD.t)} />
        </clipPath>
        {/* Red region: below zero line */}
        <clipPath id={clipBelow}>
          <rect x={PAD.l} y={zeroY} width={PLOT_W} height={Math.max(0, PAD.t + PLOT_H - zeroY)} />
        </clipPath>
      </defs>

      {/* ── Background ── */}
      <rect x={PAD.l} y={PAD.t} width={PLOT_W} height={PLOT_H} fill="#0f172a" rx={3} />

      {/* ── Horizontal grid lines ── */}
      {yTicks.map(v => {
        const y = toY(v);
        if (y < PAD.t || y > PAD.t + PLOT_H) return null;
        return (
          <line key={v} x1={PAD.l} y1={y} x2={PAD.l + PLOT_W} y2={y}
            stroke="#1e293b" strokeWidth={1} />
        );
      })}

      {/* ── Zero line ── */}
      {zeroY >= PAD.t && zeroY <= PAD.t + PLOT_H && (
        <line
          x1={PAD.l} y1={zeroY} x2={PAD.l + PLOT_W} y2={zeroY}
          stroke="#475569" strokeWidth={1.5} strokeDasharray="4 3"
        />
      )}

      {/* ── Spot price vertical line ── */}
      {spotX >= PAD.l && spotX <= PAD.l + PLOT_W && (
        <line
          x1={spotX} y1={PAD.t} x2={spotX} y2={PAD.t + PLOT_H}
          stroke="#64748b" strokeWidth={1} strokeDasharray="3 3"
        />
      )}

      {/* ── Green fill (profit region) ── */}
      <polygon points={polyPts} fill="#22c55e" fillOpacity={0.12}
        clipPath={`url(#${clipAbove})`} />

      {/* ── Red fill (loss region) ── */}
      <polygon points={polyPts} fill="#ef4444" fillOpacity={0.12}
        clipPath={`url(#${clipBelow})`} />

      {/* ── Payoff curve — green above zero ── */}
      <polyline points={curvePts} stroke="#22c55e" strokeWidth={2.5} fill="none"
        clipPath={`url(#${clipAbove})`} />

      {/* ── Payoff curve — red below zero ── */}
      <polyline points={curvePts} stroke="#ef4444" strokeWidth={2.5} fill="none"
        clipPath={`url(#${clipBelow})`} />

      {/* ── Breakeven markers ── */}
      {breakevenPrices.map((bp, i) => {
        const bx = toX(bp);
        if (bx < PAD.l || bx > PAD.l + PLOT_W) return null;
        return (
          <g key={i}>
            <circle cx={bx} cy={zeroY} r={5} fill="#fbbf24" stroke="#0f172a" strokeWidth={1.5} />
            <text x={bx} y={zeroY - 9} textAnchor="middle" fill="#fbbf24" fontSize={9}>
              {fmtPrice(bp)}
            </text>
          </g>
        );
      })}

      {/* ── Spot label ── */}
      {spotX >= PAD.l && spotX <= PAD.l + PLOT_W && (
        <text x={spotX + 3} y={PAD.t + 11} fill="#64748b" fontSize={9}>spot</text>
      )}

      {/* ── Y-axis labels (P&L) ── */}
      {yTicks.map(v => {
        const y = toY(v);
        if (y < PAD.t || y > PAD.t + PLOT_H) return null;
        return (
          <text key={v} x={PAD.l - 5} y={y + 4} textAnchor="end"
            fill={v === 0 ? '#94a3b8' : v > 0 ? '#22c55e' : '#ef4444'} fontSize={9}>
            {v >= 0 ? '+' : ''}{v >= 1000 || v <= -1000
              ? `${(v / 1000).toFixed(1)}k`
              : v.toFixed(0)}
          </text>
        );
      })}

      {/* ── X-axis labels (price) ── */}
      {xTicks.map(v => {
        const x = toX(v);
        if (x < PAD.l || x > PAD.l + PLOT_W) return null;
        return (
          <text key={v} x={x} y={SVG_H - 4} textAnchor="middle" fill="#64748b" fontSize={9}>
            ${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}
          </text>
        );
      })}

      {/* ── Axis lines ── */}
      <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={PAD.t + PLOT_H}
        stroke="#334155" strokeWidth={1} />
      <line x1={PAD.l} y1={PAD.t + PLOT_H} x2={PAD.l + PLOT_W} y2={PAD.t + PLOT_H}
        stroke="#334155" strokeWidth={1} />

      {/* ── Mouse tooltip overlay ── */}
      {tip && (() => {
        const cx       = tip.svgX;
        const cy       = toY(tip.pnl);
        const inPlot   = cy >= PAD.t && cy <= PAD.t + PLOT_H;
        const isProfit = tip.pnl >= 0;
        const dotColor = isProfit ? '#22c55e' : '#ef4444';

        const pnlAbs = Math.abs(tip.pnl);
        const pnlStr = `${isProfit ? '+' : '−'}${pnlAbs >= 10_000 ? `$${(pnlAbs / 1_000).toFixed(1)}k` : `$${pnlAbs.toFixed(0)}`}`;
        const priceStr = `$${tip.price >= 1000 ? `${(tip.price / 1000).toFixed(2)}k` : tip.price.toFixed(2)}`;

        const TIP_W = 82, TIP_H = 34;
        // Flip tooltip to left side when cursor is in the right half
        const tipX = cx > PAD.l + PLOT_W / 2 ? cx - TIP_W - 6 : cx + 6;
        const tipY = Math.max(PAD.t + 2, Math.min(PAD.t + PLOT_H - TIP_H - 2, cy - TIP_H / 2));

        return (
          <g pointerEvents="none">
            {/* Vertical crosshair */}
            <line x1={cx} y1={PAD.t} x2={cx} y2={PAD.t + PLOT_H}
              stroke="#64748b" strokeWidth={1} strokeDasharray="3 2" />
            {/* Horizontal hairline at P&L value */}
            {inPlot && (
              <line x1={PAD.l} y1={cy} x2={PAD.l + PLOT_W} y2={cy}
                stroke={dotColor} strokeWidth={0.5} strokeDasharray="2 3" opacity={0.5} />
            )}
            {/* Dot on curve */}
            {inPlot && (
              <circle cx={cx} cy={cy} r={4}
                fill={dotColor} stroke="#0f172a" strokeWidth={1.5} />
            )}
            {/* Tooltip box */}
            <rect x={tipX} y={tipY} width={TIP_W} height={TIP_H}
              rx={3} fill="#1e293b" stroke="#334155" strokeWidth={1} />
            <text x={tipX + 7} y={tipY + 13} fill="#94a3b8" fontSize={9}>
              {priceStr}
            </text>
            <text x={tipX + 7} y={tipY + 27} fill={dotColor} fontSize={11} fontWeight="700">
              {pnlStr}
            </text>
          </g>
        );
      })()}
    </svg>
  );
}

// ─── Leg card ─────────────────────────────────────────────────────────────────

function LegCard({
  leg,
  onRemove,
  onToggleSide,
  onUpdate,
}: {
  leg: PayoffLeg;
  onRemove: () => void;
  onToggleSide: () => void;
  onUpdate: (patch: Partial<PayoffLeg>) => void;
}) {
  const isBuy  = leg.side === 'buy';
  const isCall = leg.type === 'call';
  const isPut  = leg.type === 'put';

  const [editingPrem,   setEditingPrem]   = useState(false);
  const [editingQty,    setEditingQty]    = useState(false);
  const [editingStrike, setEditingStrike] = useState(false);
  const [premStr,   setPremStr]   = useState(String(leg.premium));
  const [qtyStr,    setQtyStr]    = useState(String(leg.quantity));
  const [strikeStr, setStrikeStr] = useState(String(leg.strike));

  // Keep local strings in sync when leg prop changes (e.g. chain reload or hedge recalc)
  const prevPremRef = { current: leg.premium };
  if (!editingPrem   && leg.premium !== prevPremRef.current)      setPremStr(String(leg.premium));
  if (!editingStrike && leg.strike  !== parseFloat(strikeStr))    setStrikeStr(String(leg.strike));

  const commitPrem = () => {
    const v = parseFloat(premStr);
    if (!isNaN(v) && v >= 0) onUpdate({ premium: v });
    else setPremStr(String(leg.premium));
    setEditingPrem(false);
  };

  const commitQty = () => {
    const v = parseInt(qtyStr);
    if (!isNaN(v) && v >= 1) onUpdate({ quantity: v });
    else setQtyStr(String(leg.quantity));
    setEditingQty(false);
  };

  const commitStrike = () => {
    const v = parseFloat(strikeStr);
    if (!isNaN(v) && v > 0 && v !== leg.strike) onUpdate({ strike: v });
    else setStrikeStr(String(leg.strike));
    setEditingStrike(false);
  };

  const typeLabel = leg.type === 'stock' ? '100 shares' : leg.type.toUpperCase();

  const sideColor = isBuy ? '#22c55e' : '#f97316';

  const inlineInputStyle: React.CSSProperties = {
    width: 60, padding: '1px 4px', fontSize: 11, background: '#0f172a',
    border: '1px solid #3b82f6', borderRadius: 3, color: '#f1f5f9',
    outline: 'none',
  };

  const premLabel = leg.type === 'stock' ? 'Entry' : 'Prem';
  // Highlight zero-premium option legs as a visual cue that input is needed
  const premColor = (leg.type !== 'stock' && leg.premium === 0) ? '#f97316' : '#94a3b8';

  return (
    <div style={{
      background: '#1e293b', border: '1px solid #334155', borderRadius: 6,
      padding: '8px 10px', marginBottom: 6, display: 'flex', flexDirection: 'column', gap: 3,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            onClick={onToggleSide}
            style={{
              fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 3,
              background: 'transparent', border: `1px solid ${sideColor}`,
              color: sideColor, cursor: 'pointer',
            }}
            title="Click to toggle Buy/Sell"
          >
            {isBuy ? 'BUY' : 'SELL'}
          </button>
          <span style={{ fontSize: 12, color: '#f1f5f9', fontWeight: 600 }}>
            {typeLabel}{leg.type === 'stock' ? '' : ' '}
            {leg.type !== 'stock' && (
              editingStrike ? (
                <input
                  autoFocus
                  type="number" step="0.5" min="0.5"
                  value={strikeStr}
                  onChange={e => setStrikeStr(e.target.value)}
                  onBlur={commitStrike}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitStrike();
                    if (e.key === 'Escape') { setStrikeStr(String(leg.strike)); setEditingStrike(false); }
                  }}
                  style={{ width: 65, padding: '1px 4px', fontSize: 11, background: '#0f172a', border: '1px solid #3b82f6', borderRadius: 3, color: '#f1f5f9', outline: 'none' }}
                />
              ) : (
                <span
                  onClick={() => { setStrikeStr(String(leg.strike)); setEditingStrike(true); }}
                  title="Click to change strike — snaps to nearest chain contract"
                  style={{ cursor: 'text', textDecoration: 'underline dotted', textUnderlineOffset: 2 }}
                >
                  ${leg.strike}
                </span>
              )
            )}
          </span>
          {leg.type !== 'stock' && (
            <span style={{ fontSize: 10, color: '#94a3b8' }}>
              exp {leg.expiry.slice(5)}
            </span>
          )}
        </div>
        <button
          onClick={onRemove}
          style={{ fontSize: 11, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
        >
          ✕
        </button>
      </div>
      <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#94a3b8', alignItems: 'center' }}>
        {/* Editable premium */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ color: '#64748b' }}>{premLabel}</span>
          {editingPrem ? (
            <input
              autoFocus
              type="number" step="0.01" min="0"
              value={premStr}
              onChange={e => setPremStr(e.target.value)}
              onBlur={commitPrem}
              onKeyDown={e => { if (e.key === 'Enter') commitPrem(); if (e.key === 'Escape') { setPremStr(String(leg.premium)); setEditingPrem(false); } }}
              style={inlineInputStyle}
            />
          ) : (
            <span
              onClick={() => { setPremStr(String(leg.premium)); setEditingPrem(true); }}
              title="Click to edit premium"
              style={{ color: premColor, cursor: 'text', textDecoration: 'underline dotted', textUnderlineOffset: 2 }}
            >
              {fmtPrice(leg.premium)}
            </span>
          )}
        </span>

        {/* Editable quantity */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <span style={{ color: '#64748b' }}>×</span>
          {editingQty ? (
            <input
              autoFocus
              type="number" min="1"
              value={qtyStr}
              onChange={e => setQtyStr(e.target.value)}
              onBlur={commitQty}
              onKeyDown={e => { if (e.key === 'Enter') commitQty(); if (e.key === 'Escape') { setQtyStr(String(leg.quantity)); setEditingQty(false); } }}
              style={{ ...inlineInputStyle, width: 40 }}
            />
          ) : (
            <span
              onClick={() => { setQtyStr(String(leg.quantity)); setEditingQty(true); }}
              title="Click to edit quantity"
              style={{ cursor: 'text', textDecoration: 'underline dotted', textUnderlineOffset: 2 }}
            >
              {leg.quantity}
            </span>
          )}
        </span>

        {leg.delta != null && (isCall || isPut) && (
          <span title="Delta">Δ {leg.delta >= 0 ? '+' : ''}{leg.delta.toFixed(2)}</span>
        )}
        {leg.iv != null && (
          <span title="IV">IV {(leg.iv * 100).toFixed(1)}%</span>
        )}
        {leg.openInterest != null && (isCall || isPut) && (
          <span title="Open interest (liquidity)">OI {leg.openInterest.toLocaleString()}</span>
        )}
      </div>
    </div>
  );
}

// ─── Add Leg inline form ──────────────────────────────────────────────────────

interface AddLegFormProps {
  spotNum: number;
  onAdd: (leg: PayoffLeg) => void;
  onCancel: () => void;
}

function AddLegForm({ spotNum, onAdd, onCancel }: AddLegFormProps) {
  const [side, setSide]       = useState<'buy' | 'sell'>('sell');
  const [type, setType]       = useState<'call' | 'put' | 'stock'>('put');
  const [strike, setStrike]   = useState(spotNum > 0 ? String(roundHalf(spotNum * 0.95)) : '');
  const [expiry, setExpiry]   = useState(addDays(45));
  const [premium, setPremium] = useState('');
  const [qty, setQty]         = useState('1');
  const [delta, setDelta]     = useState('');
  const [theta, setTheta]     = useState('');
  const [vega, setVega]       = useState('');

  const handleSubmit = () => {
    const strikeNum  = type === 'stock' ? 0 : parseFloat(strike) || 0;
    const premiumNum = parseFloat(premium) || 0;
    const qtyNum     = parseInt(qty) || 1;

    const typeLabel = type === 'stock'
      ? `${side === 'buy' ? 'Long' : 'Short'} 100 shares`
      : `${side === 'buy' ? 'Buy' : 'Sell'} ${type.charAt(0).toUpperCase() + type.slice(1)} $${strikeNum}`;

    // Delta convention: calls positive, puts negative (signed)
    let parsedDelta = delta !== '' ? parseFloat(delta) : null;
    if (parsedDelta != null && type === 'put' && parsedDelta > 0) parsedDelta = -parsedDelta;

    onAdd({
      id:      genId(),
      side,
      type,
      strike:  strikeNum,
      expiry:  type === 'stock' ? addDays(0) : expiry,
      premium: premiumNum,
      quantity: qtyNum,
      delta:   parsedDelta,
      theta:   theta !== '' ? parseFloat(theta) : null,
      vega:    vega  !== '' ? parseFloat(vega)  : null,
      iv:      null,
      label:   typeLabel,
    });
  };

  const btnStyle = (active: boolean) => ({
    padding: '3px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? '#000' : '#94a3b8',
    border: active ? 'none' : '1px solid #334155',
    fontWeight: active ? 700 : 400,
  } as const);

  return (
    <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 6, padding: 10, marginBottom: 8 }}>
      {/* Side */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 7 }}>
        <button style={btnStyle(side === 'buy')}  onClick={() => setSide('buy')}>Buy</button>
        <button style={btnStyle(side === 'sell')} onClick={() => setSide('sell')}>Sell</button>
        <div style={{ flex: 1 }} />
        <button style={btnStyle(type === 'put')}   onClick={() => setType('put')}>Put</button>
        <button style={btnStyle(type === 'call')}  onClick={() => setType('call')}>Call</button>
        <button style={btnStyle(type === 'stock')} onClick={() => setType('stock')}>Stock</button>
      </div>

      {/* Strike + Expiry */}
      {type !== 'stock' && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 10, color: '#64748b', display: 'block', marginBottom: 2 }}>Strike</label>
            <input
              type="number" step="0.5" value={strike} onChange={e => setStrike(e.target.value)}
              style={{ width: '100%', padding: '4px 6px', fontSize: 12, background: '#1e293b', border: '1px solid #334155', borderRadius: 3, color: '#f1f5f9' }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 10, color: '#64748b', display: 'block', marginBottom: 2 }}>Expiry</label>
            <input
              type="date" value={expiry} onChange={e => setExpiry(e.target.value)}
              style={{ width: '100%', padding: '4px 6px', fontSize: 12, background: '#1e293b', border: '1px solid #334155', borderRadius: 3, color: '#f1f5f9' }}
            />
          </div>
        </div>
      )}

      {/* Premium + Qty */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 10, color: '#64748b', display: 'block', marginBottom: 2 }}>
            {type === 'stock' ? 'Entry price/share' : 'Premium/share'}
          </label>
          <input
            type="number" step="0.01" value={premium} onChange={e => setPremium(e.target.value)}
            placeholder="0.00"
            style={{ width: '100%', padding: '4px 6px', fontSize: 12, background: '#1e293b', border: '1px solid #334151', borderRadius: 3, color: '#f1f5f9' }}
          />
        </div>
        <div style={{ width: 60 }}>
          <label style={{ fontSize: 10, color: '#64748b', display: 'block', marginBottom: 2 }}>Qty</label>
          <input
            type="number" min="1" value={qty} onChange={e => setQty(e.target.value)}
            style={{ width: '100%', padding: '4px 6px', fontSize: 12, background: '#1e293b', border: '1px solid #334155', borderRadius: 3, color: '#f1f5f9' }}
          />
        </div>
      </div>

      {/* Optional Greeks */}
      {type !== 'stock' && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          {[
            { label: 'Δ Delta', val: delta, set: setDelta, ph: type === 'put' ? '-0.30' : '0.30' },
            { label: 'Θ Theta', val: theta, set: setTheta, ph: '-0.05' },
            { label: 'V Vega',  val: vega,  set: setVega,  ph: '0.10' },
          ].map(({ label, val, set, ph }) => (
            <div key={label} style={{ flex: 1 }}>
              <label style={{ fontSize: 9, color: '#64748b', display: 'block', marginBottom: 2 }}>{label}</label>
              <input
                type="number" step="0.01" value={val} onChange={e => set(e.target.value)}
                placeholder={ph}
                style={{ width: '100%', padding: '3px 5px', fontSize: 11, background: '#1e293b', border: '1px solid #334155', borderRadius: 3, color: '#94a3b8' }}
              />
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={handleSubmit}
          style={{ flex: 1, padding: '5px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 4, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
        >
          Add Leg
        </button>
        <button
          onClick={onCancel}
          style={{ padding: '5px 10px', background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface PayoffViewProps {
  initialTicker?: string | null;
  initialSpot?: number | null;
  /** Pre-select this expiry date (YYYY-MM-DD) when navigating from Opportunity. */
  initialExpiry?: string | null;
  /** Strategy mode from Opportunity (wheel | csp | spreads | bullish | bearish). */
  initialStrategy?: string | null;
  /** Target strike price from Opportunity — used to find the nearest contract. */
  initialStrike?: number | null;
  /**
   * Pre-built legs from Strategy Lab. When provided the chain-fetch auto-load
   * is skipped and these legs are applied directly on mount.
   */
  initialLegs?: PayoffLeg[] | null;
}

export function PayoffView({ initialTicker, initialSpot, initialExpiry, initialStrategy, initialStrike, initialLegs }: PayoffViewProps) {
  const [ticker, setTicker]   = useState(initialTicker ?? '');
  const [spotStr, setSpotStr] = useState(initialSpot != null ? String(initialSpot) : '');
  const [legs, setLegs]       = useState<PayoffLeg[]>([]);

  // Saved strategies
  const [saved, setSaved]         = useState<SavedPayoffStrategy[]>([]);
  const [saveName, setSaveName]   = useState('');
  const [showSave, setShowSave]   = useState(false);
  const [showLoad, setShowLoad]   = useState(false);

  // Add-leg form
  const [showAddForm, setShowAddForm] = useState(false);

  // Chain loader
  const [showChain, setShowChain]               = useState(false);
  const [chainLoading, setChainLoading]         = useState(false);
  const [chainExpirations, setChainExpirations] = useState<OptionsChainExpirationSummary[]>([]);
  const [selectedExpiry, setSelectedExpiry]     = useState('');
  const [chainData, setChainData]               = useState<OptionsChainViewData | null>(null);
  const [chainStrikeFilter, setChainStrikeFilter] = useState<'atm' | 'all'>('atm');
  const [chainExpanded, setChainExpanded]         = useState(true); // opens expanded; user can collapse

  // Assessment state
  const [assessment, setAssessment]         = useState<PayoffAssessment | null>(null);
  const [assessLoading, setAssessLoading]   = useState(false);
  const [assessThinking, setAssessThinking] = useState('');
  const thinkingRef = useRef<HTMLDivElement>(null);

  // Pre-trade validation state (decision-support — Requirements/PRE_TRADE_VALIDATOR_SPEC.md)
  const [validation, setValidation]       = useState<PretradeValidationResult | null>(null);
  const [validateLoading, setValidateLoading] = useState(false);
  // Intent — remembered last-used across validations this session.
  const [intentHappyToOwn, setIntentHappyToOwn] = useState<'yes' | 'no' | 'na'>('na');
  const [intentPurpose, setIntentPurpose]       = useState<PretradeTradePurpose>('income');
  const [intentMultiQuarter, setIntentMultiQuarter] = useState(false);

  // UI state
  const [error, setError]               = useState<string | null>(null);
  const [statusMsg, setStatus]          = useState<string | null>(null);
  const [templateSlug, setTemplateSlug] = useState('');
  const [lastAppliedSlug, setLastAppliedSlug] = useState<string | null>(null);
  const [viewMode, setViewMode]         = useState<'chart' | 'table'>('chart');

  // Earnings date for the current ticker
  const [earningsDate, setEarningsDate] = useState<string | null>(null);

  // Watchlist picker
  const [watchlists, setWatchlists]           = useState<Watchlist[]>([]);
  const [selectedWlId, setSelectedWlId]       = useState<number | null>(null);
  const [watchlistItems, setWatchlistItems]   = useState<WatchlistItem[]>([]);

  const spotNum = parseFloat(spotStr) || 0;

  // Load saved strategies + watchlists on mount
  useEffect(() => {
    window.api.payoff.list().then(setSaved).catch(() => {});
    window.api.watchlists.list().then(setWatchlists).catch(() => {});
  }, []);

  // Load items when watchlist selection changes
  useEffect(() => {
    if (selectedWlId === null) { setWatchlistItems([]); return; }
    window.api.watchlists.items.list(selectedWlId).then(setWatchlistItems).catch(() => setWatchlistItems([]));
  }, [selectedWlId]);

  // ── Strategy Lab / Daily Brief navigation: pre-built legs supplied directly ──
  useEffect(() => {
    if (!initialLegs || initialLegs.length === 0) return;
    setLegs(initialLegs);

    // Also load the option chain for the pick's OWN expiry (e.g. 7/17), so the chain panel
    // and the "Suggested next leg" / manual leg-adds operate on that expiry — not the nearest
    // weekly Friday. Without this the chain stayed unloaded and added legs defaulted to a
    // different (this-week) expiry than the legs that came from the brief.
    if (!initialTicker || !initialExpiry) return;
    (async () => {
      try {
        const expResult = await window.api.optionsChain.getNearExpirations(initialTicker.toUpperCase());
        setChainExpirations(expResult.expirations);
        if (expResult.currentPrice) setSpotStr(expResult.currentPrice.toFixed(2));

        // Snap to the nearest available expiry (exact match when the brief's expiry is listed).
        const targetTs = new Date(initialExpiry).getTime();
        const bestExpiry = expResult.expirations.length === 0
          ? initialExpiry
          : expResult.expirations.reduce((best, e) =>
              Math.abs(new Date(e.date).getTime() - targetTs) <
              Math.abs(new Date(best.date).getTime() - targetTs) ? e : best,
            ).date;
        setSelectedExpiry(bestExpiry);

        const chainResult = await window.api.optionsChain.getChain(initialTicker.toUpperCase(), bestExpiry);
        setChainData(chainResult);
        if (chainResult.currentPrice) setSpotStr(chainResult.currentPrice.toFixed(2));
        setShowChain(true);
      } catch { /* chain is optional — the pre-built legs are already shown */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run only once on mount

  // ── Earnings fetch — runs whenever ticker changes (covers all entry paths) ────
  // This ensures the earnings annotation appears whether the view was opened via
  // a strategy template, Options Chain B/S button, Opportunity, or manual entry.
  useEffect(() => {
    const t = ticker.trim().toUpperCase();
    if (!t) { setEarningsDate(null); return; }
    window.api.earnings.get(t)
      .then(e => setEarningsDate(e?.reportDate ?? null))
      .catch(() => setEarningsDate(null));
  }, [ticker]);

  // ── Opportunity navigation: auto-load chain + pre-add leg(s) on mount ────────
  useEffect(() => {
    // Skip if Strategy Lab already supplied pre-built legs
    if (initialLegs && initialLegs.length > 0) return;
    if (!initialTicker || !initialExpiry || !initialStrike || !initialStrategy) return;

    const init = async () => {
      try {
        // 1. Load available expirations for this ticker
        const expResult = await window.api.optionsChain.getNearExpirations(initialTicker.toUpperCase());
        setChainExpirations(expResult.expirations);
        if (expResult.currentPrice) setSpotStr(expResult.currentPrice.toFixed(2));

        // 2. Find the closest available expiry to the target date
        const targetTs = new Date(initialExpiry).getTime();
        const bestExpiry = expResult.expirations.length === 0
          ? initialExpiry
          : expResult.expirations.reduce((best, e) => {
              const eDiff = Math.abs(new Date(e.date).getTime() - targetTs);
              const bDiff = Math.abs(new Date(best.date).getTime() - targetTs);
              return eDiff < bDiff ? e : best;
            }).date;

        setSelectedExpiry(bestExpiry);

        // 3. Load the option chain for that expiry
        const chainResult = await window.api.optionsChain.getChain(initialTicker.toUpperCase(), bestExpiry);
        setChainData(chainResult);
        if (chainResult.currentPrice) setSpotStr(chainResult.currentPrice.toFixed(2));
        setShowChain(true);

        // 4. Build leg(s) closest to the target strike
        const puts  = chainResult.contracts.filter(c => c.side === 'put');
        const calls = chainResult.contracts.filter(c => c.side === 'call');

        const nearest = (contracts: OptionContract[], target: number) =>
          contracts.reduce<OptionContract | null>((best, c) => {
            if (!best) return c;
            return Math.abs(c.strike - target) < Math.abs(best.strike - target) ? c : best;
          }, null);

        const mkLeg = (c: OptionContract, side: 'buy' | 'sell', type: 'put' | 'call'): PayoffLeg => {
          const mid = parseFloat(((c.bid + c.ask) / 2).toFixed(2));
          return {
            id:       genId(),
            side,
            type,
            strike:   c.strike,
            expiry:   bestExpiry,
            premium:  mid,
            quantity: 1,
            delta:    c.delta,
            theta:    c.theta,
            vega:     c.vega,
            iv:       c.iv,
            label:    `${side === 'buy' ? 'Buy' : 'Sell'} ${type.charAt(0).toUpperCase() + type.slice(1)} $${c.strike}`,
          };
        };

        const newLegs: PayoffLeg[] = [];

        if (initialStrategy === 'wheel' || initialStrategy === 'csp') {
          // Sell put at target strike
          const put = nearest(puts, initialStrike);
          if (put) newLegs.push(mkLeg(put, 'sell', 'put'));

        } else if (initialStrategy === 'spreads') {
          // Sell put at target strike + buy put ~5% lower (protection leg)
          const shortPut = nearest(puts, initialStrike);
          const longPut  = nearest(puts, initialStrike * 0.95);
          if (shortPut) newLegs.push(mkLeg(shortPut, 'sell', 'put'));
          if (longPut && longPut.strike !== shortPut?.strike) newLegs.push(mkLeg(longPut, 'buy', 'put'));

        } else if (initialStrategy === 'bullish') {
          // Buy call at target strike (105% of price)
          const call = nearest(calls, initialStrike);
          if (call) newLegs.push(mkLeg(call, 'buy', 'call'));

        } else if (initialStrategy === 'bearish') {
          // Buy put at target strike (92% of price)
          const put = nearest(puts, initialStrike);
          if (put) newLegs.push(mkLeg(put, 'buy', 'put'));
        }

        if (newLegs.length > 0) setLegs(newLegs);

      } catch (e) {
        setError((e as Error).message);
      }
    };

    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run only once on mount

  // ── Protective leg recommendation (shown when exactly 1 leg is active) ──────
  const protectiveRec = useMemo(() => {
    if (legs.length !== 1) return null;
    const leg = legs[0]!;

    let mult: number, pSide: 'buy' | 'sell', pType: 'put' | 'call', rationale: string, emoji: string;

    if (leg.side === 'sell' && leg.type === 'put') {
      // Short put (CSP) → buy put below = bull put spread
      mult = 0.95; pSide = 'buy'; pType = 'put';
      rationale = 'Bull put spread — caps max loss on this short put';
      emoji = '🛡️';
    } else if (leg.side === 'sell' && leg.type === 'call') {
      // Short call → buy call above = bear call spread
      mult = 1.05; pSide = 'buy'; pType = 'call';
      rationale = 'Bear call spread — caps upside risk on this short call';
      emoji = '🛡️';
    } else if (leg.side === 'buy' && leg.type === 'call') {
      // Long call → sell call above = bull call spread (reduce cost)
      mult = 1.05; pSide = 'sell'; pType = 'call';
      rationale = 'Bull call spread — sell higher call to cut cost basis';
      emoji = '💰';
    } else if (leg.side === 'buy' && leg.type === 'put') {
      // Long put → sell put below = bear put spread (reduce cost)
      mult = 0.95; pSide = 'sell'; pType = 'put';
      rationale = 'Bear put spread — sell lower put to cut cost basis';
      emoji = '💰';
    } else {
      return null;
    }

    const estStrike = Math.round(leg.strike * mult);

    // If chain is loaded, snap to the nearest real available contract
    let contract: OptionContract | null = null;
    if (chainData) {
      const pool = chainData.contracts.filter(c => c.side === pType);
      contract = pool.reduce<OptionContract | null>((best, c) =>
        best === null ? c : Math.abs(c.strike - estStrike) < Math.abs(best.strike - estStrike) ? c : best,
      null);
    }

    return {
      side:     pSide,
      type:     pType,
      rationale,
      emoji,
      strike:   contract?.strike ?? estStrike,
      contract,
    };
  }, [legs, chainData]);

  // ── Computed payoff ─────────────────────────────────────────────────────────
  const metrics = useMemo(
    () => (legs.length > 0 && spotNum > 0 ? computePayoffMetrics(legs, spotNum) : null),
    [legs, spotNum]
  );

  // ── Strategy recognition ────────────────────────────────────────────────────
  const recognizedStrategy = useMemo(() => recognizeStrategy(legs), [legs]);

  // ── Trade assessment ────────────────────────────────────────────────────────
  const handleAssess = useCallback(async () => {
    if (!metrics || legs.length === 0) { setError('Add legs and a spot price first'); return; }
    setAssessLoading(true);
    setAssessThinking('');
    setAssessment(null);
    setError(null);

    const strategyName = recognizedStrategy?.name ?? 'Custom Strategy';
    const input: PayoffAssessInput = {
      spot:            spotNum,
      ticker:          ticker.trim() || null,
      strategyName,
      maxProfit:       metrics.maxProfit,
      maxLoss:         metrics.maxLoss,
      unlimitedProfit: metrics.unlimitedProfit,
      unlimitedLoss:   metrics.unlimitedLoss,
      breakevenPrices: metrics.breakevenPrices,
      netPremium:      metrics.netPremium,
      netDelta:        metrics.netDelta,
      netTheta:        metrics.netTheta,
      netVega:         metrics.netVega,
    };

    const unsubscribe = window.api.payoff.onAssessProgress((chunk: string) => {
      setAssessThinking(prev => {
        const next = prev + chunk;
        setTimeout(() => { if (thinkingRef.current) thinkingRef.current.scrollTop = thinkingRef.current.scrollHeight; }, 0);
        return next;
      });
    });

    try {
      const result = await window.api.payoff.assess(legs, input);
      setAssessment(result);
      setAssessThinking('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      unsubscribe();
      setAssessLoading(false);
    }
  }, [legs, metrics, recognizedStrategy, spotNum, ticker]);

  // ── Pre-trade validation ────────────────────────────────────────────────────
  const handleValidate = useCallback(async (refresh = false) => {
    if (!metrics || legs.length === 0) { setError('Add legs and a spot price first'); return; }
    setValidateLoading(true);
    setError(null);
    const input: PretradeValidateInput = {
      ticker:       ticker.trim() || null,
      strategyName: recognizedStrategy?.name ?? 'Custom Strategy',
      spot:         spotNum,
      legs,
      metrics: {
        maxProfit:       metrics.maxProfit,
        maxLoss:         metrics.maxLoss,
        unlimitedProfit: metrics.unlimitedProfit,
        unlimitedLoss:   metrics.unlimitedLoss,
        breakevenPrices: metrics.breakevenPrices,
        netPremium:      metrics.netPremium,
        netDelta:        metrics.netDelta,
        netTheta:        metrics.netTheta,
        netVega:         metrics.netVega,
      },
      intent: {
        happyToOwn: intentHappyToOwn === 'na' ? null : intentHappyToOwn === 'yes',
        purpose:    intentPurpose,
        multiQuarterThesis: intentMultiQuarter,
      },
      refresh,
    };
    try {
      const result = await window.api.pretradeValidator.validate(input);
      setValidation(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setValidateLoading(false);
    }
  }, [legs, metrics, recognizedStrategy, spotNum, ticker, intentHappyToOwn, intentPurpose, intentMultiQuarter]);

  // ── Template application ────────────────────────────────────────────────────
  // Applies skeleton legs immediately, then auto-fills premiums from the live
  // chain when a ticker is set. Expiry is snapped to the nearest Friday expiry
  // available in the chain for each target DTE.
  // Spot price is optional when a ticker is set — the chain provides it.
  const applyTemplateBySlug = useCallback(async (slug: string) => {
    const tpl = ALL_TEMPLATES.find(t => t.slug === slug);
    if (!tpl) return;

    const hasTicker = !!ticker.trim();
    const hasSpot   = spotNum > 0;

    // Need at least one source of spot price
    if (!hasSpot && !hasTicker) { setError('Enter a ticker or spot price first'); return; }

    // Show skeleton immediately if we have a spot to build from
    if (hasSpot) setLegs(tpl.build(spotNum));
    setError(null);
    setLastAppliedSlug(slug);

    if (!hasTicker) return; // no ticker → user fills premiums manually

    setChainLoading(true);
    try {
      // 1. Load available expirations and get live spot price
      const expResult = await window.api.optionsChain.getNearExpirations(ticker.toUpperCase());
      setChainExpirations(expResult.expirations);

      const realSpot = expResult.currentPrice ?? (spotNum > 0 ? spotNum : null);
      if (!realSpot) { setError('Could not determine spot price — enter it manually'); return; }
      if (expResult.currentPrice) setSpotStr(expResult.currentPrice.toFixed(2));
      if (expResult.expirations.length === 0) return;

      // Rebuild template targets using the real spot (accurate strike percentages)
      const targetLegs = tpl.build(realSpot);

      // 2. Find best Friday expiry for each unique target DTE.
      //    Friday = standard options expiry; falls back to any expiry if none available.
      const isFriday = (d: string) => {
        const [y, m, dy] = d.split('-').map(Number);
        return new Date(y!, m! - 1, dy!).getDay() === 5;
      };

      const findBestExpiry = (targetDateStr: string): string => {
        const targetTs = new Date(targetDateStr).getTime();
        const fridays = expResult.expirations.filter(e => isFriday(e.date));
        const pool    = fridays.length > 0 ? fridays : expResult.expirations;
        return pool.reduce((best, e) =>
          Math.abs(new Date(e.date).getTime() - targetTs) <
          Math.abs(new Date(best.date).getTime() - targetTs) ? e : best,
        ).date;
      };

      // Map: template expiry string → best real Friday expiry
      const expiryMap = new Map<string, string>();
      for (const leg of targetLegs) {
        if (leg.type === 'stock') continue;
        if (!expiryMap.has(leg.expiry)) {
          expiryMap.set(leg.expiry, findBestExpiry(leg.expiry));
        }
      }

      // 3. Load chain for each unique real expiry (usually just 1, or 2 for calendars)
      const chainCache = new Map<string, OptionsChainViewData>();
      for (const realExpiry of new Set(expiryMap.values())) {
        const chain = await window.api.optionsChain.getChain(ticker.toUpperCase(), realExpiry);
        chainCache.set(realExpiry, chain);
        if (chain.currentPrice) setSpotStr(chain.currentPrice.toFixed(2));
      }

      // Show the chain for the primary (first option) expiry
      const primaryTemplateExpiry = targetLegs.find(l => l.type !== 'stock')?.expiry ?? '';
      const primaryRealExpiry     = expiryMap.get(primaryTemplateExpiry) ?? '';
      const primaryChain          = chainCache.get(primaryRealExpiry);
      if (primaryChain && primaryRealExpiry) {
        setChainData(primaryChain);
        setSelectedExpiry(primaryRealExpiry);
        setShowChain(true);
      }

      // 4. Fill each leg — lizard hedge uses smart strike selection (credit ≥ spread width)
      const filledLegs = fillLegsFromChain(
        slug,
        targetLegs,
        (templateExpiry) => { const re = expiryMap.get(templateExpiry); return re ? chainCache.get(re) : undefined; },
        (templateExpiry) => expiryMap.get(templateExpiry),
      );

      setLegs(filledLegs);
    } catch (e) {
      // Non-fatal — skeleton legs already shown, user can fill manually
      setError(`Chain load failed: ${(e as Error).message}`);
    } finally {
      setChainLoading(false);
    }
  }, [spotNum, ticker]);

  // ── Reload legs for a new expiry ────────────────────────────────────────────
  // Re-snaps all option legs from the last applied template to a new expiry date
  // using the live chain for that expiry. All legs collapse to the same expiry.
  const reloadLegsForExpiry = useCallback(async (slug: string, targetExpiry: string) => {
    if (!ticker.trim()) return;
    const tpl = ALL_TEMPLATES.find(t => t.slug === slug);
    if (!tpl) return;

    setChainLoading(true);
    try {
      const realSpot = parseFloat(spotStr) || spotNum || 100;
      const targetLegs = tpl.build(realSpot);

      const chain = (selectedExpiry === targetExpiry && chainData)
        ? chainData
        : await window.api.optionsChain.getChain(ticker.toUpperCase(), targetExpiry);

      if (selectedExpiry !== targetExpiry || !chainData) {
        setChainData(chain);
        setSelectedExpiry(targetExpiry);
      }
      if (chain.currentPrice) setSpotStr(chain.currentPrice.toFixed(2));

      const filledLegs = fillLegsFromChain(
        slug,
        targetLegs,
        () => chain,         // all legs share the same chain
        () => targetExpiry,  // all legs share the same expiry
      );
      setLegs(filledLegs);
      setStatus(`Strategy reloaded for ${targetExpiry}`);
    } catch (e) {
      setError(`Reload failed: ${(e as Error).message}`);
    } finally {
      setChainLoading(false);
    }
  }, [ticker, spotStr, spotNum, chainData, selectedExpiry]);

  // ── Leg mutation helpers ────────────────────────────────────────────────────
  const removeLeg = (id: string) => setLegs(prev => prev.filter(l => l.id !== id));

  const toggleSide = (id: string) =>
    setLegs(prev => prev.map(l =>
      l.id === id ? { ...l, side: l.side === 'buy' ? 'sell' : 'buy' } : l
    ));

  const updateLeg = (id: string, patch: Partial<PayoffLeg>) => {
    // When strike changes + chain loaded: snap to nearest real contract,
    // then recalculate the lizard hedge if this is a sell leg of a lizard strategy.
    if ('strike' in patch && patch.strike !== undefined && chainData) {
      setLegs(prev => {
        const targetLeg = prev.find(l => l.id === id);
        if (!targetLeg || targetLeg.type === 'stock') {
          return prev.map(l => l.id === id ? { ...l, ...patch } : l);
        }

        const contracts = chainData.contracts.filter(c => c.side === targetLeg.type);
        const nearest = contracts.reduce<OptionContract | null>((best, c) =>
          best === null ? c : Math.abs(c.strike - patch.strike!) < Math.abs(best.strike - patch.strike!) ? c : best,
        null);
        if (!nearest) return prev.map(l => l.id === id ? { ...l, ...patch } : l);

        const mid     = Math.max(0, parseFloat(((nearest.bid + nearest.ask) / 2).toFixed(2)));
        const sideStr = targetLeg.side === 'buy' ? 'Buy' : 'Sell';
        const typeStr = targetLeg.type.charAt(0).toUpperCase() + targetLeg.type.slice(1);
        const qtyStr  = targetLeg.quantity > 1 ? ` ${targetLeg.quantity}` : '';
        const snapped: Partial<PayoffLeg> = {
          strike:  nearest.strike,
          premium: mid,
          delta:   nearest.delta ?? targetLeg.delta,
          theta:   nearest.theta ?? null,
          vega:    nearest.vega  ?? null,
          iv:      nearest.iv    ?? null,
          label:   `${sideStr}${qtyStr} ${typeStr} $${nearest.strike}`,
        };

        const updated = prev.map(l => l.id === id ? { ...l, ...snapped } : l);

        // For lizard strategies: recalculate the buy hedge whenever a sell leg moves
        if (lastAppliedSlug && LIZARD_HEDGE_SLUGS.has(lastAppliedSlug) && targetLeg.side === 'sell') {
          const shortCredit = updated
            .filter(l => l.type !== 'stock' && l.side === 'sell')
            .reduce((s, l) => s + l.premium, 0);
          const buyLeg = updated.find(l => l.type !== 'stock' && l.side === 'buy');
          if (buyLeg && (buyLeg.type === 'call' || buyLeg.type === 'put')) {
            const hedgeContracts = chainData.contracts.filter(c => c.side === buyLeg.type);
            const sellSameType = updated.find(l => l.type === buyLeg.type && l.side === 'sell');
            if (sellSameType) {
              const newHedge = findLizardHedgePayoff(hedgeContracts, buyLeg.type as 'call' | 'put', sellSameType.strike, shortCredit);
              if (newHedge) {
                const hedgeMid  = Math.max(0, parseFloat(((newHedge.bid + newHedge.ask) / 2).toFixed(2)));
                const bQty      = buyLeg.quantity > 1 ? ` ${buyLeg.quantity}` : '';
                const bType     = buyLeg.type.charAt(0).toUpperCase() + buyLeg.type.slice(1);
                return updated.map(l => l.id !== buyLeg.id ? l : {
                  ...l,
                  strike:  newHedge.strike,
                  premium: hedgeMid,
                  delta:   newHedge.delta ?? l.delta,
                  theta:   newHedge.theta ?? null,
                  vega:    newHedge.vega  ?? null,
                  iv:      newHedge.iv    ?? null,
                  label:   `Buy${bQty} ${bType} $${newHedge.strike}`,
                });
              }
            }
          }
        }

        return updated;
      });
      return;
    }
    setLegs(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l));
  };

  const addLeg = (leg: PayoffLeg) => {
    setLegs(prev => [...prev, leg]);
    setShowAddForm(false);
  };

  const addProtectiveLeg = useCallback(async () => {
    if (!protectiveRec) return;
    // If chain already loaded, add immediately from the nearest contract
    if (protectiveRec.contract && selectedExpiry) {
      addLegFromContract(protectiveRec.contract, protectiveRec.side, protectiveRec.type, selectedExpiry);
      return;
    }
    // Chain not loaded — try to load it first, then add
    if (!ticker.trim()) { setError('Enter a ticker to load the chain'); return; }
    setChainLoading(true); setError(null);
    try {
      const expResult = await window.api.optionsChain.getNearExpirations(ticker.toUpperCase());
      setChainExpirations(expResult.expirations);
      if (expResult.currentPrice && !spotNum) setSpotStr(expResult.currentPrice.toFixed(2));
      const expiry = expResult.expirations[0]?.date ?? '';
      if (expiry) {
        setSelectedExpiry(expiry);
        const chainResult = await window.api.optionsChain.getChain(ticker.toUpperCase(), expiry);
        setChainData(chainResult);
        setShowChain(true);
        if (chainResult.currentPrice && !spotNum) setSpotStr(chainResult.currentPrice.toFixed(2));
        // Find nearest contract in freshly-loaded chain
        const pool = chainResult.contracts.filter(c => c.side === protectiveRec.type);
        const nearest = pool.reduce<OptionContract | null>((best, c) =>
          best === null ? c : Math.abs(c.strike - protectiveRec.strike) < Math.abs(best.strike - protectiveRec.strike) ? c : best,
        null);
        if (nearest) addLegFromContract(nearest, protectiveRec.side, protectiveRec.type, expiry);
      }
    } catch (e) { setError((e as Error).message); }
    finally { setChainLoading(false); }
  }, [protectiveRec, selectedExpiry, ticker, spotNum]);

  // ── Chain loading ───────────────────────────────────────────────────────────
  const loadChainExpirations = async () => {
    if (!ticker.trim()) { setError('Enter a ticker first'); return; }
    setChainLoading(true); setError(null);
    try {
      const result = await window.api.optionsChain.getNearExpirations(ticker.toUpperCase());
      setChainExpirations(result.expirations);
      if (result.currentPrice && !spotNum) setSpotStr(String(result.currentPrice.toFixed(2)));
      if (result.expirations.length > 0) {
        setSelectedExpiry(result.expirations[0]!.date);
        await loadChainForExpiry(result.expirations[0]!.date);
      }
      setShowChain(true);
    } catch (e) { setError((e as Error).message); }
    finally { setChainLoading(false); }
  };

  const loadChainForExpiry = async (expiry: string) => {
    if (!ticker.trim()) return;
    setChainLoading(true);
    try {
      const data = await window.api.optionsChain.getChain(ticker.toUpperCase(), expiry);
      setChainData(data);
      if (data.currentPrice && !spotNum) setSpotStr(String(data.currentPrice.toFixed(2)));
    } catch (e) { setError((e as Error).message); }
    finally { setChainLoading(false); }
  };

  const addLegFromContract = (
    contract: OptionContract,
    side: 'buy' | 'sell',
    type: 'call' | 'put',
    expiry: string,
  ) => {
    const mid = (contract.bid + contract.ask) / 2;
    setLegs(prev => [...prev, {
      id:       genId(),
      side,
      type,
      strike:   contract.strike,
      expiry,
      premium:  parseFloat(mid.toFixed(2)),
      quantity: 1,
      delta:    contract.delta,
      theta:    contract.theta,
      vega:     contract.vega,
      iv:       contract.iv,
      openInterest: contract.openInterest,
      volume:   contract.volume,
      bid:      contract.bid,
      ask:      contract.ask,
      label:    `${side === 'buy' ? 'Buy' : 'Sell'} ${type.charAt(0).toUpperCase() + type.slice(1)} $${contract.strike}`,
    }]);
    setStatus(`Added ${side} ${type} $${contract.strike} from chain`);
  };

  // ── Save / Load ─────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!saveName.trim()) { setError('Enter a strategy name'); return; }
    if (legs.length === 0) { setError('Add at least one leg first'); return; }
    try {
      const strat = await window.api.payoff.save(saveName.trim(), ticker.trim() || null, legs);
      setSaved(prev => [strat, ...prev]);
      setSaveName(''); setShowSave(false);
      setStatus(`Saved "${strat.name}"`);
    } catch (e) { setError((e as Error).message); }
  };

  const handleLoad = (strat: SavedPayoffStrategy) => {
    setLegs(strat.legs);
    if (strat.ticker) setTicker(strat.ticker);
    setShowLoad(false);
    setStatus(`Loaded "${strat.name}"`);
  };

  const handleDelete = async (id: number) => {
    try {
      await window.api.payoff.delete(id);
      setSaved(prev => prev.filter(s => s.id !== id));
    } catch (e) { setError((e as Error).message); }
  };

  // ── Chain-derived strikes for the ATM filter ────────────────────────────────
  const chainStrikes = useMemo(() => {
    if (!chainData) return [];
    const allStrikes = [...new Set(chainData.contracts.map(c => c.strike))].sort((a, b) => a - b);
    if (chainStrikeFilter === 'all' || spotNum === 0) return allStrikes;
    // ATM ±10%
    return allStrikes.filter(s => Math.abs(s / spotNum - 1) <= 0.10);
  }, [chainData, chainStrikeFilter, spotNum]);

  // ── Metrics summary helpers ─────────────────────────────────────────────────
  const fmtMetric = (v: number | null, unlimited: boolean, prefix = '') =>
    unlimited ? '∞' : (v == null ? '—' : `${prefix}${fmtDollar(v)}`);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', fontFamily: 'inherit' }}>

      {/* ════════════════════════════════════════════════════════════════════
          LEFT PANEL — legs + controls
      ════════════════════════════════════════════════════════════════════ */}
      <aside style={{
        width: 280, minWidth: 260, flexShrink: 0,
        borderRight: '1px solid var(--border)',
        overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10,
      }}>

        {/* ── Header ── */}
        <h2 style={{ margin: 0, fontSize: 16 }}>📐 Payoff Visualizer</h2>

        {/* ── Watchlist picker ── */}
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Watchlist</label>
            <select
              value={selectedWlId ?? ''}
              onChange={e => setSelectedWlId(e.target.value ? Number(e.target.value) : null)}
              style={{ width: '100%', padding: '5px 7px', fontSize: 13, background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4 }}
            >
              <option value=''>— select —</option>
              {watchlists.map(w => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Ticker from watchlist</label>
            <select
              value=''
              disabled={watchlistItems.length === 0}
              onChange={e => { if (e.target.value) setTicker(e.target.value); }}
              style={{ width: '100%', padding: '5px 7px', fontSize: 13, background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, opacity: watchlistItems.length === 0 ? 0.5 : 1 }}
            >
              <option value=''>— pick ticker —</option>
              {watchlistItems.map(t => (
                <option key={t.id} value={t.ticker}>{t.ticker}{t.notes ? ` — ${t.notes}` : ''}</option>
              ))}
            </select>
          </div>
        </div>

        {/* ── Ticker + Spot ── */}
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Ticker</label>
            <input
              type="text" value={ticker}
              onChange={e => setTicker(e.target.value.toUpperCase())}
              placeholder="AAPL"
              style={{ width: '100%', padding: '5px 7px', fontSize: 13, textTransform: 'uppercase' }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Spot price</label>
            <input
              type="number" step="0.01" value={spotStr}
              onChange={e => setSpotStr(e.target.value)}
              placeholder="185.00"
              style={{ width: '100%', padding: '5px 7px', fontSize: 13 }}
            />
          </div>
        </div>

        {/* ── Strategy templates dropdown (all 31 Strategy Lab strategies) ── */}
        <div>
          <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>
            Templates
          </label>
          <select
            value={templateSlug}
            onChange={e => {
              const slug = e.target.value;
              setTemplateSlug('');          // reset immediately so it shows placeholder
              if (slug) applyTemplateBySlug(slug);
            }}
            style={{
              width: '100%', padding: '5px 7px', fontSize: 12,
              background: '#1e293b', color: '#e2e8f0',
              border: '1px solid #334155', borderRadius: 4,
            }}
          >
            <option value=''>— Select a strategy —</option>
            {TEMPLATE_CATEGORY_ORDER.map(cat => {
              const strategies = ALL_TEMPLATES.filter(t => t.category === cat);
              if (strategies.length === 0) return null;
              return (
                <optgroup key={cat} label={TEMPLATE_CATEGORY_LABELS[cat]}>
                  {strategies.map(t => (
                    <option key={t.slug} value={t.slug}>{t.name}</option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </div>

        {/* ── Legs list ── */}
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
              Legs {legs.length > 0 && `(${legs.length})`}
            </span>
            {legs.length > 0 && (
              <button
                onClick={() => setLegs([])}
                style={{ fontSize: 10, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                Clear all
              </button>
            )}
          </div>

          {/* ── Reload strategy for selected chain expiry ── */}
          {lastAppliedSlug && selectedExpiry && ticker.trim() && (
            <button
              onClick={() => reloadLegsForExpiry(lastAppliedSlug, selectedExpiry)}
              disabled={chainLoading}
              title={`Re-snap all legs to ${selectedExpiry} using live chain prices`}
              style={{
                width: '100%', padding: '5px 8px', fontSize: 11, borderRadius: 4,
                background: '#0c1a2e', border: '1px solid #1d4ed8',
                color: chainLoading ? '#475569' : '#93c5fd',
                cursor: chainLoading ? 'not-allowed' : 'pointer',
                fontWeight: 600, marginBottom: 6,
              }}
            >
              {chainLoading ? '⟳ Loading…' : `↻ Reload strategy for ${selectedExpiry}`}
            </button>
          )}

          {legs.length === 0 && !showAddForm && (
            <div style={{ fontSize: 12, color: '#475569', textAlign: 'center', padding: '16px 0' }}>
              Pick a template or add a leg manually.
            </div>
          )}

          {legs.map(leg => (
            <LegCard
              key={leg.id}
              leg={leg}
              onRemove={() => removeLeg(leg.id)}
              onToggleSide={() => toggleSide(leg.id)}
              onUpdate={patch => updateLeg(leg.id, patch)}
            />
          ))}

          {/* ── Protective leg recommendation ── */}
          {protectiveRec && !showAddForm && (
            <div style={{
              background: '#0c1a2e',
              border: '1px solid #1d4ed8',
              borderLeft: '3px solid #3b82f6',
              borderRadius: 5, padding: '8px 10px', marginTop: 4,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#93c5fd', marginBottom: 3 }}>
                {protectiveRec.emoji} Suggested next leg
              </div>
              <div style={{ fontSize: 12, color: '#e2e8f0', marginBottom: 3 }}>
                {protectiveRec.side === 'buy' ? 'Buy' : 'Sell'} {protectiveRec.type} ${protectiveRec.strike}
                {!protectiveRec.contract && <span style={{ fontSize: 10, color: '#64748b' }}> (est.)</span>}
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 6 }}>
                {protectiveRec.rationale}
              </div>
              <button
                onClick={addProtectiveLeg}
                disabled={chainLoading}
                style={{
                  width: '100%', padding: '5px 8px', fontSize: 11, borderRadius: 4,
                  background: '#1d4ed8', border: 'none', color: '#fff',
                  cursor: chainLoading ? 'not-allowed' : 'pointer', fontWeight: 600,
                }}
              >
                {chainLoading ? '⟳ Loading…' : '+ Add protective leg'}
              </button>
            </div>
          )}

          {showAddForm ? (
            <AddLegForm
              spotNum={spotNum}
              onAdd={addLeg}
              onCancel={() => setShowAddForm(false)}
            />
          ) : (
            <button
              onClick={() => setShowAddForm(true)}
              style={{
                width: '100%', padding: '6px', fontSize: 12,
                background: 'transparent', border: '1px dashed #334155',
                color: '#64748b', borderRadius: 4, cursor: 'pointer', marginTop: 4,
              }}
            >
              + Add Leg manually
            </button>
          )}
        </div>

        {/* ── Strategy recognition badge + formula rules ── */}
        {recognizedStrategy && (
          <>
            <div style={{
              background: '#0f172a',
              border: `1px solid ${recognizedStrategy.color}44`,
              borderLeft: `3px solid ${recognizedStrategy.color}`,
              borderRadius: 5, padding: '7px 10px',
              opacity: recognizedStrategy.partial ? 0.65 : 1,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: recognizedStrategy.color, marginBottom: 2 }}>
                {recognizedStrategy.partial ? '…' : '✓'} {recognizedStrategy.name}
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.4 }}>
                {recognizedStrategy.description}
              </div>
            </div>
            {!recognizedStrategy.partial && spotNum > 0 && (
              <StrategyFormulaPanel
                strategyName={recognizedStrategy.name}
                legs={legs}
                spot={spotNum}
                chainContracts={chainData?.contracts}
                onFix={(fixedLegs, note) => { setLegs(fixedLegs); setStatus(`Fixed: ${note}`); }}
              />
            )}
          </>
        )}

        {/* ── Chain Loader ── */}
        <div>
          <button
            onClick={showChain ? () => setShowChain(false) : loadChainExpirations}
            disabled={chainLoading}
            style={{
              width: '100%', padding: '6px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
              background: showChain ? '#1e3a5f' : '#1e293b',
              border: `1px solid ${showChain ? '#3b82f6' : '#334155'}`,
              color: showChain ? '#93c5fd' : '#94a3b8',
            }}
          >
            {chainLoading ? '⟳ Loading…' : showChain ? '✕ Hide chain' : '📋 Load options chain'}
          </button>
        </div>

        {/* ── Save / Load ── */}
        <div style={{ borderTop: '1px solid #1e293b', paddingTop: 8, display: 'flex', gap: 6 }}>
          <button
            onClick={() => { setShowSave(!showSave); setShowLoad(false); }}
            style={{ flex: 1, padding: '5px', fontSize: 11, background: '#1e293b', border: '1px solid #334155', borderRadius: 4, color: '#94a3b8', cursor: 'pointer' }}
          >
            💾 Save
          </button>
          <button
            onClick={() => { setShowLoad(!showLoad); setShowSave(false); window.api.payoff.list().then(setSaved).catch(() => {}); }}
            style={{ flex: 1, padding: '5px', fontSize: 11, background: '#1e293b', border: '1px solid #334155', borderRadius: 4, color: '#94a3b8', cursor: 'pointer' }}
          >
            📂 Load
          </button>
        </div>

        {showSave && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="text" value={saveName} onChange={e => setSaveName(e.target.value)}
              placeholder="Strategy name…"
              onKeyDown={e => e.key === 'Enter' && handleSave()}
              style={{ flex: 1, padding: '5px 7px', fontSize: 12 }}
            />
            <button onClick={handleSave} style={{ padding: '5px 10px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}>
              Save
            </button>
          </div>
        )}

        {showLoad && (
          <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 6, overflow: 'hidden' }}>
            {saved.length === 0 ? (
              <div style={{ padding: '10px', fontSize: 12, color: '#64748b', textAlign: 'center' }}>No saved strategies.</div>
            ) : saved.map(s => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', padding: '7px 10px', borderBottom: '1px solid #1e293b' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: '#f1f5f9' }}>{s.name}</div>
                  <div style={{ fontSize: 10, color: '#64748b' }}>{s.ticker ?? '—'} · {s.legs.length} legs</div>
                </div>
                <button onClick={() => handleLoad(s)} style={{ fontSize: 11, padding: '2px 8px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer', marginRight: 4 }}>Load</button>
                <button onClick={() => handleDelete(s.id)} style={{ fontSize: 11, padding: '2px 6px', background: 'transparent', color: '#64748b', border: 'none', cursor: 'pointer' }}>✕</button>
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* ════════════════════════════════════════════════════════════════════
          RIGHT PANEL — chart + metrics + chain drawer
      ════════════════════════════════════════════════════════════════════ */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <main style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Toasts */}
        {error && (
          <div className="error-toast" onClick={() => setError(null)}>
            {error} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
          </div>
        )}
        {statusMsg && !error && (
          <div className="status-toast" onClick={() => setStatus(null)}>
            {statusMsg} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
          </div>
        )}

        {/* ── Empty state ── */}
        {!metrics && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#475569', gap: 10 }}>
            <div style={{ fontSize: 48 }}>📐</div>
            <h3 style={{ margin: 0 }}>Build a strategy</h3>
            <p style={{ margin: 0, fontSize: 13, textAlign: 'center', maxWidth: 320 }}>
              Enter a spot price, pick a template or add legs manually, then see the P&L diagram at expiration.
            </p>
          </div>
        )}

        {/* ── Chart / Table toggle + content ── */}
        {metrics && (
          <>
            {/* ── View toggle ── */}
            <div style={{ display: 'flex', gap: 0, alignSelf: 'flex-start', border: '1px solid #1e293b', borderRadius: 5, overflow: 'hidden' }}>
              {(['chart', 'table'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  style={{
                    padding: '4px 14px', fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none',
                    background: viewMode === mode ? '#1d4ed8' : '#0f172a',
                    color: viewMode === mode ? '#fff' : '#64748b',
                    borderRight: mode === 'chart' ? '1px solid #1e293b' : 'none',
                  }}
                >
                  {mode === 'chart' ? '📈 Chart' : '⬛ Risk Matrix'}
                </button>
              ))}
            </div>

            {/* ── Single-line metrics + Greeks bar ── */}
            <div style={{
              background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6,
              padding: '5px 10px', display: 'flex', alignItems: 'center',
              flexWrap: 'wrap', gap: 0, fontSize: 11, rowGap: 4,
            }}>
              {/* Separator helper */}
              {(() => {
                const sep = <span style={{ color: '#1e3a5f', margin: '0 8px', userSelect: 'none' }}>│</span>;

                return (
                  <>
                    {/* Max Profit */}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      <span style={{ color: '#64748b' }}>Max Profit</span>
                      <InfoTip text={'Highest P&L at expiration across 200 simulated price points (50%–155% of spot).\n\n• Short options: total premium collected × qty × 100\n• Spreads: capped at strike width − net debit\n• Long calls/stock: shown as ∞\n\nFormula: max(pnl[i]) across simulated prices'} />
                      <strong style={{ color: '#22c55e', marginLeft: 3 }}>
                        {fmtMetric(metrics.maxProfit, metrics.unlimitedProfit)}
                      </strong>
                    </span>
                    {sep}
                    {/* Max Loss */}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      <span style={{ color: '#64748b' }}>Max Loss</span>
                      <InfoTip text={'Worst P&L at expiration across the same 200 simulated price points.\n\n• Long options: limited to premium paid × qty × 100\n• Short naked options: shown as ∞\n• Short puts: (strike − premium) × qty × 100\n\nFormula: min(pnl[i]) across simulated prices'} />
                      <strong style={{ color: '#ef4444', marginLeft: 3 }}>
                        {fmtMetric(metrics.maxLoss, metrics.unlimitedLoss)}
                      </strong>
                    </span>
                    {sep}
                    {/* Breakeven */}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      <span style={{ color: '#64748b' }}>
                        {metrics.breakevenPrices.length > 1 ? `BE ×${metrics.breakevenPrices.length}` : 'BE'}
                      </span>
                      <InfoTip text={'Stock price(s) at expiration where total P&L = $0.\n\nDetected by linear interpolation wherever the payoff curve crosses the zero line. Complex strategies have two breakevens.\n\nCSP example: strike − net premium received\nLong call: strike + premium paid'} />
                      <strong style={{ color: '#fbbf24', marginLeft: 3 }}>
                        {metrics.breakevenPrices.length === 0
                          ? '—'
                          : metrics.breakevenPrices.map(p => fmtPrice(p)).join(' / ')}
                      </strong>
                    </span>
                    {sep}
                    {/* Net Credit / Debit */}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      <span style={{ color: '#64748b' }}>
                        {metrics.netPremium >= 0 ? 'Net Cr' : 'Net Dr'}
                      </span>
                      <InfoTip text={'Total premium cash flow for the position.\n\n• Net Credit (positive): you received more than you paid — the credit is your buffer before a loss begins\n• Net Debit (negative): you paid net — the stock must move in your favour to profit\n\nFormula: Σ (sell: +premium, buy: −premium) × qty × 100'} />
                      <strong style={{ color: metrics.netPremium >= 0 ? '#22c55e' : '#f97316', marginLeft: 3 }}>
                        {fmtDollar(Math.abs(metrics.netPremium))}
                      </strong>
                    </span>
                    {/* Greeks — only shown when available */}
                    {metrics.netDelta != null && (
                      <>
                        {sep}
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <span style={{ color: '#94a3b8' }}>Δ</span>
                          <InfoTip text={'Position delta — how much total P&L changes per $1 move in the stock.\n\n+1.00 ≈ long 100 shares\n−1.00 ≈ short 100 shares\n 0.00 = delta-neutral\n\nFormula: Σ (buy:+1, sell:−1) × leg.delta × qty'} />
                          <strong style={{ color: metrics.netDelta > 0 ? '#22c55e' : '#ef4444', marginLeft: 2 }}>
                            {metrics.netDelta >= 0 ? '+' : ''}{metrics.netDelta.toFixed(2)}
                          </strong>
                        </span>
                      </>
                    )}
                    {metrics.netTheta != null && (
                      <>
                        {sep}
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <span style={{ color: '#94a3b8' }}>Θ</span>
                          <InfoTip text={'Daily time decay for the full position (in dollars/day).\n\nPositive Θ: you collect decay each day (short options — favourable)\nNegative Θ: time erodes your position value (long options)\n\nFormula: Σ (buy:+1, sell:−1) × leg.theta × qty × 100'} />
                          <strong style={{ color: metrics.netTheta > 0 ? '#22c55e' : '#f97316', marginLeft: 2 }}>
                            {metrics.netTheta >= 0 ? '+' : ''}{fmtDollar(metrics.netTheta)}/d
                          </strong>
                        </span>
                      </>
                    )}
                    {metrics.netVega != null && (
                      <>
                        {sep}
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <span style={{ color: '#94a3b8' }}>V</span>
                          <InfoTip text={'How much the position gains or loses per 1% rise in implied volatility.\n\nPositive Vega: rising IV helps (long options, pre-earnings)\nNegative Vega: rising IV hurts (short options, sellers prefer IV crush)\n\nFormula: Σ (buy:+1, sell:−1) × leg.vega × qty × 100'} />
                          <strong style={{ color: '#94a3b8', marginLeft: 2 }}>
                            {metrics.netVega >= 0 ? '+' : ''}{fmtDollar(metrics.netVega)}/1%IV
                          </strong>
                        </span>
                      </>
                    )}
                  </>
                );
              })()}
            </div>

            {/* ── Chart or Risk Matrix ── */}
            {viewMode === 'chart' ? (
              <>
                <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '4px 6px 1px' }}>
                  <PayoffChart metrics={metrics} spot={spotNum} />
                </div>
                {earningsDate && (() => {
                  const dte = Math.round((new Date(earningsDate).getTime() - Date.now()) / 86_400_000);
                  const withinDte = legs.some(l => l.type !== 'stock' && dte <= Math.round((new Date(l.expiry).getTime() - Date.now()) / 86_400_000));
                  if (dte < 0) return null;
                  return (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
                      background: withinDte ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)',
                      border: `1px solid ${withinDte ? '#ef444444' : '#f59e0b44'}`,
                      borderRadius: 5, fontSize: 11,
                    }}>
                      <span>📅</span>
                      <span style={{ fontWeight: 600, color: withinDte ? '#ef4444' : '#f59e0b' }}>
                        Earnings {new Date(`${earningsDate}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {dte === 0 ? 'Today' : `${dte}d`}
                      </span>
                      {withinDte && <span style={{ color: '#94a3b8' }}>— inside option DTE window · IV crush risk after report</span>}
                    </div>
                  );
                })()}
              </>
            ) : (
              <RiskMatrixTable
                legs={legs}
                spotNum={spotNum}
                chainExpirations={chainExpirations}
                chainData={chainData}
                hasIv={legs.filter(l => l.type !== 'stock').every(l => l.iv !== null)}
                earningsDate={earningsDate}
              />
            )}
          </>
        )}

        {/* ════════════════════════════════════════════════════════════════════
            PRE-TRADE VALIDATION (decision-support — Requirements/PRE_TRADE_VALIDATOR_SPEC.md)
        ════════════════════════════════════════════════════════════════════ */}
        {legs.length > 0 && spotNum > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid #1e293b', paddingTop: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#cbd5e1', letterSpacing: 0.5 }}>
              PRE-TRADE VALIDATION
              <span style={{ color: '#64748b', fontWeight: 400, marginLeft: 8 }}>— is this a good idea, given your intent?</span>
            </div>

            {/* Intent inputs */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 11, color: '#94a3b8', alignItems: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                Purpose
                <select value={intentPurpose} onChange={e => setIntentPurpose(e.target.value as PretradeTradePurpose)}
                  style={{ background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, padding: '3px 6px', fontSize: 11 }}>
                  <option value="income">Income</option>
                  <option value="ownership">Ownership (wheel)</option>
                  <option value="directional">Directional</option>
                  <option value="hedge">Hedge</option>
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                Happy to own at strike?
                <select value={intentHappyToOwn} onChange={e => setIntentHappyToOwn(e.target.value as 'yes' | 'no' | 'na')}
                  style={{ background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, padding: '3px 6px', fontSize: 11 }}>
                  <option value="na">N/A</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input type="checkbox" checked={intentMultiQuarter} onChange={e => setIntentMultiQuarter(e.target.checked)} />
                Multi-quarter thesis
              </label>
            </div>

            <button
              onClick={() => handleValidate(false)}
              disabled={validateLoading}
              style={{
                padding: '8px 16px', fontSize: 13, fontWeight: 600, borderRadius: 5,
                cursor: validateLoading ? 'default' : 'pointer',
                background: validateLoading ? '#1e293b' : '#0e7490',
                color: validateLoading ? '#64748b' : '#fff',
                border: '1px solid #334155',
                display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center',
              }}
            >
              {validateLoading
                ? <><span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span> Validating…</>
                : <><span>✓</span> {validation ? 'Re-validate' : 'Validate Trade'}</>}
            </button>

            {validation && !validateLoading && (() => {
              const vColors: Record<string, string> = { good: '#22c55e', caution: '#f97316', bad: '#ef4444' };
              const vLabel: Record<string, string> = { good: 'GOOD IDEA', caution: 'CAUTION', bad: 'BAD IDEA' };
              const sColors: Record<string, string> = { pass: '#22c55e', warn: '#f97316', fail: '#ef4444', info: '#94a3b8' };
              const sIcon: Record<string, string> = { pass: '✓', warn: '!', fail: '✕', info: 'i' };
              const vc = vColors[validation.verdict] ?? '#94a3b8';
              return (
                <div style={{ background: '#0f172a', border: `1px solid ${vc}44`, borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{ padding: '10px 14px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: vc }}>{vLabel[validation.verdict]}</span>
                    {validation.context.ivRank != null && (
                      <span style={{ fontSize: 10, color: '#64748b' }}>IV rank {validation.context.ivRank.toFixed(0)}%</span>)}
                    {validation.context.directionBias && (
                      <span style={{ fontSize: 10, color: '#64748b' }}>trend {validation.context.directionBias}</span>)}
                    {validation.fromCache && (
                      <span style={{ fontSize: 10, color: '#64748b' }} title="Lab data from cache">cached</span>)}
                  </div>
                  <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {validation.checks.map((c, i) => (
                      <div key={i} style={{ display: 'flex', gap: 8, fontSize: 11, lineHeight: 1.45 }}>
                        <span style={{ color: sColors[c.status], fontWeight: 700, minWidth: 12 }}>{sIcon[c.status]}</span>
                        <span><span style={{ color: '#e2e8f0', fontWeight: 600 }}>{c.title}.</span> <span style={{ color: '#94a3b8' }}>{c.detail}</span></span>
                      </div>
                    ))}
                  </div>
                  {validation.suggestion && (
                    <div style={{ padding: '10px 14px', borderTop: '1px solid #1e293b', background: '#0c1425' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: validation.suggestion.sameAsCurrent ? '#94a3b8' : '#38bdf8' }}>
                          {validation.suggestion.sameAsCurrent ? 'LAB: NO BETTER ALTERNATIVE' : 'LAB SUGGESTS INSTEAD'}
                        </span>
                        {ticker.trim() && (
                          <button
                            onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-strategyLab', {
                              detail: { ticker: ticker.trim().toUpperCase(), slug: validation.suggestion?.slug },
                            }))}
                            title="Open this structure in the Strategy Lab"
                            style={{ padding: '2px 8px', fontSize: 9, fontWeight: 600, borderRadius: 4, cursor: 'pointer', background: '#0e7490', color: '#fff', border: '1px solid #334155' }}>
                            Open in Lab →
                          </button>
                        )}
                      </div>
                      {validation.suggestion.sameAsCurrent && (
                        <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 3, fontStyle: 'italic' }}>
                          The lab has no higher-graded structure than the one you&apos;re evaluating — shown for context.
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: '#cbd5e1' }}>{validation.suggestion.name} (grade {validation.suggestion.grade})</div>
                      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 3 }}>
                        {validation.suggestion.legs.map(l => `${l.action} ${l.side} $${l.strike}`).join(' · ')}
                      </div>
                      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 3 }}>{validation.suggestion.rationale}</div>
                      <button onClick={() => handleValidate(true)}
                        style={{ marginTop: 6, padding: '3px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1e293b', color: '#94a3b8', border: '1px solid #334155' }}>
                        ⟳ Refresh with live chain
                      </button>
                    </div>
                  )}
                  <div style={{ padding: '6px 14px', borderTop: '1px solid #1e293b', fontSize: 9, color: '#475569' }}>
                    Decision-support only — not a recommendation to trade. Thresholds are first-pass and tunable.
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════════
            AI TRADE ASSESSMENT
        ════════════════════════════════════════════════════════════════════ */}
        {legs.length > 0 && spotNum > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Assess button */}
            <button
              onClick={handleAssess}
              disabled={assessLoading}
              style={{
                padding: '8px 16px', fontSize: 13, fontWeight: 600, borderRadius: 5,
                cursor: assessLoading ? 'default' : 'pointer',
                background: assessLoading ? '#1e293b' : '#1d4ed8',
                color: assessLoading ? '#64748b' : '#fff',
                border: '1px solid #334155',
                display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center',
              }}
            >
              {assessLoading
                ? <><span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span> Analysing…</>
                : <><span>⚡</span> {assessment ? 'Re-assess Trade' : 'Assess Trade'}</>
              }
            </button>

            {/* Thinking progress */}
            {assessLoading && assessThinking && (
              <div style={{ background: '#0c1425', border: '1px solid #1e3a5f', borderRadius: 6, padding: '8px 10px' }}>
                <div style={{ fontSize: 10, color: '#3b82f6', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#3b82f6', animation: 'pulse 1s ease-in-out infinite' }} />
                  Claude is thinking…
                </div>
                <div
                  ref={thinkingRef}
                  style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace', maxHeight: 120, overflowY: 'auto', lineHeight: 1.5 }}
                >
                  {assessThinking}
                </div>
              </div>
            )}

            {/* Assessment results */}
            {assessment && !assessLoading && (() => {
              const ratingColors: Record<string, string> = {
                excellent: '#22c55e', good: '#86efac', neutral: '#94a3b8',
                caution: '#f97316', avoid: '#ef4444',
              };
              const rc = ratingColors[assessment.rating] ?? '#94a3b8';
              return (
                <div style={{ background: '#0f172a', border: `1px solid ${rc}33`, borderRadius: 8, overflow: 'hidden' }}>
                  {/* Header */}
                  <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{
                      padding: '3px 12px', borderRadius: 12, fontSize: 12, fontWeight: 700,
                      background: rc + '22', color: rc, border: `1px solid ${rc}55`,
                      textTransform: 'uppercase', letterSpacing: 0.5,
                    }}>
                      {assessment.rating}
                    </span>
                    <span style={{ fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>{assessment.strategyName}</span>
                    {assessment.probOfProfit && (
                      <span style={{ marginLeft: 'auto', fontSize: 13, color: '#94a3b8' }}>
                        POP: <strong style={{ color: '#fbbf24' }}>{assessment.probOfProfit}</strong>
                      </span>
                    )}
                  </div>
                  <div style={{ padding: '10px 16px', fontSize: 13, color: '#94a3b8', borderBottom: '1px solid #1e293b', fontStyle: 'italic', lineHeight: 1.5 }}>
                    {assessment.ratingReason}
                  </div>

                  {/* Pros / Cons */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid #1e293b' }}>
                    <div style={{ padding: '10px 14px', borderRight: '1px solid #1e293b' }}>
                      <div style={{ fontSize: 11, color: '#22c55e', fontWeight: 700, marginBottom: 7, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        ✓ Pros
                      </div>
                      {assessment.pros.map((p, i) => (
                        <div key={i} style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 5, paddingLeft: 9, borderLeft: '2px solid #22c55e33', lineHeight: 1.45 }}>
                          {p}
                        </div>
                      ))}
                    </div>
                    <div style={{ padding: '10px 14px' }}>
                      <div style={{ fontSize: 11, color: '#ef4444', fontWeight: 700, marginBottom: 7, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        ✗ Cons
                      </div>
                      {assessment.cons.map((c, i) => (
                        <div key={i} style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 5, paddingLeft: 9, borderLeft: '2px solid #ef444433', lineHeight: 1.45 }}>
                          {c}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Ideal market + Key risks */}
                  <div style={{ padding: '10px 16px', borderBottom: '1px solid #1e293b', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Ideal market</div>
                      <div style={{ fontSize: 13, color: '#e2e8f0', lineHeight: 1.5 }}>{assessment.idealMarket}</div>
                    </div>
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <div style={{ fontSize: 11, color: '#f97316', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Key risks</div>
                      {assessment.keyRisks.map((r, i) => (
                        <div key={i} style={{ fontSize: 13, color: '#fca5a5', marginBottom: 3, lineHeight: 1.45 }}>• {r}</div>
                      ))}
                    </div>
                  </div>

                  {/* Exit strategy — 3 scenarios */}
                  <div style={{ padding: '12px 16px' }}>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      Recommended exit strategy
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                      {/* Close All */}
                      <div style={{ background: '#1e293b', borderRadius: 6, padding: '10px 12px', border: '1px solid #334155' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span>⏹</span> Close All
                        </div>
                        <div style={{ fontSize: 13, color: '#fbbf24', marginBottom: 5, fontWeight: 600, lineHeight: 1.4 }}>
                          {assessment.exit.closeAll.trigger}
                        </div>
                        <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.5 }}>
                          {assessment.exit.closeAll.details}
                        </div>
                      </div>

                      {/* Bullish */}
                      <div style={{ background: '#0c2010', borderRadius: 6, padding: '10px 12px', border: '1px solid #22c55e33' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#22c55e', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span>↑</span> Bullish trend
                        </div>
                        <div style={{ fontSize: 13, color: '#86efac', marginBottom: 5, fontWeight: 600, lineHeight: 1.4 }}>
                          {assessment.exit.bullish.trigger}
                        </div>
                        <div style={{ fontSize: 13, color: '#4ade80', marginBottom: 5, lineHeight: 1.5 }}>
                          <strong>Exit first:</strong> {assessment.exit.bullish.exitFirst}
                        </div>
                        <div style={{ fontSize: 13, color: '#86efac', lineHeight: 1.5 }}>
                          <strong>Hold:</strong> {assessment.exit.bullish.holdLast}
                        </div>
                      </div>

                      {/* Bearish */}
                      <div style={{ background: '#200c0c', borderRadius: 6, padding: '10px 12px', border: '1px solid #ef444433' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#ef4444', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span>↓</span> Bearish trend
                        </div>
                        <div style={{ fontSize: 13, color: '#fca5a5', marginBottom: 5, fontWeight: 600, lineHeight: 1.4 }}>
                          {assessment.exit.bearish.trigger}
                        </div>
                        <div style={{ fontSize: 13, color: '#f87171', marginBottom: 5, lineHeight: 1.5 }}>
                          <strong>Exit first:</strong> {assessment.exit.bearish.exitFirst}
                        </div>
                        <div style={{ fontSize: 13, color: '#fca5a5', lineHeight: 1.5 }}>
                          <strong>Hold:</strong> {assessment.exit.bearish.holdLast}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

      </main>

      {/* ════════════════════════════════════════════════════════════════════
          OPTIONS CHAIN DRAWER — expandable panel anchored to bottom of right panel
          ▲ expands to 70 vh   ▼ collapses to compact 220 px strip
      ════════════════════════════════════════════════════════════════════ */}
      {showChain && (
        <div style={{
          flexShrink: 0,
          height: chainExpanded ? '45vh' : 44,
          transition: 'height 0.22s ease',
          borderTop: '2px solid #1e293b',
          background: '#0f172a',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>

          {/* ── Title bar — fixed 44 px, always fully visible ── */}
          <div style={{
            height: 44, flexShrink: 0,
            padding: '0 12px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            borderBottom: '1px solid #1e293b',
          }}>
            <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600 }}>Options Chain</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {chainExpanded && (
                <button
                  onClick={() => setChainStrikeFilter(f => f === 'atm' ? 'all' : 'atm')}
                  style={{ padding: '3px 8px', fontSize: 10, borderRadius: 3, cursor: 'pointer', background: '#1e293b', border: '1px solid #334155', color: '#94a3b8' }}
                >
                  {chainStrikeFilter === 'atm' ? 'Show all strikes' : 'ATM ±10%'}
                </button>
              )}
              <button
                onClick={() => setChainExpanded(e => !e)}
                title={chainExpanded ? 'Minimize chain panel' : 'Expand chain panel'}
                style={{ padding: '3px 10px', fontSize: 13, lineHeight: 1, borderRadius: 3, cursor: 'pointer', background: '#1e293b', border: '1px solid #334155', color: '#94a3b8' }}
              >
                {chainExpanded ? '▼' : '▲'}
              </button>
            </div>
          </div>

          {/* ── Expiry tabs — only rendered when expanded ── */}
          {chainExpanded && (
            <div style={{ padding: '6px 12px', borderBottom: '1px solid #1e293b', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
              {chainExpirations.map(exp => (
                <button
                  key={exp.date}
                  onClick={() => { setSelectedExpiry(exp.date); loadChainForExpiry(exp.date); }}
                  style={{
                    padding: '3px 8px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
                    background: selectedExpiry === exp.date ? '#1d4ed8' : '#1e293b',
                    color: selectedExpiry === exp.date ? '#fff' : '#94a3b8',
                    border: `1px solid ${selectedExpiry === exp.date ? '#3b82f6' : '#334155'}`,
                  }}
                >
                  {exp.date.slice(5)} <span style={{ color: '#64748b', fontSize: 9 }}>({exp.dte}d)</span>
                </button>
              ))}
            </div>
          )}

          {/* ── Chain table — fills remaining panel height (only when expanded) ── */}
          {chainExpanded && (chainLoading ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: 12 }}>
              Loading chain…
            </div>
          ) : !chainData ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: 12 }}>
              No data — chain failed to load.
            </div>
          ) : chainData.contracts.length === 0 ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, color: '#475569', fontSize: 12, padding: 16, textAlign: 'center' }}>
              <span>No contracts returned for this expiry.</span>
              <span style={{ fontSize: 11, color: '#334155' }}>
                Try a different expiry, or click &quot;Show all strikes&quot; to remove the ATM filter.
              </span>
            </div>
          ) : (
            <div style={{ flex: 1, overflowX: 'auto', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ position: 'sticky', top: 0, background: '#0f172a', zIndex: 1 }}>
                    <th colSpan={6} style={{ padding: '5px 8px', textAlign: 'center', color: '#22c55e', borderBottom: '1px solid #1e293b', borderRight: '1px solid #1e293b', fontSize: 10 }}>CALLS</th>
                    <th style={{ padding: '5px 8px', textAlign: 'center', color: '#fbbf24', borderBottom: '1px solid #1e293b', fontWeight: 700, fontSize: 12 }}>Strike</th>
                    <th colSpan={6} style={{ padding: '5px 8px', textAlign: 'center', color: '#ef4444', borderBottom: '1px solid #1e293b', borderLeft: '1px solid #1e293b', fontSize: 10 }}>PUTS</th>
                  </tr>
                  <tr style={{ background: '#0f172a' }}>
                    {(['IV%', 'OI', 'B', 'S', 'Mid', 'Δ'] as const).map(h => (
                      <th key={`c-${h}`} style={{ padding: '4px 6px', color: '#64748b', fontWeight: 400, textAlign: h === 'Mid' || h === 'Δ' || h === 'OI' || h === 'IV%' ? 'right' : 'center', borderBottom: '1px solid #1e293b' }}>{h}</th>
                    ))}
                    <th style={{ padding: '4px 6px', color: '#fbbf24', textAlign: 'center', borderBottom: '1px solid #1e293b' }}></th>
                    {(['Δ', 'Mid', 'B', 'S', 'OI', 'IV%'] as const).map(h => (
                      <th key={`p-${h}`} style={{ padding: '4px 6px', color: '#64748b', fontWeight: 400, textAlign: h === 'Mid' || h === 'Δ' || h === 'OI' || h === 'IV%' ? 'right' : 'center', borderBottom: '1px solid #1e293b' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {chainStrikes.map(strike => {
                    const call = chainData.contracts.find(c => c.strike === strike && c.side === 'call');
                    const put  = chainData.contracts.find(c => c.strike === strike && c.side === 'put');
                    const isAtm = spotNum > 0 && Math.abs(strike / spotNum - 1) < 0.01;

                    const cell = (v: number | null) =>
                      v != null ? (Math.abs(v) < 0.01 ? v.toFixed(4) : v.toFixed(2)) : '—';

                    // Spread quality: color mid by spread-pct to flag illiquid options.
                    // spread% = (ask - bid) / mid. <10% green, 10-30% yellow, >30% red.
                    const midColor = (bid: number, ask: number, baseColor: string) => {
                      const mid = (bid + ask) / 2;
                      if (mid <= 0) return baseColor;
                      const spreadPct = (ask - bid) / mid * 100;
                      if (spreadPct > 30) return '#ef4444';   // red  — wide, illiquid
                      if (spreadPct > 10) return '#f59e0b';   // amber — moderate spread
                      return baseColor;                        // original color — tight
                    };
                    const midTitle = (bid: number, ask: number) => {
                      const mid = (bid + ask) / 2;
                      const spread = ask - bid;
                      const spreadPct = mid > 0 ? (spread / mid * 100).toFixed(0) : '—';
                      return `Bid $${bid.toFixed(2)}  Ask $${ask.toFixed(2)}  Spread $${spread.toFixed(2)} (${spreadPct}%)`;
                    };

                    return (
                      <tr key={strike} style={{ background: isAtm ? '#0f2d4a' : 'transparent' }}>
                        {/* Call IV% */}
                        <td style={{ padding: '3px 6px', textAlign: 'right', fontSize: 10,
                          color: call == null ? '#475569'
                            : call.iv * 100 >= 50 ? '#ef4444'
                            : call.iv * 100 >= 30 ? '#f59e0b'
                            : '#64748b' }}>
                          {call != null ? `${(call.iv * 100).toFixed(1)}%` : '—'}
                        </td>
                        {/* Call OI */}
                        <td style={{ padding: '3px 6px', textAlign: 'right', color: '#475569', fontSize: 10 }}>
                          {call?.openInterest != null ? call.openInterest.toLocaleString() : '—'}
                        </td>
                        {/* Call: Buy + Sell buttons */}
                        <td style={{ padding: '3px 5px', textAlign: 'center' }}>
                          {call && (
                            <button onClick={() => addLegFromContract(call, 'buy', 'call', selectedExpiry)}
                              style={{ fontSize: 9, padding: '1px 5px', background: '#14532d', color: '#86efac', border: 'none', borderRadius: 2, cursor: 'pointer' }}>
                              B
                            </button>
                          )}
                        </td>
                        <td style={{ padding: '3px 5px', textAlign: 'center' }}>
                          {call && (
                            <button onClick={() => addLegFromContract(call, 'sell', 'call', selectedExpiry)}
                              style={{ fontSize: 9, padding: '1px 5px', background: '#7c2d12', color: '#fdba74', border: 'none', borderRadius: 2, cursor: 'pointer' }}>
                              S
                            </button>
                          )}
                        </td>
                        <td style={{ padding: '3px 6px', textAlign: 'right', color: call ? midColor(call.bid, call.ask, '#22c55e') : '#22c55e' }}
                            title={call ? midTitle(call.bid, call.ask) : undefined}>
                          {call ? cell((call.bid + call.ask) / 2) : '—'}
                        </td>
                        <td style={{ padding: '3px 6px', textAlign: 'right', color: '#64748b' }}>
                          {call?.delta != null ? call.delta.toFixed(2) : '—'}
                        </td>

                        {/* Strike */}
                        <td style={{ padding: '3px 8px', textAlign: 'center', fontWeight: 700, color: isAtm ? '#fbbf24' : '#e2e8f0', borderLeft: '1px solid #1e293b', borderRight: '1px solid #1e293b' }}>
                          {strike}
                        </td>

                        {/* Put: Delta + Mid + Buy + Sell */}
                        <td style={{ padding: '3px 6px', textAlign: 'right', color: '#64748b' }}>
                          {put?.delta != null ? put.delta.toFixed(2) : '—'}
                        </td>
                        <td style={{ padding: '3px 6px', textAlign: 'right', color: put ? midColor(put.bid, put.ask, '#ef4444') : '#ef4444' }}
                            title={put ? midTitle(put.bid, put.ask) : undefined}>
                          {put ? cell((put.bid + put.ask) / 2) : '—'}
                        </td>
                        <td style={{ padding: '3px 5px', textAlign: 'center' }}>
                          {put && (
                            <button onClick={() => addLegFromContract(put, 'buy', 'put', selectedExpiry)}
                              style={{ fontSize: 9, padding: '1px 5px', background: '#14532d', color: '#86efac', border: 'none', borderRadius: 2, cursor: 'pointer' }}>
                              B
                            </button>
                          )}
                        </td>
                        <td style={{ padding: '3px 5px', textAlign: 'center' }}>
                          {put && (
                            <button onClick={() => addLegFromContract(put, 'sell', 'put', selectedExpiry)}
                              style={{ fontSize: 9, padding: '1px 5px', background: '#7c2d12', color: '#fdba74', border: 'none', borderRadius: 2, cursor: 'pointer' }}>
                              S
                            </button>
                          )}
                        </td>
                        {/* Put OI */}
                        <td style={{ padding: '3px 6px', textAlign: 'right', color: '#475569', fontSize: 10 }}>
                          {put?.openInterest != null ? put.openInterest.toLocaleString() : '—'}
                        </td>
                        {/* Put IV% */}
                        <td style={{ padding: '3px 6px', textAlign: 'right', fontSize: 10,
                          color: put == null ? '#475569'
                            : put.iv * 100 >= 50 ? '#ef4444'
                            : put.iv * 100 >= 30 ? '#f59e0b'
                            : '#64748b' }}>
                          {put != null ? `${(put.iv * 100).toFixed(1)}%` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}

        </div>
      )}
      </div>
    </div>
  );
}
