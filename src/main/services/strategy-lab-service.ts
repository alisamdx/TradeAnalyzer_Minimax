/**
 * Strategy Lab service — scores and sets up all 31 tastylive strategies
 * for a single ticker using entirely fresh data (no cache dependencies).
 *
 * Data flow:
 *  1. getHistoricalBars(90d)  → direction bias (20/50d MA)
 *  2. getOptionsExpirations   → nearest 25–45 DTE expiration
 *  3. getOptionsChain         → live strikes, deltas, IV, OI
 *  4. iv_history table        → IV rank / percentile (current IV from chain)
 */

import type { Database } from 'better-sqlite3';
import type { DataProvider, HistoricalBar, OptionContract, OptionsChain } from './data-provider.js';
import type { OptionsProvider } from './options-provider.js';
import type {
  StrategyLabContext,
  StrategyLabDirectionBias,
  StrategyLabValidateResult,
  StrategyScore,
  StrategySetup,
  SetupLeg,
  StrategyLabGrade,
  StrategyLabComplexity,
} from '@shared/types.js';

// ─── Strategy Profile definitions ─────────────────────────────────────────────

interface LegDef {
  side:              'call' | 'put';
  action:            'buy' | 'sell';
  deltaTarget:       number;  // absolute value 0–1
  qty?:              number;  // default 1
  farExpiration?:    boolean; // calendars / PMCC need a second expiry
}

interface StrategyProfile {
  slug:                    string;
  name:                    string;
  category:                string;
  ivPreference:            'high' | 'low' | 'neutral';
  direction:               'bullish' | 'bearish' | 'neutral' | 'neutral-bullish' | 'neutral-bearish' | 'omnidirectional';
  shortPremium:            boolean;
  requiresStock:           boolean;
  complexity:              StrategyLabComplexity;
  legs:                    LegDef[];
}

