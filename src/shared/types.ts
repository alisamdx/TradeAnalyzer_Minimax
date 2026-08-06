// Types crossing the IPC boundary. Imported by main, preload, and renderer.

// ─── Watchlists (Phase 1) ───────────────────────────────────────────────────────

export interface Watchlist {
  id: number;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
}

export interface WatchlistItem {
  id: number;
  watchlistId: number;
  ticker: string;
  notes: string | null;
  addedAt: string;
  sector: string | null;
  currentIv: number | null;  // ATM implied volatility as percentage
}

export interface CsvImportResult {
  watchlistId: number;
  imported: number;
  skipped: Array<{ row: number; ticker: string; reason: string }>;
}

export interface CsvExportResult {
  filePath: string;
  rowCount: number;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

// ─── Screener (Phase 2) ────────────────────────────────────────────────────────

// 'all' = both + etf (deduplicated) — currently only offered by the Filters view.
export type Universe = 'sp500' | 'russell1000' | 'both' | 'etf' | 'all';

/** One enabled filter with its threshold(s). */
export interface FilterDef {
  id: string;
  enabled: boolean;
  /** Varies by filter — a number, [min, max], string[], etc. */
  value: unknown;
}

/** Full criteria shape serialised to JSON for storage. */
export interface ScreenCriteria {
  universe: Universe;
  mode: 'strict' | 'soft';
  filters: FilterDef[];
}

export interface ScreenPreset {
  id: number;
  name: string;
  universe: Universe;
  criteria: ScreenCriteria;
  isDefault: boolean;
  createdAt: string;
}

export interface ConstituentsMeta {
  indexName: 'sp500' | 'russell1000' | 'etf';
  refreshedAt: string;
  source: 'bundled' | 'wikipedia' | 'csv' | 'vanguard';
}

export interface ConstituentRow {
  ticker: string;
  companyName: string | null;
  sector: string | null;
}

/** A constituent row with its stored membership metadata (for the Constituents viewer). */
export interface ConstituentWithMeta extends ConstituentRow {
  /** UTC ISO timestamp the ticker was first added to this index (stable across refreshes). */
  addedAt: string;
  indexName: 'sp500' | 'russell1000';
}

export interface ScreenRunResult {
  id: number;
  presetId: number | null;
  presetName: string | null;
  universe: Universe;
  resultCount: number;
  runAt: string;
}

export interface ScreenResultRow {
  id: number;
  screenRunId: number;
  ticker: string;
  companyName: string | null;
  sector: string | null;
  payload: ScreenResultPayload;
}

export interface ScreenResultPayload {
  // Fundamental fields
  marketCap: number | null;
  peRatio: number | null;
  eps: number | null;
  revenueGrowth: number | null;
  epsGrowth: number | null;
  debtToEquity: number | null;
  roe: number | null;
  profitMargin: number | null;
  freeCashFlow: number | null;
  currentRatio: number | null;
  // Quality signals (v0.22.20)
  fcfToNetIncome: number | null;   // (operatingCashFlow / netIncome) × 100
  roic: number | null;             // NOPAT / investedCapital × 100
  netDebtToEbitda: number | null;  // (totalDebt − cash) / EBITDA
  revenueGrowth5Y: number | null;  // 5-year revenue CAGR
  epsGrowth5Y: number | null;      // 5-year EPS CAGR
  valueScore: number | null;       // VS 0–6
  growthScore: number | null;      // GS 0–6
  stockGrade: number | null;       // 3=★★★  2=★★  1=★
  avgVolume: number | null;
  avgOptionVolume: number | null;
  price: number | null;
  distance52WkHigh: number | null;
  distance52WkLow: number | null;
  beta: number | null;
  sector: string | null;
  // Quote fields
  lastPrice: number | null;
  dayChangePct: number | null;
  // Derived
  currentIv: number | null;    // ATM IV as percentage (e.g. 28.5 for 28.5%) — from iv_history
  ivRank: number | null;       // 0–100, null if < 21 data points
  ivPercentile: number | null; // 0–100, null if < 21 data points
  // Pass score
  passScore: number;       // count of filters passed (soft mode)
  failedFilters: string[]; // ids of filters that failed
}

// ─── Quote & Fundamentals (Phase 2) ───────────────────────────────────────────

export interface Quote {
  ticker: string;
  last: number | null;
  prevClose: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  ivRank: number | null;
  ivPercentile: number | null;
  currentIv: number | null;  // ATM implied volatility as percentage (e.g., 28.5)
  distance52WkHigh?: number | null;
  distance52WkLow?: number | null;
  fetchedAt: string;
  // Wheel Strategy columns (Phase 2)
  wheelSuitability?: number | null;
  targetStrike?: number | null;
  estimatedPremium?: number | null;
}

/** Alias of Quote — used by the cache service IPC bridge. */
export type CachedQuote = Quote;

/** Derived ratios computed from raw Polygon financials data.
 *  Computed by src/main/services/fundamentals-computer.ts — see docs/formulas.md */
export interface DerivedRatios {
  peRatio: number | null;
  eps: number | null;
  marketCap: number | null;
  debtToEquity: number | null;
  roe: number | null;
  profitMargin: number | null;
  revenueGrowth: number | null;
  epsGrowth: number | null;
  freeCashFlow: number | null;
  currentRatio: number | null;
  dividendYield: number | null;
  beta: number | null;
  // Quality signals (v0.22.20) — see docs/formulas.md#quality-signals
  fcfToNetIncome: number | null;   // (operatingCashFlow / netIncome) × 100
  roic: number | null;             // NOPAT / investedCapital × 100
  netDebtToEbitda: number | null;  // (totalDebt − cash) / EBITDA; null if D&A unavailable
  revenueGrowth5Y: number | null;  // 5-year revenue CAGR; null if < 20 quarterly filings
  epsGrowth5Y: number | null;      // 5-year EPS CAGR; null if < 20 quarterly filings
  valueScore: number | null;       // VS 0–6: passes value quality criteria count
  growthScore: number | null;      // GS 0–6: passes growth quality criteria count
  stockGrade: number | null;       // 3=★★★  2=★★  1=★  null=below threshold
  sector: string | null;
  industry: string | null;
  companyName: string | null;
}

export interface FundamentalsCache {
  ticker: string;
  ratios: DerivedRatios;
  fetchedAt: string;
}

// ─── Analysis Engine (Phase 3) ────────────────────────────────────────────────

/** Analysis mode types, one per FR-3.3 mode. */
export type AnalysisMode = 'buy' | 'options_income' | 'wheel' | 'bullish' | 'bearish' | 'jade_lizard' | 'big_lizard';

/** List-item shape for the analysis snapshot selector. */
export interface AnalysisSnapshotRow {
  id: number;
  watchlistId: number;
  /** 'all' for combined runs (all 5 modes); individual mode string for legacy single-mode runs. */
  mode: AnalysisMode | 'all';
  runAt: string;
  /** For 'all' snapshots: number of tickers analyzed. For single-mode: number of results. */
  resultCount: number;
  /** JSON string — structure depends on mode. */
  payloadJson: string;
}

/** All-modes payload stored in 'all' snapshots. */
export interface AnalysisAllModesPayload {
  buy: BuyResult[];
  options_income: OptionsIncomeResult[];
  wheel: WheelResult[];
  bullish: StrategyResult[];
  bearish: StrategyResult[];
  jade_lizard: LizardResult[];
  big_lizard: LizardResult[];
}

/** Result returned by analysis:run-all. */
export interface AnalysisAllModesRunResult {
  snapshotId: number;
  watchlistId: number;
  runAt: string;
  tickerCount: number;
  results: AnalysisAllModesPayload;
}

/** Mode descriptor for the UI selector. */
export interface AnalysisModeInfo {
  id: AnalysisMode;
  label: string;
  icon: string;
  description: string;
  outputColumns: string[];
}

/** Result of running an analysis against a watchlist. */
export interface AnalysisRunResult {
  snapshotId: number;
  mode: AnalysisMode;
  resultCount: number;
  runAt: string;
  resultsJson: string;
  failedTickers: string[];
}

/** Per-ticker progress event emitted during analysis:run and analysis:run-all. */
export interface AnalysisProgressEvent {
  current: number;
  total: number;
  ticker: string;
  /** Present during run-all to indicate which mode is currently executing. */
  mode?: AnalysisMode;
}

/** Unified analysis result — union of all 7 mode outputs. */
export type AnalysisResult =
  | BuyResult
  | OptionsIncomeResult
  | WheelResult
  | StrategyResult
  | LizardResult;

export interface BuyResult {
  mode: 'buy';
  ticker: string;
  lastPrice: number | null;
  compositeScore: number;
  trend: 'bullish' | 'bearish' | 'sideways';
  smaStack: { sma20: number | null; sma50: number | null; sma200: number | null };
  rsi: number | null;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  stopLoss: number | null;
  targetPrice: number | null;
  riskReward: number | null;
  fundamentalsPass: boolean;
  explanation: string;
}

export interface OptionsIncomeResult {
  mode: 'options_income';
  ticker: string;
  lastPrice: number | null;
  strategy: 'CSP' | 'CC';
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  delta: number | null;
  bid: number | null;
  ask: number | null;
  premium: number | null;
  annualizedReturn: number | null;
  ivRank: number | null;
  openInterest: number | null;
  /** Same-day contract volume — the third input to the liquidity score. Added v1.1.132; it was
   *  the one liquidity input no result type carried, so it is unrecoverable historically. */
  volume: number | null;
  breakeven: number | null;
  capitalRequired: number | null;
  explanation: string;
}

export interface WheelResult {
  mode: 'wheel';
  ticker: string;
  lastPrice: number | null;
  recommendedStrike: number | null;
  expiration: string | null;
  dte: number | null;
  delta: number | null;
  premium: number | null;
  annualizedReturn: number | null;
  /** Current ATM implied volatility, as a percentage. Was missing from this (renderer-visible)
   *  copy while present on the main-process one — the drift that motivated collapsing the two. */
  currentIv: number | null;
  ivRank: number | null;
  daysToEarnings: number | null;
  /** Quote and interest on the recommended contract. These are the inputs
   *  `optionLiquidityScore` is computed from; carrying them lets consumers (notably
   *  `options_premium_history`) persist the evidence rather than just the verdict. Absent until
   *  v1.1.132 — `analyzeWheel` computed them, scored them, then discarded them, so two months of
   *  wheel history rows have NULL bid/ask/open_interest while income rows are complete. */
  bid: number | null;
  ask: number | null;
  openInterest: number | null;
  volume: number | null;
  /** 0–10, or **null when liquidity could not be measured at all** (no suitable CSP chain /
   *  insufficient history). Null must NOT be collapsed to 0 — the Trade Scoring Engine treats
   *  a real 0 as "measured and illiquid" (full weight-9 penalty) but null as *missing*
   *  (FR-SE-03 denominator deflation). see docs/formulas.md#liquidity-score */
  optionLiquidityScore: number | null;
  suitabilityScore: number;
  explanation: string;
}

export interface StrategyResult {
  mode: 'bullish' | 'bearish';
  ticker: string;
  lastPrice: number | null;
  trendStrength: number | null;
  suggestedStrategy:
    | 'long_call'
    | 'bull_call_spread'
    | 'short_put'
    | 'long_put'
    | 'bear_put_spread'
    | 'short_call';
  structure: string;
  maxProfit: number | null;
  maxLoss: number | null;
  breakeven: number | null;
  probabilityOfProfit: number | null;
  explanation: string;
}

export interface LizardResult {
  mode: 'jade_lizard' | 'big_lizard';
  ticker: string;
  lastPrice: number | null;
  expiration: string | null;
  dte: number | null;
  putStrike: number | null;
  shortCallStrike: number | null;
  longCallStrike: number | null;
  /** Total net credit received per share — primary sort field. */
  netCredit: number | null;
  spreadWidth: number | null;
  /** True when netCredit > spreadWidth — no upside risk. */
  hasNoUpsideRisk: boolean | null;
  maxProfit: number | null;    // = netCredit per share
  maxLossDown: number | null;  // putStrike − netCredit per share
  breakevenDown: number | null;
  ivRank: number | null;
  /** Per-leg mid premiums — used to pre-build PayoffLeg[] when navigating to Payoff. */
  putPremium: number | null;
  shortCallPremium: number | null;
  longCallPremium: number | null;
  explanation: string;
}

// ─── Options chain (from DataProvider) ───────────────────────────────────────

/** Alias — shared across DataProvider interface and renderer. */
export type OptionsChain = DataProviderOptionsChain;

export interface DataProviderOptionsChain {
  ticker: string;
  expiration: string;
  contracts: OptionContract[];
}

/** Single option contract. */
export interface OptionContract {
  ticker: string;
  expiration: string;
  strike: number;
  side: 'call' | 'put';
  bid: number;
  ask: number;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number;
  openInterest: number | null;
  volume: number | null;
}

/** Backwards-alias — don't use in new code. */
export type OptionsContract = OptionContract;

// ─── Options Chain View ─────────────────────────────────────────────────────────

export interface OptionsChainExpirationSummary {
  date: string;
  dte: number;
  callCount: number;
  putCount: number;
}

export interface OptionsChainViewData {
  ticker: string;
  expiration: string;
  contracts: OptionContract[];
  currentPrice: number | null;
  currentIv: number | null;
}

// ─── FR-4 Validation Dashboard ───────────────────────────────────────────────

export interface ValidateTickerItem {
  ticker: string;
  name: string | null;
}

export interface PatternHit {
  name: string;
  barIndex: number;
  direction: 'bullish' | 'bearish' | 'neutral';
}

export interface Zone {
  price: number;
  type: 'demand' | 'supply';
  strengthPct: number;
}

export interface ChartData {
  bars: Bar[];
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  stopLoss: number | null;
  target: number | null;
  supportZones: Zone[];
  patterns: PatternHit[];
  sma20: (number | null)[];
  sma50: (number | null)[];
  sma200: (number | null)[];
  bollingerUpper: (number | null)[];
  bollingerMiddle: (number | null)[];
  bollingerLower: (number | null)[];
  rsi: (number | null)[];
  macd: (number | null)[];
  macdSignal: (number | null)[];
  macdHistogram: (number | null)[];
}

export interface ValidateDashboardResult {
  ticker: string;
  companyName: string | null;
  verdict: 'Strong' | 'Acceptable' | 'Caution' | 'Avoid';
  verdictReason: string;
  fundamentals: {
    peRatio: number | null;
    eps: number | null;
    revenueGrowth: number | null;
    profitMargin: number | null;
    debtToEquity: number | null;
    roe: number | null;
    nextEarningsDate: string | null;
    daysToEarnings: number | null;
    epsHistory: number[];
  };
  marketOpinion: {
    buyCount: number | null;
    holdCount: number | null;
    sellCount: number | null;
    avgPriceTarget: number | null;
    upsidePct: number | null;
    badge: 'BUY' | 'HOLD' | 'SELL' | null;
  };
  trend: {
    label: 'Bullish' | 'Bearish' | 'Sideways';
    adx: number | null;
    smaStack: { sma20: number | null; sma50: number | null; sma200: number | null };
    priceVsSma50: number | null;
  };
  chart: ChartData;
  indicators: {
    rsi: number | null;
    macdSignal: number | null;
    macdValue: number | null;
    bollingerPosition: number | null;
    volumeAnomalyPct: number | null;
    macdBullishCross: boolean;
    rsiBuyZone: 'oversold_recovery' | 'neutral_momentum' | null;
    buySignalStrength: 'strong' | 'moderate' | 'none';
    buySignalScore: number;
    buySignalReasons: string[];
  };
  ivData: {
    currentIv: number | null;
    iv52WkHigh: number | null;
    iv52WkLow: number | null;
    ivRank: number | null;
    ivPercentile: number | null;
  };
  /** Downside overnight gap-risk vs IV-implied move (display-only). see docs/formulas.md#gap-risk */
  gapRisk: {
    score: number | null;
    adverseGapP95Pct: number | null;
    ivDailyMovePct: number | null;
    sampleDays: number;
  };
  fetchedAt: string;
}

/** OHLCV bar — same shape as the Bar type in analysis-service.ts */
export interface Bar {
  t: number; // unix timestamp in ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// ─── Validate All (FR-4.4) ────────────────────────────────────────────────────

export type ValidateStatus = 'pending' | 'fetched' | 'persisted' | 'failed';

export interface ValidateAllResult {
  jobRunId: number;
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  status: 'running' | 'completed' | 'stopped' | 'failed';
}

/** Per-ticker status for the Validate All progress grid. */
export interface TickerStatusRow {
  ticker: string;
  status: ValidateStatus;
  errorMsg: string | null;
}

// ─── Job run status ────────────────────────────────────────────────────────────

export type JobRunStatus = 'pending' | 'running' | 'paused' | 'stopped' | 'completed' | 'failed';

export interface JobRunInfo {
  id: number;
  type: 'validate_all' | 'screen_run' | 'analysis_run' | 'backtest_run';
  watchlistId: number | null;
  status: JobRunStatus;
  startedAt: string;
  endedAt: string | null;
  totalCount: number;
  succeededCount: number;
  failedCount: number;
}

// ─── Settings (Phase 4) ────────────────────────────────────────────────────────

export interface AppSettings {
  polygonApiKey: string;
  rateLimitRpm: number;
  quoteCacheTtlSec: number;
  fundamentalsCacheTtlSec: number;
  optionsCacheTtlSec: number;
  logRetentionDays: number;
  errorLogRetentionDays: number;
  autoBackupEnabled: boolean;
  autoBackupIntervalDays: number;
  autoBackupDir: string;                  // '' = default (userData/backups/auto); else a chosen folder
  // Priority 9: Settings Enhancements
  soundAlertsEnabled: boolean;
  defaultScreenerIndex: 'sp500' | 'russell1000' | 'both';
  theme: 'dark' | 'light';
  /** Which inflection breakout directions the brief/scoring will surface (FR-SEY-3 follow-up:
   *  bear-call/down-breakout inflection is a validated net loser, so default 'up'). */
  inflectionDirection: 'both' | 'up' | 'down';
  keyboardShortcuts: KeyboardShortcutsConfig;
  // v0.12.0: TraderAgent integration
  agentDbPath: string;
  agentProjectPath: string;
  // ENH-3: Portfolio Greeks monitor
  accountSize: number;
}

// ─── TraderAgent (v0.12.0) ─────────────────────────────────────────────────────

export interface AgentTrade {
  id: number;
  ticker: string;
  mode: string;
  strategy: string;
  strike: number;
  expiration: string;
  dteAtEntry: number;
  entryPremium: number;
  capitalRequired: number;
  compositeScore: number;
  rankAtEntry: number;
  rationale: string;
  status: 'open' | 'closed' | 'expired';
  entryDate: string;
  closeDate: string | null;
  actualPl: number | null;
  closeReason: string | null;
  targetPl: number | null;
  maxLoss: number | null;
  annualizedReturn: number | null;
  entryPrice: number | null;    // stock price at entry
  lastPrice: number | null;     // current stock price
  currentOptionMid: number | null;  // current option mid-price (from latest theory check)
}

export interface AgentLesson {
  id: number;
  tradeId: number;
  gapCause: string;
  gapAmountUsd: number;
  gapPct: number;
  narrative: string;
  createdAt: string;
}

export interface AgentDashboard {
  winRateByStrategy: Record<string, { wins: number; total: number; winRate: number }>;
  winRateByMode:     Record<string, { wins: number; total: number; winRate: number }>;
  overallWinRate: number;
  totalClosed: number;
  totalDeployedCapital: number;
  capitalByTicker:   Record<string, number>;
  capitalByStrategy: Record<string, number>;
  openPositionCount: number;
  avgIv:    number | null;
  avgDelta: number | null;
  avgDTE:   number | null;
  estimatedDailyTheta: number | null;
  totalRealizedPl: number;
  plByMonth: Record<string, number>;
}

/** AI-generated learning captured when an agent trade is closed. */
export interface AgentTradeLearning {
  agentTradeId:     number;
  ticker:           string;
  wasStrategySound: boolean;   // was the setup sound for the conditions?
  keyLesson:        string;    // one sentence on the main takeaway
  suggestedTweak:   string | null;  // one sentence on what to do differently
  capturedAt:       string;    // ISO timestamp
}

export interface AgentNativeLesson {
  id: number;        // synthetic negative integer (never persisted)
  type: 'expiry_risk' | 'strike_breach' | 'strategy_losing_streak' | 'stale_position' | 'profit_target';
  severity: 'high' | 'medium' | 'low';
  title: string;
  narrative: string;
  ticker?: string;
  tradeId?: number;
  createdAt: string;
}

export interface AgentTheoryCheck {
  id: number;
  tradeId: number;
  tradeStatus: string;
  verdict: 'CONFIRMED' | 'AT_RISK' | 'INVALIDATED';
  narrative: string;
  currentStockPrice: number | null;
  currentOptionMid: number | null;
  currentDelta: number | null;
  currentDTE: number | null;
  ivAtCheck: number | null;
  checkedAt: string;
  // joined from agent_trades
  ticker: string;
  strategy: string;
  strike: number;
  expiration: string;
  entryPremium: number;
}

export interface AgentRecommendation {
  id: number;
  category: string;
  severity: string;
  description: string;
  proposedChange: string;
  status: string;
  createdAt: string;
}

export interface AgentMemorySnapshot {
  id: number;
  weights: Record<string, number>;
  winRateByMode: Record<string, number>;
  tradeCount: number;
  confidence: number;
  topLessons: string[];
  savedAt: string;
}

export interface AgentStatus {
  dbExists: boolean;
  openTrades: number;
  closedTrades: number;
  totalPl: number;
  winRate: number;
  lastRunAt: string | null;
  confidence: number;
}

export type OptionStrategyType =
  | 'wheel'
  | 'leaps_csp'
  | 'covered_call'
  | 'bull_call_spread'
  | 'bear_put_spread'
  | 'iron_condor';

export interface AgentScreeningCriteria {
  optionStrategies: OptionStrategyType[];
  minCompositeScore: number;   // 0–100 gate for analysis mode
  minBuyStrength: number;      // 0–100 gate for validate mode
}

export interface AgentStrategy {
  id: string;
  name: string;
  description?: string;
  screeningMode: 'analysis' | 'validate' | 'both';
  screeningCriteria: AgentScreeningCriteria;
  screenerUniverse: 'sp500' | 'russell1000' | 'both' | 'etf';
  preferredModes: string;
  dteMin: number;
  dteMax: number;
  deltaMin: number;
  deltaMax: number;
  minIv: number;
  minOi: number;
  maxBidAskPct: number;
  minAnnualizedReturn: number;
  earningsExclusionDays: number;
}

export interface AgentStrategiesState {
  strategies: AgentStrategy[];
  activeId: string | null;
}

export interface AgentConfig {
  // Connection
  apiUrl: string;
  agentDbPath: string;
  // Capital & Risk
  cashBalance: number;
  maxPositionPct: number;
  maxPositions: number;
  maxPositionsPerSector: number;
  kellyFraction: number;
  // Trade Filters
  dteMin: number;
  dteMax: number;
  deltaMin: number;
  deltaMax: number;
  minIv: number;         // minimum current IV% (replaces minIvRank — true IV rank requires 52-wk history we don't have)
  minOi: number;
  maxBidAskPct: number;
  minAnnualizedReturn: number;
  earningsExclusionDays: number;
  // Universe
  screenerUniverse: 'sp500' | 'russell1000' | 'both' | 'etf';
  preferredModes: string;
  // Email / Notifications
  emailList: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
}

export interface KeyboardShortcutsConfig {
  refreshQuotes: string;
  runAnalysis: string;
  openScreener: string;
  openPortfolio: string;
  openBriefing: string;
}

export interface DiagnosticCheck {
  ok: boolean;
  message: string;
}

export interface DiagnosticsResult {
  checks: Record<string, DiagnosticCheck>;
  overall: 'ok' | 'degraded' | 'error';
}

// ─── Cache Management (Phase 1 Enhancement) ─────────────────────────────────────

export interface CacheStatus {
  isStale: boolean;
  lastUpdated: number | null;
  ageMs: number | null;
  ageText: string;
  recordCount: number;
}

export interface CacheStats {
  lastScreenerRun: number | null;
  recordCount: number;
  updatedAt: string;
}

// ─── Backtesting Engine (v0.13.0) ─────────────────────────────────────────────

export type BacktestStrategy = 'CSP' | 'CC' | 'Wheel';

export interface BacktestConfig {
  id?: number;
  name: string;
  strategy: BacktestStrategy;
  ticker: string;
  startDate: string;       // YYYY-MM-DD
  endDate: string;         // YYYY-MM-DD
  startingCapital: number; // dollars
  dteTarget: number;       // days to expiration target
  deltaTarget: number;     // e.g. 0.30 for 30-delta
  profitTargetPct: number; // close at X% of max profit (e.g. 50)
  stopLossPct: number;     // close when loss reaches X% of premium (e.g. 200)
  createdAt?: string;
}

export interface BacktestRun {
  id: number;
  configId: number;
  config: BacktestConfig;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string | null;
  completedAt: string | null;
  errorMsg: string | null;
  totalDays: number | null;
  simulatedDays: number;
  createdAt: string;
}

export interface BacktestTrade {
  id: number;
  runId: number;
  ticker: string;
  strategy: BacktestStrategy;
  side: 'put' | 'call';
  entryDate: string;
  expiration: string;
  strike: number;
  entryPremium: number;
  exitDate: string | null;
  exitPremium: number | null;
  exitReason: 'profit_target' | 'stop_loss' | 'expiration' | 'assigned' | null;
  pnl: number | null;
  stockShares: number;
  stockCostBasis: number | null;
  capitalRequired: number;
  entrySpot: number | null;   // underlying price at entry
  exitSpot: number | null;    // underlying price at exit
}

export interface BacktestMetrics {
  runId: number;
  netPnl: number;
  totalReturnPct: number;
  annualizedReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  winRate: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  avgTradePnl: number;
  avgDaysHeld: number;
  equityCurve: Array<{ date: string; equity: number }>;
  computedAt: string;
}

export interface BacktestProgressEvent {
  runId: number;
  simulatedDays: number;
  totalDays: number;
  currentDate: string;
  currentEquity: number;
  openTrades: number;
}

export interface BacktestRunSummary {
  run: BacktestRun;
  metrics: BacktestMetrics | null;
  tradeCount: number;
}

// Aggregate backtest of every historical Brief-Replay pick for a premium strategy:
// one CSP simulated per (date, ticker) pick, then pooled. Answers "if I'd traded all my
// wheel/income picks, what would they have returned?" see docs/formulas.md#backtest-iv
export interface AggregatePickBacktest {
  strategy: ScoringStrategy;
  // Structure simulated: 'csp' (wheel/income), 'credit-spread' (inflection), or 'stock'
  // (buy/bullish/bearish — fixed-notional directional stock position, dollar-comparable).
  structure?: 'csp' | 'credit-spread' | 'stock';
  notionalPerTrade?: number;  // $ deployed per pick for 'stock' structure
  tradeCount: number;        // picks that produced a simulated trade
  skipped: number;           // picks with no usable price/option data
  winRate: number;           // % of trades with pnl > 0
  avgReturnPct: number;      // mean return on capital per trade
  medianReturnPct: number;
  bestReturnPct: number;
  worstReturnPct: number;
  totalPnl: number;          // sum of per-contract P&L ($) — 1 contract per pick
  avgDaysHeld: number;
  maxDrawdownPnl: number;    // largest peak-to-trough drop ($) on the cumulative-$ curve
  // Cumulative realized dollar P&L (1 contract per pick) ordered by exit date — ends at
  // totalPnl. Real money, unlike a sum of per-trade percentages.
  equityCurve: Array<{ date: string; cumPnl: number }>;
  params: { deltaTarget: number; dteTarget: number; profitTargetPct: number; stopLossPct: number };
}

// ─── LEAPS Strategy Module (v0.22.0) ──────────────────────────────────────────
// Pure LEAPS screener — finds deep-ITM long calls (365–730 DTE) ranked by score.
// CSP pairing removed: CSP is covered by Analysis and Strategy Lab.

export type LeapsCspGate = 'PASS' | 'CAUTION' | 'FAIL';
export type LeapsCspGrade = 'A+' | 'A' | 'B' | 'C' | 'F';

export interface LeapsCspGateDetail {
  spx: number | null;
  spx50d: number | null;
  spx200d: number | null;
  vix: number | null;
  vix5dChangePct: number | null;
  hygIefRatio: number | null;
  hygIefTrend: 'up' | 'down' | 'flat' | null;
}

export interface LeapsCspScoreComponent {
  name: string;
  weight: number;   // 0–1
  rawScore: number; // 0–10
  weightedScore: number;
}

export interface LeapsCspDetail {
  leapsScoreBreakdown: LeapsCspScoreComponent[];
}

export interface LeapsCspOpportunity {
  id: number;
  runId: number;
  rank: number;

