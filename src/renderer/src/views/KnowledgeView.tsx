// KnowledgeView — tastylive Strategy Guide quick reference
// Top-level tabs: Strategies (31 one-pagers) | Glossary | Classifications

import { useState, useMemo } from 'react';
import {
  STRATEGIES,
  STRATEGIES_BY_CATEGORY,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type Strategy,
  type StrategyCategory,
} from '../knowledge/index.js';

// ─── Image map (Vite bundles all PNGs at build time) ─────────────────────────

const imageModules = import.meta.glob('../knowledge/images/*.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

function imageUrl(slug: string): string {
  return imageModules[`../knowledge/images/${slug}.png`] ?? '';
}

// ─── Category styling ─────────────────────────────────────────────────────────

const CATEGORY_COLOR: Record<StrategyCategory, string> = {
  'bullish':         '#22c55e',
  'bearish':         '#ef4444',
  'omnidirectional': '#a78bfa',
  'neutral':         '#60a5fa',
  'neutral-bullish': '#34d399',
  'neutral-bearish': '#f97316',
};

const GREEK_COLOR: Record<string, string> = {
  'Long':    '#22c55e',
  'Short':   '#ef4444',
  'Flat':    '#6b7280',
  'Dynamic': '#60a5fa',
};

function greekColor(val: string): string { return GREEK_COLOR[val] ?? '#9ca3af'; }
function ivColor(val: string): string {
  if (/high/i.test(val)) return '#ef4444';
  if (/low/i.test(val))  return '#22c55e';
  return '#9ca3af';
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function StatChip({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ background: '#111827', borderRadius: 6, padding: '6px 12px', minWidth: 90 }}>
      <div style={{ fontSize: 9, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: valueColor ?? '#f9fafb' }}>{value || '—'}</div>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6b7280', marginBottom: 8, marginTop: 20 }}>
      {children}
    </div>
  );
}

function Pill({ text, color }: { text: string; color: string }) {
  return (
    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: `${color}22`, color, fontWeight: 700, border: `1px solid ${color}44` }}>
      {text}
    </span>
  );
}

// ─── Strategies: Text view ────────────────────────────────────────────────────