const PROFILES: StrategyProfile[] = [
  // ── Bullish ──────────────────────────────────────────────────────────────
  { slug: 'covered-call',              name: 'Covered Call',              category: 'bullish',
    ivPreference: 'high',    direction: 'neutral-bullish', shortPremium: true,  requiresStock: true,  complexity: 'simple',
    legs: [{ side: 'call', action: 'sell', deltaTarget: 0.30 }] },

  { slug: 'long-call-vertical',        name: 'Long Call Vertical',        category: 'bullish',
    ivPreference: 'low',     direction: 'bullish',          shortPremium: false, requiresStock: false, complexity: 'simple',
    legs: [{ side: 'call', action: 'buy', deltaTarget: 0.50 }, { side: 'call', action: 'sell', deltaTarget: 0.25 }] },

  { slug: 'call-zebra',                name: 'Call Zebra',                category: 'bullish',
    ivPreference: 'low',     direction: 'bullish',          shortPremium: false, requiresStock: false, complexity: 'complex',
    legs: [{ side: 'call', action: 'buy', deltaTarget: 0.70, qty: 2 }, { side: 'call', action: 'sell', deltaTarget: 0.50, qty: 1 }] },

  { slug: 'poor-mans-covered-call',    name: "Poor Man's Covered Call",   category: 'bullish',
    ivPreference: 'neutral', direction: 'neutral-bullish',  shortPremium: false, requiresStock: false, complexity: 'moderate',
    legs: [{ side: 'call', action: 'buy', deltaTarget: 0.70, farExpiration: true }, { side: 'call', action: 'sell', deltaTarget: 0.30 }] },

  { slug: 'call-calendar',             name: 'Call Calendar',             category: 'bullish',
    ivPreference: 'low',     direction: 'neutral-bullish',  shortPremium: false, requiresStock: false, complexity: 'moderate',
    legs: [{ side: 'call', action: 'sell', deltaTarget: 0.50 }, { side: 'call', action: 'buy', deltaTarget: 0.50, farExpiration: true }] },

  { slug: 'call-butterfly',            name: 'Call Butterfly',            category: 'bullish',
    ivPreference: 'high',    direction: 'neutral-bullish',  shortPremium: true,  requiresStock: false, complexity: 'complex',
    legs: [{ side: 'call', action: 'buy', deltaTarget: 0.40 }, { side: 'call', action: 'sell', deltaTarget: 0.25, qty: 2 }, { side: 'call', action: 'buy', deltaTarget: 0.10 }] },

  { slug: 'big-lizard',                name: 'Big Lizard',                category: 'bullish',
    ivPreference: 'high',    direction: 'neutral-bullish',  shortPremium: true,  requiresStock: false, complexity: 'complex',
    legs: [{ side: 'put', action: 'sell', deltaTarget: 0.50 }, { side: 'call', action: 'sell', deltaTarget: 0.50 }, { side: 'call', action: 'buy', deltaTarget: 0.20 }] },

  // ── Bearish ───────────────────────────────────────────────────────────────
  { slug: 'covered-put',               name: 'Covered Put',               category: 'bearish',
    ivPreference: 'high',    direction: 'neutral-bearish',  shortPremium: true,  requiresStock: true,  complexity: 'simple',
    legs: [{ side: 'put', action: 'sell', deltaTarget: 0.30 }] },

  { slug: 'long-put-vertical',         name: 'Long Put Vertical',         category: 'bearish',
    ivPreference: 'low',     direction: 'bearish',          shortPremium: false, requiresStock: false, complexity: 'simple',
    legs: [{ side: 'put', action: 'buy', deltaTarget: 0.50 }, { side: 'put', action: 'sell', deltaTarget: 0.25 }] },

  { slug: 'put-zebra',                 name: 'Put Zebra',                 category: 'bearish',
    ivPreference: 'low',     direction: 'bearish',          shortPremium: false, requiresStock: false, complexity: 'complex',
    legs: [{ side: 'put', action: 'buy', deltaTarget: 0.70, qty: 2 }, { side: 'put', action: 'sell', deltaTarget: 0.50, qty: 1 }] },

  { slug: 'poor-mans-covered-put',     name: "Poor Man's Covered Put",    category: 'bearish',
    ivPreference: 'neutral', direction: 'neutral-bearish',  shortPremium: false, requiresStock: false, complexity: 'moderate',
    legs: [{ side: 'put', action: 'buy', deltaTarget: 0.70, farExpiration: true }, { side: 'put', action: 'sell', deltaTarget: 0.30 }] },

  { slug: 'put-calendar',              name: 'Put Calendar',              category: 'bearish',
    ivPreference: 'low',     direction: 'neutral-bearish',  shortPremium: false, requiresStock: false, complexity: 'moderate',
    legs: [{ side: 'put', action: 'sell', deltaTarget: 0.50 }, { side: 'put', action: 'buy', deltaTarget: 0.50, farExpiration: true }] },

  { slug: 'put-butterfly',             name: 'Put Butterfly',             category: 'bearish',
    ivPreference: 'high',    direction: 'neutral-bearish',  shortPremium: true,  requiresStock: false, complexity: 'complex',
    legs: [{ side: 'put', action: 'buy', deltaTarget: 0.40 }, { side: 'put', action: 'sell', deltaTarget: 0.25, qty: 2 }, { side: 'put', action: 'buy', deltaTarget: 0.10 }] },

  { slug: 'reverse-big-lizard',        name: 'Reverse Big Lizard',        category: 'bearish',
    ivPreference: 'high',    direction: 'neutral-bearish',  shortPremium: true,  requiresStock: false, complexity: 'complex',
    legs: [{ side: 'call', action: 'sell', deltaTarget: 0.50 }, { side: 'put', action: 'sell', deltaTarget: 0.50 }, { side: 'put', action: 'buy', deltaTarget: 0.20 }] },

  // ── Omnidirectional ───────────────────────────────────────────────────────
  { slug: 'put-front-ratio',           name: 'Put Front Ratio',           category: 'omnidirectional',
    ivPreference: 'high',    direction: 'omnidirectional',  shortPremium: true,  requiresStock: false, complexity: 'complex',
    legs: [{ side: 'put', action: 'buy', deltaTarget: 0.40 }, { side: 'put', action: 'sell', deltaTarget: 0.20, qty: 2 }] },

  { slug: 'call-front-ratio',          name: 'Call Front Ratio',          category: 'omnidirectional',
    ivPreference: 'high',    direction: 'omnidirectional',  shortPremium: true,  requiresStock: false, complexity: 'complex',
    legs: [{ side: 'call', action: 'buy', deltaTarget: 0.40 }, { side: 'call', action: 'sell', deltaTarget: 0.20, qty: 2 }] },

  { slug: 'put-broken-wing-butterfly', name: 'Put Broken Wing Butterfly', category: 'omnidirectional',
    ivPreference: 'high',    direction: 'neutral-bullish',  shortPremium: true,  requiresStock: false, complexity: 'complex',
    legs: [{ side: 'put', action: 'buy', deltaTarget: 0.35 }, { side: 'put', action: 'sell', deltaTarget: 0.20, qty: 2 }, { side: 'put', action: 'buy', deltaTarget: 0.05 }] },

  { slug: 'call-broken-wing-butterfly',name: 'Call Broken Wing Butterfly',category: 'omnidirectional',
    ivPreference: 'high',    direction: 'neutral-bearish',  shortPremium: true,  requiresStock: false, complexity: 'complex',
    legs: [{ side: 'call', action: 'buy', deltaTarget: 0.35 }, { side: 'call', action: 'sell', deltaTarget: 0.20, qty: 2 }, { side: 'call', action: 'buy', deltaTarget: 0.05 }] },

  { slug: 'call-broken-heart-butterfly', name: 'Call Broken Heart Butterfly', category: 'omnidirectional',
    ivPreference: 'high',    direction: 'neutral',          shortPremium: true,  requiresStock: false, complexity: 'complex',
    legs: [{ side: 'call', action: 'buy', deltaTarget: 0.35 }, { side: 'call', action: 'sell', deltaTarget: 0.50, qty: 2 }, { side: 'call', action: 'buy', deltaTarget: 0.65 }] },

  { slug: 'put-broken-heart-butterfly', name: 'Put Broken Heart Butterfly', category: 'omnidirectional',
    ivPreference: 'high',    direction: 'neutral',          shortPremium: true,  requiresStock: false, complexity: 'complex',
    legs: [{ side: 'put', action: 'buy', deltaTarget: 0.35 }, { side: 'put', action: 'sell', deltaTarget: 0.50, qty: 2 }, { side: 'put', action: 'buy', deltaTarget: 0.65 }] },

  // ── Neutral ───────────────────────────────────────────────────────────────
  { slug: 'short-strangle',            name: 'Short Strangle',            category: 'neutral',
    ivPreference: 'high',    direction: 'neutral',          shortPremium: true,  requiresStock: false, complexity: 'moderate',
    legs: [{ side: 'put', action: 'sell', deltaTarget: 0.16 }, { side: 'call', action: 'sell', deltaTarget: 0.16 }] },

  { slug: 'short-straddle',            name: 'Short Straddle',            category: 'neutral',
    ivPreference: 'high',    direction: 'neutral',          shortPremium: true,  requiresStock: false, complexity: 'moderate',
    legs: [{ side: 'put', action: 'sell', deltaTarget: 0.50 }, { side: 'call', action: 'sell', deltaTarget: 0.50 }] },

  { slug: 'iron-condor',               name: 'Iron Condor',               category: 'neutral',
    ivPreference: 'high',    direction: 'neutral',          shortPremium: true,  requiresStock: false, complexity: 'moderate',
    legs: [{ side: 'put', action: 'sell', deltaTarget: 0.16 }, { side: 'put', action: 'buy', deltaTarget: 0.05 }, { side: 'call', action: 'sell', deltaTarget: 0.16 }, { side: 'call', action: 'buy', deltaTarget: 0.05 }] },

  { slug: 'dynamic-width-iron-condor', name: 'Dynamic Width Iron Condor', category: 'neutral',
    ivPreference: 'high',    direction: 'neutral',          shortPremium: true,  requiresStock: false, complexity: 'moderate',
    legs: [{ side: 'put', action: 'sell', deltaTarget: 0.20 }, { side: 'put', action: 'buy', deltaTarget: 0.08 }, { side: 'call', action: 'sell', deltaTarget: 0.20 }, { side: 'call', action: 'buy', deltaTarget: 0.08 }] },

  { slug: 'iron-fly',                  name: 'Iron Fly',                  category: 'neutral',
    ivPreference: 'high',    direction: 'neutral',          shortPremium: true,  requiresStock: false, complexity: 'moderate',
    legs: [{ side: 'put', action: 'sell', deltaTarget: 0.50 }, { side: 'put', action: 'buy', deltaTarget: 0.20 }, { side: 'call', action: 'sell', deltaTarget: 0.50 }, { side: 'call', action: 'buy', deltaTarget: 0.20 }] },

  // ── Neutral-Bullish ───────────────────────────────────────────────────────
  { slug: 'short-naked-put',           name: 'Short Naked Put',           category: 'neutral-bullish',
    ivPreference: 'high',    direction: 'neutral-bullish',  shortPremium: true,  requiresStock: false, complexity: 'simple',
    legs: [{ side: 'put', action: 'sell', deltaTarget: 0.30 }] },

  { slug: 'short-put-vertical',        name: 'Short Put Vertical',        category: 'neutral-bullish',
    ivPreference: 'high',    direction: 'neutral-bullish',  shortPremium: true,  requiresStock: false, complexity: 'simple',
    legs: [{ side: 'put', action: 'sell', deltaTarget: 0.30 }, { side: 'put', action: 'buy', deltaTarget: 0.15 }] },

  { slug: 'jade-lizard',               name: 'Jade Lizard',               category: 'neutral-bullish',
    ivPreference: 'high',    direction: 'neutral-bullish',  shortPremium: true,  requiresStock: false, complexity: 'moderate',
    legs: [{ side: 'put', action: 'sell', deltaTarget: 0.30 }, { side: 'call', action: 'sell', deltaTarget: 0.20 }, { side: 'call', action: 'buy', deltaTarget: 0.10 }] },

  // ── Neutral-Bearish ───────────────────────────────────────────────────────
  { slug: 'short-naked-call',          name: 'Short Naked Call',          category: 'neutral-bearish',
    ivPreference: 'high',    direction: 'neutral-bearish',  shortPremium: true,  requiresStock: false, complexity: 'simple',
    legs: [{ side: 'call', action: 'sell', deltaTarget: 0.30 }] },

  { slug: 'short-call-vertical',       name: 'Short Call Vertical',       category: 'neutral-bearish',
    ivPreference: 'high',    direction: 'neutral-bearish',  shortPremium: true,  requiresStock: false, complexity: 'simple',
    legs: [{ side: 'call', action: 'sell', deltaTarget: 0.30 }, { side: 'call', action: 'buy', deltaTarget: 0.15 }] },

  { slug: 'reverse-jade-lizard',       name: 'Reverse Jade Lizard',       category: 'neutral-bearish',
    ivPreference: 'high',    direction: 'neutral-bearish',  shortPremium: true,  requiresStock: false, complexity: 'moderate',
    legs: [{ side: 'call', action: 'sell', deltaTarget: 0.30 }, { side: 'put', action: 'sell', deltaTarget: 0.20 }, { side: 'put', action: 'buy', deltaTarget: 0.10 }] },
];

