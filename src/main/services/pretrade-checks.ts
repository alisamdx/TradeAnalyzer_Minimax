// Pre-Trade Validator — pure check functions + verdict roll-up + suggestion picker.
// No DB / no I/O, so the trade-discipline rules are fully unit-tested. The orchestrating
// service (pretrade-validator-service.ts) gathers data and calls these.
// see Requirements/PRE_TRADE_VALIDATOR_SPEC.md

import type {
  PayoffLeg,
  PretradeCheck,
  PretradeIntent,
  PretradeMarketContext,
  PretradeVerdict,
  PretradeSuggestion,
  StrategyScore,
  StrategyLabDirectionBias,
} from '@shared/types.js';

/** Tunable thresholds (first-pass; see spec). Exported so tests + UI can reference them. */
export const PRETRADE_THRESHOLDS = {
  rrFail: 0.1,         // reward/risk below this ⇒ structurally broken (bad)
  rrWarn: 0.25,        // below this ⇒ caution
  lowIvRank: 30,       // selling net premium below this IV rank ⇒ cheap vol
  highIvRank: 60,      // buying net premium above this IV rank ⇒ expensive vol
  cushionAtrMult: 1.5, // short-strike cushion must exceed this × ATR%
  shortHorizonDte: 60, // a multi-quarter thesis in a shorter structure ⇒ mismatch
  neutralDelta: 0.15,  // |net delta| below this ⇒ treat as directionally neutral
};

export interface PretradeCheckMetrics {
  maxProfit: number | null;      // total $ (×100); null = unlimited
  maxLoss: number | null;        // total $ (×100, negative); null = unlimited
  unlimitedProfit: boolean;
  unlimitedLoss: boolean;
  breakevenPrices: number[];
  netPremium: number;            // total $ (×100); >0 credit, <0 debit
  netDelta: number | null;       // signed contract-delta; >0 bullish
  netTheta: number | null;
  netVega: number | null;
}

export interface PretradeCheckInput {
  legs: PayoffLeg[];
  spot: number;
  metrics: PretradeCheckMetrics;
  context: PretradeMarketContext;
  intent: PretradeIntent;
  now?: number;                  // injectable for tests
}

const DAY_MS = 86_400_000;

function optionLegs(legs: PayoffLeg[]): PayoffLeg[] {
  return legs.filter(l => l.type !== 'stock');
}

function shortOptionLegs(legs: PayoffLeg[]): PayoffLeg[] {
  return optionLegs(legs).filter(l => l.side === 'sell');
}

function maxExpiry(legs: PayoffLeg[]): string | null {
  const exps = optionLegs(legs).map(l => l.expiry).filter(Boolean).sort();
  return exps.length ? exps[exps.length - 1]! : null;
}

function maxDte(legs: PayoffLeg[], now: number): number | null {
  const exp = maxExpiry(legs);
  if (!exp) return null;
  return Math.ceil((new Date(exp).getTime() - now) / DAY_MS);
}

/** OTM cushion % for a short option leg (positive = OTM, negative = ITM). */
function shortLegCushionPct(leg: PayoffLeg, spot: number): number {
  if (leg.type === 'call') return ((leg.strike - spot) / spot) * 100;
  return ((spot - leg.strike) / spot) * 100; // put
}