  // LEAPS leg
  leapsTicker: string;
  leapsCurrentPrice: number | null;
  leapsStrike: number;
  leapsExpiry: string;
  leapsDte: number | null;
  leapsDelta: number | null;
  leapsPremium: number | null;       // per contract (mid × 100)
  leapsExtrinsicPct: number | null;
  leapsIvPct: number | null;
  leapsIvr: number | null;
  leapsOi: number | null;
  leapsSubScore: number;

  // Score (= leapsSubScore, kept for DB backward-compat)
  combinedScore: number;
  grade: LeapsCspGrade;
  cautionFlags: string[];
  totalCashToDeploy: number | null;  // = leapsPremium per contract

  detail: LeapsCspDetail;
}

export interface LeapsCspRunSummary {
  id: number;
  runAt: string;
  universe: string;
  watchlistId: number | null;
  marketGate: LeapsCspGate;
  gateDetail: LeapsCspGateDetail;
  gateEffect: string;
  candidateCount: number;
  opportunityCount: number;
}

export interface LeapsCspRunResult {
  run: LeapsCspRunSummary;
  opportunities: LeapsCspOpportunity[];
}

export interface LeapsCspOpenedEntry {
  id: number;
  opportunityId: number;
  openedAt: string;
  leapsEntryDebit: number | null;
  notes: string | null;
}

export interface LeapsCspProgressDetail {
  phase: 'gate' | 'universe' | 'leaps';
  current: number;
  total: number;
  ticker?: string;
}

// ─── Filter Templates (Pre-built criteria) ──────────────────────────────────

export type FilterCategory = 'technical' | 'volatility' | 'earnings' | 'options' | 'wheel';
export type DataNeeded = 'quote' | 'bars' | 'fundamentals' | 'options' | 'earnings';

export interface FilterTemplate {
  id: string;
  label: string;
  description: string;
  category: FilterCategory;
  icon: string;
  dataNeeded: DataNeeded[];
  metricColumns: Record<string, string>;
}

export interface FilterTemplateResult {
  ticker: string;
  watchlists: string[];
  lastPrice: number | null;
  // String values (e.g. an expiry date) are shown as-is and sort lexically.
  metrics: Record<string, number | string | null>;
  matchReason: string;
}

/** A batch-precomputed filter run (filter_template_runs table) — latest run per template. */
export interface FilterSavedRun {
  templateId: string;
  ranAt: string;
  universe: Universe;
  resultCount: number;
  results: FilterTemplateResult[];
}

// ─── Collared LEAPS Strategy ──────────────────────────────────────────────────
// Long deep-ITM LEAPS call + long OTM protective put on same underlying.
// The put is insurance on the LEAPS; its parameters derive from the LEAPS chosen.

export type CollaredLeapsGate = 'PASS' | 'CAUTION' | 'FAIL';
export type CollaredLeapsGrade = 'A+' | 'A' | 'B' | 'C' | 'F';

export interface CollaredLeapsGateDetail {
  spx: number | null;
  spx50d: number | null;
  spx200d: number | null;
  vix: number | null;
  vix5dChangePct: number | null;
  hygIefRatio: number | null;
  hygIefTrend: 'up' | 'down' | 'flat' | null;
}

export interface CollaredLeapsScoreComponent {
  name: string;
  weight: number;       // 0–1
  rawScore: number;     // 0–10
  weightedScore: number;
}

/** One point in the P&L payoff grid (200 price points across 0.5×–1.5× spot). */
export interface CollaredLeapsPnlPoint {
  price: number;        // underlying price
  collarPnl: number;    // collared position P&L ($)
  nakedPnl: number;     // naked LEAPS call P&L ($)
}

export interface CollaredLeapsDetail {
  leapsScoreBreakdown: CollaredLeapsScoreComponent[];
  putScoreBreakdown: CollaredLeapsScoreComponent[];
  structuralScoreBreakdown: CollaredLeapsScoreComponent[];
  pnlGrid: CollaredLeapsPnlPoint[];        // 200 pts at LEAPS expiry — always present
  pnlGrid180d?: CollaredLeapsPnlPoint[];   // omitted if LEAPS DTE < 190
  pnlGrid90d?: CollaredLeapsPnlPoint[];
  pnlGrid30d?: CollaredLeapsPnlPoint[];
}

export interface CollaredLeapsOpportunity {
  id: number;
  runId: number;
  rank: number;

