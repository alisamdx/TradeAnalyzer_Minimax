// PayoffView — Multi-leg strategy payoff visualizer.
// Builds an at-expiration P&L diagram from user-defined legs.
// Supports CSP, CC, Collar, Bull/Bear spreads, and arbitrary combos.
// Chain integration loads live strikes + mid-prices + Greeks from the IPC layer.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  PayoffLeg,
  SavedPayoffStrategy,
  PayoffAssessInput,
  PayoffAssessment,
  OptionsChainExpirationSummary,
  OptionsChainViewData,
  OptionContract,
  Watchlist,
  WatchlistItem,
} from '@shared/types.js';

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

  // Detect unlimited by checking slope at the boundaries
  const rSlope = (pnls[N - 1]! - pnls[N - 6]!);   // change over last 5 pts
  const lSlope = (pnls[5]! - pnls[0]!);             // change over first 5 pts
  const slopeThreshold = spot * 0.5;                // $0.50 per point roughly

  // Right boundary still moving → could be unlimited
  const unlimitedProfit = rSlope > slopeThreshold || lSlope < -slopeThreshold;
  const unlimitedLoss   = rSlope < -slopeThreshold || lSlope > slopeThreshold;

  const maxPnl = Math.max(...pnls);
  const minPnl = Math.min(...pnls);

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

// ─── Template definitions ─────────────────────────────────────────────────────

interface Template { label: string; icon: string; build: (spot: number) => PayoffLeg[] }

const TEMPLATES: Template[] = [
  {
    label: 'CSP',
    icon: '↓',
    build: spot => [{
      id: genId(), side: 'sell', type: 'put',
      strike: roundHalf(spot * 0.95), expiry: addDays(45),
      premium: 0, quantity: 1, delta: -0.30, theta: null, vega: null, iv: null,
      label: `Sell Put $${roundHalf(spot * 0.95)}`,
    }],
  },
  {
    label: 'Covered Call',
    icon: '↗',
    build: spot => [
      { id: genId(), side: 'buy', type: 'stock', strike: 0, expiry: addDays(0), premium: spot, quantity: 1, delta: null, theta: null, vega: null, iv: null, label: 'Long 100 shares' },
      { id: genId(), side: 'sell', type: 'call', strike: roundHalf(spot * 1.05), expiry: addDays(30), premium: 0, quantity: 1, delta: 0.25, theta: null, vega: null, iv: null, label: `Sell Call $${roundHalf(spot * 1.05)}` },
    ],
  },
  {
    label: 'Collar',
    icon: '⇅',
    build: spot => [
      { id: genId(), side: 'buy', type: 'stock', strike: 0, expiry: addDays(0), premium: spot, quantity: 1, delta: null, theta: null, vega: null, iv: null, label: 'Long 100 shares' },
      { id: genId(), side: 'buy', type: 'put', strike: roundHalf(spot * 0.95), expiry: addDays(45), premium: 0, quantity: 1, delta: -0.25, theta: null, vega: null, iv: null, label: `Buy Put $${roundHalf(spot * 0.95)}` },
      { id: genId(), side: 'sell', type: 'call', strike: roundHalf(spot * 1.05), expiry: addDays(45), premium: 0, quantity: 1, delta: 0.25, theta: null, vega: null, iv: null, label: `Sell Call $${roundHalf(spot * 1.05)}` },
    ],
  },
  {
    label: 'Bull Call Spread',
    icon: '↑',
    build: spot => [
      { id: genId(), side: 'buy', type: 'call', strike: Math.round(spot), expiry: addDays(45), premium: 0, quantity: 1, delta: 0.50, theta: null, vega: null, iv: null, label: `Buy Call $${Math.round(spot)}` },
      { id: genId(), side: 'sell', type: 'call', strike: roundHalf(spot * 1.05), expiry: addDays(45), premium: 0, quantity: 1, delta: 0.25, theta: null, vega: null, iv: null, label: `Sell Call $${roundHalf(spot * 1.05)}` },
    ],
  },
  {
    label: 'Bear Put Spread',
    icon: '↓',
    build: spot => [
      { id: genId(), side: 'buy', type: 'put', strike: Math.round(spot), expiry: addDays(45), premium: 0, quantity: 1, delta: -0.50, theta: null, vega: null, iv: null, label: `Buy Put $${Math.round(spot)}` },
      { id: genId(), side: 'sell', type: 'put', strike: roundHalf(spot * 0.95), expiry: addDays(45), premium: 0, quantity: 1, delta: -0.25, theta: null, vega: null, iv: null, label: `Sell Put $${roundHalf(spot * 0.95)}` },
    ],
  },
];