function TextPanel({ s }: { s: Strategy }) {
  const catColor = CATEGORY_COLOR[s.category];
  return (
    <div style={{ padding: '0 4px' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <StatChip label="Direction"   value={s.directionalAssumption} />
        <StatChip label="IV"          value={s.ivEnvironment} valueColor={ivColor(s.ivEnvironment)} />
        <StatChip label="DTE"         value={s.dte ? `${s.dte} days` : '—'} />
        <StatChip label="PoP"         value={s.probabilityOfProfit} valueColor="#22c55e" />
      </div>
      {s.setup.length > 0 && (
        <>
          <SectionHeader>Setup</SectionHeader>
          <div style={{ background: '#111827', borderRadius: 8, padding: '10px 14px', marginBottom: 4 }}>
            {s.setup.map((leg, i) => (
              <div key={i} style={{ fontSize: 12, color: '#d1d5db', padding: '3px 0', borderBottom: i < s.setup.length - 1 ? '1px solid #1f2937' : 'none' }}>
                {leg}
              </div>
            ))}
          </div>
        </>
      )}
      <SectionHeader>Risk / Reward</SectionHeader>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 4 }}>
        {[
          { label: 'Max Profit',    value: s.maxProfit,    color: '#22c55e' },
          { label: 'Max Loss',      value: s.maxLoss,      color: '#ef4444' },
          { label: 'Profit Target', value: s.profitTarget, color: '#34d399' },
          { label: 'Breakeven',     value: s.breakeven,    color: '#9ca3af' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: '#111827', borderRadius: 6, padding: '8px 12px' }}>
            <div style={{ fontSize: 9, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{label}</div>
            <div style={{ fontSize: 11, color, lineHeight: 1.4 }}>{value || '—'}</div>
          </div>
        ))}
      </div>
      <SectionHeader>Greeks</SectionHeader>
      <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
        {(['delta', 'vega', 'theta', 'gamma'] as const).map(g => (
          <div key={g} style={{ background: '#111827', borderRadius: 6, padding: '6px 12px', flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: '#6b7280', textTransform: 'uppercase', marginBottom: 3 }}>{g}</div>
            <div style={{ fontSize: 11, fontWeight: 700, color: greekColor(s.greeks[g]) }}>{s.greeks[g] || '—'}</div>
          </div>
        ))}
      </div>
      <SectionHeader>How the Trade Works</SectionHeader>
      {[
        { label: 'Ideal',             text: s.howItWorks.ideal,            icon: '✅' },
        { label: 'Not Ideal',         text: s.howItWorks.notIdeal,         icon: '⚠️' },
        { label: 'Defensive Tactics', text: s.howItWorks.defensiveTactics, icon: '🛡️' },
      ].filter(x => x.text).map(({ label, text, icon }) => (
        <div key={label} style={{ background: '#111827', borderRadius: 8, padding: '10px 14px', marginBottom: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', marginBottom: 4 }}>{icon} {label}</div>
          <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.6 }}>{text}</div>
        </div>
      ))}
      {(s.volatility.ifExpands || s.volatility.ifContracts) && (
        <>
          <SectionHeader>Volatility</SectionHeader>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 4 }}>
            {[
              { label: 'If IV Expands',   text: s.volatility.ifExpands },
              { label: 'If IV Contracts', text: s.volatility.ifContracts },
            ].filter(x => x.text).map(({ label, text }) => (
              <div key={label} style={{ background: '#111827', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.6 }}>{text}</div>
              </div>
            ))}
          </div>
        </>
      )}
      {(s.expiration.ifOTM || s.expiration.ifITM || s.expiration.other?.length > 0) && (
        <>
          <SectionHeader>At Expiration</SectionHeader>
          {[
            { label: 'If OTM', text: s.expiration.ifOTM },
            { label: 'If ITM', text: s.expiration.ifITM },
            ...(s.expiration.other ?? []).map((o, i) => ({ label: `Other (${i + 1})`, text: o })),
          ].filter(x => x.text).map(({ label, text }) => (
            <div key={label} style={{ background: '#111827', borderRadius: 8, padding: '10px 14px', marginBottom: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.6 }}>{text}</div>
            </div>
          ))}
        </>
      )}
      {s.takeaways.length > 0 && (
        <>
          <SectionHeader>Takeaways</SectionHeader>
          {s.takeaways.map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, background: '#111827', borderRadius: 8, padding: '10px 14px', marginBottom: 6 }}>
              <span style={{ color: catColor, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>→</span>
              <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.6 }}>{t}</div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ─── GLOSSARY data ────────────────────────────────────────────────────────────

type GlossarySection = 'direction' | 'long-short' | 'metrics' | 'pricing' | 'greeks' | 'volatility';

interface GlossaryTerm {
  term: string;
  abbrev?: string;
  definition: string;
  section: GlossarySection;
}

const GLOSSARY_SECTION_ORDER: GlossarySection[] = ['direction', 'long-short', 'metrics', 'pricing', 'greeks', 'volatility'];
const GLOSSARY_SECTION_LABELS: Record<GlossarySection, string> = {
  'direction':  '🧭 Directional & Market Outlook',
  'long-short': '↕ Long vs Short',
  'metrics':    '📊 Trade Metrics',
  'pricing':    '💰 Option Pricing',
  'greeks':     '🔢 The Greeks',
  'volatility': '🌊 Volatility',
};

const GLOSSARY_TERMS: GlossaryTerm[] = [
  // Directional
  {
    term: 'Directional Assumption',
    section: 'direction',
    definition: 'The outlook a trader chooses based on whether they want an underlying to increase (bullish), decrease (bearish), or remain unchanged in price (neutral). Directional assumption can be based on market awareness, statistical analysis, trading style, and more.',
  },
  {
    term: 'Being Bullish',
    section: 'direction',
    definition: 'A directional assumption that the price of an underlying will increase in price over a given timeframe.',
  },
  {
    term: 'Being Bearish',
    section: 'direction',
    definition: 'A directional assumption that the price of an underlying will decrease in price over a given timeframe.',
  },
  {
    term: 'IV Environment',
    abbrev: 'Implied Volatility Environment',
    section: 'direction',
    definition: 'Implied volatility (IV) in the market refers to the forecasted magnitude of potential movement away from the underlying price in a year\'s time. Low IV environments tell us the market isn\'t expecting much movement from the current stock price. High IV environments tell us the market expects large movements over the next twelve months. IV is not a static metric — it helps traders understand ranges from a statistical perspective for risk management and buying power.',
  },
  // Long vs Short
  {
    term: 'Being Long',
    section: 'long-short',
    definition: 'When you are long something, it means you purchased it (an option, a spread, a stock, a futures contract) to open the trade and you want it to increase in value. If you\'re long a put, you want the contract to increase in value with the stock price dropping. If you\'re long a call, you want it to increase in value with the stock price rising.',
  },
  {
    term: 'Being Short',
    section: 'long-short',
    definition: 'When you are short something, it means you sold it (an option, a spread, a stock, a futures contract) to open the trade and you want it to decrease in value. If you\'re short a put, you want the contract to decrease in value with the stock price rising or time passing. If you\'re short a call, you want it to decrease in value with the stock price dropping or time passing.',
  },
  // Metrics
  {
    term: 'Days to Expiration',
    abbrev: 'DTE',
    section: 'metrics',
    definition: 'The number of days until an option or futures contract expires. Unlike stocks or ETFs, options and futures have a date at which they cease to trade. Traders can select from shorter duration or longer-term trades based on their trading style, investment goals, and assumption over the given timeframe.',
  },
  {
    term: 'Probability of Profit',
    abbrev: 'PoP',
    section: 'metrics',
    definition: 'The likelihood of making at least $0.01 on a position. This metric can be altered based on strategy, strike selection, trade price, and more.',
  },
  {
    term: 'Maximum Profit',
    section: 'metrics',
    definition: 'The greatest possible amount a position can make. For credit trades (short options/spreads), max profit is the premium collected at open. For debit trades, max profit depends on how far in-the-money the position moves.',
  },
  {
    term: 'Maximum Loss',
    section: 'metrics',
    definition: 'The greatest possible amount a position can lose. Defined-risk strategies cap max loss at open (e.g., spreads). Undefined-risk strategies (short naked options) have theoretically unlimited loss potential.',
  },
  {
    term: 'Profit Target',
    section: 'metrics',
    definition: 'A feasible amount a trader can hope to make in a given position. The tastylive approach targets 50% of max profit for credit trades — this locks in gains while freeing up capital and reducing time at risk. Profit targets can be impacted by trade price, capital required, risk tolerance, and days in the trade.',
  },
  {
    term: 'Breakeven',
    section: 'metrics',
    definition: 'The price(s) at which a position is neither making nor losing money. There are different calculations for breakeven prices based on trade price (credit or debit paid), strategy complexity, and whether or not a position has been rolled. For a short put: breakeven = strike − credit received.',
  },
  // Pricing
  {
    term: 'Intrinsic Value',
    section: 'pricing',
    definition: 'The intrinsic value of an in-the-money (ITM) option is equal to the difference between the strike price and the market value of the underlying security. For example, the $35 strike call with the underlying at $40 has an intrinsic value of $5. Out-of-the-money (OTM) options have zero intrinsic value.',
  },
  {
    term: 'Extrinsic Value',
    section: 'pricing',
    definition: 'Also referred to as "time value" or "risk premium" — it is everything that is not intrinsic value. The extrinsic value of an option fluctuates based on supply and demand (the market price of volatility). Total Option Value = Extrinsic Value + Intrinsic Value. All extrinsic value goes to zero at expiration.',
  },
  {
    term: 'At-the-Money',
    abbrev: 'ATM',
    section: 'pricing',
    definition: 'An ATM option is a contract trading very close to the underlying price. For example, if XYZ is trading at $99.38 and the chain has $1-wide strikes, the ATM contracts are the $99 and $100 strikes. ATM strikes have the highest extrinsic value compared to OTM or ITM strikes because of the uncertainty of whether the option will be ITM at expiration.',
  },
  {
    term: 'Out-of-the-Money',
    abbrev: 'OTM',
    section: 'pricing',
    definition: 'An OTM option has no intrinsic value — it is purely extrinsic value. In call options, an OTM strike is above the underlying price. In put options, an OTM strike is below the underlying price. All extrinsic value goes away by expiration if the option remains OTM.',
  },
  {
    term: 'In-the-Money',
    abbrev: 'ITM',
    section: 'pricing',
    definition: 'An ITM option has real value at expiration to the option owner. In call options, an ITM strike is below the underlying price (you could exercise and immediately profit). In put options, an ITM strike is above the underlying price. ITM options have intrinsic value plus whatever extrinsic value remains.',
  },
  // Greeks
  {
    term: 'Delta',
    section: 'greeks',
    definition: 'The rate of change in an option\'s theoretical value for a $1 change in the price of the underlying security, all else equal. Delta ranges from 0 to 1 for calls and 0 to −1 for puts. Delta helps understand directional exposure, share equivalency in an options position, and can also be used as a proxy for estimating probability of expiring ITM.',
  },
  {
    term: 'Theta',
    section: 'greeks',
    definition: 'The rate of decay of an option\'s extrinsic value given a one-day passage of time, all else equal. Positive theta comes from option selling (time decay benefits the seller). Negative theta comes from option buying (decaying extrinsic value hurts the buyer). Since markets are constantly moving, theta is generally a weak contributor to daily changes in an option\'s price.',
  },
  {
    term: 'Vega',
    section: 'greeks',
    definition: 'The rate of change in an option\'s extrinsic value given a 1% change in implied volatility, all else equal. Long options have positive vega (benefit from IV increase). Short options have negative vega (benefit from IV decrease). Vega values depend on the strategy\'s strikes in relation to the underlying price and whether implied volatility is expanding or contracting.',
  },
  {
    term: 'Gamma',
    section: 'greeks',
    definition: 'The rate of change of an option\'s delta given a $1.00 move in the underlying, all else equal. Long option holders benefit from gamma. For option sellers, gamma can accelerate losses and decelerate directional gains — it is highest near ATM and near expiration.',
  },
  // Volatility
  {
    term: 'Volatility Expansion',
    section: 'volatility',
    definition: 'An increase in implied volatility, often signified by the widening of bid-ask spreads, increases in daily trading ranges, and rising VIX. Volatility expansion aids long premium trades (like debit spreads) and hinders short premium trades (like credit spreads). IV expansion is not dependent on price direction — only on the magnitude of price moves.',
  },
  {
    term: 'Volatility Contraction',
    section: 'volatility',
    definition: 'A reduction in implied volatility, with more compact trading ranges and cheaper option prices. Volatility contraction benefits short premium trades (like credit spreads) through "IV crush." This is particularly pronounced after binary events like earnings announcements when elevated pre-event IV collapses sharply.',
  },
  {
    term: 'IV Rank',
    abbrev: 'IVR',
    section: 'volatility',
    definition: 'A measure of where current implied volatility stands relative to its 52-week range. Formula: IVR = (IV_current − IV_low) / (IV_high − IV_low) × 100. An IVR of 0 means IV is at its yearly low; 100 means it\'s at its yearly high. Tastylive recommends selling premium when IVR > 50 and buying when IVR < 30.',
  },
];

// ─── CLASSIFICATIONS data ─────────────────────────────────────────────────────

interface ClassificationEntry {
  key: StrategyCategory;
  label: string;
  icon: string;
  color: string;
  tagline: string;
  summary: string;
  whenToUse: string[];
  rightConditions: string;
  ivPreference: string;
  examples: string[];
  riskNote: string;
  proTip: string;
}

const CLASSIFICATIONS: ClassificationEntry[] = [
  {
    key: 'bullish',
    label: 'Bullish',
    icon: '📈',
    color: '#22c55e',
    tagline: 'Price will rise — profit from upward movement',
    summary: 'A bullish strategy profits when the underlying asset\'s price increases. You have a positive delta — the position gains value as the stock moves up. Bullish trades range from simple (long calls) to premium-selling (short puts) depending on your conviction and IV environment.',
    whenToUse: [
      'Stock is in a confirmed uptrend (series of higher highs and higher lows)',
      'Price breaks out above a key resistance level with volume',
      'Positive catalyst ahead: earnings beat, product launch, analyst upgrade',
      'Sector showing leadership relative to the broader market (SPX/SPY)',
      'Oversold bounce from a key support level (RSI < 30, support zone holds)',
    ],
    rightConditions: 'SPX above its 50-day and 200-day moving averages. Individual stock above its 50-day MA. IVR moderate-to-low (< 30) favors long calls for leverage; IVR elevated (> 50) favors short puts or bull put spreads to collect inflated premium.',
    ivPreference: 'Low IV → debit (long calls). High IV → credit (short puts, bull put spreads).',
    examples: ['Long Call', 'Bull Call Spread', 'Short Put (Cash-Secured)', 'Bull Put Spread', 'Covered Call', 'LEAPS Call (stock replacement)'],
    riskNote: 'Loses value if the stock falls. Long calls have defined max loss (premium paid). Short puts have large downside if the stock collapses. Bull put spreads cap both profit and loss.',
    proTip: 'Combine elevated IVR (>30) with a bullish thesis using a short put or bull put spread. You collect inflated premium while defining your bullish entry point — this is the highest-PoP way to express a bullish view.',
  },
  {
    key: 'bearish',
    label: 'Bearish',
    icon: '📉',
    color: '#ef4444',
    tagline: 'Price will fall — profit from downward movement',
    summary: 'A bearish strategy profits when the underlying asset\'s price decreases. You have a negative delta — the position gains value as the stock moves down. Important caveat: markets have a long-term upward bias, so bearish trades require more confirmation than bullish trades and are typically shorter in duration.',
    whenToUse: [
      'Stock breaks below a key support level with increasing volume',
      'Failed rally at resistance — price tests a level multiple times and is rejected',
      'Negative catalyst: earnings miss, guidance cut, downgrade, regulatory issue',
      'Death cross (50-day MA crosses below 200-day MA) on a major holding',
      'Sector rotation out — institutional money leaving a weak sector',
    ],
    rightConditions: 'SPX below its 50-day MA or showing distribution (heavy volume on down days). Individual stock below 50-day MA, failing to recover previous support levels. VIX elevated (> 20) suggests market turbulence and makes bearish trades more timely. IVR elevated favors credit strategies (bear call spreads); IVR low favors debit (long puts).',
    ivPreference: 'Low IV → debit (long puts). High IV → credit (short calls, bear call spreads).',
    examples: ['Long Put', 'Bear Put Spread', 'Short Call', 'Bear Call Spread', 'Short Stock (advanced)'],
    riskNote: 'Short naked calls have theoretically unlimited risk if the stock spikes. Long puts have defined loss (premium paid). Bear call spreads cap both sides. Time is the enemy on long puts — use appropriate DTE (45+ days).',
    proTip: 'The market trends up ~70% of calendar days. Use bear call spreads above resistance instead of naked short calls — you cap your max loss and define the trade. Set a hard stop at 2× the premium received.',
  },
  {
    key: 'omnidirectional',
    label: 'Omnidirectional',
    icon: '↔️',
    color: '#a78bfa',
    tagline: 'A large move is coming — direction unknown',
    summary: 'Omnidirectional strategies profit from significant price movement in either direction. You profit if the stock makes a large move up OR down — what matters is the magnitude of the move, not the direction. These are typically long-premium (debit) strategies that benefit from volatility expansion.',
    whenToUse: [
      'Known binary event approaching: earnings announcement, FDA decision, FOMC meeting, legal ruling',
      'Stock is in a tight consolidation (coiling pattern) with a breakout imminent',
      'Technical setup like a symmetrical triangle where direction is unclear',
      'High conviction that the stock will move significantly but no directional edge',
      'Implied volatility is still relatively low before a catalyst (IV not yet priced in)',
    ],
    rightConditions: 'The critical factor is IV timing. You are BUYING options — you want IV to be low at entry so you are not overpaying. The ideal setup is a known catalyst ahead with IV that has not yet spiked. Avoid buying straddles/strangles 1-2 weeks before earnings when IV has already doubled — you will suffer IV crush even if the stock moves.',
    ivPreference: 'Low-to-moderate IV at entry. You need the subsequent move to exceed the "expected move" (≈ strangle width × 0.68) to profit.',
    examples: ['Long Straddle (ATM call + ATM put, same expiry)', 'Long Strangle (OTM call + OTM put, same expiry)', 'Reverse Iron Condor', 'Long Calendar (to finance the structure)'],
    riskNote: 'If the underlying doesn\'t move enough to overcome the total premium paid, the trade loses. "IV crush" after a binary event can cause losses even if the stock moves in the right direction — this happens when the move is smaller than the implied expected move.',
    proTip: 'Use the expected move as your guide. If the ATM straddle costs $5, the market implies the stock will move ±$5. You need a move larger than that to profit. Buy 6-8 weeks out to give yourself runway, and avoid entering when IVR > 60.',
  },
  {
    key: 'neutral',
    label: 'Neutral',
    icon: '⚖️',
    color: '#60a5fa',
    tagline: 'No large move expected — collect premium from time decay',
    summary: 'Neutral strategies profit when the underlying stays within a defined range. You have near-zero net delta and positive theta — time decay is your friend. These are the highest-probability trades in options: an iron condor at 1 standard deviation has ~68% PoP. Neutral strategies are the core of premium-selling approaches.',
    whenToUse: [
      'Stock is in a clearly defined trading range between support and resistance',
      'No major catalyst expected in the near term (post-earnings, between events)',
      'IV is elevated — you are selling overpriced options (IVR > 50)',
      'After a large volatile move, expecting the stock to "mean revert" and settle',
      'Broad market is choppy and range-bound (VIX elevated but not spiking)',
    ],
    rightConditions: 'IVR > 50 is the gold standard for selling premium. The higher the IV rank, the more premium you collect relative to historical norms. Post-earnings is often the ideal entry — IV crushes after the announcement and the stock typically settles into a range. 30-45 DTE is the sweet spot for theta decay to accelerate.',
    ivPreference: 'High IV (IVR > 50). You are short vega — IV contraction adds to your P&L. The tastylive mechanical rule: sell premium when IVR > 50.',
    examples: ['Iron Condor', 'Iron Butterfly', 'Short Strangle', 'Short Straddle', 'Jade Lizard', 'Short Call Spread + Short Put Spread'],
    riskNote: 'A large unexpected move in either direction is the biggest risk. Short strangles/straddles have undefined risk on both sides. Iron condors and butterflies cap max loss but also cap max profit. Manage losers at 2× the premium received to avoid catastrophic losses.',
    proTip: 'Tastylive\'s research shows closing winners at 50% of max profit improves risk-adjusted returns. The last 50% of potential profit takes much longer to capture and exposes you to event risk. Take the "sure thing" early and redeploy the capital.',
  },
  {
    key: 'neutral-bullish',
    label: 'Neutral-Bullish',
    icon: '📊',
    color: '#34d399',
    tagline: 'Mildly bullish or flat — premium selling with an upside tilt',
    summary: 'Neutral-bullish strategies are primarily premium sellers with a slight bullish bias. The position profits most from time decay and IV contraction, but also benefits from modest upward movement. The "neutral" part means you are comfortable if the stock goes sideways; the "bullish" part means you tolerate — and actually profit more — if it rises.',
    whenToUse: [
      'Mildly bullish fundamental or technical outlook but not high conviction on direction',
      'Stock is above key support and you expect it to hold or grind higher',
      'You want to collect premium while defining a bullish entry point (short put)',
      'Covered call scenario — you own stock and want to generate income against it',
      'Wheel strategy — systematic premium selling on stocks you are comfortable owning',
    ],
    rightConditions: 'Stock above its 50-day and 200-day moving averages (healthy trend). IVR > 30-40 to justify selling premium. No near-term negative catalyst. Fundamentally solid company — you are willing to own shares if the put gets assigned.',
    ivPreference: 'Elevated IV (IVR > 30). The higher the IV, the more premium you collect on the short put or bull put spread.',
    examples: ['Short Put (CSP)', 'Bull Put Spread', 'Covered Call', 'Wheel Strategy', 'Jade Lizard', 'Short Put Vertical'],
    riskNote: 'Sharp downside is the primary risk — the stock gaps down on bad news. Short puts have large (but defined by zero) downside if the stock collapses. Bull put spreads cap the max loss at the spread width minus premium received. Always ask: "Am I comfortable owning this stock at this price?"',
    proTip: 'The short put / CSP is the workhorse of neutral-bullish trading. Select a strike at or below a key support level, at a delta of −0.20 to −0.30, for 30-45 DTE. This gives you ~70-80% PoP and a defined bullish entry point if assigned.',
  },
  {
    key: 'neutral-bearish',
    label: 'Neutral-Bearish',
    icon: '📉',
    color: '#f97316',
    tagline: 'Mildly bearish or flat — premium selling with a downside tilt',
    summary: 'Neutral-bearish strategies are primarily premium sellers with a slight bearish bias. The position profits most from time decay and IV contraction, but also benefits from modest downward movement or stagnation. The "neutral" part means you profit if the stock sits still; the "bearish" part means you expect the stock to face headwinds and be capped at overhead resistance.',
    whenToUse: [
      'Mildly bearish technical or fundamental outlook — stock looks "tired" at resistance',
      'Stock has run up significantly and you expect it to consolidate or pull back slightly',
      'Overhead resistance is clearly defined and the stock has failed to break through it multiple times',
      'Sector is showing weakness relative to the broader market',
      'You want to collect premium from an overextended, elevated stock',
    ],
    rightConditions: 'Stock near or at identifiable resistance (previous highs, key moving average from above, trendline). IVR elevated (> 30-40) to justify selling premium. No imminent positive catalyst (earnings beat, buyout rumor) that could cause a breakout. VIX environment: manageable (15-25), not in a panic spike.',
    ivPreference: 'Elevated IV (IVR > 30). Higher IV means higher premium collected on the short call or bear call spread.',
    examples: ['Short Call', 'Bear Call Spread', 'Short Call Vertical', 'Inverse Jade Lizard'],
    riskNote: 'Sharp upside — if the stock breaks out or receives a buyout offer, naked short calls have unlimited risk. Always use bear call spreads (defined risk) rather than naked short calls unless you are an experienced trader managing positions actively. Set max loss at 2× premium received.',
    proTip: 'The bear call spread above resistance is the highest-PoP way to express a neutral-bearish view with defined risk. Sell the call just above resistance, buy the call one spread-width higher. Collect premium if the stock stays below resistance through expiration.',
  },
];

// ─── Glossary Panel ───────────────────────────────────────────────────────────

function GlossaryPanel() {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return GLOSSARY_TERMS;
    return GLOSSARY_TERMS.filter(t =>
      t.term.toLowerCase().includes(q) ||
      (t.abbrev?.toLowerCase().includes(q) ?? false) ||
      t.definition.toLowerCase().includes(q),
    );
  }, [search]);

  const bySection = useMemo(() => {
    const map = new Map<GlossarySection, GlossaryTerm[]>();
    for (const s of GLOSSARY_SECTION_ORDER) map.set(s, []);
    for (const t of filtered) map.get(t.section)!.push(t);
    return map;
  }, [filtered]);

  const hasResults = filtered.length > 0;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Search bar */}
      <div style={{ padding: '12px 24px', borderBottom: '1px solid #1f2937', flexShrink: 0 }}>
        <input
          type="text"
          placeholder="Search terms…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            width: 320, boxSizing: 'border-box', padding: '6px 12px',
            fontSize: 12, background: '#1f2937', border: '1px solid #374151',
            borderRadius: 6, color: '#f9fafb', outline: 'none',
          }}
        />
        <span style={{ marginLeft: 12, fontSize: 11, color: '#6b7280' }}>
          {filtered.length} of {GLOSSARY_TERMS.length} terms
        </span>
      </div>

      {/* Terms */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 24px 24px' }}>
        {!hasResults && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: '#6b7280', fontSize: 13 }}>
            No matching terms found.
          </div>
        )}
        {GLOSSARY_SECTION_ORDER.map(sec => {
          const terms = bySection.get(sec)!;
          if (terms.length === 0) return null;
          return (
            <div key={sec}>
              <div style={{
                fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.08em', color: '#6b7280',
                padding: '20px 0 10px',
                borderBottom: '1px solid #1f2937',
                marginBottom: 12,
              }}>
                {GLOSSARY_SECTION_LABELS[sec]}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 10, marginBottom: 4 }}>
                {terms.map(t => (
                  <div key={t.term} style={{
                    background: '#111827', borderRadius: 8,
                    padding: '12px 16px',
                    border: '1px solid #1f2937',
                  }}>
                    <div style={{ marginBottom: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#f9fafb' }}>{t.term}</span>
                      {t.abbrev && (
                        <span style={{
                          marginLeft: 8, fontSize: 10, fontWeight: 700,
                          background: '#1f2937', color: '#9ca3af',
                          padding: '1px 6px', borderRadius: 3,
                        }}>
                          {t.abbrev}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.65 }}>
                      {t.definition}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {/* Attribution */}
        <div style={{ marginTop: 24, padding: '12px 16px', background: '#0f1623', borderRadius: 8, fontSize: 11, color: '#4b5563' }}>
          Definitions sourced from the tastylive Options Strategy Guide (pp. 36–37) with supplementary context.
          For more terms see{' '}
          <span style={{ color: '#60a5fa' }}>tastylive.com</span>.
        </div>
      </div>
    </div>
  );
}

// ─── Classifications Panel ────────────────────────────────────────────────────

function ClassificationsPanel() {
  const [active, setActive] = useState<StrategyCategory | null>(null);

  const selected = active ? CLASSIFICATIONS.find(c => c.key === active) : null;

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden' }}>

      {/* Left: category picker */}
      <div style={{
        width: 200, flexShrink: 0,
        background: '#111827',
        borderRight: '1px solid #1f2937',
        display: 'flex', flexDirection: 'column',
        padding: '12px 0',
        overflowY: 'auto',
      }}>
        <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#4b5563', padding: '0 12px 10px' }}>
          Strategy Classification
        </div>
        {CLASSIFICATIONS.map(c => (
          <button
            key={c.key}
            onClick={() => setActive(c.key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              width: '100%', textAlign: 'left',
              padding: '8px 12px 8px 14px', border: 'none',
              fontSize: 12, cursor: 'pointer',
              color: active === c.key ? '#f9fafb' : '#9ca3af',
              background: active === c.key ? `${c.color}18` : 'transparent',
              borderLeft: active === c.key ? `3px solid ${c.color}` : '3px solid transparent',
            }}
          >
            <span>{c.icon}</span>
            <div>
              <div style={{ fontWeight: active === c.key ? 700 : 400 }}>{c.label}</div>
              <div style={{ fontSize: 9, color: '#6b7280', marginTop: 1, lineHeight: 1.3 }}>{c.tagline.split('—')[0]?.trim() ?? c.tagline}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Right: detail or empty state */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0' }}>
        {!selected ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#6b7280' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📚</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: '#9ca3af' }}>Select a Classification</div>
            <div style={{ fontSize: 12, textAlign: 'center', maxWidth: 320, lineHeight: 1.6 }}>
              Choose a strategy classification from the left to learn when to use it, what market conditions it thrives in, and which strategies fall under it.
            </div>
          </div>
        ) : (
          <ClassificationDetail entry={selected} />
        )}
      </div>
    </div>
  );
}

function ClassificationDetail({ entry: e }: { entry: ClassificationEntry }) {
  return (
    <div style={{ padding: '20px 28px 32px' }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20,
        paddingBottom: 16, borderBottom: `2px solid ${e.color}33`,
      }}>
        <span style={{ fontSize: 36 }}>{e.icon}</span>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#f9fafb' }}>{e.label}</h2>
            <span style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 4,
              background: `${e.color}22`, color: e.color,
              fontWeight: 700, border: `1px solid ${e.color}44`,
            }}>
              {e.key.toUpperCase()}
            </span>
          </div>
          <div style={{ fontSize: 13, color: '#9ca3af', fontStyle: 'italic' }}>{e.tagline}</div>
        </div>
      </div>

      {/* Summary */}
      <div style={{ background: '#111827', borderRadius: 8, padding: '14px 16px', marginBottom: 20, borderLeft: `3px solid ${e.color}` }}>
        <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.7 }}>{e.summary}</div>
      </div>

      {/* 2-column grid for the detail sections */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

        {/* When to use */}
        <div style={{ background: '#111827', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: e.color, marginBottom: 10 }}>
            ✅ When to Use
          </div>
          <ul style={{ margin: 0, padding: '0 0 0 16px' }}>
            {e.whenToUse.map((w, i) => (
              <li key={i} style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.6, marginBottom: 4 }}>{w}</li>
            ))}
          </ul>
        </div>

        {/* Right conditions */}
        <div style={{ background: '#111827', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: e.color, marginBottom: 10 }}>
            🎯 Right Market Conditions
          </div>
          <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.7 }}>{e.rightConditions}</div>
          <div style={{ marginTop: 10, padding: '8px 12px', background: '#1f2937', borderRadius: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280' }}>IV Preference: </span>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>{e.ivPreference}</span>
          </div>
        </div>

      </div>

      {/* Strategy examples */}
      <div style={{ background: '#111827', borderRadius: 8, padding: '14px 16px', marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: e.color, marginBottom: 10 }}>
          📋 Strategy Examples
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {e.examples.map(ex => (
            <span key={ex} style={{
              fontSize: 12, padding: '4px 10px', borderRadius: 5,
              background: `${e.color}15`, color: e.color,
              border: `1px solid ${e.color}33`, fontWeight: 600,
            }}>
              {ex}
            </span>
          ))}
        </div>
      </div>

      {/* Risk + Pro tip */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

        <div style={{ background: '#111827', borderRadius: 8, padding: '14px 16px', borderLeft: '3px solid #ef4444' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#ef4444', marginBottom: 8 }}>
            ⚠️ Risk Note
          </div>
          <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.7 }}>{e.riskNote}</div>
        </div>

        <div style={{ background: '#111827', borderRadius: 8, padding: '14px 16px', borderLeft: '3px solid #facc15' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#facc15', marginBottom: 8 }}>
            💡 Pro Tip
          </div>
          <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.7 }}>{e.proTip}</div>
        </div>

      </div>

    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

type KnowledgeTab = 'strategies' | 'glossary' | 'classifications';

export function KnowledgeView() {
  const [tab, setTab]                         = useState<KnowledgeTab>('strategies');
  const [drawerOpen, setDrawerOpen]           = useState(true);
  const [activeSlug, setActiveSlug]           = useState<string>(STRATEGIES[0]?.slug ?? '');
  const [viewMode, setViewMode]               = useState<'image' | 'text'>('image');
  const [search, setSearch]                   = useState('');

  const active = useMemo(
    () => STRATEGIES.find(s => s.slug === activeSlug) ?? STRATEGIES[0],
    [activeSlug],
  );

  const filteredByCategory = useMemo(() => {
    const q = search.toLowerCase();
    const result: Partial<Record<StrategyCategory, Strategy[]>> = {};
    for (const cat of CATEGORY_ORDER) {
      const matches = STRATEGIES_BY_CATEGORY[cat].filter(s =>
        !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
      );
      if (matches.length) result[cat] = matches;
    }
    return result;
  }, [search]);

  const catColor = active ? CATEGORY_COLOR[active.category] : '#6b7280';

  const TAB_ITEMS: { id: KnowledgeTab; label: string; icon: string }[] = [
    { id: 'strategies',      label: 'Strategies',      icon: '📋' },
    { id: 'glossary',        label: 'Glossary',         icon: '📖' },
    { id: 'classifications', label: 'Classifications',  icon: '🏷️' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>

      {/* ── Top tab bar ─────────────────────────────────────────────────────── */}
      <div style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        padding: '0 16px',
        borderBottom: '1px solid #1f2937',
        background: '#0f172a',
        height: 40,
      }}>
        {TAB_ITEMS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              height: '100%',
              padding: '0 18px',
              border: 'none',
              borderBottom: tab === t.id ? '2px solid var(--accent, #6366f1)' : '2px solid transparent',
              background: 'transparent',
              color: tab === t.id ? '#f9fafb' : '#6b7280',
              fontWeight: tab === t.id ? 700 : 400,
              fontSize: 12,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            <span>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Tab content ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex' }}>

        {/* ── STRATEGIES tab ── */}
        {tab === 'strategies' && (
          <>
            {/* Collapsible left drawer */}
            <div style={{
              width: drawerOpen ? 220 : 36,
              flexShrink: 0,
              transition: 'width 0.2s ease',
              background: '#111827',
              borderRight: '1px solid #1f2937',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}>
              <button
                onClick={() => setDrawerOpen(o => !o)}
                title={drawerOpen ? 'Collapse' : 'Expand strategy list'}
                style={{
                  flexShrink: 0, height: 36, background: 'none', border: 'none',
                  borderBottom: '1px solid #1f2937', color: '#6b7280', cursor: 'pointer',
                  fontSize: 14, display: 'flex', alignItems: 'center',
                  justifyContent: drawerOpen ? 'flex-end' : 'center',
                  paddingRight: drawerOpen ? 10 : 0,
                }}
              >
                {drawerOpen ? '◀' : '▶'}
              </button>

              {drawerOpen && (
                <>
                  <div style={{ padding: '8px 10px', flexShrink: 0 }}>
                    <input
                      type="text"
                      placeholder="Search strategies…"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      style={{
                        width: '100%', boxSizing: 'border-box',
                        padding: '5px 8px', fontSize: 11,
                        background: '#1f2937', border: '1px solid #374151',
                        borderRadius: 4, color: '#f9fafb', outline: 'none',
                      }}
                    />
                  </div>
                  <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
                    {CATEGORY_ORDER.map(cat => {
                      const strategies = filteredByCategory[cat];
                      if (!strategies) return null;
                      return (
                        <div key={cat}>
                          <div style={{
                            fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
                            letterSpacing: '0.08em', padding: '10px 12px 4px',
                            color: CATEGORY_COLOR[cat],
                          }}>
                            {CATEGORY_LABELS[cat]}
                          </div>
                          {strategies.map(s => (
                            <button
                              key={s.slug}
                              onClick={() => setActiveSlug(s.slug)}
                              style={{
                                display: 'block', width: '100%', textAlign: 'left',
                                padding: '6px 12px 6px 16px', border: 'none',
                                fontSize: 11, cursor: 'pointer', lineHeight: 1.3,
                                color: activeSlug === s.slug ? '#f9fafb' : '#9ca3af',
                                background: activeSlug === s.slug
                                  ? `${CATEGORY_COLOR[s.category]}18`
                                  : 'transparent',
                                borderLeft: activeSlug === s.slug
                                  ? `2px solid ${CATEGORY_COLOR[s.category]}`
                                  : '2px solid transparent',
                              }}
                            >
                              {s.name}
                            </button>
                          ))}
                        </div>
                      );
                    })}
                    {Object.keys(filteredByCategory).length === 0 && (
                      <div style={{ fontSize: 11, color: '#6b7280', padding: '16px 12px' }}>No matches</div>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Content panel */}
            {active && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
                <div style={{
                  flexShrink: 0, padding: '12px 20px',
                  borderBottom: '1px solid #1f2937',
                  display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#f9fafb' }}>{active.name}</h2>
                      <Pill text={CATEGORY_LABELS[active.category]} color={catColor} />
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {active.description}
                    </div>
                  </div>
                  <div style={{
                    display: 'flex', background: '#1f2937', borderRadius: 6,
                    border: '1px solid #374151', overflow: 'hidden', flexShrink: 0,
                  }}>
                    {(['image', 'text'] as const).map(mode => (
                      <button
                        key={mode}
                        onClick={() => setViewMode(mode)}
                        style={{
                          padding: '5px 14px', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600,
                          background: viewMode === mode ? catColor : 'transparent',
                          color: viewMode === mode ? '#fff' : '#9ca3af',
                          transition: 'background 0.15s',
                        }}
                      >
                        {mode === 'image' ? '🖼 Image' : '📄 Text'}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
                  {viewMode === 'image' ? (
                    <img
                      src={imageUrl(active.slug)}
                      alt={active.name}
                      style={{ width: '100%', height: 'auto', borderRadius: 8, display: 'block' }}
                    />
                  ) : (
                    <TextPanel s={active} />
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* ── GLOSSARY tab ── */}
        {tab === 'glossary' && (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <GlossaryPanel />
          </div>
        )}

        {/* ── CLASSIFICATIONS tab ── */}
        {tab === 'classifications' && (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <ClassificationsPanel />
          </div>
        )}

      </div>
    </div>
  );
}