const PROFILE_MAP = new Map(PROFILES.map(p => [p.slug, p]));

// ─── Helpers ───────────────────────────────────────────────────────────────────

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function selectExpiration(expirations: string[]): { expiration: string; dte: number } | null {
  const now = Date.now();
  const candidates = expirations
    .map(exp => ({ expiration: exp, dte: Math.round((new Date(exp + 'T16:00:00').getTime() - now) / 86_400_000) }))
    .filter(({ dte }) => dte >= 20 && dte <= 50)
    .sort((a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30));
  if (candidates[0]) return candidates[0];
  // Fallback: nearest expiration ≥ 14 DTE
  const fallbacks = expirations
    .map(exp => ({ expiration: exp, dte: Math.round((new Date(exp + 'T16:00:00').getTime() - now) / 86_400_000) }))
    .filter(({ dte }) => dte >= 14)
    .sort((a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30));
  return fallbacks[0] ?? null;
}

function computeDirectionBias(bars: HistoricalBar[]): {
  bias: StrategyLabDirectionBias; ma20: number | null; ma50: number | null; momentum5d: number | null;
} {
  if (bars.length < 20) return { bias: 'neutral', ma20: null, ma50: null, momentum5d: null };
  const closes = bars.map(b => b.c);
  const latest = closes[closes.length - 1] ?? 0;
  const ma20   = avg(closes.slice(-20));
  const ma50   = closes.length >= 50 ? avg(closes.slice(-50)) : null;
  const ma20_5ago = closes.length >= 25 ? avg(closes.slice(-25, -5)) : ma20;
  const maSlope = ma20 > ma20_5ago;
  const momentum5d = closes.length >= 6
    ? ((latest - (closes[closes.length - 6] ?? latest)) / (closes[closes.length - 6] ?? latest)) * 100
    : null;

  let bias: StrategyLabDirectionBias;
  if (ma50 && latest > ma50 && maSlope) bias = 'bullish';
  else if (ma50 && latest < ma50 && !maSlope) bias = 'bearish';
  else bias = 'neutral';

  return { bias, ma20, ma50: ma50 ?? null, momentum5d };
}