  // Underlying
  ticker: string;
  spot: number;
  ma200d: number | null;

  // LEAPS call leg
  leapsStrike: number;
  leapsExpiry: string;
  leapsDte: number | null;
  leapsDelta: number | null;
  leapsDebit: number;           // mid × 100 per contract
  leapsExtrinsicPct: number | null;
  leapsIvPct: number | null;
  leapsIvr: number | null;
  leapsOi: number | null;
  leapsSpreadPct: number | null;
  leapsSubScore: number;

  // Protective put leg
  putStrike: number;
  putExpiry: string;
  putDte: number | null;
  putDelta: number | null;      // negative
  putDebit: number;             // mid × 100 per contract
  putIvPct: number | null;
  putIvr: number | null;
  putOi: number | null;
  putSpreadPct: number | null;
  putSubScore: number;

  // Structural metrics
  costDragPct: number;
  floorDepthPct: number;
  breakeven: number;
  maxLossAtPut: number | null;
  maxLossAtZero: number;        // can be negative (put over-insures — fully hedged)
  upsideRetentionPct: number;
  hedgeEfficiencyPct: number;
  rrRatio: number | null;

  // Combined scoring
  structuralSubScore: number;
  combinedScore: number;
  grade: CollaredLeapsGrade;
  cautionFlags: string[];
  gateSurvived: boolean;        // true if collar passes FAIL-gate structural requirements