/** Run all deterministic checks. Pure. */
export function runPretradeChecks(input: PretradeCheckInput): PretradeCheck[] {
  const { legs, spot, metrics, context, intent } = input;
  const now = input.now ?? Date.now();
  const checks: PretradeCheck[] = [];
  const isCredit = metrics.netPremium > 0;
  const shorts = shortOptionLegs(legs);
  // A long option leg caps the loss → a true defined-risk spread, where maxProfit/|maxLoss|
  // is a meaningful payoff ratio. For cash-secured puts / covered calls (no long option) the
  // "max loss" is the whole strike (stock → 0), so the ratio is structurally tiny and would
  // mislead — those are judged by cushion + ownership basis instead.
  const hasLongOption = optionLegs(legs).some(l => l.side === 'buy');

  // 1. Reward / risk
  if (metrics.unlimitedLoss) {
    checks.push({
      key: 'undefined_risk', status: 'warn', title: 'Undefined risk',
      detail: 'This structure has an uncovered short leg — the loss is unbounded. Only appropriate if you can manage the naked exposure.',
    });
  } else if (hasLongOption && metrics.maxLoss != null && metrics.maxLoss < 0 && metrics.maxProfit != null) {
    const rr = metrics.maxProfit / Math.abs(metrics.maxLoss);
    const status = rr < PRETRADE_THRESHOLDS.rrFail ? 'fail' : rr < PRETRADE_THRESHOLDS.rrWarn ? 'warn' : 'pass';
    checks.push({
      key: 'reward_risk', status,
      title: 'Reward vs risk',
      detail: `Max profit $${metrics.maxProfit.toFixed(0)} against max loss $${Math.abs(metrics.maxLoss).toFixed(0)} — reward/risk ${(rr).toFixed(2)}.`
        + (status === 'fail' ? ' That is a very poor payoff for the capital at risk.'
          : status === 'warn' ? ' A thin payoff for the risk — make sure the probability justifies it.' : ''),
    });
  }

  // 2. IV-regime fit
  if (context.ivRank == null) {
    checks.push({
      key: 'iv_regime', status: 'info', title: 'IV regime unknown',
      detail: 'No IV-rank data for this ticker — can\'t judge whether premium is rich or cheap. Check IV before relying on premium.',
    });
  } else if (isCredit && context.ivRank < PRETRADE_THRESHOLDS.lowIvRank) {
    // Intent-gated like direction/earnings: when premium isn't the edge (you're happy to own /
    // running a wheel), selling cheap vol is context, not a red flag. For income/directional it
    // stays a warning — there the premium IS the edge.
    const premiumSecondary = intent.purpose === 'ownership' || intent.happyToOwn === true;
    checks.push({
      key: 'iv_regime', status: premiumSecondary ? 'info' : 'warn',
      title: premiumSecondary ? 'Selling cheap volatility (premium secondary)' : 'Selling cheap volatility',
      detail: `IV rank ${context.ivRank.toFixed(0)}% is below ${PRETRADE_THRESHOLDS.lowIvRank}% — you're selling cheap premium relative to this name's own history.`
        + (premiumSecondary
          ? ` Premium isn't your edge here (you're happy to own), so it's context, not a red flag — just know you're not richly paid for the downside.`
          : ` The dollar credit can look big on a high-priced name while being cheap; the premium edge isn't really there.`),
    });
  } else if (!isCredit && context.ivRank > PRETRADE_THRESHOLDS.highIvRank) {
    checks.push({
      key: 'iv_regime', status: 'warn', title: 'Buying expensive volatility',
      detail: `You're paying net debit with IV rank at ${context.ivRank.toFixed(0)}% — above ${PRETRADE_THRESHOLDS.highIvRank}%. You're buying rich options; a vol contraction works against you.`,
    });
  } else {
    checks.push({
      key: 'iv_regime', status: 'pass', title: 'IV regime fits',
      detail: `IV rank ${context.ivRank.toFixed(0)}% suits ${isCredit ? 'premium selling' : 'premium buying'}.`,
    });
  }

  // 3. Direction vs trend
  if (metrics.netDelta != null && Math.abs(metrics.netDelta) >= PRETRADE_THRESHOLDS.neutralDelta && context.directionBias && context.directionBias !== 'neutral') {
    const structureDir: StrategyLabDirectionBias = metrics.netDelta > 0 ? 'bullish' : 'bearish';
    if (structureDir !== context.directionBias) {
      const deliberate = intent.purpose === 'ownership' || intent.purpose === 'hedge' || intent.happyToOwn === true;
      checks.push({
        key: 'direction_fit', status: deliberate ? 'info' : 'warn',
        title: deliberate ? 'Against the trend (by intent)' : 'Against the trend',
        detail: `Your structure is ${structureDir} but the tape is ${context.directionBias} (MA20 ${context.ma20?.toFixed(2) ?? '?'} / MA50 ${context.ma50?.toFixed(2) ?? '?'}).`
          + (deliberate ? ' You\'ve flagged this as a deliberate ownership/hedge stance, so it\'s a conscious fade.' : ' You\'re fading the trend — make sure that\'s intentional.'),
      });
    } else {
      checks.push({ key: 'direction_fit', status: 'pass', title: 'Direction aligns with trend', detail: `Both ${structureDir}.` });
    }
  }

  // 4. Earnings before expiry
  const exp = maxExpiry(legs);
  if (context.nextEarningsDate && exp && context.nextEarningsDate <= exp.slice(0, 10)) {
    const ownerOk = intent.happyToOwn === true;
    checks.push({
      key: 'earnings_window', status: ownerOk ? 'info' : 'warn',
      title: 'Earnings before expiry',
      detail: `Earnings on ${context.nextEarningsDate} fall before expiry ${exp.slice(0, 10)} — the single biggest event risk for an options position.`
        + (ownerOk ? ' You\'re happy to own at the strike, so the print is an acceptable (welcome) assignment trigger.' : ' You hold through the print — a gap can blow through the strike.'),
    });
  }

  // 5. Cushion vs volatility (only for premium-selling structures)
  if (shorts.length > 0) {
    const cushions = shorts.map(l => ({ leg: l, c: shortLegCushionPct(l, spot) }));
    const binding = cushions.reduce((m, x) => (x.c < m.c ? x : m), cushions[0]!);
    if (binding.c < 0) {
      checks.push({
        key: 'cushion', status: 'warn', title: 'Short strike in-the-money',
        detail: `The short ${binding.leg.type} at $${binding.leg.strike} is ITM (spot $${spot.toFixed(2)}) — high assignment probability.`,
      });
    } else if (context.atrPct != null) {
      const need = PRETRADE_THRESHOLDS.cushionAtrMult * context.atrPct;
      const status = binding.c < need ? 'warn' : 'pass';
      checks.push({
        key: 'cushion', status,
        title: status === 'warn' ? 'Thin cushion for the volatility' : 'Adequate cushion',
        detail: `Short strike is ${binding.c.toFixed(1)}% OTM vs a daily ATR of ${context.atrPct.toFixed(1)}%.`
          + (status === 'warn' ? ` On this name a single session can erase that — it's the live wire of the trade.` : ''),
      });
    } else {
      checks.push({ key: 'cushion', status: 'info', title: 'Cushion unknown', detail: `Short strike ${binding.c.toFixed(1)}% OTM; no ATR data to judge whether that's enough.` });
    }
  }

  // 6. Horizon match
  if (intent.multiQuarterThesis) {
    const dte = maxDte(legs, now);
    if (dte != null && dte < PRETRADE_THRESHOLDS.shortHorizonDte) {
      checks.push({
        key: 'horizon_match', status: 'warn', title: 'Structure shorter than the thesis',
        detail: `Your thesis is multi-quarter but the structure expires in ${dte} days. It will likely close out before the thesis plays out — match the expiry to the timeframe, or own the underlying.`,
      });
    }
  }

  // 7. Wheel ownership basis (info)
  if ((intent.purpose === 'ownership' || intent.purpose === 'income') && intent.happyToOwn === true) {
    const shortPuts = shorts.filter(l => l.type === 'put');
    if (shortPuts.length === 1 && isCredit) {
      const sp = shortPuts[0]!;
      const perShareCredit = metrics.netPremium / 100 / Math.max(1, sp.quantity);
      const basis = sp.strike - perShareCredit;
      checks.push({
        key: 'ownership_basis', status: 'info', title: 'Effective ownership basis',
        detail: `If assigned, your effective basis is ~$${basis.toFixed(2)} (strike $${sp.strike} − $${perShareCredit.toFixed(2)} credit). Confirm that's a price you genuinely want to own.`,
      });
    }
  }

  return checks;
}