function computeAtmIv(chain: OptionsChain, underlyingPx: number): number {
  if (!chain.contracts.length) return 0;
  const atmStrike = chain.contracts.reduce((best, c) =>
    Math.abs(c.strike - underlyingPx) < Math.abs(best - underlyingPx) ? c.strike : best,
    chain.contracts[0]?.strike ?? underlyingPx
  );
  const ivs = chain.contracts
    .filter(c => c.strike === atmStrike && c.iv > 0)
    .map(c => c.iv);
  return ivs.length ? avg(ivs) : 0;
}

function computeIvRank(db: Database, ticker: string, currentIv: number): {
  ivRank: number | null; ivPercentile: number | null; dataPoints: number;
} {
  const rows = db.prepare(
    `SELECT atm_iv FROM iv_history WHERE ticker = ? ORDER BY date DESC LIMIT 252`
  ).all(ticker) as { atm_iv: number }[];
  if (rows.length < 10) return { ivRank: null, ivPercentile: null, dataPoints: rows.length };
  const vals    = rows.map(r => r.atm_iv);
  const minIv   = Math.min(...vals);
  const maxIv   = Math.max(...vals);
  const ivRank  = maxIv > minIv ? ((currentIv - minIv) / (maxIv - minIv)) * 100 : 50;
  const ivPct   = (vals.filter(v => v < currentIv).length / vals.length) * 100;
  return { ivRank: Math.max(0, Math.min(100, ivRank)), ivPercentile: ivPct, dataPoints: rows.length };
}

function findByDelta(
  contracts: OptionContract[], side: 'call' | 'put', targetDelta: number
): OptionContract | null {
  const filtered = contracts.filter(c => c.side === side && c.delta !== null && c.bid > 0);
  if (!filtered.length) return null;
  return filtered.reduce((best, c) =>
    Math.abs(Math.abs(c.delta!) - targetDelta) < Math.abs(Math.abs(best.delta!) - targetDelta) ? c : best
  );
}