// ─── InfoTip tooltip (portal-based — renders at document.body to avoid clipping) ──

interface TooltipState { top: number; left: number }

function InfoTip({ text }: { text: string }) {
  const [pos, setPos] = useState<TooltipState | null>(null);
  const btnRef = useRef<HTMLSpanElement>(null);

  const open = () => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.top, left: r.left + r.width / 2 });
  };

  const close = () => setPos(null);

  return (
    <span style={{ display: 'inline-flex', verticalAlign: 'middle' }}>
      <span
        ref={btnRef}
        onMouseEnter={open}
        onMouseLeave={close}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 14, height: 14, borderRadius: '50%',
          background: '#334155', color: '#94a3b8',
          fontSize: 9, fontWeight: 700, cursor: 'help', marginLeft: 4, flexShrink: 0,
          lineHeight: 1,
        }}
      >?</span>
      {pos && createPortal(
        <div style={{
          position: 'fixed',
          bottom: `calc(100vh - ${pos.top}px + 6px)`,
          left: pos.left,
          transform: 'translateX(-50%)',
          zIndex: 99999,
          background: '#1e293b',
          border: '1px solid #475569',
          borderRadius: 6,
          padding: '9px 11px',
          fontSize: 11,
          color: '#cbd5e1',
          lineHeight: 1.55,
          maxWidth: 280,
          width: 'max-content',
          boxShadow: '0 6px 18px rgba(0,0,0,0.6)',
          pointerEvents: 'none',
          whiteSpace: 'pre-line',
        }}>
          {text}
        </div>,
        document.body,
      )}
    </span>
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

  const opts      = legs.filter(l => l.type !== 'stock');
  const stocks    = legs.filter(l => l.type === 'stock');
  const puts      = opts.filter(l => l.type === 'put').sort((a, b) => a.strike - b.strike);
  const calls     = opts.filter(l => l.type === 'call').sort((a, b) => a.strike - b.strike);
  const sellPuts  = puts.filter(l => l.side === 'sell');
  const buyPuts   = puts.filter(l => l.side === 'buy');
  const sellCalls = calls.filter(l => l.side === 'sell');
  const buyCalls  = calls.filter(l => l.side === 'buy');
  const longStock = stocks.filter(l => l.side === 'buy');

  // ── Single leg ────────────────────────────────────────────────────────────────
  if (legs.length === 1) {
    const l = legs[0]!;
    if (l.side === 'sell' && l.type === 'put')
      return { name: 'Cash-Secured Put', description: 'Collect premium; buy stock at strike if assigned', color: '#22c55e' };
    if (l.side === 'sell' && l.type === 'call')
      return { name: 'Naked Call', description: '⚠ Unlimited upside risk — requires margin', color: '#ef4444' };
    if (l.side === 'buy' && l.type === 'call')
      return { name: 'Long Call', description: 'Bullish; profit above breakeven, risk = premium paid', color: '#3b82f6' };
    if (l.side === 'buy' && l.type === 'put')
      return { name: 'Long Put', description: 'Bearish; profit below breakeven, risk = premium paid', color: '#f97316' };
    if (l.type === 'stock')
      return { name: l.side === 'buy' ? 'Long Stock' : 'Short Stock', description: 'Directional equity position', color: '#94a3b8' };
  }

  // ── Covered Call: long stock + sell call ──────────────────────────────────────
  if (longStock.length === 1 && sellCalls.length === 1 && opts.length === 1)
    return { name: 'Covered Call', description: 'Capped upside; premium reduces effective cost basis', color: '#22c55e' };

  // ── Protective Put: long stock + buy put ──────────────────────────────────────
  if (longStock.length === 1 && buyPuts.length === 1 && opts.length === 1)
    return { name: 'Protective Put', description: 'Stock with a floor; unlimited upside, limited downside', color: '#3b82f6' };

  // ── Collar: long stock + buy put + sell call ──────────────────────────────────
  if (longStock.length === 1 && buyPuts.length === 1 && sellCalls.length === 1 && opts.length === 2)
    return { name: 'Collar', description: 'Protected between put (floor) and call (cap)', color: '#8b5cf6' };

  // ── Two-leg option strategies ─────────────────────────────────────────────────
  if (stocks.length === 0 && opts.length === 2) {
    // Bull Call Spread / Bear Call Spread
    if (buyCalls.length === 1 && sellCalls.length === 1 && puts.length === 0) {
      const b = buyCalls[0]!, s = sellCalls[0]!;
      return b.strike < s.strike
        ? { name: 'Bull Call Spread', description: 'Defined-risk bullish; max profit at or above short call', color: '#22c55e' }
        : { name: 'Bear Call Spread',  description: 'Credit spread; profit if stock stays below long call',   color: '#f97316' };
    }
    // Bear Put Spread / Bull Put Spread
    if (buyPuts.length === 1 && sellPuts.length === 1 && calls.length === 0) {
      const b = buyPuts[0]!, s = sellPuts[0]!;
      return b.strike > s.strike
        ? { name: 'Bear Put Spread', description: 'Defined-risk bearish; max profit at or below short put', color: '#ef4444' }
        : { name: 'Bull Put Spread', description: 'Credit spread; profit if stock stays above short put',   color: '#22c55e' };
    }
    // Short Straddle / Strangle
    if (sellPuts.length === 1 && sellCalls.length === 1 && buyPuts.length === 0 && buyCalls.length === 0) {
      const p = sellPuts[0]!, c = sellCalls[0]!;
      return p.strike === c.strike
        ? { name: 'Short Straddle', description: 'Profit in tight range; ATM short put + call', color: '#f97316' }
        : { name: 'Short Strangle', description: 'Profit if stock stays between strikes', color: '#f97316' };
    }
    // Long Straddle / Strangle
    if (buyPuts.length === 1 && buyCalls.length === 1 && sellPuts.length === 0 && sellCalls.length === 0) {
      const p = buyPuts[0]!, c = buyCalls[0]!;
      return p.strike === c.strike
        ? { name: 'Long Straddle', description: 'Profit on large move either direction', color: '#3b82f6' }
        : { name: 'Long Strangle', description: 'Profit on large move; lower cost than straddle', color: '#3b82f6' };
    }
  }

  // ── Four-leg strategies ───────────────────────────────────────────────────────
  if (stocks.length === 0 && buyPuts.length === 1 && sellPuts.length === 1
      && buyCalls.length === 1 && sellCalls.length === 1) {
    const bp = buyPuts[0]!, sp = sellPuts[0]!, sc = sellCalls[0]!, bc = buyCalls[0]!;
    if (bp.strike < sp.strike && sp.strike <= sc.strike && sc.strike < bc.strike) {
      return sp.strike === sc.strike
        ? { name: 'Iron Butterfly', description: 'Max profit at middle strike; defined risk both sides', color: '#8b5cf6' }
        : { name: 'Iron Condor',    description: 'Profit if stock stays between short strikes; defined risk', color: '#8b5cf6' };
    }
  }

  // ── Partial / building state ──────────────────────────────────────────────────
  if (sellPuts.length >= 1 && opts.length < 4)
    return { name: 'Building…', description: `${sellPuts.length} short put${sellPuts.length > 1 ? 's' : ''} — add more legs to complete the strategy`, color: '#64748b', partial: true };
  if (sellCalls.length >= 1 && opts.length < 4)
    return { name: 'Building…', description: `${sellCalls.length} short call${sellCalls.length > 1 ? 's' : ''} — add more legs`, color: '#64748b', partial: true };

  // ── Generic fallback ──────────────────────────────────────────────────────────
  const netPrem = legs.reduce((s, l) => s + (l.side === 'sell' ? 1 : -1) * l.premium, 0);
  return {
    name: 'Custom Strategy',
    description: netPrem >= 0 ? 'Net credit spread' : 'Net debit spread',
    color: '#94a3b8',
  };
}

