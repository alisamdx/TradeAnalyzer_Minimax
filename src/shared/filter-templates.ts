// Filter template definitions — pre-built criteria that scan watchlist tickers.
// Each template specifies what data it needs and a human-readable condition.
// The actual condition logic lives in FilterTemplatesService on the main side.

export type FilterCategory = 'technical' | 'volatility' | 'options' | 'wheel';

export type DataNeeded = 'quote' | 'bars' | 'fundamentals' | 'options';

export interface FilterTemplate {
  id: string;
  label: string;
  description: string;
  category: FilterCategory;
  icon: string;
  dataNeeded: DataNeeded[];
  /** Column definitions for the results table (key → display label). */
  metricColumns: Record<string, string>;
}

export interface FilterTemplateResult {
  ticker: string;
  /** Watchlist name(s) this ticker belongs to. */
  watchlists: string[];
  lastPrice: number | null;
  /** Template-specific metric values (e.g., rsi, ivRank). String values (e.g. an expiry date)
   *  are shown as-is and sort lexically. */
  metrics: Record<string, number | string | null>;
  /** Human-readable reason why this ticker matched. */
  matchReason: string;
}

// Bump whenever the cached result shape (columns / metrics) OR the filter logic changes
// materially, so cached runs written by an older build are discarded instead of shown
// (avoids blank new columns, or stale results a new gate would now exclude).
// Shared by the renderer's localStorage day-cache and the filter_template_runs DB rows.
export const FILTER_RESULTS_SHAPE_VERSION = 5;

// ─── Built-in template definitions ────────────────────────────────────────────

export const FILTER_TEMPLATES: FilterTemplate[] = [
  {
    id: 'rsi_overbought',
    label: 'RSI Overbought',
    description: 'RSI crosses above 70 — potential pullback signal',
    category: 'technical',
    icon: '📈',
    dataNeeded: ['bars'],
    metricColumns: { rsi: 'RSI' }
  },
  {
    id: 'rsi_oversold',
    label: 'RSI Oversold',
    description: 'RSI drops below 30 — potential bounce signal',
    category: 'technical',
    icon: '📉',
    dataNeeded: ['bars'],
    metricColumns: { rsi: 'RSI' }
  },
  {
    id: 'iv_rank_low',
    label: 'IV Low',
    description: 'IV Rank below 20 — cheap options, consider buying or waiting for IV expansion before selling premium.',
    category: 'volatility',
    icon: '📉',
    dataNeeded: ['quote', 'options'],
    metricColumns: { ivRank: 'IV Rank', currentIv: 'IV %' }
  },
  {
    id: 'iv_rank_high',
    label: 'IV High',
    description: 'IV Rank above 70 — elevated premium, good for CSPs / covered calls / selling premium.',
    category: 'volatility',
    icon: '📈',
    dataNeeded: ['quote', 'options'],
    metricColumns: { ivRank: 'IV Rank', currentIv: 'IV %' }
  },
  {
    id: 'price_alert',
    label: 'Price Alert',
    description: 'Stock near key SMA levels or SMA crossovers (golden/death cross)',
    category: 'technical',
    icon: '🎯',
    dataNeeded: ['bars', 'quote'],
    metricColumns: { priceVsSma50: '% vs SMA50', priceVsSma200: '% vs SMA200' }
  },
  {
    id: 'assignment_risk',
    label: 'Assignment Risk',
    description: 'Short option delta above 0.70 — assignment likely',
    category: 'options',
    icon: '⚠️',
    dataNeeded: ['options'],
    metricColumns: { delta: 'Delta', strike: 'Strike', dte: 'DTE' }
  },
  {
    id: 'wheel_opportunity',
    label: 'Wheel Opportunity',
    description: 'High suitability score (≥ 60) — good wheel candidate',
    category: 'wheel',
    icon: '🔄',
    dataNeeded: ['fundamentals', 'quote'],
    metricColumns: { suitabilityScore: 'Score', currentIv: 'IV %', targetStrike: 'Target Strike' }
  },
  {
    id: 'wheel_vetted',
    label: 'Wheel (Vetted)',
    description: 'Two-stage: good foundation (score ≥ 70), then a monthly-expiry liquidity check on the ~0.30Δ put (open interest ≥ 100, tight spread, real premium). Deeper scan — fetches option chains for survivors.',
    category: 'wheel',
    icon: '✅',
    dataNeeded: ['fundamentals', 'quote', 'options'],
    metricColumns: { suitabilityScore: 'Score', currentIv: 'IV %', expiry: 'Expiry', putStrike: 'Put Strike', credit: 'Credit', annualizedReturn: 'Ann %', riskAdjustedReturn: 'Risk-Adj %', openInterest: 'OI', spread: 'Spread' }
  }
];