function buildSetup(
  profile: StrategyProfile, chain: OptionsChain, underlyingPx: number, dte: number,
  currentAtmIv: number
): StrategySetup {
  const ticker = chain.ticker;
  const base: Omit<StrategySetup, 'legs' | 'netCredit' | 'netDebit' | 'maxProfit' | 'maxLoss' | 'breakevens' | 'annualizedReturn' | 'popEstimate' | 'unavailableReason'> = {
    slug: profile.slug, ticker, expiration: chain.expiration, dte, underlyingPrice: underlyingPx, currentAtmIv,
  };

  // Strategies requiring a far expiration can't be built with a single chain
  if (profile.legs.some(l => l.farExpiration)) {
    return { ...base, legs: [], netCredit: null, netDebit: null, maxProfit: null, maxLoss: null,
      breakevens: [], annualizedReturn: null, popEstimate: null,
      unavailableReason: 'Requires two expirations — select strikes manually' };
  }

  // Requires existing stock position
  if (profile.requiresStock) {
    return { ...base, legs: [], netCredit: null, netDebit: null, maxProfit: null, maxLoss: null,
      breakevens: [], annualizedReturn: null, popEstimate: null,
      unavailableReason: 'Requires an existing stock/short-stock position' };
  }

  // Build legs
  const builtLegs: SetupLeg[] = [];
  for (const legDef of profile.legs) {
    const contract = findByDelta(chain.contracts, legDef.side, legDef.deltaTarget);
    if (!contract) {
      return { ...base, legs: [], netCredit: null, netDebit: null, maxProfit: null, maxLoss: null,
        breakevens: [], annualizedReturn: null, popEstimate: null,
        unavailableReason: 'Insufficient option data at target delta' };
    }
    builtLegs.push({
      action: legDef.action, side: legDef.side, strike: contract.strike,
      expiration: chain.expiration, delta: contract.delta,
      bid: contract.bid, ask: contract.ask, mid: (contract.bid + contract.ask) / 2,
      iv: contract.iv, openInterest: contract.openInterest, qty: legDef.qty ?? 1,
    });
  }

  // Net credit per share (multiply by 100 for dollars)
  let netCreditPerShare = 0;
  for (const leg of builtLegs) {
    netCreditPerShare += leg.action === 'sell' ? leg.mid * leg.qty : -leg.mid * leg.qty;
  }
  const dollarCredit = netCreditPerShare * 100;

  // P&L based on leg structure
  const putSell  = builtLegs.find(l => l.side === 'put'  && l.action === 'sell');
  const putBuy   = builtLegs.find(l => l.side === 'put'  && l.action === 'buy');
  const callSell = builtLegs.find(l => l.side === 'call' && l.action === 'sell');
  const callBuy  = builtLegs.find(l => l.side === 'call' && l.action === 'buy');

  let maxProfit: number | null = null;
  let maxLoss:   number | null = null;
  let breakevens: number[]    = [];

  if (putSell && !putBuy && !callSell && !callBuy) {
    // Naked put
    maxProfit  = dollarCredit;
    maxLoss    = -(putSell.strike * 100 - dollarCredit);
    breakevens = [putSell.strike - netCreditPerShare];
  } else if (callSell && !callBuy && !putSell && !putBuy) {
    // Naked call
    maxProfit  = dollarCredit;
    maxLoss    = null;  // theoretically unlimited
    breakevens = [callSell.strike + netCreditPerShare];
  } else if (putSell && putBuy && !callSell && !callBuy) {
    // Put spread (short or long)
    const width = (putSell.strike - putBuy.strike) * 100;
    maxProfit  = netCreditPerShare > 0 ? dollarCredit : width + dollarCredit;
    maxLoss    = netCreditPerShare > 0 ? -(width - dollarCredit) : -Math.abs(dollarCredit);
    breakevens = [putSell.strike - netCreditPerShare];
  } else if (callSell && callBuy && !putSell && !putBuy) {
    // Call spread
    const width = (callBuy.strike - callSell.strike) * 100;
    maxProfit  = netCreditPerShare > 0 ? dollarCredit : width + dollarCredit;
    maxLoss    = netCreditPerShare > 0 ? -(width - dollarCredit) : -Math.abs(dollarCredit);
    breakevens = [callSell.strike + netCreditPerShare];
  } else if (putSell && callSell && !putBuy && !callBuy) {
    // Strangle / straddle
    maxProfit  = dollarCredit;
    maxLoss    = null;
    breakevens = [putSell.strike - netCreditPerShare, callSell.strike + netCreditPerShare];
  } else if (putSell && putBuy && callSell && callBuy) {
    // Iron condor / iron fly
    const putW  = (putSell.strike - putBuy.strike) * 100;
    const callW = (callBuy.strike - callSell.strike) * 100;
    const wing  = Math.max(putW, callW);
    maxProfit  = dollarCredit;
    maxLoss    = -(wing - dollarCredit);
    breakevens = [putSell.strike - netCreditPerShare, callSell.strike + netCreditPerShare];
  } else if (putSell && callSell && callBuy) {
    // Jade Lizard — upside risk capped by the call spread, so max loss is the naked put downside
    maxProfit  = dollarCredit;
    maxLoss    = -(putSell.strike * 100 - dollarCredit);
    breakevens = [putSell.strike - netCreditPerShare];
  } else if (callSell && putSell && putBuy) {
    // Reverse Jade Lizard
    const putW = (putSell.strike - putBuy.strike) * 100;
    maxProfit  = dollarCredit;
    maxLoss    = -(putW - dollarCredit);
    breakevens = [callSell.strike + netCreditPerShare];
  } else {
    // General fallback
    maxProfit = dollarCredit > 0 ? dollarCredit : null;
    maxLoss   = dollarCredit < 0 ? dollarCredit : null;
  }

  // Annualized return on capital
  const capital = maxLoss !== null ? Math.abs(maxLoss) : 0;
  const annualizedReturn = capital > 0 && dollarCredit > 0 && dte > 0
    ? (dollarCredit / capital) * (365 / dte) * 100 : null;

  // PoP estimate from outermost short leg delta
  const shortLegs = builtLegs.filter(l => l.action === 'sell');
  const minDeltaShort = shortLegs.reduce<number | null>((min, l) => {
    const ad = Math.abs(l.delta ?? 0);
    return min === null || ad < min ? ad : min;
  }, null);
  const popEstimate = minDeltaShort !== null ? (1 - minDeltaShort) * 100 : null;

  return {
    ...base, legs: builtLegs,
    netCredit:        dollarCredit > 0 ? dollarCredit : null,
    netDebit:         dollarCredit < 0 ? Math.abs(dollarCredit) : null,
    maxProfit, maxLoss, breakevens, annualizedReturn, popEstimate,
    unavailableReason: null,
  };
}