// ─── Payoff SVG chart ─────────────────────────────────────────────────────────

const PAD = { t: 18, r: 24, b: 30, l: 56 };
const SVG_W = 560;
const SVG_H = 160;
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

  return (
    <svg
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      style={{ width: '100%', display: 'block' }}
      aria-label="Payoff diagram"
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

  const [editingPrem, setEditingPrem] = useState(false);
  const [editingQty,  setEditingQty]  = useState(false);
  const [premStr, setPremStr]         = useState(String(leg.premium));
  const [qtyStr,  setQtyStr]          = useState(String(leg.quantity));

  // Keep local strings in sync when leg prop changes (e.g. chain reload)
  const prevPremRef = { current: leg.premium };
  if (!editingPrem && leg.premium !== prevPremRef.current) setPremStr(String(leg.premium));

  const commitPrem = () => {
    const v = parseFloat(premStr);
    if (!isNaN(v) && v >= 0) onUpdate({ premium: v });
    else setPremStr(String(leg.premium));   // revert on bad input
    setEditingPrem(false);
  };

  const commitQty = () => {
    const v = parseInt(qtyStr);
    if (!isNaN(v) && v >= 1) onUpdate({ quantity: v });
    else setQtyStr(String(leg.quantity));
    setEditingQty(false);
  };

  const typeLabel = leg.type === 'stock' ? '100 shares'
    : `${leg.type.toUpperCase()} $${leg.strike}`;

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
            {typeLabel}
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
}

