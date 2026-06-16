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
import { bsPrice, RISK_FREE_RATE } from './black-scholes.js';
import { fillPrice } from './options-fill.js';
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

// Far-dated expiration for the long leg of calendars / PMCC diagonals. Targets ~120
// DTE (LEAPS-lite for PMCC; acceptably wide back month for calendars), and must sit at
// least 25 DTE beyond the near leg so there is a real time spread. Returns null when no
// suitable long expiration exists → the strategy stays unavailable rather than synthesized.
function selectFarExpiration(
  expirations: string[], nearDte: number, targetDte = 120
): { expiration: string; dte: number } | null {
  const now = Date.now();
  const candidates = expirations
    .map(exp => ({ expiration: exp, dte: Math.round((new Date(exp + 'T16:00:00').getTime() - now) / 86_400_000) }))
    .filter(({ dte }) => dte >= nearDte + 25 && dte <= 220)
    .sort((a, b) => Math.abs(a.dte - targetDte) - Math.abs(b.dte - targetDte));
  return candidates[0] ?? null;
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
  // OptionContract.iv is a decimal fraction (0.285) from both Polygon and E*Trade.
  // Multiply by 100 to get percentage consistent with iv_history storage.
  // see docs/formulas.md#iv-conventions
  return ivs.length ? avg(ivs) * 100 : 0;
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

// Strategies where the buy (hedge) leg must satisfy: credit ≥ spread width
// This guarantees no upside (for call hedges) or downside (for put hedges) risk.
const LIZARD_HEDGE_SLUGS = new Set([
  'jade-lizard', 'big-lizard', 'reverse-jade-lizard', 'reverse-big-lizard',
]);

// For lizard-family strategies: scan available contracts from nearest OTM outward
// and return the furthest strike where shortCreditPerShare ≥ spread width.
// Falls back to nearest OTM when no valid strike exists (rule simply can't be met).
// see Requirements/ai-critic.md §4.1 and docs/formulas.md#lizard-hedge
function findLizardHedge(
  contracts: OptionContract[],
  side: 'call' | 'put',
  sellStrike: number,
  shortCreditPerShare: number,
): OptionContract | null {
  // Filter to OTM side only and sort nearest-first
  const candidates = contracts
    .filter(c => c.side === side && c.bid >= 0 &&
      (side === 'call' ? c.strike > sellStrike : c.strike < sellStrike))
    .sort((a, b) => side === 'call' ? a.strike - b.strike : b.strike - a.strike);

  if (!candidates.length) return null;

  let bestValid: OptionContract | null = null;
  for (const c of candidates) {
    const spreadWidth = side === 'call' ? c.strike - sellStrike : sellStrike - c.strike;
    const netCredit   = shortCreditPerShare - (c.bid + c.ask) / 2;
    if (netCredit >= spreadWidth) {
      bestValid = c; // rule passes — keep scanning for wider coverage
    } else {
      break;         // monotonically harder as spread widens — stop here
    }
  }

  return bestValid ?? candidates[0] ?? null; // fallback: nearest OTM
}

function findByDelta(
  contracts: OptionContract[], side: 'call' | 'put', targetDelta: number,
  underlyingPx?: number, trustDeltas = true
): OptionContract | null {
  // Primary: use delta (available during market hours when Greeks are returned).
  // Skipped when trustDeltas=false — E*Trade serves stale Greeks on thin (OI=0)
  // chains (observed: delta −0.50 at a strike ~20% above spot), which would
  // select wildly ITM/OTM legs. Moneyness selection below is then authoritative.
  const withDelta = trustDeltas ? contracts.filter(c => c.side === side && c.delta !== null && c.bid >= 0) : [];
  if (withDelta.length) {
    return withDelta.reduce((best, c) =>
      Math.abs(Math.abs(c.delta!) - targetDelta) < Math.abs(Math.abs(best.delta!) - targetDelta) ? c : best
    );
  }

  // Fallback: approximate by moneyness when Greeks are absent (pre/post-market)
  // delta ~0.5 → ATM, delta ~0.3 → ~1 std dev OTM, delta ~0.16 → ~2 std dev OTM
  if (underlyingPx && underlyingPx > 0) {
    const all = contracts.filter(c => c.side === side);
    if (!all.length) return null;
    // Map targetDelta to an approximate strike offset fraction:
    // calls: higher delta = lower strike (ITM); puts: higher |delta| = higher strike (ITM)
    const otmFraction = 1 - targetDelta * 1.5; // rough: 0.5→0.25 OTM, 0.3→0.55 OTM, 0.16→0.76 OTM
    const targetStrike = side === 'call'
      ? underlyingPx * (1 + otmFraction * 0.15)
      : underlyingPx * (1 - otmFraction * 0.15);
    return all.reduce((best, c) =>
      Math.abs(c.strike - targetStrike) < Math.abs(best.strike - targetStrike) ? c : best
    );
  }

  return null;
}

/**
 * Closed-form max-profit / max-loss / breakevens for a SINGLE-expiration option
 * structure, classified by its leg signature. Pure and exported for direct testing.
 *
 * `dollarCredit` is the net credit in dollars (negative = net debit); `netCreditPerShare`
 * is the per-share credit used for breakeven offsets. A **null `maxLoss` means the loss is
 * unbounded** — a naked short option with no covering long on that side (naked call,
 * strangle/straddle, and the reverse lizards, whose naked short call has unlimited upside).
 * see docs/formulas.md#structure-pnl
 */
export function classifySingleExpiryPnl(
  legs: Array<{ side: 'call' | 'put'; action: 'buy' | 'sell'; strike: number; qty?: number }>,
  dollarCredit: number,
  netCreditPerShare: number,
): { maxProfit: number | null; maxLoss: number | null; breakevens: number[] } {
  const putSell  = legs.find(l => l.side === 'put'  && l.action === 'sell');
  const putBuy   = legs.find(l => l.side === 'put'  && l.action === 'buy');
  const callSell = legs.find(l => l.side === 'call' && l.action === 'sell');
  const callBuy  = legs.find(l => l.side === 'call' && l.action === 'buy');

  let maxProfit: number | null = null;
  let maxLoss:   number | null = null;
  let breakevens: number[]     = [];

  if (putSell && !putBuy && !callSell && !callBuy) {
    // Naked put
    maxProfit  = dollarCredit;
    maxLoss    = -(putSell.strike * 100 - dollarCredit);
    breakevens = [putSell.strike - netCreditPerShare];
  } else if (callSell && !callBuy && !putSell && !putBuy) {
    // Naked call — unbounded upside loss
    maxProfit  = dollarCredit;
    maxLoss    = null;
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
    // Strangle / straddle — naked on both sides, unbounded upside loss
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
  } else if (putSell && callSell && callBuy && !putBuy) {
    // Jade Lizard / Big Lizard — short put + short call SPREAD. Upside is capped by
    // the call spread, so the binding risk is the naked-put downside (bounded at the
    // put strike).
    maxProfit  = dollarCredit;
    maxLoss    = -(putSell.strike * 100 - dollarCredit);
    breakevens = [putSell.strike - netCreditPerShare];
  } else if (callSell && putSell && putBuy && !callBuy) {
    // Reverse Jade Lizard / Reverse Big Lizard — short put SPREAD + a NAKED short call.
    // The naked call makes the UPSIDE loss unbounded; the put spread only caps the
    // downside. Pre-v1.1.24 this reported the bounded put-spread residual as maxLoss
    // (e.g. FLUT −$11), hiding the real risk and inflating annualizedReturn to ~100,000%
    // and the structure's premiumScore/grade → these floated to the top of the bearish
    // brief. The true max loss is unbounded.
    maxProfit  = dollarCredit;
    maxLoss    = null;
    breakevens = [callSell.strike + netCreditPerShare];
  } else {
    // General fallback
    maxProfit = dollarCredit > 0 ? dollarCredit : null;
    maxLoss   = dollarCredit < 0 ? dollarCredit : null;
  }

  return { maxProfit, maxLoss, breakevens };
}

function buildSetup(
  profile: StrategyProfile, chain: OptionsChain, underlyingPx: number, dte: number,
  currentAtmIv: number, trustDeltas = true, farChain: OptionsChain | null = null, farDte: number | null = null
): StrategySetup {
  const ticker = chain.ticker;
  const base: Omit<StrategySetup, 'legs' | 'netCredit' | 'netDebit' | 'maxProfit' | 'maxLoss' | 'breakevens' | 'annualizedReturn' | 'popEstimate' | 'unavailableReason'> = {
    slug: profile.slug, ticker, expiration: chain.expiration, dte, underlyingPrice: underlyingPx, currentAtmIv,
  };

  const hasFarLeg = profile.legs.some(l => l.farExpiration);

  // Calendars / PMCC need a second (far) expiration chain. If none is available, the
  // structure stays unavailable rather than being synthesized from a single expiry.
  if (hasFarLeg && (!farChain || farChain.contracts.length === 0 || farDte === null)) {
    return { ...base, legs: [], netCredit: null, netDebit: null, maxProfit: null, maxLoss: null,
      breakevens: [], annualizedReturn: null, popEstimate: null,
      unavailableReason: 'No suitable far expiration available' };
  }

  // Requires existing stock position
  if (profile.requiresStock) {
    return { ...base, legs: [], netCredit: null, netDebit: null, maxProfit: null, maxLoss: null,
      breakevens: [], annualizedReturn: null, popEstimate: null,
      unavailableReason: 'Requires an existing stock/short-stock position' };
  }

  // Build legs — far-expiration legs draw from farChain; all others from the near chain.
  const builtLegs: SetupLeg[] = [];
  for (const legDef of profile.legs) {
    const legChain = legDef.farExpiration ? farChain! : chain;
    let contract: OptionContract | null;

    if (legDef.action === 'buy' && LIZARD_HEDGE_SLUGS.has(profile.slug)) {
      // Lizard hedge: select the furthest OTM strike where credit ≥ spread width
      // so the structure carries no upside (call) or downside (put) risk.
      const shortCreditPerShare = builtLegs
        .filter(l => l.action === 'sell')
        .reduce((sum, l) => sum + l.mid * l.qty, 0);
      const sellLeg = builtLegs.find(l => l.side === legDef.side && l.action === 'sell');
      contract = sellLeg
        ? findLizardHedge(legChain.contracts, legDef.side, sellLeg.strike, shortCreditPerShare)
        : findByDelta(legChain.contracts, legDef.side, legDef.deltaTarget, underlyingPx, trustDeltas);
    } else {
      contract = findByDelta(legChain.contracts, legDef.side, legDef.deltaTarget, underlyingPx, trustDeltas);
    }

    if (!contract) {
      return { ...base, legs: [], netCredit: null, netDebit: null, maxProfit: null, maxLoss: null,
        breakevens: [], annualizedReturn: null, popEstimate: null,
        unavailableReason: 'Insufficient option data at target delta' };
    }
    builtLegs.push({
      action: legDef.action, side: legDef.side, strike: contract.strike,
      expiration: legChain.expiration, delta: contract.delta,
      gamma: contract.gamma ?? null, theta: contract.theta ?? null, vega: contract.vega ?? null,
      bid: contract.bid, ask: contract.ask, mid: (contract.bid + contract.ask) / 2,
      iv: contract.iv * 100, // decimal fraction → percentage (see docs/formulas.md#iv-conventions)
      openInterest: contract.openInterest, volume: contract.volume ?? null, qty: legDef.qty ?? 1,
    });
  }

  // Net credit per share, priced at the modeled fill (sells below mid, buys above) rather
  // than the optimistic mid — see docs/formulas.md#fill-model.
  let netCreditPerShare = 0;
  for (const leg of builtLegs) {
    const px = fillPrice(leg.bid, leg.ask, leg.action);
    netCreditPerShare += leg.action === 'sell' ? px * leg.qty : -px * leg.qty;
  }
  const dollarCredit = netCreditPerShare * 100;

  // P&L based on leg structure
  let maxProfit: number | null = null;
  let maxLoss:   number | null = null;
  let breakevens: number[]    = [];

  if (hasFarLeg) {
    // Calendar / PMCC diagonal: legs span two expirations, so max profit is not
    // closed-form (the long/far leg retains time value when the short/near leg expires).
    // Value the long leg's residual at the short leg's expiry via Black-Scholes, assuming
    // the underlying pins the short strike — the calendar/diagonal profit peak.
    // see docs/formulas.md#calendar-diagonal-pnl
    const longLeg  = builtLegs.find(l => l.action === 'buy');
    const shortLeg = builtLegs.find(l => l.action === 'sell');
    if (longLeg && shortLeg && farDte !== null) {
      const isCall    = longLeg.side === 'call';
      const evalSpot  = shortLeg.strike;                       // underlying ≈ short strike at near expiry
      const remYears  = Math.max(0, farDte - dte) / 365;       // long leg's life left after short expires
      const longResidual   = bsPrice(evalSpot, longLeg.strike, remYears, longLeg.iv / 100, RISK_FREE_RATE, isCall);
      const shortIntrinsic = isCall ? Math.max(0, evalSpot - shortLeg.strike) : Math.max(0, shortLeg.strike - evalSpot);
      const posValuePerShare = longResidual * longLeg.qty - shortIntrinsic * shortLeg.qty;
      maxProfit  = posValuePerShare * 100 - Math.abs(dollarCredit); // close both at near expiry
      maxLoss    = -Math.abs(dollarCredit);                         // worst case ≈ net debit paid
      breakevens = [];                                              // not closed-form here
    }
  } else {
    ({ maxProfit, maxLoss, breakevens } =
      classifySingleExpiryPnl(builtLegs, dollarCredit, netCreditPerShare));
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
  ctx: { ivRank: number | null; ivDataPoints: number; bias: StrategyLabDirectionBias; isEtf?: boolean },
  setup: StrategySetup | null,
): StrategyScore {
  const flags: string[] = [];
  let ivScore = 0, directionScore = 0, premiumScore = 0, liquidityScore = 0;
  const isEtf = ctx.isEtf ?? false;

  // ── IV Score (30 pts) ──────────────────────────────────────────────────────
  // ETFs have structurally lower IV than individual stocks (SPY typically IVR 10–25).
  // Use compressed thresholds calibrated to ETF volatility levels (IVR 30 = elevated).
  // see docs/formulas.md#iv-rank-score
  const ivHighThresh = isEtf ? 30 : 50;
  const ivMidThresh  = isEtf ? 15 : 30;
  const ivHighLabel  = isEtf ? `(ETF-calibrated — IVR ${ivHighThresh}= elevated)` : '';

  const ivRank = ctx.ivRank;
  if (ivRank !== null) {
    if (profile.ivPreference === 'high') {
      if (ivRank >= ivHighThresh)      { ivScore = 30; flags.push(`✓ IV rank ${ivRank.toFixed(0)}% — ideal for premium selling ${ivHighLabel}`.trim()); }
      else if (ivRank >= ivMidThresh)  { ivScore = 15; flags.push(`~ IV rank ${ivRank.toFixed(0)}% — moderate for premium selling`); }
      else                             { ivScore = 0;  flags.push(`✗ IV rank ${ivRank.toFixed(0)}% — low IV, unfavorable for selling`); }
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
    // Three components, summed per leg and averaged: bid-ask spread (8 — drives fill cost),
    // open interest (4 — standing interest), and same-day volume (3 — today's activity, so a
    // high-OI/zero-volume strike no longer scores as fully liquid). see docs/formulas.md#liquidity-score
    let oiPts = 0, spreadPts = 0, volPts = 0;
    for (const leg of setup.legs) {
      const oi   = leg.openInterest ?? 0;
      oiPts     += oi >= 500 ? 4 / n : oi >= 100 ? 2.5 / n : 0.5 / n;
      const mid  = (leg.bid + leg.ask) / 2;
      const spd  = mid > 0 ? (leg.ask - leg.bid) / mid : 1;
      spreadPts += spd <= 0.05 ? 8 / n : spd <= 0.15 ? 5 / n : 1 / n;
      const vol  = leg.volume ?? 0;
      volPts    += vol >= 100 ? 3 / n : vol >= 10 ? 1.5 / n : 0;
    }
    liquidityScore = Math.min(15, Math.round(oiPts + spreadPts + volPts));
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

    // 3b. Far chain for calendar/PMCC long legs (one extra E*Trade call; null on failure)
    const { farChain, farDte } = await this.fetchFarChain(t, expirations, expInfo.dte);

    // 4. Underlying price — live quote, chain-delta estimate as fallback
    const { underlyingPx, trustDeltas } = await this.resolveUnderlyingPrice(t, chain);

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

    // 6b. Detect ETF — compressed IV thresholds apply (IVR 30 = elevated for ETFs)
    const isEtf = !!(db.prepare(
      `SELECT 1 FROM constituents WHERE ticker = ? AND index_name = 'etf' LIMIT 1`
    ).get(t));

    // 7. Score all strategies
    const scores: StrategyScore[] = PROFILES.map(profile => {
      const setup = buildSetup(profile, chain, underlyingPx, expInfo.dte, currentAtmIv, trustDeltas, farChain, farDte);
      setup.ticker = t;
      return scoreStrategy(profile, { ivRank: ctx.ivRank, ivDataPoints: ctx.ivDataPoints, bias: ctx.directionBias, isEtf }, setup);
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

    const { underlyingPx, trustDeltas } = await this.resolveUnderlyingPrice(t, chain);
    const currentAtmIv = computeAtmIv(chain, underlyingPx);

    // Far chain only needed for calendar/PMCC strategies — skip the extra call otherwise.
    const { farChain, farDte } = profile.legs.some(l => l.farExpiration)
      ? await this.fetchFarChain(t, expirations, expInfo.dte)
      : { farChain: null, farDte: null };

    const setup = buildSetup(profile, chain, underlyingPx, expInfo.dte, currentAtmIv, trustDeltas, farChain, farDte);
    setup.ticker = t;
    return setup;
  }

  /** Fetch the long-leg chain for calendar/PMCC structures. Returns nulls on any failure
   *  so the caller degrades gracefully (those strategies show as unavailable). */
  private async fetchFarChain(
    ticker: string, expirations: string[], nearDte: number
  ): Promise<{ farChain: OptionsChain | null; farDte: number | null }> {
    const farInfo = selectFarExpiration(expirations, nearDte);
    if (!farInfo) return { farChain: null, farDte: null };
    try {
      const farChain = await this.optionsProvider.getOptionsChain(ticker, farInfo.expiration);
      if (!farChain.contracts.length) return { farChain: null, farDte: null };
      return { farChain, farDte: farInfo.dte };
    } catch {
      return { farChain: null, farDte: null };
    }
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
    const { underlyingPx } = await this.resolveUnderlyingPrice(t, chain);
    const currentAtmIv = computeAtmIv(chain, underlyingPx);
    const ivRankResult = computeIvRank(db, t, currentAtmIv);
    return {
      ticker: t, underlyingPx, expiration: expInfo.expiration, dte: expInfo.dte,
      currentAtmIv, ivRank: ivRankResult.ivRank, ivPercentile: ivRankResult.ivPercentile,
      ivDataPoints: ivRankResult.dataPoints, directionBias: dir.bias,
      ma20: dir.ma20, ma50: dir.ma50, momentum5d: dir.momentum5d,
    };
  }

  /**
   * Resolve the underlying price. Priority:
   *   1. chain.underlyingPrice — E*Trade supplies its own real-time spot with
   *      the chain (no extra API call; Polygon chains return null here)
   *   2. DataProvider.getQuote() — live Polygon quote
   *   3. chain-delta estimate — last resort (offline/tests)
   *
   * Also decides whether the chain's Greeks can be trusted: E*Trade serves
   * stale deltas on thin chains (observed 2026-06-10: WSO delta −0.50 at a
   * $450 strike with spot at $375.66, OI=0 — option PRICES were correct,
   * deltas were computed at a months-old spot). When the delta-implied ATM
   * deviates > 8% from the real spot, leg selection must use moneyness.
   */
  private async resolveUnderlyingPrice(
    ticker: string,
    chain: OptionsChain,
  ): Promise<{ underlyingPx: number; trustDeltas: boolean }> {
    const deltaEstimate = this.estimateUnderlyingPrice(chain);

    let spot: number | null =
      (chain.underlyingPrice !== null && chain.underlyingPrice > 0) ? chain.underlyingPrice : null;

    if (spot === null) {
      try {
        const q = await this.dataProvider.getQuote(ticker);
        spot = q.last ?? q.prevClose ?? null;
      } catch { /* provider offline — fall back to chain estimate */ }
    }

    if (spot !== null && spot > 0) {
      const trustDeltas = deltaEstimate > 0 &&
        Math.abs(deltaEstimate - spot) / spot <= 0.08;
      return { underlyingPx: spot, trustDeltas };
    }
    return { underlyingPx: deltaEstimate, trustDeltas: true };
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
