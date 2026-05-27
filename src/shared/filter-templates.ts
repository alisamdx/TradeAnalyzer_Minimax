// Filter template definitions — pre-built criteria that scan watchlist tickers.
// Each template specifies what data it needs and a human-readable condition.
// The actual condition logic lives in FilterTemplatesService on the main side.

export type FilterCategory = 'technical' | 'volatility' | 'earnings' | 'options' | 'wheel';

export type DataNeeded = 'quote' | 'bars' | 'fundamentals' | 'options' | 'earnings';

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
  /** Template-specific metric values (e.g., rsi, ivRank). */
  metrics: Record<string, number | null>;
  /** Human-readable reason why this ticker matched. */
  matchReason: string;
}

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
    label: 'IV Rank Low',
    description: 'IV rank below 20 — good CSP entry (low premium)',
    category: 'volatility',
    icon: '📉',
    dataNeeded: ['quote'],
    metricColumns: { ivRank: 'IV Rank %' }
  },
  {
    id: 'iv_rank_high',
    label: 'IV Rank High',
    description: 'IV rank above 70 — good CC entry or CSP exit (high premium)',
    category: 'volatility',
    icon: '📈',
    dataNeeded: ['quote'],
    metricColumns: { ivRank: 'IV Rank %', currentIv: 'Current IV %' }
  },
  {
    id: 'earnings_approaching',
    label: 'Earnings Approaching',
    description: 'Earnings within 14 days — avoid or prepare',
    category: 'earnings',
    icon: '📅',
    dataNeeded: ['earnings'],
    metricColumns: { daysToEarnings: 'Days to Earnings' }
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
  }
];