  detail: CollaredLeapsDetail;
}

export interface CollaredLeapsRunSummary {
  id: number;
  runAt: string;
  universe: string;
  watchlistId: number | null;
  marketGate: CollaredLeapsGate;
  gateDetail: CollaredLeapsGateDetail;
  gateEffect: string;
  candidateCount: number;
  opportunityCount: number;
}

export interface CollaredLeapsRunResult {
  run: CollaredLeapsRunSummary;
  opportunities: CollaredLeapsOpportunity[];
}

export interface CollaredLeapsOpenedEntry {
  id: number;
  opportunityId: number;
  openedAt: string;
  leapsEntryDebit: number | null;
  putEntryDebit: number | null;
  notes: string | null;
}

export interface CollaredLeapsProgressDetail {
  phase: 'gate' | 'universe' | 'leaps' | 'puts' | 'structural' | 'persist';
  current: number;
  total: number;
  ticker?: string;
}

// ─── AI Portfolio Advisor (v0.16.0) ───────────────────────────────────────────

export interface EtradeAccount {
  accountId: string;
  accountIdKey: string;
  accountName: string;
  accountType: string;   // 'INDIVIDUAL', 'IRA', etc.
  institutionType: string;
}

export interface EtradeSyncResult {
  accountsScanned: number;
  positionsUpserted: number;
  positionsSkipped: number;
  /** Open broker-synced positions marked closed because they no longer exist at E*Trade. */
  positionsClosed?: number;
  errors: string[];
  syncedAt: string;
}

/** Extended position with E*Trade sync fields (migration 014). */
export interface PositionEtrade {
  id: number;
  ticker: string;
  positionType: 'CSP' | 'CC' | 'Stock' | 'Long Put' | 'Long Call';
  quantity: number;
  entryPrice: number;
  entryDate: string;
  entryNotes: string | null;
  exitPrice: number | null;
  exitDate: string | null;
  exitNotes: string | null;
  strikePrice: number | null;
  expirationDate: string | null;
  premiumReceived: number | null;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  status: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
  // E*Trade sync fields
  etradePositionId: number | null;
  etradeAccountId: string | null;
  marketValue: number | null;
  totalGainPct: number | null;
  daysGain: number | null;
  daysGainPct: number | null;
  costPerShare: number | null;
  pctOfPortfolio: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;     // percentage (e.g. 38.82)
  beta: number | null;
  lastSyncedAt: string | null;
  // Analysis fields (from position_analysis table)
  analysis?: PositionAnalysis | null;
}

export interface PositionAnalysis {
  id: number;
  positionId: number;
  analyzedAt: string;
  // Technical signals
  trend: 'bullish' | 'bearish' | 'sideways' | null;
  rsi: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  supportLevel: number | null;
  resistanceLevel: number | null;
  compositeScore: number | null;
  // Position metrics
  daysInPosition: number | null;
  currentReturnPct: number | null;
  annualizedReturn: number | null;
  // Options-specific
  currentDelta: number | null;
  thetaDecay: number | null;
  ivRank: number | null;
  assignmentRisk: 'low' | 'medium' | 'high' | null;
  rollOpportunity: unknown | null;
  // Recommendation
  action: 'hold' | 'close' | 'roll' | 'hedge' | 'take_profits';
  conviction: 1 | 2 | 3;
  explanation: string;
}

export interface AdvisorActionItem {
  positionId: number | null;
  ticker: string | null;
  action: string;
  rationale: string;
  urgency: 'immediate' | 'this_week' | 'monitor';
}

export interface AdvisorSession {
  id: number;
  requestedAt: string;
  adviceText: string;
  actionItems: AdvisorActionItem[];
  positionAdvice: Record<string, string>;
  observations: string[];
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Streamed from main → renderer while the advisor is running. */
export interface AdvisorProgressEvent {
  /** 'thinking' = reasoning chunk from Claude; 'status' = app-level status line; 'done' = finished */
  type: 'thinking' | 'status' | 'done';
  text: string;
}

// ─── Payoff Visualizer ────────────────────────────────────────────────────────

/** One leg of a multi-leg options/stock strategy. */
export interface PayoffLeg {
  id: string;
  side: 'buy' | 'sell';
  type: 'call' | 'put' | 'stock';
  /** Strike price; 0 for stock legs (stock uses premium as entry price). */
  strike: number;
  /** ISO date expiry; ignored for stock legs. */
  expiry: string;
  /** Per-share price: premium paid/received for options; entry price for stock. */
  premium: number;
  /** Number of contracts (1 contract = 100 shares). */
  quantity: number;
  /** Signed delta per share (positive for calls, negative for puts). Null if unknown. */
  delta: number | null;
  /** Theta per day per share. Null if unknown. */
  theta: number | null;
  /** Vega per 1% IV move per share. Null if unknown. */
  vega: number | null;
  /** IV as percentage (e.g. 28.5). Null if unknown. */
  iv: number | null;
  /** Open interest on the contract when the leg was built from the chain.
   *  Undefined/null for manually-entered legs (liquidity then unknown). */
  openInterest?: number | null;
  /** Day volume on the contract when the leg was built from the chain. */
  volume?: number | null;
  /** Bid (per share) when the leg was built from the chain. */
  bid?: number | null;
  /** Ask (per share) when the leg was built from the chain. */
  ask?: number | null;
  /** Human-readable label shown in the legs list. */
  label: string;
}

/** A named multi-leg strategy saved to the DB. */
export interface SavedPayoffStrategy {
  id: number;
  name: string;
  ticker: string | null;
  legs: PayoffLeg[];
  createdAt: string;
}

/** Inputs passed from the renderer to the assessment service. */
export interface PayoffAssessInput {
  spot: number;
  ticker: string | null;
  strategyName: string;
  maxProfit: number | null;
  maxLoss: number | null;
  unlimitedProfit: boolean;
  unlimitedLoss: boolean;
  breakevenPrices: number[];
  netPremium: number;
  netDelta: number | null;
  netTheta: number | null;
  netVega: number | null;
}

/** Structured expert assessment returned by Claude. */
export interface PayoffAssessment {
  strategyName: string;
  rating: 'excellent' | 'good' | 'neutral' | 'caution' | 'avoid';
  ratingReason: string;
  pros: string[];
  cons: string[];
  idealMarket: string;
  keyRisks: string[];
  /** E.g. "~68% based on Δ" or null if deltas unavailable. */
  probOfProfit: string | null;
  exit: {
    closeAll: { trigger: string; details: string };
    bullish: { trigger: string; exitFirst: string; holdLast: string };
    bearish: { trigger: string; exitFirst: string; holdLast: string };
  };
}

// ─── Roll / Closure Analyzer ───────────────────────────────────────────────────
// Exit-side companion to the Payoff visualizer: given an EXISTING (or hypothetical)
// single short option (CSP or covered call), assess close vs hold vs roll, and rank
// roll candidates across expiries/strikes by a user-selected efficiency metric.
// Credit-rolls only (net credit > 0), matching the wheel discipline.

export type RollOptionType = 'put' | 'call';

/** The ranking metric the user selects on the screen; the system re-ranks by it. */
export type RollMetric = 'annualizedRoc' | 'netCredit' | 'riskAdjusted' | 'capitalEfficiency';

/** The short-option position to analyze. */
export interface RollPositionInput {
  ticker: string;
  optionType: RollOptionType;   // put = cash-secured put; call = covered call
  strike: number;
  expiration: string;           // YYYY-MM-DD of the current short leg
  contracts: number;            // number of contracts (> 0)
  entryCredit: number;          // premium received per share when opened (e.g. 2.50)
}

/** Current-position assessment (close-now vs hold-to-expiry economics). */
export interface RollCurrentState {
  underlyingPrice: number | null;
  markToClose: number | null;   // per-share mid to buy-to-close the short now
  bid: number | null;
  ask: number | null;
  delta: number | null;         // short-leg delta
  iv: number | null;
  dte: number;
  moneyness: 'ITM' | 'ATM' | 'OTM';
  openCredit: number;           // $ received at open (entryCredit * 100 * contracts)
  closeCost: number | null;     // $ to buy-to-close now
  unrealizedPnl: number | null; // openCredit − closeCost
  pctOfMaxProfit: number | null;// unrealizedPnl / openCredit (0..1; how much of the credit is banked)
  capitalAtRisk: number;        // CSP: strike*100*contracts ; CC: underlying*100*contracts
  breakeven: number;            // put: strike − entryCredit ; call: strike + entryCredit
  assignmentProbability: number | null; // |delta| as 0..1
  chainStale: boolean;          // true when the short leg couldn't be re-priced from a live chain
}

export type RollDirection = 'same' | 'out-down' | 'out-up';

/** A single roll candidate (buy-to-close current + sell-to-open a later short). */
export interface RollCandidate {
  expiration: string;
  dte: number;
  addedDte: number;             // dte(new) − dte(current)
  strike: number;
  optionType: RollOptionType;
  direction: RollDirection;
  newBid: number;
  newAsk: number;
  newMid: number;
  newDelta: number | null;
  buyToCloseMid: number;        // per-share cost to close the current short
  netCreditPerShare: number;    // sell-to-open new − buy-to-close current (> 0 = credit)
  netCredit: number;            // netCreditPerShare * 100 * contracts
  capitalAtRisk: number;        // new strike (put) or underlying (call) * 100 * contracts
  annualizedRoc: number | null; // netCreditPerShare / capitalPerShare / addedDte * 365
  capitalEfficiency: number;    // netCreditPerShare / capitalPerShare (credit per $ committed)
  assignmentProbability: number | null; // |newDelta| 0..1
  breakeven: number;
  liquidityOk: boolean;         // both legs two-sided with a non-crazy spread
  score: number;                // value of the selected metric (ranking key)
}

export interface RollRecommendation {
  action: 'hold' | 'close' | 'roll';
  reason: string;
}

export interface RollAnalysis {
  input: RollPositionInput;
  metric: RollMetric;
  current: RollCurrentState;
  candidates: RollCandidate[];  // ranked desc by the selected metric's score
  recommendation: RollRecommendation;
  notes: string[];
  generatedAt: string;
}

// ─── Pre-Trade Validator (Payoff view) ─────────────────────────────────────────
// Validates a hand-built Payoff structure against the user's intent before placing
// it. Decision-support only — see Requirements/PRE_TRADE_VALIDATOR_SPEC.md.

export type PretradeTradePurpose = 'income' | 'directional' | 'ownership' | 'hedge';
export type PretradeVerdict = 'good' | 'caution' | 'bad';
export type PretradeCheckStatus = 'pass' | 'warn' | 'fail' | 'info';

/** The user's declared intent — the verdict is thesis-aware (same trade can be a bad
 *  income trade but a fine ownership trade), so this is required input. */
export interface PretradeIntent {
  /** Genuinely happy to own the stock at the short strike? null = N/A (no short put). */
  happyToOwn: boolean | null;
  purpose: PretradeTradePurpose;
  /** True when the thesis extends well beyond the structure's expiry. */
  multiQuarterThesis: boolean;
}

export interface PretradeCheck {
  key: string;
  status: PretradeCheckStatus;
  title: string;
  detail: string;
}

/** Live market context resolved for the validated ticker. */
export interface PretradeMarketContext {
  ivRank: number | null;
  ivPercentile: number | null;
  currentAtmIv: number | null;
  directionBias: StrategyLabDirectionBias | null;
  ma20: number | null;
  ma50: number | null;
  atrPct: number | null;
  nextEarningsDate: string | null;
}

/** A better structure the Strategy Lab suggests when the user's trade is flagged. */
export interface PretradeSuggestion {
  slug: string;
  name: string;
  grade: string;
  rationale: string;
  legs: { action: 'buy' | 'sell'; side: 'call' | 'put'; strike: number; expiration: string; qty: number }[];
  netCredit: number | null;
  netDebit: number | null;
  maxProfit: number | null;
  maxLoss: number | null;
  breakevens: number[];
  annualizedReturn: number | null;
  /** True when the lab's best pick is effectively the structure the user already built
   *  (same legs) — so it's "no better alternative", not a different recommendation. */
  sameAsCurrent?: boolean;
}

/** Renderer → main: the hand-built structure + the metrics the Payoff view already
 *  computes + the declared intent. */
export interface PretradeValidateInput {
  ticker: string | null;
  strategyName: string;
  spot: number;
  legs: PayoffLeg[];
  metrics: {
    maxProfit: number | null;
    maxLoss: number | null;
    unlimitedProfit: boolean;
    unlimitedLoss: boolean;
    breakevenPrices: number[];
    netPremium: number;
    netDelta: number | null;
    netTheta: number | null;
    netVega: number | null;
  };
  intent: PretradeIntent;
  /** Bypass cached lab data and fetch a fresh chain for the suggestion. */
  refresh?: boolean;
}

export interface PretradeValidationResult {
  verdict: PretradeVerdict;
  checks: PretradeCheck[];
  context: PretradeMarketContext;
  suggestion: PretradeSuggestion | null;
  /** True when the lab context/suggestion came from cache rather than a fresh fetch. */
  fromCache: boolean;
  generatedAt: string;
}

export interface PretradeValidationRow {
  id: number;
  ticker: string | null;
  strategyName: string;
  spot: number | null;
  verdict: PretradeVerdict;
  checks: PretradeCheck[];
  suggestion: PretradeSuggestion | null;
  intent: PretradeIntent;
  createdAt: string;
}

// ─── IV History (v0.17.0) ──────────────────────────────────────────────────────

/** Which backfill phase to run. gap_fill fills holes in existing history. */
export type IvHistoryBackfillPhase = 'initial_sp500' | 'initial_russell' | 'initial_etf' | 'gap_fill';

/** Per-ticker IV rank/percentile result from the iv_history table. */
export interface IvRankResult {
  ticker:       string;
  currentIv:    number | null;  // most recent ATM IV as percentage (28.5 = 28.5%) — null if < 21 points
  ivRank:       number | null;  // 0–100, null if insufficient data
  ivPercentile: number | null;  // 0–100, null if insufficient data
  dataPoints:   number;         // number of daily readings used
  oldestDate:   string | null;  // YYYY-MM-DD of oldest reading in window
  newestDate:   string | null;  // YYYY-MM-DD of most recent reading
}

/** Coverage summary for a universe of tickers. */
export interface IvHistoryCoverage {
  complete:        number;         // tickers with ≥ 252 data points
  partial:         number;         // tickers with 1–251 data points
  none:            number;         // tickers with 0 data points
  lastRefreshDate: string | null;  // most recent date in the table
  totalReadings:   number;         // total rows in iv_history
}

/** Summary of how many (ticker, date) gap pairs exist. */
export interface IvHistoryGapSummary {
  missingDays:    number;         // distinct missing trading days
  missingPairs:   number;         // total (ticker, date) pairs to fetch
  oldestGapDate:  string | null;  // YYYY-MM-DD
  newestGapDate:  string | null;  // YYYY-MM-DD
  estimatedCalls: number;         // = missingPairs
}

// ─── ENH-2: Opportunity Dashboard ─────────────────────────────────────────────

export type StrategyMode = 'wheel' | 'csp' | 'spreads' | 'bullish' | 'bearish';
export type OpportunityUniverse = 'sp500' | 'russell1000' | 'both' | 'etf';

export interface OpportunityRow {
  rank: number;
  ticker: string;
  companyName: string | null;
  sector: string | null;
  lastPrice: number | null;
  dayChangePct: number | null;
  ivRank: number | null;
  ivPercentile: number | null;
  currentIv: number | null;
  dataPoints: number;
  fundamentalsScore: number | null;
  technicalScore: number | null;
  premiumYieldScore: number | null;
  ivRankScore: number | null;
  compositeScore: number;
  passScore: number | null;
  estimatedPremium: number | null;
  targetStrike: number | null;
  targetExpiry: string | null;
  targetDte: number | null;
  priceAge: string | null;
}

export interface OpportunityRunOptions {
  universe: OpportunityUniverse;
  strategy: StrategyMode;
  minCompositeScore?: number;
  limit?: number;
}

// ─── Strategy Lab ─────────────────────────────────────────────────────────────

export type StrategyLabDirectionBias = 'bullish' | 'bearish' | 'neutral';
export type StrategyLabGrade = 'A+' | 'A' | 'B' | 'C' | 'F';
export type StrategyLabComplexity = 'simple' | 'moderate' | 'complex';

export interface StrategyLabContext {
  ticker:        string;
  underlyingPx:  number;
  expiration:    string;
  dte:           number;
  currentAtmIv:  number;
  ivRank:        number | null;
  ivPercentile:  number | null;
  ivDataPoints:  number;
  directionBias: StrategyLabDirectionBias;
  ma20:          number | null;
  ma50:          number | null;
  momentum5d:    number | null;  // 5-day price change %
}

export interface SetupLeg {
  action:       'buy' | 'sell';
  side:         'call' | 'put';
  strike:       number;
  expiration:   string;
  delta:        number | null;
  gamma:        number | null;
  theta:        number | null;
  vega:         number | null;
  bid:          number;
  ask:          number;
  mid:          number;
  iv:           number;
  openInterest: number | null;
  volume:       number | null;
  qty:          number;
}

export interface StrategySetup {
  slug:              string;
  ticker:            string;
  expiration:        string;
  dte:               number;
  underlyingPrice:   number;
  legs:              SetupLeg[];
  netCredit:         number | null;  // dollars per contract (positive = credit received)
  netDebit:          number | null;  // dollars per contract (positive = debit paid)
  maxProfit:         number | null;  // dollars per contract
  maxLoss:           number | null;  // dollars per contract (negative = loss)
  breakevens:        number[];
  annualizedReturn:  number | null;  // %
  popEstimate:       number | null;  // % from short leg delta
  currentAtmIv:      number;
  unavailableReason: string | null;  // set when setup cannot be computed
}

export interface StrategyScore {
  slug:           string;
  name:           string;
  category:       string;
  totalScore:     number;       // 0–100
  grade:          StrategyLabGrade;
  ivScore:        number;       // 0–30
  directionScore: number;       // 0–30
  premiumScore:   number;       // 0–25
  liquidityScore: number;       // 0–15
  requiresStock:  boolean;
  complexity:     StrategyLabComplexity;
  flags:          string[];     // reason chips
  setup:          StrategySetup | null;
  aiRationale:    string | null;
}

/**
 * A Level-2-tradeable (debit) vertical surfaced in the Daily Brief for IBKR account-building.
 * Long leg ATM, short leg pulled in from the live chain to the widest strike whose net debit
 * stays within a small max-risk budget. Display-only — does NOT affect scoring or what the
 * engine trades. `side: 'call'` = bullish (long call spread); `'put'` = bearish (long put
 * spread). see docs/formulas.md#level2-debit-vertical
 */
export interface Level2DebitVertical {
  side:           'call' | 'put';
  longStrike:     number;
  shortStrike:    number;
  longPremium:    number;   // per-share mid paid for the long leg
  shortPremium:   number;   // per-share mid received for the short leg
  expiration:     string;   // ISO date
  dte:            number;
  debitPerShare:  number;   // net debit paid per share
  maxRisk:        number;   // total $ at risk (= debitPerShare × 100)
  maxProfit:      number;   // total $ (= (width − debit) × 100)
  breakeven:      number;   // underlying price at breakeven
  movePctToBreakeven: number | null; // % move from spot to breakeven (signed)
  underlyingPrice: number;
  exceededBudget: boolean;  // true when even the narrowest spread is above the risk target
}

export interface StrategyLabValidateResult {
  context: StrategyLabContext;
  scores:  StrategyScore[];    // sorted best → worst
  /** Level-2 (debit) vertical alternatives for the Daily Brief account-building chip.
   *  Display-only; built from the same chain. Optional — absent on older persisted briefs. */
  level2DebitAlts?: { call: Level2DebitVertical | null; put: Level2DebitVertical | null };
}

/** Progress event emitted during backfill via iv-history:progress IPC channel. */
export interface IvHistoryProgressEvent {
  phase:       IvHistoryBackfillPhase;
  ticker:      string;
  date:        string;
  processed:   number;
  total:       number;
  skipped:     number;
  failed:      number;
  callsPerMin: number;
  lastError?:  string;   // set when the most recent ticker failed — shown in console
}

// ─── Batch Jobs (v0.21.0) ─────────────────────────────────────────────────────

export interface BatchJob {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  runOnStartup: boolean;
  startupDelaySeconds: number;
  dailyScheduleEnabled: boolean;
  dailyScheduleTime: string;   // 'HH:MM' ET
  lastRunAt: string | null;
  lastRunStatus: 'running' | 'success' | 'failed' | 'skipped' | null;
  lastSuccessDate: string | null;
  sequenceOrder: number;
  /** Runs only in the after-close (full) batch slot — skipped by the lean intraday slot because it
   *  runs after the brief and can't contribute to it (spec 08 §4). Editable per-job in the Batch view. */
  afterCloseOnly: boolean;
  /** Free-form per-job config. For daily-iv-update: { callDelayMs: number }. */
  config: Record<string, unknown>;
}

export interface BatchRun {
  id: number;
  jobId: string;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';
  tickersAttempted: number;
  tickersUpdated: number;
  tickersSkipped: number;
  tickersFailed: number;
  notes: string | null;
  errorMessage: string | null;
  trigger: 'manual' | 'schedule' | 'startup';
  slotTime: string | null;
}

export interface OrchestratorJobEntry {
  id: string;
  enabled: boolean;
}

export interface OrchestratorJobConfig {
  scheduleSlots: string[];
  /** Slot times ('HH:MM' ET) that run LEAN (skip after_close_only jobs). When omitted, the default
   *  is every slot except the latest — the after-close slot runs everything (spec 08 §4). */
  leanSlots?: string[];
  validateEtradeToken: boolean;
  emailOnStart: boolean;
  jobs: OrchestratorJobEntry[];
}

export interface AppNotification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  message: string;
  cta?: { label: string; view: string };
}

export interface BatchProgressEvent {
  jobId: string;
  runId: number;
  ticker: string;
  status: 'updated' | 'skipped' | 'failed' | 'no-data';
  attempted: number;
  updated: number;
  skipped: number;
  failed: number;
  total: number;
  message?: string;
}

// ─── Trade Scoring Engine + Daily Intelligence Brief (v0.22.7) ────────────────

export type ScoringStrategy = 'wheel' | 'bullish' | 'bearish' | 'income' | 'buy' | 'inflection';

export interface ScoringSignal {
  key: string;
  label: string;
  weight: number;
  enabled: boolean;
  description: string;
  dataSource: string;
  direction: 'higher_better' | 'lower_better' | 'target_range';
  targetMin?: number;
  targetMax?: number;
  normMax?: number;
}

export interface SignalBreakdown {
  raw: number | null;
  normalized: number;
  weight: number;
  missing: boolean;
}

export interface ScoredTicker {
  ticker: string;
  compositeScore: number;
  signals: Record<string, SignalBreakdown>;
}

export interface ScoringConfig {
  strategy: ScoringStrategy;
  signals: ScoringSignal[];
  version: string;
  updatedAt: string;
}

export interface CriticFlag {
  key: string;
  severity: 'warning' | 'info';
  description: string;
}

export interface CriticVerdict {
  verdict: 'pass' | 'caution' | 'flag';
  confidence: 'high' | 'medium' | 'low';
  flags: CriticFlag[];
  rationale: string | null;
  generatedAt: string;
  /** True when the LLM critic did NOT run (e.g. Anthropic 529/overload) and `verdict` is the
   *  rule-based fallback only — NOT an adversarial all-clear. Consumers must treat a degraded
   *  verdict as un-vetted: the v2 entry gate rejects it (fail-closed), and the UI marks it. */
  degraded?: boolean;
}

export interface BriefPick {
  ticker: string;
  compositeScore: number;
  signals: Record<string, SignalBreakdown>;
  strategyLabResult?: object | null;
  aiRationale: string | null;
  criticVerdict?: CriticVerdict | null;
  rank: number;
  validated: boolean;
  price: number | null;
  /** Inflection only: the breakout side that earned the pick ('up' → bull-put vertical,
   *  'down' → bear-call vertical). Locks structure selection to the breakout direction so an
   *  up breakout never surfaces a bearish bear-call. Absent for non-inflection / legacy picks
   *  (selection then defaults to 'up', the launch/default config). */
  breakoutDirection?: 'up' | 'down';
}

export interface DailyBriefEntry {
  id: number;
  generatedAt: string;
  validUntil: string;
  strategy: ScoringStrategy;
  picks: BriefPick[];
  runMeta: object | null;
}

// ─── Brief Trend: per-pick drilldown ─────────────────────────────────────────

/** One row in the Brief Trend drilldown table.
 *  Day 1–5 are the closing prices on the 1st–5th trading day after the brief date.
 *  historical_prices only contains market-open days, so ROW_NUMBER() naturally
 *  skips weekends and holidays. Null = that trading day has not yet passed. */
export interface BriefPickDetail {
  ticker: string;
  strategy: ScoringStrategy;
  briefScore: number;
  briefRank: number;
  /** Stock price on brief day (= paper_trades.entry_price). */
  briefPrice: number | null;
  day1Price: number | null;
  day2Price: number | null;
  day3Price: number | null;
  day4Price: number | null;
  day5Price: number | null;
  /** Return % from brief price to the most recent available day price. */
  returnPct: number | null;
  /** Verdict based on the latest available day. Null until at least Day 1 is available. */
  latestVerdict: 'positive' | 'negative' | 'neutral' | null;
  criticVerdict: 'pass' | 'caution' | 'flag' | null;
  criticRationale: string | null;
  aiRationale: string | null;
}

// ─── Paper Trading / Retrospect (v0.23.0) ────────────────────────────────────

export type TradeStatus = 'open' | 'closed' | 'expired';
export type TradeOutcome = 'win' | 'loss' | 'breakeven';
export type TradeVerdict = 'positive' | 'negative' | 'neutral';
export type TradeRecommendation = 'hold' | 'close_signal';

export interface RetroStrategySettings {
  negThresholdPct: number;         // stock move % defining "negative" direction (default 5)
  incomeRangeThresholdPct: number; // income only: move in EITHER direction beyond this = negative (default 8)
  closeSignalDte: number;          // DTE at which Close Signal fires when trade is negative (default 7)
  maxMoveAgainstPct: number;       // unconditional Close Signal regardless of DTE (default 15)
}

export interface RetroSettings {
  wheel:   RetroStrategySettings;
  bullish: RetroStrategySettings;
  bearish: RetroStrategySettings;
  income:  RetroStrategySettings;
  buy:     RetroStrategySettings;
  inflection: RetroStrategySettings;
}

/** Recommended action for an open paper trade, computed rule-based from current market state. */
export type TradeActionType = 'hold' | 'take_profit' | 'close' | 'roll' | 'watch';

export interface TradeInsight {
  action:     TradeActionType;
  urgency:    'high' | 'medium' | 'low';
  reason:     string;   // plain-English explanation shown in the UI
  suggestion: string | null;  // specific action to take, if any
}

/** Structured cause of a trade's gap vs expectation — mirrors Agent's GapCause taxonomy. */
export type TradeLearningGapCause =
  | 'EARNINGS_GAP_RISK'     // earnings during hold period caused binary move
  | 'IV_CRUSH'              // IV declined after entry, reducing premium value
  | 'TREND_REVERSAL'        // stock direction reversed against the position
  | 'THETA_UNDERESTIMATE'   // slower theta decay than expected
  | 'EARLY_CLOSE_MISSED'    // closed a profitable trade before reaching full target
  | 'MODEL_ERROR';          // loss not explained by the above

/** AI-generated learning captured when a trade closes or expires. */
export interface TradeLearning {
  strategyWorked: boolean;
  entryFit:       'good' | 'early' | 'late' | 'wrong';
  gapCause:       TradeLearningGapCause | null;
  keyLesson:      string;
  suggestedTweak: string | null;
  capturedAt:     string;
}

/** Recurring-pattern recommendation — generated when same gap cause hits ≥3 times. */
export interface BriefLearningRecommendation {
  id:              number;
  strategy:        string;
  gapCause:        TradeLearningGapCause;
  occurrenceCount: number;
  description:     string;
  proposedTweak:   string;
  status:          'open' | 'acknowledged';
  createdAt:       string;
}

/** Pearson-correlation signal weight suggestion for the scoring engine. */
export interface SignalWeightSuggestion {
  strategy:        ScoringStrategy;
  signalKey:       string;
  signalLabel:     string;
  currentWeight:   number;    // current % weight in config
  correlation:     number;    // Pearson r with Day+1 positive outcome
  sampleSize:      number;    // paper trades used
  suggestedWeight: number;    // proportional weight based on |correlation|
  direction:       'increase' | 'decrease' | 'hold';
}

export interface PaperTrade {
  id:             number;
  briefId:        number | null;
  briefStrategy:  ScoringStrategy;
  briefScore:     number | null;
  briefRank:      number | null;
  ticker:         string;
  briefDate:      string;       // YYYY-MM-DD ET
  strategyName:   string | null;
  legsJson:       string;       // JSON array of SetupLeg
  entryDate:      string;       // YYYY-MM-DD
  entryPrice:     number | null;
  entryPremium:   number | null;
  expiryDate:     string | null;
  status:         TradeStatus;
  exitDate:       string | null;
  exitPrice:      number | null;
  exitNotes:      string | null;
  stockReturnPct: number | null;
  /** Realized structure (option) P&L in dollars at close — the money metric `outcome` derives
   *  from (Black-Scholes-marked from the legs). Null for open trades or unpriceable legs. */
  structurePnl:   number | null;
  outcome:        TradeOutcome | null;
  createdAt:      string;
  learning:       TradeLearning | null;  // AI-captured on close/expire; null until then
}

export interface PaperTradeWithPnl extends PaperTrade {
  currentPrice:   number | null;
  priceDate:      string | null;  // date of latest price in historical_prices
  daysHeld:       number;
  daysToExpiry:   number | null;
  verdict:        TradeVerdict;
  recommendation: TradeRecommendation;
  estimatedPnl:   number | null;  // delta-based estimate; null if no delta data
  insight:        TradeInsight;   // rule-based recommendation for this trade right now
}

export interface PaperTradeSummary {
  totalTrades:  number;
  openTrades:   number;
  closedTrades: number;
  winRate:      number | null;  // % of closed trades that were wins
  avgReturn:    number | null;  // avg stock_return_pct of closed trades
  bestTrade:    { ticker: string; returnPct: number } | null;
  worstTrade:   { ticker: string; returnPct: number } | null;
}

export interface StrategyBreakdown {
  strategy:   ScoringStrategy;
  total:      number;
  wins:       number;
  losses:     number;
  breakevens: number;
  open:       number;
  winRate:    number | null;
  avgReturn:  number | null;
}

export interface BriefAccuracy {
  date:        string;
  totalClosed: number;
  wins:        number;
  accuracy:    number | null;  // null if < 3 closed trades (insufficient data)
}

// Per-strategy next-day accuracy from paper_trade_snapshots
export interface SnapshotStrategyRow {
  strategy:  ScoringStrategy;
  total:     number;       // trades with at least one snapshot
  positives: number;
  negatives: number;
  neutrals:  number;
  accuracy:  number | null;  // positives/total × 100; null if < 3 trades
  avgReturn: number | null;
}

// Per-brief-date next-day accuracy from paper_trade_snapshots
export interface SnapshotBriefRow {
  briefDate:  string;
  total:      number;
  positives:  number;
  negatives:  number;
  accuracy:   number | null;
  avgReturn:  number | null;
}

export interface SnapshotAccuracy {
  totalSnapshots: number;
  byStrategy:     SnapshotStrategyRow[];
  byBriefDate:    SnapshotBriefRow[];
}

// Brief health trend — critic pass/caution/flag rates over recent briefs (B-02)
export interface BriefHealthPoint {
  date:      string;        // YYYY-MM-DD of the brief
  total:     number;        // picks that had a criticVerdict
  passes:    number;
  cautions:  number;
  flags:     number;
  passRate:  number | null; // passes/total × 100; null if total < 2
}

export interface BriefHealthTrend {
  strategy:   ScoringStrategy;
  points:     BriefHealthPoint[];  // chronological (oldest → newest), up to 7
  trend:      'improving' | 'declining' | 'stable' | 'insufficient';
  currentPct: number | null;       // pass rate of the most recent brief
}

// Brief performance summary for the Daily Brief header banner (B-01)
// Shows last brief's Day+5 hit-rate and avg return per strategy.
export interface BriefPerformanceStrategy {
  strategy:      ScoringStrategy;
  picks:         number;    // total picks that have Day+5 data
  hits:          number;    // count with positive verdict at Day+5
  avgReturnPct:  number | null;
}

export interface BriefPerformanceSummary {
  briefDate:   string;   // YYYY-MM-DD of the brief being summarised
  strategies:  BriefPerformanceStrategy[];
}

// ─── Conviction List (v0.24.0) ───────────────────────────────────────────────

export type ConvictionZone = 'buy' | 'mid' | 'watch' | 'high' | 'unset';

export interface ConvictionStock {
  ticker: string;
  priceLow: number | null;
  priceMid: number | null;
  priceHigh: number | null;
  note: string | null;
  inPlay: boolean;        // on/off "pay attention / may act on this" flag
  addedAt: string;
  updatedAt: string;
  currentPrice: number | null;
  iv: number | null;
  ivRank: number | null;
  zone: ConvictionZone;
}

export interface ConvictionBandHistory {
  id: number;
  ticker: string;
  priceLow: number | null;
  priceMid: number | null;
  priceHigh: number | null;
  note: string | null;
  changedAt: string;
}

export interface ConvictionInput {
  ticker: string;
  priceLow?: number | null;
  priceMid?: number | null;
  priceHigh?: number | null;
  note?: string | null;
}

export interface ConvictionRecommendation {
  priceLow: number | null;
  priceMid: number | null;
  priceHigh: number | null;
  priceLowBasis: string;
  priceMidBasis: string;
  priceHighBasis: string;
  hasData: boolean;
}

export interface ConvictionAiReview {
  ticker: string;
  currentZone: ConvictionZone;
  currentPrice: number | null;
  currentLow: number | null;
  currentMid: number | null;
  currentHigh: number | null;
  action: 'add' | 'hold' | 'reduce' | 'remove';
  zoneVerdict: 'keep' | 'adjust';
  recommendedLow: number | null;
  recommendedMid: number | null;
  recommendedHigh: number | null;
  riskFlag: string | null;
  rationale: string;
}

// ─── News & Research (FR-NR) ─────────────────────────────────────────────────

export type NewsResearchBias = 'bull' | 'bear' | 'mixed';

export type KeyFactorTag =
  | 'EARNINGS'
  | 'ANALYST'
  | 'INSIDER'
  | 'MACRO'
  | 'REGULATORY'
  | 'SHORT_SQUEEZE'
  | 'NEWS'
  | 'SEASONALITY';

/** A source link attached to a key factor. */
export interface KeyFactorLink {
  label: string;   // Short display label e.g. "Article", "Fed", "BLS", "Search"
  url: string;
}

export interface KeyFactor {
  tag: KeyFactorTag;
  direction: 'bull' | 'bear' | 'neutral';
  description: string;
  links?: KeyFactorLink[];
}

export interface ResearchEvent {
  date: string;          // YYYY-MM-DD
  type: string;          // 'EARNINGS' | 'FOMC' | 'CPI' | 'JOBS' | 'OTHER'
  description: string;
  daysUntil: number;
}

export interface NewsHeadline {
  headline: string;
  source: string;
  publishedUtc: string;
  url: string;
  sentiment: 'positive' | 'negative' | 'neutral' | null;
}

export interface EarningsSignal {
  earningsDate: string | null;
  daysToEarnings: number | null;
  epsEstimate: number | null;
  revenueEstimate: number | null;
  priorEps: number | null;
}

export interface AnalystRating {
  firm: string;
  action: string;
  ratingFrom: string | null;
  ratingTo: string | null;
  priceTargetFrom: number | null;
  priceTargetTo: number | null;
  date: string;
}

export interface InsiderTransaction {
  filerName: string;
  filerTitle: string | null;
  transactionType: 'buy' | 'sell';
  shares: number;
  pricePerShare: number | null;
  totalValue: number | null;
  filingDate: string;
}

export interface ShortInterestSignal {
  shortPctFloat: number | null;
  daysToCover: number | null;
}

export interface MacroEvent {
  id?: number;
  date: string;
  type: string;
  description: string;
}

export interface RawSignals {
  earnings: EarningsSignal | null;
  analystRatings: AnalystRating[];
  insiderTransactions: InsiderTransaction[];
  shortInterest: ShortInterestSignal | null;
  macroEvents: MacroEvent[];
  newsHeadlines: NewsHeadline[];
}

export interface NewsResearchResult {
  ticker: string;
  cacheDate: string;
  impactScore: number | null;
  bias: NewsResearchBias | null;
  keyFactors: KeyFactor[];
  summary: string | null;
  portfolioNote: string | null;
  events: ResearchEvent[];
  news: NewsHeadline[];
  rawSignals: RawSignals;
  aiModel: string | null;
  updatedAt: string;
}

export interface NewsBatchProgressEvent {
  done: number;
  total: number;
  ticker: string;
  phase?: 'fetch' | 'synthesis';
}

// ─── Brief Replay ─────────────────────────────────────────────────────────────

export interface ReplayProgressEvent {
  phase: 'scoring' | 'outcomes' | 'done' | 'error';
  current: number;
  total: number;
  currentDate: string;
  message: string;
}

export interface ReplayPickRow {
  replayBriefId: number;
  asOfDate: string;
  strategy: string;
  ticker: string;
  rank: number;
  compositeScore: number;
  entryPrice: number | null;
  ret5d: number | null;
  ret10d: number | null;
  ret21d: number | null;
  maxDrawdown21d: number | null;
  stayedAboveStrike: boolean | null;
  closePrice: number | null;
  closeDate: string | null;
  evaluatedAt: string | null;
}

// Coverage/readiness of the options_premium_history table — drives the in-app
// "ready to build real income/wheel ROC" note in Brief Replay. An entry is
// "matured" once its option would have expired (~45 calendar days old).
export interface PremiumHistoryReadiness {
  totalRows: number;
  days: number;            // distinct as_of_date captured
  fromDate: string | null;
  toDate: string | null;
  maturedDays: number;     // distinct captured dates older than the maturity window
  thresholdDays: number;   // matured-days target before ROC analysis is worthwhile
  ready: boolean;          // maturedDays >= thresholdDays
}

export interface ReplaySummary {
  strategy: string;
  totalDates: number;
  totalPicks: number;
  n5d: number;   // picks with 5d data (denominator of HR 5d)
  n10d: number;  // picks with 10d data
  n21d: number;  // picks with 21d data
  hitRate5d: number | null;
  hitRate10d: number | null;
  hitRate21d: number | null;
  avgReturn5d: number | null;
  avgReturn10d: number | null;
  avgReturn21d: number | null;
}

export interface ReplayChartStrategyStats {
  strategy: string;
  n: number;
  avg21d: number | null;
  hr21d: number | null;
  bullAvg21d: number | null;
  bullHr21d: number | null;
  bullN: number;
  bearAvg21d: number | null;
  bearHr21d: number | null;
  bearN: number;
  scoreQuintiles: (number | null)[];  // Q1..Q5 avg21d
  rankAvg: (number | null)[];         // rank 1..5 avg21d
  topTickers: Array<{ ticker: string; n: number; avg21d: number; hr: number }>;
  worstTickers: Array<{ ticker: string; n: number; avg21d: number; hr: number }>;
}

export interface ReplayChartMonthlyRow {
  month: string;
  label: string;
  regime: 'bull' | 'bear' | 'mix' | null;
  buy: number | null;
  bullish: number | null;
  income: number | null;
  wheel: number | null;
  bearish: number | null;
  inflection: number | null;
}

export interface ReplayChartData {
  dateRange: { from: string; to: string; dates: number; picks: number };
  regimeDates: { bull: number; bear: number };
  strategies: ReplayChartStrategyStats[];
  monthly: ReplayChartMonthlyRow[];
}

// ─── v2 Execution Subsystem ──────────────────────────────────────────────────
// Domain types for the automated-execution engine. See Requirements/v2-execution/.
// The headless core owns the exec_* tables (migration 045); these are the parsed,
// camelCase domain shapes services map rows to. Phase 0: schema + types + config seed.

export type ExecutionMode = 'paper' | 'live';

/** Master engine lifecycle (00-overview §0.37, 02-risk-governor §2.7). */
export type EngineState = 'running' | 'stopped' | 'paused' | 'kill_tripped';

/** Defined-risk structures eligible in v2.0 (00-overview §0.4). */
export type ExecStructure = 'short-put-vertical' | 'short-call-vertical' | 'csp' | 'iron-condor';

/** A single persisted option leg of a structure. */
export interface ExecLeg {
  right: 'P' | 'C';
  action: 'buy' | 'sell';
  strike: number;
  expiry: string;            // YYYY-MM-DD
  ratio: number;             // contracts multiple within the structure (usually 1)
}

/** The governor's rules — single row (exec_config). Limits in 02-risk-governor §2.3,
 *  entry policy in 03-lifecycle §3.6. */
/** Execution venue behind the ExecutionBroker seam. paper/live are selected independently. */
export type ExecBrokerKind = 'mock' | 'ibkr' | 'tradier';

export interface ExecConfig {
  executionMode: ExecutionMode;
  // per-mode broker selection (07-broker-alternatives §3) — the paper/soak venue and the
  // live/real-money venue are chosen independently. TA_EXEC_BROKER env overrides both (dev/test).
  paperBroker: ExecBrokerKind;             // venue when executionMode = 'paper'
  liveBroker: ExecBrokerKind;              // venue when executionMode = 'live'
  capitalCeiling: number;                  // $ capital base
  maxRiskPerTradePct: number;              // % of ceiling
  maxConcurrentPositions: number;
  dailyLossTripPct: number;                // kill-switch trip %
  maxPositionsPerTicker: number;
  maxPositionsPerStrategy: number | null;  // null = off
  eligibleStrategies: string[];            // launch: ['inflection']
  proposalShelfLifeMin: number;
  // drawdown-scaled risk (FR-SEY-2)
  drawdownThrottlePct: number;             // 0 = off; throttle per-trade size at/above this DD%
  drawdownThrottleFactor: number;          // size multiplier applied when throttled (e.g. 0.5)
  // sector-concentration cap (FR-SEY-1)
  maxPositionsPerSector: number | null;    // null = off; max concurrent open positions per sector bucket
  // inflection-direction guard (FR-SEY-3 follow-up; mirrors the app `inflectionDirection` setting)
  inflectionDirection: 'both' | 'up' | 'down';
  // risk-budget-driven spread width (default off; brief sizes the inflection vertical's hedge leg
  // to the per-trade budget so it's sizeable on a small account — see docs/formulas.md#budget-width)
  budgetWidthEnabled: boolean;
  // entry policy (§3.6)
  minCompositeScore: number;                 // global floor; per-strategy override below
  minCompositeByStrategy: Record<string, number>; // {strategy: floor} — overrides the global floor (composites aren't comparable across strategies)
  maxNewEntriesPerDay: number;
  maxNewEntriesPerWeek: number;
  avoidEarningsBeforeExpiry: boolean;
  maxComboSpreadPct: number;               // 0 = off; reject when (ask−bid)/|mid| exceeds this (liquidity gate)
  entryWindowStart: string;                // ET HH:MM
  entryWindowEnd: string;                  // ET HH:MM
  repriceTolerancePct: number;
  // exit policy (§3.3)
  stopMultiple: number;                    // protective stop at × credit
  defensiveDte: number;                    // protective defensive-expiry close
  profitTargetPct: number;                 // discretionary, % of credit
  holdDays: number;                        // discretionary planned exit
  timeExitDte: number;                     // discretionary, 0 = off
  profitTargetMode: 'propose' | 'auto';
  timeExitMode: 'propose' | 'auto';
  // unattended operation (spec 08) — the arm switch + loop + notifications
  automationMode: 'semi' | 'dry_run' | 'unattended'; // semi=approve-each · dry_run=decide,place nothing · unattended=auto (paper-only)
  cycleIntervalSec: number;                 // management/entry loop tick
  notifyPerAction: boolean;                 // email + OS push on entry/exit/kill
  notifyPush: boolean;                      // include the desktop/OS notification surface
  notifyEodDigest: boolean;                 // end-of-day digest email (fires only when armed)
  updatedAt: string;
}

/** Live risk ledger + engine state — single row (exec_risk_state). 02 §2.6/§2.7. */
export interface ExecRiskState {
  engineState: EngineState;
  killSwitchTripped: boolean;
  killSwitchReason: string | null;
  capitalDeployed: number;                 // Σ open-position max loss
  dayRealizedPnl: number;
  dayUnrealizedPnl: number;
  dayAnchorDate: string | null;
  equityHighWater: number;                 // closed-equity peak (ratchets up) — FR-SEY-2
  updatedAt: string;
}

export type ExecProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'superseded';
export type ExecProposalKind = 'entry' | 'exit';

/** A candidate order awaiting approval (semi-auto). 03-lifecycle §3.2. */
export interface ExecProposal {
  id: number;
  createdAt: string;
  expiresAt: string;
  status: ExecProposalStatus;
  kind: ExecProposalKind;
  ticker: string;
  strategy: string;
  structure: ExecStructure;
  legs: ExecLeg[];
  netCredit: number | null;                // per-share
  maxLoss: number;                         // per-contract $
  contracts: number;
  sourceBriefId: number | null;
  riskCheck: ExecGateResult | null;
  rejectReason: string | null;
}

export type ExecOrderStatus =
  | 'pending' | 'submitted' | 'working' | 'filled' | 'partially_filled' | 'rejected' | 'cancelled';
export type ExecOrderSide = 'open' | 'close';

/** An order in the state machine (idempotent via clientOrderId). 02 §2.8. */
export interface ExecOrder {
  id: number;
  clientOrderId: string;                   // COID — idempotency key
  proposalId: number | null;
  brokerOrderId: string | null;
  status: ExecOrderStatus;
  side: ExecOrderSide;
  rejectReason: string | null;
  submittedAt: string | null;
  updatedAt: string;
}

/** A fill reconciled from broker truth (exec_fills). 02 §2.9. */
export interface ExecFill {
  id: number;
  orderId: number;
  brokerExecId: string | null;
  filledAt: string;
  price: number;                           // net per-share for the combo
  quantity: number;                        // contracts
  commission: number | null;
}

export type ExecPositionStatus = 'open' | 'closing' | 'closed' | 'needs_attention';
export type ExecCloseReason =
  | 'profit_target' | 'stop' | 'time_stop' | 'defensive' | 'manual' | 'flatten';

/** A bot-managed position (distinct from the v1 E*Trade portfolio mirror). 02 §2.10. */
export interface ExecPosition {
  id: number;
  ticker: string;
  strategy: string;
  structure: ExecStructure;
  legs: ExecLeg[];
  contracts: number;
  entryOrderId: number | null;
  entryNetCredit: number | null;
  maxLoss: number;                         // capital this position ties up
  openedAt: string;
  status: ExecPositionStatus;
  currentMark: number | null;
  currentPnl: number | null;
  closedAt: string | null;
  closeReason: ExecCloseReason | null;
}

/** Result of the pre-trade risk gate (02 §2.5) — snapshot stored on a proposal. */
export interface ExecGateResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  rejectReason: string | null;             // the first failing check's reason, if any
}

/** One append-only audit record (exec_audit_log). 02 §2.11. */
export interface ExecAuditEntry {
  id: number;
  at: string;
  event: string;
  refTable: string | null;
  refId: number | null;
  detail: unknown;                         // parsed detail_json
}

// ── Execution facade shapes (renderer-facing) ────────────────────────────────
// What the ExecutionEngine facade returns over IPC (`window.api.execution.*`).
// Reads come straight off the SQL selects, so positions/proposals/audit are the
// raw snake_case rows; the UI maps as needed. State/config/risk are camelCase
// domain shapes from the governor.

/** Broker/cycle health snapshot (mirrors ExecutionCore's CoreHealth). */
export interface ExecEngineHealth {
  brokerConnected: boolean;
  lastCycleAt: string | null;
  healthy: boolean;
  degradedReason: string | null;           // null when healthy
}

/** Engine snapshot from `getState()`. */
export interface ExecEngineStateView {
  engineState: EngineState;
  killSwitch: { tripped: boolean; reason: string | null };
  executionMode: ExecutionMode;
  automationMode: 'semi' | 'dry_run' | 'unattended'; // the arm switch (spec 08)
  armed: boolean;                           // running + unattended + paper (auto-entry active)
  drawdownPct: number;                      // closed-equity drawdown from HWM (FR-SEY-2)
  health: ExecEngineHealth;
}

/** Live event stream the core pushes to the renderer (`execution:event`). */
export type ExecEngineEvent =
  | { type: 'engine_state'; state: EngineState }
  | { type: 'cycle'; result: unknown }
  | { type: 'health'; health: ExecEngineHealth }
  | { type: 'reconcile_mismatch'; detail: unknown };

/** Open-position row as selected by the facade. */
export interface ExecPositionRow {
  id: number;
  ticker: string;
  strategy: string;
  structure: string;
  contracts: number;
  max_loss: number;
  entry_net_credit: number | null;
  current_mark: number | null;
  current_pnl: number | null;
  status: string;
  opened_at: string;
  closed_at: string | null;
  close_reason: string | null;
}

/** Pending-proposal row as selected by the facade. */
export interface ExecProposalRow {
  id: number;
  created_at: string;
  expires_at: string;
  status: string;
  kind: string;
  ticker: string;
  strategy: string;
  structure: string;
  net_credit: number | null;
  max_loss: number;
  contracts: number;
  position_id: number | null;
  close_reason: string | null;
}

/** Dry-run would-be decision row (spec 08 §2.4) as selected by the facade. */
export interface ExecDryRunRow {
  id: number;
  at: string;
  et_date: string;
  kind: string; // 'entry' | 'exit'
  ticker: string;
  strategy: string | null;
  structure: string | null;
  net_credit: number | null;
  max_loss: number | null;
  contracts: number | null;
  reason: string | null;
}

/** Audit-log row as selected by the facade. */
export interface ExecAuditRow {
  id: number;
  at: string;
  event: string;
  ref_table: string | null;
  ref_id: number | null;
  detail_json: string | null;
}

/** Result of approving an entry/exit proposal. */
export interface ExecApproveResult {
  ok: boolean;
  orderId: number | null;
  reason: string | null;
}

/** Result of starting the engine (refusal carries a reason). */
export interface ExecStartResult {
  started: boolean;
  reason: string | null;
}