/** Roll the checks up into a single verdict: any fail ⇒ bad; any warn ⇒ caution; else good. */
export function rollUpVerdict(checks: PretradeCheck[]): PretradeVerdict {
  if (checks.some(c => c.status === 'fail')) return 'bad';
  if (checks.some(c => c.status === 'warn')) return 'caution';
  return 'good';
}

/**
 * Pick the Strategy Lab structure that best fits the user's intent + IV regime, to suggest
 * when their trade is flagged. Pure. Returns null when nothing valid fits.
 */
export function pickSuggestedStructure(
  scores: StrategyScore[],
  intent: PretradeIntent,
  ivRank: number | null,
): PretradeSuggestion | null {
  const valid = scores.filter(s => s.setup && !s.setup.unavailableReason);
  if (valid.length === 0) return null;

  const isCredit = (s: StrategyScore) => (s.setup?.netCredit ?? 0) > 0;
  const cat = (s: StrategyScore) => (s.category ?? '').toLowerCase();
  const lowIv = ivRank != null && ivRank < PRETRADE_THRESHOLDS.lowIvRank;

  let pool = valid;
  switch (intent.purpose) {
    case 'income':
      // Income wants to SELL premium — but not into cheap vol. If IV is low, prefer
      // defined-risk credit and let the rationale flag the regime.
      pool = valid.filter(isCredit);
      break;
    case 'ownership':
      // Wheel: put-based credit structures (own on a dip).
      pool = valid.filter(s => isCredit(s) && (s.slug.includes('put') || s.slug === 'short-naked-put'));
      break;
    case 'directional':
      pool = valid.filter(s => cat(s).includes('bull') || cat(s).includes('bear'));
      break;
    case 'hedge':
      pool = valid.filter(s => s.slug.includes('long-put') || s.slug.includes('put-vertical'));
      break;
  }
  if (pool.length === 0) pool = valid;

  // Prefer defined-risk (finite max loss), then higher grade.
  const GRADE: Record<string, number> = { 'A+': 6, A: 5, B: 4, C: 3, F: 1 };
  const definedRisk = pool.filter(s => s.setup?.maxLoss != null);
  const tier = definedRisk.length ? definedRisk : pool;
  const best = tier.reduce((b, s) => ((GRADE[s.grade] ?? 0) > (GRADE[b.grade] ?? 0) ? s : b), tier[0]!);
  const su = best.setup!;

  const regimeNote = lowIv && isCredit(best)
    ? ` Note: IV rank is ${ivRank!.toFixed(0)}% — even this is selling cheap premium, so consider waiting for higher IV or simply buying/owning instead.`
    : '';

  return {
    slug: best.slug,
    name: best.name,
    grade: best.grade,
    rationale: `Lab's best ${intent.purpose} fit: ${best.name} (grade ${best.grade}, score ${best.totalScore}/100).${regimeNote}`,
    legs: su.legs.map(l => ({ action: l.action, side: l.side, strike: l.strike, expiration: l.expiration, qty: l.qty })),
    netCredit: su.netCredit,
    netDebit: su.netDebit,
    maxProfit: su.maxProfit,
    maxLoss: su.maxLoss,
    breakevens: su.breakevens,
    annualizedReturn: su.annualizedReturn,
  };
}
