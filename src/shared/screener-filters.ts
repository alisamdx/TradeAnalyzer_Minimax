// Filter spec definitions for the ScreenerView — shared so tests can import them too.
// Mirrored here and in the screener service (Phase ≥ 3 will extract to a shared module).
// see SPEC: §5.2.2 table

export interface FilterSpec {
  id: string;
  label: string;
  defaultMin: number;
  defaultMax: number;
  defaultEnabled: boolean;
  format: 'percent' | 'ratio' | 'dollars' | 'count' | 'bool';
  description: string;
}

export const DEFAULT_FILTER_SPECS: FilterSpec[] = [
  { id: 'market_cap',       label: 'Market Cap',         defaultMin: 10_000_000_000, defaultMax: Infinity,    defaultEnabled: true,  format: 'dollars', description: '≥ $10B — large-cap only' },
  { id: 'pe_ratio',         label: 'P/E Ratio',           defaultMin: 5,              defaultMax: 30,          defaultEnabled: true,  format: 'ratio',   description: '5–30: profitable but not stretched' },
  { id: 'eps',              label: 'EPS (TTM)',            defaultMin: 0.01,          defaultMax: Infinity,    defaultEnabled: true,  format: 'dollars', description: '> 0: profitable today' },
  { id: 'revenue_growth',   label: 'Revenue Growth YoY',  defaultMin: 5,             defaultMax: Infinity,    defaultEnabled: true,  format: 'percent', description: '≥ 5%: top line growing' },
  { id: 'eps_growth',       label: 'EPS Growth YoY',       defaultMin: 5,             defaultMax: Infinity,    defaultEnabled: true,  format: 'percent', description: '≥ 5%: earnings growing with or ahead of revenue' },
  { id: 'debt_to_equity',   label: 'Debt / Equity',        defaultMin: 0,             defaultMax: 1.5,         defaultEnabled: true,  format: 'ratio',   description: '< 1.5: manageable leverage (financials exempt)' },
  { id: 'roe',              label: 'ROE',                 defaultMin: 15,            defaultMax: Infinity,    defaultEnabled: true,  format: 'percent', description: '≥ 15%: capital efficient' },
  { id: 'profit_margin',    label: 'Profit Margin',       defaultMin: 8,             defaultMax: Infinity,    defaultEnabled: true,  format: 'percent', description: '≥ 8%: pricing power and operational discipline' },
  { id: 'free_cash_flow',   label: 'Free Cash Flow',      defaultMin: 0,             defaultMax: Infinity,    defaultEnabled: true,  format: 'dollars', description: 'Positive TTM: real cash, not just earnings' },
  { id: 'current_ratio',    label: 'Current Ratio',       defaultMin: 1.0,          defaultMax: Infinity,    defaultEnabled: true,  format: 'ratio',   description: '≥ 1.0: can cover short-term obligations' },
  { id: 'avg_volume',       label: 'Avg Daily Volume',     defaultMin: 1_000_000,    defaultMax: Infinity,    defaultEnabled: true,  format: 'count',   description: '≥ 1M shares: liquidity floor' },
  { id: 'avg_option_vol',   label: 'Avg Option Volume',   defaultMin: 1_000,        defaultMax: Infinity,    defaultEnabled: false, format: 'count',   description: '≥ 1,000 contracts: options tradeable' },
  { id: 'price',            label: 'Price',              defaultMin: 20,            defaultMax: Infinity,    defaultEnabled: true,  format: 'dollars', description: '≥ $20: wheel/CSP math gets thin below this' },
  { id: 'dist_52wk_high',   label: 'Dist. 52-wk High',   defaultMin: 0,             defaultMax: 25,          defaultEnabled: true,  format: 'percent', description: 'Within 25%: healthy uptrend' },
  { id: 'dist_52wk_low',    label: 'Dist. 52-wk Low',    defaultMin: 15,            defaultMax: Infinity,    defaultEnabled: true,  format: 'percent', description: '≥ 15%: not at the bottom of a freefall' },
  { id: 'beta',             label: 'Beta',               defaultMin: 0.7,           defaultMax: 1.6,         defaultEnabled: true,  format: 'ratio',   description: '0.7–1.6: excludes flatliners and meme-vol names' },
  { id: 'exclude_earnings', label: 'Earnings ≤ 7 days',  defaultMin: 0,             defaultMax: 7,           defaultEnabled: false, format: 'bool',    description: 'Exclude if earnings within 7 days (toggle)' },
  { id: 'sector_exclude',   label: 'Sector Exclude',     defaultMin: 0,             defaultMax: 0,           defaultEnabled: false, format: 'bool',    description: 'Exclude listed sectors' },
];