function scoreStrategy(
  profile: StrategyProfile,
  ctx: { ivRank: number | null; ivDataPoints: number; bias: StrategyLabDirectionBias },
  setup: StrategySetup | null,
): StrategyScore {
  const flags: string[] = [];
  let ivScore = 0, directionScore = 0, premiumScore = 0, liquidityScore = 0;

  // ── IV Score (30 pts) ──────────────────────────────────────────────────────
  const ivRank = ctx.ivRank;
  if (ivRank !== null) {
    if (profile.ivPreference === 'high') {
      if (ivRank >= 50)       { ivScore = 30; flags.push(`✓ IV rank ${ivRank.toFixed(0)}% — ideal for premium selling`); }
      else if (ivRank >= 30)  { ivScore = 15; flags.push(`~ IV rank ${ivRank.toFixed(0)}% — moderate for premium selling`); }
      else                    { ivScore = 0;  flags.push(`✗ IV rank ${ivRank.toFixed(0)}% — low IV, unfavorable for selling`); }
    } else if (profile.ivPreference === 'low') {
      if (ivRank <= 30)       { ivScore = 30; flags.push(`✓ IV rank ${ivRank.toFixed(0)}% — ideal for buying options`); }
      else if (ivRank <= 50)  { ivScore = 15; flags.push(`~ IV rank ${ivRank.toFixed(0)}% — moderate IV for debit strategy`); }
      else                    { ivScore = 0;  flags.push(`✗ IV rank ${ivRank.toFixed(0)}% — high IV, overpaying for options`); }
    } else {
      ivScore = 20;
      flags.push(`~ IV rank ${ivRank.toFixed(0)}% — neutral IV preference`);
    }
  } else {
    ivScore = 12;
    flags.push(`? IV rank unavailable — run History bulk load for better scoring`);
  }

  // ── Direction Score (30 pts) ───────────────────────────────────────────────
  const compatible: Record<string, StrategyLabDirectionBias[]> = {
    'bullish':         ['bullish'],
    'bearish':         ['bearish'],
    'neutral':         ['neutral'],
    'neutral-bullish': ['bullish', 'neutral'],
    'neutral-bearish': ['bearish', 'neutral'],
    'omnidirectional': ['bullish', 'bearish', 'neutral'],
  };
  const compatBiases = compatible[profile.direction] ?? [];

  if (profile.direction === 'omnidirectional') {
    directionScore = 22;
    flags.push(`~ Works in all market directions`);
  } else if (compatBiases.includes(ctx.bias)) {
    directionScore = 30;
    flags.push(`✓ ${ctx.bias.charAt(0).toUpperCase() + ctx.bias.slice(1)} trend aligns with strategy`);
  } else if (ctx.bias === 'neutral') {
    directionScore = 12;
    flags.push(`~ Neutral market — directional strategies have lower edge`);
  } else {
    directionScore = 0;
    flags.push(`✗ ${ctx.bias.charAt(0).toUpperCase() + ctx.bias.slice(1)} trend opposes strategy direction`);
  }

  // ── Premium Score (25 pts) ────────────────────────────────────────────────
  if (setup && !setup.unavailableReason) {
    if (profile.shortPremium && setup.netCredit !== null && setup.netCredit > 0) {
      const capital = setup.maxLoss !== null ? Math.abs(setup.maxLoss)
        : setup.legs.find(l => l.side === 'put' && l.action === 'sell')?.strike
          ? (setup.legs.find(l => l.side === 'put' && l.action === 'sell')!.strike * 100) : 0;
      const ret30d = capital > 0 ? (setup.netCredit / capital) * 100 : 0;
      if (ret30d >= 1.5)      { premiumScore = 25; flags.push(`✓ ${ret30d.toFixed(1)}% return/30d — strong premium`); }
      else if (ret30d >= 0.8) { premiumScore = 15; flags.push(`~ ${ret30d.toFixed(1)}% return/30d — adequate premium`); }
      else                    { premiumScore = 5;  flags.push(`✗ ${ret30d.toFixed(1)}% return/30d — thin premium`); }
    } else if (!profile.shortPremium && setup.netDebit !== null && setup.netDebit > 0) {
      const rr = setup.maxProfit !== null && setup.netDebit > 0
        ? setup.maxProfit / setup.netDebit : 0;
      if (rr >= 1.5)      { premiumScore = 25; flags.push(`✓ ${rr.toFixed(1)}:1 reward/risk`); }
      else if (rr >= 0.8) { premiumScore = 15; flags.push(`~ ${rr.toFixed(1)}:1 reward/risk`); }
      else                { premiumScore = 5;  flags.push(`✗ ${rr.toFixed(1)}:1 reward/risk — unfavorable`); }
    } else {
      premiumScore = 10;
    }
  } else if (setup?.unavailableReason) {
    premiumScore = 5;
    flags.push(`~ Setup: ${setup.unavailableReason}`);
  }

  // ── Liquidity Score (15 pts) ──────────────────────────────────────────────
  if (setup && setup.legs.length > 0 && !setup.unavailableReason) {
    const n = setup.legs.length;
    let oiPts = 0, spreadPts = 0;
    for (const leg of setup.legs) {
      const oi   = leg.openInterest ?? 0;
      oiPts     += oi >= 500 ? 5 / n : oi >= 100 ? 3 / n : 1 / n;
      const mid  = (leg.bid + leg.ask) / 2;
      const spd  = mid > 0 ? (leg.ask - leg.bid) / mid : 1;
      spreadPts += spd <= 0.05 ? 10 / n : spd <= 0.15 ? 6 / n : 2 / n;
    }
    liquidityScore = Math.min(15, Math.round(oiPts + spreadPts));
    const avgOi = setup.legs.reduce((s, l) => s + (l.openInterest ?? 0), 0) / n;
    if (liquidityScore >= 12) flags.push(`✓ Good liquidity (avg OI: ${Math.round(avgOi).toLocaleString()})`);
    else if (liquidityScore >= 7) flags.push(`~ Moderate liquidity (avg OI: ${Math.round(avgOi).toLocaleString()})`);
    else flags.push(`✗ Low liquidity — wide spreads or low OI`);
  } else {
    liquidityScore = 5;
  }

  const totalScore = ivScore + directionScore + premiumScore + liquidityScore;
  const grade: StrategyLabGrade =
    totalScore >= 85 ? 'A+' :
    totalScore >= 70 ? 'A'  :
    totalScore >= 55 ? 'B'  :
    totalScore >= 40 ? 'C'  : 'F';

  if (profile.requiresStock) flags.push(`⚠ Requires existing stock position`);

  return {
    slug: profile.slug, name: profile.name, category: profile.category,
    totalScore, grade, ivScore, directionScore, premiumScore, liquidityScore,
    requiresStock: profile.requiresStock, complexity: profile.complexity,
    flags: flags.slice(0, 5), setup, aiRationale: null,
  };
}

