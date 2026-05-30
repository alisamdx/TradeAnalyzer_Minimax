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

export type Universe = 'sp500' | 'russell1000' | 'both';

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
  indexName: 'sp500' | 'russell1000';
  refreshedAt: string;
  source: 'bundled' | 'wikipedia' | 'csv';
}

export interface ConstituentRow {
  ticker: string;
  companyName: string | null;
  sector: string | null;
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
  ivRank: number | null;
  ivPercentile: number | null;
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
export type AnalysisMode = 'buy' | 'options_income' | 'wheel' | 'bullish' | 'bearish';

/** List-item shape for the analysis snapshot selector. */
export interface AnalysisSnapshotRow {
  id: number;
  watchlistId: number;
  mode: AnalysisMode;
  runAt: string;
  resultCount: number;
  /** JSON string — parse to get the full AnalysisResult[]. */
  payloadJson: string;
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

/** Unified analysis result — union of all 5 mode outputs. */
export type AnalysisResult =
  | BuyResult
  | OptionsIncomeResult
  | WheelResult
  | StrategyResult;

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
  premium: number | null;
  annualizedReturn: number | null;
  ivRank: number | null;
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
  ivRank: number | null;
  daysToEarnings: number | null;
  optionLiquidityScore: number;
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
  // Priority 9: Settings Enhancements
  soundAlertsEnabled: boolean;
  defaultScreenerIndex: 'sp500' | 'russell1000' | 'both';
  theme: 'dark' | 'light';
  keyboardShortcuts: KeyboardShortcutsConfig;
  // v0.12.0: TraderAgent integration
  agentDbPath: string;
  agentProjectPath: string;
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
  screenerUniverse: 'sp500' | 'russell1000' | 'both';
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
  screenerUniverse: 'sp500' | 'russell1000' | 'both';
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

// ─── LEAPS + CSP Strategy Module (v0.14.0) ────────────────────────────────────

export type LeapsCspGate = 'PASS' | 'CAUTION' | 'FAIL';
export type LeapsCspGrade = 'A+' | 'A' | 'B' | 'C' | 'F';
export type LeapsCspPairingMode = 'same_ticker' | 'different_ticker' | 'leaps_only';

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

export interface LeapsCspAlternative {
  cspTicker: string;
  cspStrike: number;
  cspExpiry: string;
  cspDelta: number | null;
  cspPremium: number | null;
  cspAnnReturnPct: number | null;
  cspSubScore: number;
  combinedScore: number;
  grade: LeapsCspGrade;
}

export interface LeapsCspDetail {
  leapsScoreBreakdown: LeapsCspScoreComponent[];
  cspScoreBreakdown: LeapsCspScoreComponent[];
  alternatives: LeapsCspAlternative[];
}

export interface LeapsCspOpportunity {
  id: number;
  runId: number;
  rank: number;
  pairingMode: LeapsCspPairingMode;

  // Leg A
  leapsTicker: string;
  leapsCurrentPrice: number | null;
  leapsStrike: number;
  leapsExpiry: string;
  leapsDte: number | null;
  leapsDelta: number | null;
  leapsPremium: number | null;
  leapsExtrinsicPct: number | null;
  leapsIvPct: number | null;
  leapsIvr: number | null;
  leapsOi: number | null;
  leapsSubScore: number;

  // Leg B
  cspTicker: string | null;
  cspCurrentPrice: number | null;
  cspStrike: number | null;
  cspExpiry: string | null;
  cspDte: number | null;
  cspDelta: number | null;
  cspPremium: number | null;
  cspCollateral: number | null;
  cspAnnReturnPct: number | null;
  cspIvPct: number | null;
  cspIvr: number | null;
  cspOi: number | null;
  cspSubScore: number | null;

  // Combined
  combinedScore: number;
  grade: LeapsCspGrade;
  cautionFlags: string[];
  totalCashToDeploy: number | null;

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
  cspEntryCredit: number | null;
  notes: string | null;
}

export interface LeapsCspProgressDetail {
  phase: 'gate' | 'universe' | 'leaps' | 'csp' | 'pairing';
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
  metrics: Record<string, number | null>;
  matchReason: string;
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
  errors: string[];
  syncedAt: string;
}

/** Extended position with E*Trade sync fields (migration 014). */
export interface PositionEtrade {
  id: number;
  ticker: string;
  positionType: 'CSP' | 'CC' | 'Stock';
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
