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
    label: 'IV Low',
    description: 'IV below 20% — low premium environment, consider waiting for higher IV before selling options. Uses IV rank if available, otherwise current ATM IV.',
    category: 'volatility',
    icon: '📉',
    dataNeeded: ['quote', 'options'],
    metricColumns: { ivRank: 'IV %' }
  },
  {
    id: 'iv_rank_high',
    label: 'IV High',
    description: 'IV above 35% — elevated premium, good for CSPs / CCs. Uses IV rank if available, otherwise current ATM IV.',
    category: 'volatility',
    icon: '📈',
    dataNeeded: ['quote', 'options'],
    metricColumns: { ivRank: 'IV %', currentIv: 'Current IV %' }
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