// ─── Service ────────────────────────────────────────────────────────────────────

export class StrategyLabService {
  constructor(
    private readonly dataProvider: DataProvider,
    private readonly optionsProvider: OptionsProvider,
  ) {}

  /** Run all 31 strategies for a ticker with entirely fresh data. */
  async validate(db: Database, ticker: string): Promise<StrategyLabValidateResult> {
    const t = ticker.trim().toUpperCase();

    // 1. Fresh price bars for direction bias
    const bars = await this.dataProvider.getHistoricalBars(t, 'day', 90);
    const directionResult = computeDirectionBias(bars);

    // 2. Pick expiration
    const expirations = await this.optionsProvider.getOptionsExpirations(t);
    const expInfo = selectExpiration(expirations);
    if (!expInfo) throw new Error(`No suitable expiration found for ${t} (need 20–50 DTE)`);

    // 3. Fetch live chain
    const chain = await this.optionsProvider.getOptionsChain(t, expInfo.expiration);
    if (!chain.contracts.length) throw new Error(`Empty options chain for ${t} at ${expInfo.expiration}`);

    // 4. Underlying price (mid of ATM call/put, or first contract's reference)
    const underlyingPx = this.estimateUnderlyingPrice(chain);

    // 5. ATM IV from chain
    const currentAtmIv = computeAtmIv(chain, underlyingPx);

    // 6. IV rank from local history
    const ivRankResult = computeIvRank(db, t, currentAtmIv);

    const ctx: StrategyLabContext = {
      ticker: t,
      underlyingPx,
      expiration:    expInfo.expiration,
      dte:           expInfo.dte,
      currentAtmIv,
      ivRank:        ivRankResult.ivRank,
      ivPercentile:  ivRankResult.ivPercentile,
      ivDataPoints:  ivRankResult.dataPoints,
      directionBias: directionResult.bias,
      ma20:          directionResult.ma20,
      ma50:          directionResult.ma50,
      momentum5d:    directionResult.momentum5d,
    };

    // 7. Score all strategies
    const scores: StrategyScore[] = PROFILES.map(profile => {
      const setup = buildSetup(profile, chain, underlyingPx, expInfo.dte, currentAtmIv);
      setup.ticker = t;
      return scoreStrategy(profile, { ivRank: ctx.ivRank, ivDataPoints: ctx.ivDataPoints, bias: ctx.directionBias }, setup);
    });

    // Sort: non-requiresStock first, then by score descending
    scores.sort((a, b) => {
      if (a.requiresStock !== b.requiresStock) return a.requiresStock ? 1 : -1;
      return b.totalScore - a.totalScore;
    });

    return { context: ctx, scores };
  }

