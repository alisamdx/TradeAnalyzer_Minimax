// Filter spec definitions for the ScreenerView — shared so tests can import them too.
// Mirrored here and in the screener service (Phase ≥ 3 will extract to a shared module).
// see SPEC: §5.2.2 table
//
// NOTE: Filters that require data not available from Polygon API have been removed:
// - avg_option_vol (option volume not available)
// - beta (beta not available from Polygon)
// - exclude_earnings (earnings dates not available)

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
  { id: 'market_cap',       label: 'Market Cap',         defaultMin: 2_000_000_000,  defaultMax: Infinity,    defaultEnabled: true,  format: 'dollars', description: '≥ $2B — Mid and Large-cap companies' },
  { id: 'pe_ratio',         label: 'P/E Ratio',           defaultMin: 0,              defaultMax: 50,          defaultEnabled: true,  format: 'ratio',   description: '0–50: profitable and not wildly overvalued' },
  { id: 'eps',              label: 'EPS (TTM)',            defaultMin: 0.01,          defaultMax: Infinity,    defaultEnabled: true,  format: 'dollars', description: '> 0: currently profitable' },
  { id: 'revenue_growth',   label: 'Revenue Growth YoY',  defaultMin: 0,             defaultMax: Infinity,    defaultEnabled: true,  format: 'percent', description: '≥ 0%: revenue is not shrinking' },
  { id: 'eps_growth',       label: 'EPS Growth YoY',       defaultMin: 0,             defaultMax: Infinity,    defaultEnabled: true,  format: 'percent', description: '≥ 0%: earnings are not shrinking' },
  { id: 'debt_to_equity',   label: 'Debt / Equity',        defaultMin: 0,             defaultMax: 2.0,         defaultEnabled: true,  format: 'ratio',   description: '< 2.0: manageable leverage' },
  { id: 'roe',              label: 'ROE',                 defaultMin: 10,            defaultMax: Infinity,    defaultEnabled: true,  format: 'percent', description: '≥ 10%: solid return on equity' },
  { id: 'profit_margin',    label: 'Profit Margin',       defaultMin: 5,             defaultMax: Infinity,    defaultEnabled: true,  format: 'percent', description: '≥ 5%: positive operating margins' },
  { id: 'free_cash_flow',   label: 'Free Cash Flow',      defaultMin: 0,             defaultMax: Infinity,    defaultEnabled: true,  format: 'dollars', description: 'Positive TTM cash flow' },
  { id: 'current_ratio',    label: 'Current Ratio',       defaultMin: 1.0,          defaultMax: Infinity,    defaultEnabled: true,  format: 'ratio',   description: '≥ 1.0: can cover short-term obligations' },
  { id: 'avg_volume',       label: 'Avg Daily Volume',     defaultMin: 500_000,      defaultMax: Infinity,    defaultEnabled: true,  format: 'count',   description: '≥ 500K shares: basic liquidity' },
  { id: 'price',            label: 'Price',              defaultMin: 0,             defaultMax: 300,    defaultEnabled: true, format: 'dollars', description: 'Price under $300' },
  { id: 'dist_52wk_high',   label: 'Dist. 52-wk High',   defaultMin: 0,             defaultMax: 25,          defaultEnabled: false, format: 'percent', description: 'Within 25%: near highs' },
  { id: 'dist_52wk_low',    label: 'Dist. 52-wk Low',    defaultMin: 15,            defaultMax: Infinity,    defaultEnabled: false, format: 'percent', description: '≥ 15%: off the absolute bottom' },
  { id: 'sector_exclude',   label: 'Sector Exclude',     defaultMin: 0,             defaultMax: 0,           defaultEnabled: false, format: 'bool',    description: 'Exclude listed sectors' },
];