export function PayoffView({ initialTicker, initialSpot, initialExpiry, initialStrategy, initialStrike }: PayoffViewProps) {
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

  // UI state
  const [error, setError]     = useState<string | null>(null);
  const [statusMsg, setStatus] = useState<string | null>(null);

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

  // ── Opportunity navigation: auto-load chain + pre-add leg(s) on mount ────────
  useEffect(() => {
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

  // ── Template application ────────────────────────────────────────────────────
  const applyTemplate = useCallback((tpl: Template) => {
    if (!spotNum) { setError('Enter a spot price first'); return; }
    setLegs(tpl.build(spotNum));
    setError(null);
  }, [spotNum]);

  // ── Leg mutation helpers ────────────────────────────────────────────────────
  const removeLeg = (id: string) => setLegs(prev => prev.filter(l => l.id !== id));

  const toggleSide = (id: string) =>
    setLegs(prev => prev.map(l =>
      l.id === id ? { ...l, side: l.side === 'buy' ? 'sell' : 'buy' } : l
    ));

  const updateLeg = (id: string, patch: Partial<PayoffLeg>) =>
    setLegs(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l));

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

        {/* ── Quick templates ── */}
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 1 }}>Templates</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {TEMPLATES.map(tpl => (
              <button
                key={tpl.label}
                onClick={() => applyTemplate(tpl)}
                title={`Build ${tpl.label} from current spot`}
                style={{
                  padding: '4px 8px', fontSize: 11, borderRadius: 4,
                  background: '#1e293b', border: '1px solid #334155',
                  color: '#cbd5e1', cursor: 'pointer',
                }}
              >
                {tpl.icon} {tpl.label}
              </button>
            ))}
          </div>
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

        {/* ── Strategy recognition badge ── */}
        {recognizedStrategy && (
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

        {/* ── Chart ── */}
        {metrics && (
          <>
            <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '6px 8px 2px' }}>
              <PayoffChart metrics={metrics} spot={spotNum} />
            </div>

            {/* ── Metrics row ── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {([
                {
                  label: 'Max Profit',
                  tip: 'Highest P&L at expiration, simulated across 200 price points (50%–155% of spot).\n\n• Short options: total premium collected × qty × 100\n• Spreads: capped at strike width − net debit\n• Long calls/stock: shown as ∞ (payoff rises indefinitely)\n\nFormula: max(pnl[i]) across simulated prices',
                  value: fmtMetric(metrics.maxProfit, metrics.unlimitedProfit),
                  color: '#22c55e',
                },
                {
                  label: 'Max Loss',
                  tip: 'Worst P&L at expiration across the same 200 simulated price points.\n\n• Long options: limited to premium paid × qty × 100\n• Short naked options: shown as ∞\n• Short puts: (strike − premium) × qty × 100\n\nFormula: min(pnl[i]) across simulated prices',
                  value: fmtMetric(metrics.maxLoss, metrics.unlimitedLoss),
                  color: '#ef4444',
                },
                {
                  label: metrics.breakevenPrices.length > 1 ? `Breakeven ×${metrics.breakevenPrices.length}` : 'Breakeven',
                  tip: 'Stock price(s) at expiration where total P&L = $0.\n\nDetected by linear interpolation wherever the payoff curve crosses the zero line. Complex strategies (straddles, condors, collars) have two breakevens.\n\nCSP example: strike − net premium received\nLong call: strike + premium paid',
                  value: metrics.breakevenPrices.length === 0
                    ? '—'
                    : metrics.breakevenPrices.map(p => fmtPrice(p)).join(' / '),
                  color: '#fbbf24',
                },
                {
                  label: metrics.netPremium >= 0 ? 'Net Credit' : 'Net Debit',
                  tip: 'Total premium cash flow for the position.\n\n• Net Credit (positive): you received more than you paid — the credit is your buffer before a loss begins\n• Net Debit (negative): you paid net — the stock must move in your favour to profit\n\nFormula: Σ (sell: +premium, buy: −premium) × qty × 100',
                  value: fmtDollar(Math.abs(metrics.netPremium)),
                  color: metrics.netPremium >= 0 ? '#22c55e' : '#f97316',
                },
              ] as Array<{ label: string; tip: string; value: string; color: string }>).map(m => (
                <div key={m.label} style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, padding: '8px 10px' }}>
                  <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3, display: 'flex', alignItems: 'center' }}>
                    {m.label}<InfoTip text={m.tip} />
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: m.color }}>{m.value}</div>
                </div>
              ))}
            </div>

            {/* ── Net Greeks ── */}
            {(metrics.netDelta != null || metrics.netTheta != null || metrics.netVega != null) && (
              <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, padding: '8px 14px', display: 'flex', gap: 20, fontSize: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ color: '#64748b' }}>Net Greeks</span>
                {metrics.netDelta != null && (
                  <span style={{ display: 'flex', alignItems: 'center' }}>
                    <span style={{ color: '#94a3b8' }}>Δ</span>
                    <InfoTip text={'Position delta — how much total P&L changes per $1 move in the stock.\n\n+1.00 ≈ long 100 shares\n−1.00 ≈ short 100 shares\n 0.00 = delta-neutral\n\nFormula: Σ (buy:+1, sell:−1) × leg.delta × qty\nStock legs contribute ±1 per share × qty.'} />
                    <strong style={{ color: metrics.netDelta > 0 ? '#22c55e' : '#ef4444', marginLeft: 4 }}>
                      {metrics.netDelta >= 0 ? '+' : ''}{metrics.netDelta.toFixed(2)}
                    </strong>
                  </span>
                )}
                {metrics.netTheta != null && (
                  <span style={{ display: 'flex', alignItems: 'center' }}>
                    <span style={{ color: '#94a3b8' }}>Θ</span>
                    <InfoTip text={'Daily time decay for the full position (in dollars/day).\n\nPositive Θ: you collect decay each day (short options — favourable)\nNegative Θ: time erodes your position value (long options)\n\nFormula: Σ (buy:+1, sell:−1) × leg.theta × qty × 100\nScaled by 100 shares per contract.'} />
                    <strong style={{ color: metrics.netTheta > 0 ? '#22c55e' : '#f97316', marginLeft: 4 }}>
                      {metrics.netTheta >= 0 ? '+' : ''}{fmtDollar(metrics.netTheta)}/day
                    </strong>
                  </span>
                )}
                {metrics.netVega != null && (
                  <span style={{ display: 'flex', alignItems: 'center' }}>
                    <span style={{ color: '#94a3b8' }}>V</span>
                    <InfoTip text={'How much the position gains or loses per 1% rise in implied volatility.\n\nPositive Vega: rising IV helps (long options, pre-earnings)\nNegative Vega: rising IV hurts (short options, sellers prefer IV crush)\n\nFormula: Σ (buy:+1, sell:−1) × leg.vega × qty × 100\nScaled by 100 shares per contract.'} />
                    <strong style={{ color: '#94a3b8', marginLeft: 4 }}>
                      {metrics.netVega >= 0 ? '+' : ''}{fmtDollar(metrics.netVega)}/1%IV
                    </strong>
                  </span>
                )}
              </div>
            )}
          </>
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
          height: chainExpanded ? '70vh' : 44,
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
                Try a different expiry, or click "Show all strikes" to remove the ATM filter.
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