  /** Fetch setup for a single strategy. */
  async explore(db: Database, ticker: string, slug: string): Promise<StrategySetup> {
    const profile = PROFILE_MAP.get(slug);
    if (!profile) throw new Error(`Unknown strategy slug: ${slug}`);

    const t    = ticker.trim().toUpperCase();
    const expirations = await this.optionsProvider.getOptionsExpirations(t);
    const expInfo     = selectExpiration(expirations);
    if (!expInfo) throw new Error(`No suitable expiration found for ${t}`);

    const chain = await this.optionsProvider.getOptionsChain(t, expInfo.expiration);
    if (!chain.contracts.length) throw new Error(`Empty options chain for ${t}`);

    const underlyingPx = this.estimateUnderlyingPrice(chain);
    const currentAtmIv = computeAtmIv(chain, underlyingPx);

    const setup = buildSetup(profile, chain, underlyingPx, expInfo.dte, currentAtmIv);
    setup.ticker = t;
    return setup;
  }

  /** Get full scoring context without rebuilding setups (fast re-score for AI rationale). */
  async getContext(db: Database, ticker: string): Promise<StrategyLabContext> {
    const t    = ticker.trim().toUpperCase();
    const bars = await this.dataProvider.getHistoricalBars(t, 'day', 90);
    const dir  = computeDirectionBias(bars);
    const expirations = await this.optionsProvider.getOptionsExpirations(t);
    const expInfo     = selectExpiration(expirations);
    if (!expInfo) throw new Error(`No suitable expiration for ${t}`);
    const chain        = await this.optionsProvider.getOptionsChain(t, expInfo.expiration);
    const underlyingPx = this.estimateUnderlyingPrice(chain);
    const currentAtmIv = computeAtmIv(chain, underlyingPx);
    const ivRankResult = computeIvRank(db, t, currentAtmIv);
    return {
      ticker: t, underlyingPx, expiration: expInfo.expiration, dte: expInfo.dte,
      currentAtmIv, ivRank: ivRankResult.ivRank, ivPercentile: ivRankResult.ivPercentile,
      ivDataPoints: ivRankResult.dataPoints, directionBias: dir.bias,
      ma20: dir.ma20, ma50: dir.ma50, momentum5d: dir.momentum5d,
    };
  }

  private estimateUnderlyingPrice(chain: OptionsChain): number {
    if (!chain.contracts.length) return 0;
    // Use the strike where put delta ≈ -0.50 (ATM)
    const puts = chain.contracts.filter(c => c.side === 'put' && c.delta !== null);
    if (puts.length) {
      const atm = puts.reduce((best, c) =>
        Math.abs(Math.abs(c.delta!) - 0.50) < Math.abs(Math.abs(best.delta!) - 0.50) ? c : best
      );
      return atm.strike;
    }
    // Fallback: mid-range strike
    const strikes = chain.contracts.map(c => c.strike).sort((a, b) => a - b);
    return strikes[Math.floor(strikes.length / 2)] ?? 0;
  }
}

export { PROFILES as STRATEGY_PROFILES, PROFILE_MAP };
