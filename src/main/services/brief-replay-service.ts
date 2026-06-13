// Brief Replay Service — point-in-time historical back-test of the Daily Brief pipeline.
//
// Replays the scoring pipeline for past dates using price/IV data filtered to
// each replay date plus live fundamentals_cache for fundamentals. No E*Trade
// chains: picks = top-5 composite score with a volume/price liquidity proxy
// (Option A from BRIEF_REPLAY_SPEC.md §5).
//
// see Requirements/BRIEF_REPLAY_SPEC.md

import type { Database } from 'better-sqlite3';
import type { ScoringService, TickerSignalData } from './scoring-service.js';
import { STRATEGIES, minCompositeForStrategy } from './scoring-service.js';
import { isTradingDay } from './iv-history-service.js';
import type { ReplayProgressEvent, ReplayPickRow, ReplaySummary, ReplayChartData, ReplayChartMonthlyRow, ScreenResultPayload, PremiumHistoryReadiness } from '@shared/types.js';
import { withTransaction } from '../db/connection.js';

// Liquidity proxy thresholds (Option A — no options chains)
const MIN_AVG_VOLUME     = 1_000_000; // 20-day avg daily volume
const MIN_PRICE          = 5;         // exclude sub-$5 stocks
const PICKS_PER_STRATEGY = 5;

// Price lookback window: enough calendar days to cover 252 trading days
const LOOKBACK_DAYS = 450;

// Sector ETF map (duplicated from scoring-service to avoid coupling)
const SECTOR_ETF: Record<string, string> = {
  'Technology':             'XLK',
  'Financials':             'XLF',
  'Health Care':            'XLV',
  'Energy':                 'XLE',
  'Industrials':            'XLI',
  'Consumer Staples':       'XLP',
  'Consumer Discretionary': 'XLY',
  'Materials':              'XLB',
  'Real Estate':            'XLRE',
  'Utilities':              'XLU',
  'Communication Services': 'XLC',
};

function sectorStringToEtf(raw: string): string | undefined {
  const s = raw.toLowerCase();
  if (/semiconductor|electronic computer|prepackaged software|computer integrated|computer storage|computer communication|computer programming|data processing|computer processing|telephone apparatus|communications equipment|electronic component|printed circuit|optical instrument|industrial instrument|laboratory.*instrument|analytical instrument/.test(s)) return 'XLK';
  if (/telephone communication|cable.*television|pay television|radio broadcasting|television broadcasting|motion picture|newspaper.*publish|video.*rental/.test(s)) return 'XLC';
  if (/commercial bank|savings institution|fire.*insurance|life insurance|accident.*insurance|investment advice|security broker|personal credit|mortgage banker|insurance agent/.test(s)) return 'XLF';
  if (/pharmaceutical|biological product|diagnostic substance|surgical.*instrument|medical instrument|electromedical|hospital|health service|home health/.test(s)) return 'XLV';
  if (/crude petroleum|natural gas|oil.*gas field|petroleum refin|drilling.*oil/.test(s)) return 'XLE';
  if (/air transportation|air courier|railroad|trucking.*courier|aerospace|aircraft|engineering service|industrial.*machiner|ship building|electrical equipment/.test(s)) return 'XLI';
  if (/auto dealer|retail-eating|eating.*drinking|apparel.*accessor|home furniture|hotels.*motel|motor vehicle|automotive part/.test(s)) return 'XLY';
  if (/food.*kindred|beverages|retail-variety|food store|drug store|soap.*detergent|tobacco product/.test(s)) return 'XLP';
  if (/steel work|chemicals.*allied|plastics material|metal mining|paper.*allied/.test(s)) return 'XLB';
  if (/real estate investment trust|real estate dealer|land subdivider/.test(s)) return 'XLRE';
  if (/electric service|electric.*combined|gas transmission|water supply|combination electric.*gas/.test(s)) return 'XLU';
  return undefined;
}

// ─── Price row type (subset of historical_prices) ─────────────────────────────

interface PriceRow {
  date: string;
  close: number;
  high: number;
  low: number;
  volume: number;
}

interface IvRow {
  date: string;
  atm_iv: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function subtractCalendarDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function addCalendarDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** All NYSE trading days between from and to (inclusive). */
function tradingDaysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  const end = new Date(to + 'T12:00:00Z');
  let cur = new Date(from + 'T12:00:00Z');
  while (cur <= end) {
    const s = cur.toISOString().slice(0, 10);
    if (isTradingDay(s)) days.push(s);
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

/** Last index in ASC-sorted prices array with date <= asOf. Returns -1 if none. */
function upperBound(prices: PriceRow[], asOf: string): number {
  let lo = 0, hi = prices.length - 1, result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (prices[mid]!.date <= asOf) { result = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result;
}

function avg(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/** 14-period Wilder RSI from ascending closes array. */
function computeRsi14(closes: number[]): number | null {
  if (closes.length < 15) return null;
  // Use up to last 42 closes (3× period) for smoothing stability
  const window = closes.slice(-42);
  const n = window.length;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= 14; i++) {
    const chg = window[i]! - window[i - 1]!;
    if (chg > 0) avgGain += chg; else avgLoss -= chg;
  }
  avgGain /= 14;
  avgLoss /= 14;

  for (let i = 15; i < n; i++) {
    const chg = window[i]! - window[i - 1]!;
    const g = chg > 0 ? chg : 0;
    const l = chg < 0 ? -chg : 0;
    avgGain = (avgGain * 13 + g) / 14;
    avgLoss = (avgLoss * 13 + l) / 14;
  }

  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

/** 90-day return for a ticker at asOf using its ascending price array. */
function return90d(prices: PriceRow[], endIdx: number): number | null {
  if (endIdx < 0 || endIdx >= prices.length) return null;
  const current = prices[endIdx]!.close;
  // rn=90 → index endIdx - 89 (0-indexed, newest is endIdx)
  const baseIdx = endIdx - 89;
  if (baseIdx < 0) {
    // Fall back to oldest available if ≥ 60 bars
    const count = endIdx + 1;
    if (count < 60) return null;
    const base = prices[0]!.close;
    return base > 0 ? ((current - base) / base) * 100 : null;
  }
  const base = prices[baseIdx]!.close;
  return base > 0 ? ((current - base) / base) * 100 : null;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class BriefReplayService {
  constructor(
    private readonly db: Database,
    private readonly scoringService: ScoringService,
  ) {}

  // ── Data management ───────────────────────────────────────────────────────

  clearAll(): void {
    withTransaction(this.db, () => {
      this.db.prepare('DELETE FROM replay_outcomes').run();
      this.db.prepare('DELETE FROM replay_briefs').run();
    });
  }

  // ── Main replay runner ────────────────────────────────────────────────────

  async runRange(
    from: string,
    to: string,
    onProgress: (evt: ReplayProgressEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const days = tradingDaysBetween(from, to);
    if (days.length === 0) throw new Error('No trading days in the selected range.');

    // Clear before re-run
    this.clearAll();

    // Candidates: same universe as brief job (sp500 + russell1000 + etf, minus ref tickers)
    const tickers = this.loadCandidates();
    if (tickers.length === 0) throw new Error('No constituents in DB — sync the universe first.');

    const allTickers = ['SPY', ...Object.values(SECTOR_ETF), ...tickers];

    // Load price data for full window: lookback before 'from' through 'to'
    const windowFrom = subtractCalendarDays(from, LOOKBACK_DAYS);
    onProgress({ phase: 'scoring', current: 0, total: days.length, currentDate: from, message: 'Loading price history…' });

    const priceCache = this.loadPriceCache(allTickers, windowFrom, to);
    const ivCache    = this.loadIvCache(tickers, windowFrom, to);

    // Fundamentals: from fundamentals_cache (current, not point-in-time — acceptable for v1)
    const fundamentals = this.loadFundamentals(tickers);

    // Sector map: ticker → sector ETF
    const sectorMap = this.loadSectorMap(tickers);

    // Build per-date ETF returns cache (ticker → returns by date)
    // We compute these lazily inside the date loop

    // Score each trading day
    for (let i = 0; i < days.length; i++) {
      if (signal.aborted) return;
      const asOf = days[i]!;

      onProgress({
        phase: 'scoring',
        current: i + 1,
        total: days.length,
        currentDate: asOf,
        message: `Scoring ${asOf} (${i + 1}/${days.length})…`,
      });

      // Build signal data for all tickers at this date
      const signalMap = new Map<string, TickerSignalData>();
      const volumeMap = new Map<string, number>(); // for liquidity proxy

      // Pre-compute SPY + ETF returns for this date
      const spyReturn   = this.ticker90dReturn('SPY', asOf, priceCache);
      const etfReturns  = new Map<string, number>();
      for (const etf of Object.values(SECTOR_ETF)) {
        const r = this.ticker90dReturn(etf, asOf, priceCache);
        if (r !== null) etfReturns.set(etf, r);
      }

      for (const ticker of tickers) {
        const prices = priceCache.get(ticker);
        if (!prices || prices.length === 0) continue;

        const endIdx = upperBound(prices, asOf);
        if (endIdx < 0) continue;

        const available = prices.slice(0, endIdx + 1); // ASC, up to asOf
        const n = available.length;

        // Last price at asOf
        const lastPrice = available[n - 1]!.close;
        if (lastPrice <= 0) continue;

        // SMAs
        const sma20  = n >= 20  ? avg(available.slice(n - 20).map(p  => p.close)) : null;
        const sma50  = n >= 50  ? avg(available.slice(n - 50).map(p  => p.close)) : null;
        const sma200 = n >= 200 ? avg(available.slice(n - 200).map(p => p.close)) : null;

        // 20-day low (support proxy)
        const entryZoneLow = n >= 10
          ? Math.min(...available.slice(Math.max(0, n - 20)).map(p => p.low))
          : null;

        // 20-day avg volume (liquidity proxy)
        const avgVol20d = n >= 10
          ? avg(available.slice(Math.max(0, n - 20)).map(p => p.volume))
          : null;
        if (avgVol20d !== null) volumeMap.set(ticker, avgVol20d);

        // Price momentum (252-day)
        let priceMomentumPct: number | null = null;
        if (n >= 30) {
          const baseIdx = n >= 252 ? n - 252 : 0;
          const base    = available[baseIdx]!.close;
          if (base > 0) priceMomentumPct = ((lastPrice - base) / base) * 100;
        }

        // Recent 20-day realized volatility (annualized)
        let recentVolatility: number | null = null;
        if (n >= 16) {
          const slice    = available.slice(Math.max(0, n - 22));
          const logRets: number[] = [];
          for (let j = 1; j < slice.length; j++) {
            const prev = slice[j - 1]!.close;
            const curr = slice[j]!.close;
            if (prev > 0 && curr > 0) logRets.push(Math.log(curr / prev));
          }
          if (logRets.length >= 15) {
            const mean = avg(logRets);
            const variance = logRets.reduce((s, r) => s + (r - mean) ** 2, 0) / (logRets.length - 1);
            recentVolatility = Math.sqrt(variance * 252) * 100;
          }
        }

        // RSI (14-period Wilder)
        const rsi = computeRsi14(available.map(p => p.close));

        // Trend label from SMA stack
        let trendLabel: 'bullish' | 'bearish' | 'sideways' | null = null;
        if (sma50 !== null && sma200 !== null) {
          if (lastPrice > sma50 && sma50 > sma200)      trendLabel = 'bullish';
          else if (lastPrice < sma50 && sma50 < sma200) trendLabel = 'bearish';
          else                                           trendLabel = 'sideways';
        } else if (sma200 !== null) {
          trendLabel = lastPrice > sma200 ? 'bullish' : 'bearish';
        }

        // Relative strength vs SPY (90-day excess return)
        const tickerReturn90 = return90d(available, n - 1);
        const relativeStrengthVsSpy = (tickerReturn90 !== null && spyReturn !== null)
          ? tickerReturn90 - spyReturn
          : null;

        // Sector momentum (sector ETF 90-day return)
        const etfTicker = sectorMap.get(ticker);
        const sectorMomentumPct = etfTicker ? (etfReturns.get(etfTicker) ?? null) : null;

        // IV rank (from iv_history filtered to asOf)
        const ivRank = this.computeIvRankAsOf(ticker, asOf, ivCache);

        // Fundamentals from cache
        const fund = fundamentals.get(ticker);

        signalMap.set(ticker, {
          ticker,
          // IV
          ivRank,
          // Fundamentals
          fundamentalScore:   fund?.fundamentalScore ?? null,
          epsGrowth:          fund?.epsGrowth        ?? null,
          revenueGrowth:      fund?.revenueGrowth    ?? null,
          // Analysis snapshots — not available for replay
          rsi,
          trendStrengthAdx:   null,  // ADX skipped for replay
          trendLabel,
          smaStack:           (sma20 !== null || sma50 !== null || sma200 !== null)
                                ? { sma20, sma50, sma200 }
                                : null,
          lastPrice,
          annualizedReturn:    null, // options-based, not available
          optionLiquidityScore: null,
          suitabilityScore:    null,
          entryZoneLow,
          snapshotAgeHours:    0,   // replay data is always "fresh" for breakoutScore check
          // Computed
          priceMomentumPct,
          relativeStrengthVsSpy,
          sectorMomentumPct,
          recentVolatility,
          // Technical signals — not available for replay
          buySignalScore:      null,
          // Quality signals
          fcfToNetIncome:      fund?.fcfToNetIncome  ?? null,
          roic:                fund?.roic             ?? null,
          netDebtToEbitda:     fund?.netDebtToEbitda  ?? null,
          revenueGrowth5Y:     fund?.revenueGrowth5Y  ?? null,
          epsGrowth5Y:         fund?.epsGrowth5Y      ?? null,
          stockGrade:          null,
        });
      }

      if (signal.aborted) return;

      // Score + filter + persist for each strategy
      withTransaction(this.db, () => {
        for (const strategy of STRATEGIES) {
          const config   = this.scoringService.getConfig(strategy);
          const scored   = this.scoringService.scoreFromSignalData(signalMap, strategy);

          // Liquidity proxy (Option A): volume >= 1M, price >= $5
          // Plus per-strategy quality gate (bearish ≥70; others ungated) — mirrors the
          // live brief so replay validates the same picks. see minCompositeForStrategy().
          const minComposite = minCompositeForStrategy(strategy);
          const liquid = scored.filter(s => {
            const vol = volumeMap.get(s.ticker) ?? 0;
            const sig = signalMap.get(s.ticker);
            return vol >= MIN_AVG_VOLUME && (sig?.lastPrice ?? 0) >= MIN_PRICE
              && s.compositeScore >= minComposite;
          });

          const top5 = liquid.slice(0, PICKS_PER_STRATEGY);

          // Persist
          const briefRow = this.db.prepare(`
            INSERT OR REPLACE INTO replay_briefs (as_of_date, strategy, picks, config_version)
            VALUES (?, ?, ?, ?)
          `).run(
            asOf,
            strategy,
            JSON.stringify(top5.map((s, idx) => ({
              ticker: s.ticker,
              rank: idx + 1,
              compositeScore: s.compositeScore,
            }))),
            config.version,
          );

          // Seed outcome rows (entry_price + returns filled later by evaluateOutcomes)
          const briefId = briefRow.lastInsertRowid as number;
          const entryPrice = signalMap.get(top5[0]?.ticker ?? '')?.lastPrice ?? null;

          for (let idx = 0; idx < top5.length; idx++) {
            const pick = top5[idx]!;
            const price = signalMap.get(pick.ticker)?.lastPrice ?? null;
            this.db.prepare(`
              INSERT OR IGNORE INTO replay_outcomes
                (replay_brief_id, ticker, rank, composite_score, entry_price)
              VALUES (?, ?, ?, ?, ?)
            `).run(briefId, pick.ticker, idx + 1, pick.compositeScore, price);
          }
          void entryPrice;
        }
      });
    }

    // Evaluate forward returns for all persisted picks
    onProgress({ phase: 'outcomes', current: 0, total: 1, currentDate: to, message: 'Evaluating forward returns…' });
    this.evaluateOutcomes();
    onProgress({ phase: 'done', current: days.length, total: days.length, currentDate: to, message: 'Done.' });
  }

  // ── Outcome evaluation ────────────────────────────────────────────────────

  evaluateOutcomes(): void {
    type OutcomeRow = {
      id: number;
      replay_brief_id: number;
      ticker: string;
      rank: number;
      composite_score: number;
      entry_price: number | null;
      as_of_date: string;
      strategy: string;
    };

    const rows = this.db.prepare(`
      SELECT ro.id, ro.replay_brief_id, ro.ticker, ro.rank, ro.composite_score,
             ro.entry_price, rb.as_of_date, rb.strategy
      FROM replay_outcomes ro
      JOIN replay_briefs rb ON rb.id = ro.replay_brief_id
      WHERE ro.evaluated_at IS NULL OR ro.ret_21d IS NULL
    `).all() as OutcomeRow[];

    if (rows.length === 0) return;

    // Load all historical prices for affected tickers
    const tickers = [...new Set(rows.map(r => r.ticker))];
    const ph = tickers.map(() => '?').join(',');
    type PRow = { ticker: string; date: string; close: number; low: number };
    const allPrices = this.db.prepare(`
      SELECT ticker, date, close, low FROM historical_prices
      WHERE ticker IN (${ph})
      ORDER BY ticker, date ASC
    `).all(...tickers) as PRow[];

    const priceMap = new Map<string, PRow[]>();
    for (const p of allPrices) {
      if (!priceMap.has(p.ticker)) priceMap.set(p.ticker, []);
      priceMap.get(p.ticker)!.push(p);
    }

    // Global "To" date = last scored trading day across all briefs in this run.
    // close_price / close_date show each ticker's price at this single endpoint
    // so all picks can be compared at the same moment (like a portfolio snapshot).
    const globalToDate = (this.db.prepare(
      'SELECT MAX(as_of_date) as d FROM replay_briefs'
    ).get() as { d: string | null }).d ?? '';

    const updateStmt = this.db.prepare(`
      UPDATE replay_outcomes
      SET ret_5d = ?, ret_10d = ?, ret_21d = ?, max_drawdown_21d = ?,
          synth_strike = ?, stayed_above_strike = ?, close_price = ?, close_date = ?, evaluated_at = ?
      WHERE id = ?
    `);

    withTransaction(this.db, () => {
      for (const row of rows) {
        const prices = priceMap.get(row.ticker);
        if (!prices || prices.length === 0) continue;

        // Find entry date index
        const entryIdx = prices.findIndex(p => p.date >= row.as_of_date);
        if (entryIdx < 0) continue;

        const entryPrice = row.entry_price ?? prices[entryIdx]!.close;

        // Build forward price array (trading days at and after entry)
        // forward[0] = entry day, forward[5] = 5 trading days later, etc.
        const forward = prices.slice(entryIdx);

        // Need at least entry day + 5 forward days to compute ret_5d
        if (forward.length < 6) continue;

        // Use exact indices — null when not enough forward data
        const close5  = forward.length > 5  ? forward[5]!.close  : null;
        const close10 = forward.length > 10 ? forward[10]!.close : null;
        const close21 = forward.length > 21 ? forward[21]!.close : null;

        const ret5d  = (close5  !== null && entryPrice > 0) ? ((close5  - entryPrice) / entryPrice) * 100 : null;
        const ret10d = (close10 !== null && entryPrice > 0) ? ((close10 - entryPrice) / entryPrice) * 100 : null;
        const ret21d = (close21 !== null && entryPrice > 0) ? ((close21 - entryPrice) / entryPrice) * 100 : null;

        // Max drawdown: worst low relative to entry over 21 days
        const fwd21 = forward.slice(0, Math.min(22, forward.length));
        const worstLow = Math.min(...fwd21.map(p => p.low));
        const maxDrawdown21d = entryPrice > 0 ? ((worstLow - entryPrice) / entryPrice) * 100 : null;

        // Wheel / income proxy: synthesize short strike ≈ 0.85× entry (delta-30 proxy)
        // Spec §6: K = S × (1 − 0.5 × IV × √(DTE/365)); simplified to S × 0.85 for 30 DTE
        const isShortPremium = row.strategy === 'wheel' || row.strategy === 'income';
        let synthStrike: number | null = null;
        let stayedAbove: number | null = null;
        if (isShortPremium && entryPrice > 0) {
          synthStrike = entryPrice * 0.85;
          // "win" if closing price never dropped below strike (lows used for worst-case)
          stayedAbove = fwd21.every(p => p.low >= synthStrike!) ? 1 : 0;
        }

        // Close price: ticker's price on the global replay To date (or closest prior bar)
        let closePrice: number | null = null;
        let closeDate: string | null = null;
        if (globalToDate) {
          for (let i = prices.length - 1; i >= 0; i--) {
            if (prices[i]!.date <= globalToDate) {
              closePrice = prices[i]!.close;
              closeDate  = prices[i]!.date;
              break;
            }
          }
        }

        updateStmt.run(
          ret5d, ret10d, ret21d, maxDrawdown21d,
          synthStrike, stayedAbove,
          closePrice, closeDate,
          new Date().toISOString(),
          row.id,
        );
      }
    });
  }

  // ── Query methods ─────────────────────────────────────────────────────────

  getSummaries(): ReplaySummary[] {
    return STRATEGIES.map(strategy => {
      type BriefRow = { total_dates: number };
      const briefs = this.db.prepare(`
        SELECT COUNT(*) as total_dates FROM replay_briefs WHERE strategy = ?
      `).get(strategy) as BriefRow;

      type PickRow = {
        total_picks: number;
        avg_ret5d: number | null;
        avg_ret10d: number | null;
        avg_ret21d: number | null;
        positive_5d: number;
        positive_10d: number;
        positive_21d: number;
        n_5d: number;
        n_10d: number;
        n_21d: number;
      };
      const picks = this.db.prepare(`
        SELECT
          COUNT(*) as total_picks,
          AVG(CASE WHEN ro.ret_5d  IS NOT NULL THEN ro.ret_5d  END) as avg_ret5d,
          AVG(CASE WHEN ro.ret_10d IS NOT NULL THEN ro.ret_10d END) as avg_ret10d,
          AVG(CASE WHEN ro.ret_21d IS NOT NULL THEN ro.ret_21d END) as avg_ret21d,
          -- bearish wins when stock goes DOWN; all others win when stock goes UP
          SUM(CASE WHEN (rb.strategy = 'bearish' AND ro.ret_5d  < 0) OR (rb.strategy != 'bearish' AND ro.ret_5d  > 0) THEN 1 ELSE 0 END) as positive_5d,
          SUM(CASE WHEN (rb.strategy = 'bearish' AND ro.ret_10d < 0) OR (rb.strategy != 'bearish' AND ro.ret_10d > 0) THEN 1 ELSE 0 END) as positive_10d,
          SUM(CASE WHEN (rb.strategy = 'bearish' AND ro.ret_21d < 0) OR (rb.strategy != 'bearish' AND ro.ret_21d > 0) THEN 1 ELSE 0 END) as positive_21d,
          COUNT(CASE WHEN ro.ret_5d  IS NOT NULL THEN 1 END) as n_5d,
          COUNT(CASE WHEN ro.ret_10d IS NOT NULL THEN 1 END) as n_10d,
          COUNT(CASE WHEN ro.ret_21d IS NOT NULL THEN 1 END) as n_21d
        FROM replay_outcomes ro
        JOIN replay_briefs rb ON rb.id = ro.replay_brief_id
        WHERE rb.strategy = ?
      `).get(strategy) as PickRow;

      const hitRate = (pos: number, n: number) => n > 0 ? Math.round((pos / n) * 1000) / 10 : null;

      return {
        strategy,
        totalDates:  briefs.total_dates,
        totalPicks:  picks.total_picks,
        n5d:  picks.n_5d,
        n10d: picks.n_10d,
        n21d: picks.n_21d,
        hitRate5d:  hitRate(picks.positive_5d,  picks.n_5d),
        hitRate10d: hitRate(picks.positive_10d, picks.n_10d),
        hitRate21d: hitRate(picks.positive_21d, picks.n_21d),
        avgReturn5d:  picks.avg_ret5d  !== null ? Math.round(picks.avg_ret5d  * 100) / 100 : null,
        avgReturn10d: picks.avg_ret10d !== null ? Math.round(picks.avg_ret10d * 100) / 100 : null,
        avgReturn21d: picks.avg_ret21d !== null ? Math.round(picks.avg_ret21d * 100) / 100 : null,
      };
    });
  }

  getPickRows(strategy?: string, limit = 500): ReplayPickRow[] {
    const strategyFilter = strategy ? 'AND rb.strategy = ?' : '';
    const args: unknown[] = strategy ? [strategy, limit] : [limit];

    type Row = {
      replay_brief_id: number;
      as_of_date: string;
      strategy: string;
      ticker: string;
      rank: number;
      composite_score: number;
      entry_price: number | null;
      ret_5d: number | null;
      ret_10d: number | null;
      ret_21d: number | null;
      max_drawdown_21d: number | null;
      stayed_above_strike: number | null;
      close_price: number | null;
      close_date: string | null;
      evaluated_at: string | null;
    };

    const rows = this.db.prepare(`
      SELECT
        ro.replay_brief_id, rb.as_of_date, rb.strategy,
        ro.ticker, ro.rank, ro.composite_score,
        ro.entry_price, ro.ret_5d, ro.ret_10d, ro.ret_21d,
        ro.max_drawdown_21d, ro.stayed_above_strike,
        ro.close_price, ro.close_date, ro.evaluated_at
      FROM replay_outcomes ro
      JOIN replay_briefs rb ON rb.id = ro.replay_brief_id
      WHERE 1=1 ${strategyFilter}
      ORDER BY rb.as_of_date DESC, rb.strategy, ro.rank
      LIMIT ?
    `).all(...args) as Row[];

    return rows.map(r => ({
      replayBriefId:      r.replay_brief_id,
      asOfDate:           r.as_of_date,
      strategy:           r.strategy,
      ticker:             r.ticker,
      rank:               r.rank,
      compositeScore:     r.composite_score,
      entryPrice:         r.entry_price,
      ret5d:              r.ret_5d,
      ret10d:             r.ret_10d,
      ret21d:             r.ret_21d,
      maxDrawdown21d:     r.max_drawdown_21d,
      stayedAboveStrike:  r.stayed_above_strike === null ? null : r.stayed_above_strike === 1,
      closePrice:         r.close_price,
      closeDate:          r.close_date,
      evaluatedAt:        r.evaluated_at,
    }));
  }

  // ── SPY regime (50-day SMA) ──────────────────────────────────────────────
  // Returns a map of as_of_date → 'bullish' | 'bearish' ('bullish' = SPY closed above
  // its 50-day SMA on that date). Used only for the descriptive regime-split chart
  // (ReplayChartsModal "Regime" tab). NOT a trade gate: the full-year replay showed
  // gating bearish to bear-regime dates inverted vs. the early 5-month sample, so no
  // regime filter is applied to pick selection. see minCompositeForStrategy().
  private computeSpyRegimes(): Map<string, 'bullish' | 'bearish'> {
    type DateRange = { min_date: string | null; max_date: string | null };
    const range = this.db.prepare(
      'SELECT MIN(as_of_date) as min_date, MAX(as_of_date) as max_date FROM replay_briefs'
    ).get() as DateRange;
    if (!range.min_date || !range.max_date) return new Map();

    // Need 50 trading days of SPY history before the first replay date
    const from = subtractCalendarDays(range.min_date, 100);
    type SpyRow = { date: string; close: number };
    const spyPrices = this.db.prepare(`
      SELECT date, close FROM historical_prices
      WHERE ticker = 'SPY' AND date >= ? AND date <= ?
      ORDER BY date ASC
    `).all(from, range.max_date) as SpyRow[];

    if (spyPrices.length === 0) return new Map();

    type DateRow = { as_of_date: string };
    const dates = (this.db.prepare(
      'SELECT DISTINCT as_of_date FROM replay_briefs ORDER BY as_of_date'
    ).all() as DateRow[]).map(r => r.as_of_date);

    const regimeMap = new Map<string, 'bullish' | 'bearish'>();
    for (const date of dates) {
      let endIdx = -1;
      for (let i = spyPrices.length - 1; i >= 0; i--) {
        if (spyPrices[i]!.date <= date) { endIdx = i; break; }
      }
      if (endIdx < 49) continue; // need 50 bars
      const close = spyPrices[endIdx]!.close;
      const sma50  = avg(spyPrices.slice(endIdx - 49, endIdx + 1).map(p => p.close));
      regimeMap.set(date, close > sma50 ? 'bullish' : 'bearish');
    }
    return regimeMap;
  }

  getChartData(): ReplayChartData | null {
    type MetaRow = { n: number; mn: string | null; mx: string | null };
    const meta = this.db.prepare(
      'SELECT COUNT(DISTINCT as_of_date) as n, MIN(as_of_date) as mn, MAX(as_of_date) as mx FROM replay_briefs'
    ).get() as MetaRow;
    if (!meta.n) return null;

    const regimeMap = this.computeSpyRegimes();

    type ORow = { as_of_date: string; strategy: string; ticker: string; rank: number; composite_score: number; ret_21d: number | null };
    const outcomes = this.db.prepare(`
      SELECT rb.as_of_date, rb.strategy, ro.ticker, ro.rank, ro.composite_score, ro.ret_21d
      FROM replay_outcomes ro
      JOIN replay_briefs rb ON rb.id = ro.replay_brief_id
      ORDER BY rb.as_of_date, rb.strategy, ro.rank
    `).all() as ORow[];

    const allDates = [...new Set(outcomes.map(r => r.as_of_date))].sort();
    const bullSet = new Set(allDates.filter(d => regimeMap.get(d) === 'bullish'));
    const bearSet = new Set(allDates.filter(d => regimeMap.get(d) === 'bearish'));

    const avgFn = (arr: number[]): number | null =>
      arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length * 10) / 10 : null;
    const hrFn = (arr: number[], reverse = false): number | null =>
      arr.length ? Math.round(arr.filter(v => reverse ? v < 0 : v > 0).length / arr.length * 100) : null;

    const STRATS = ['buy', 'bullish', 'income', 'wheel', 'bearish'] as const;

    const strategies = STRATS.map(s => {
      const sRows = outcomes.filter(r => r.strategy === s);
      const r21  = sRows.filter(r => r.ret_21d !== null).map(r => r.ret_21d as number);
      const bullR = sRows.filter(r => bullSet.has(r.as_of_date) && r.ret_21d !== null).map(r => r.ret_21d as number);
      const bearR = sRows.filter(r => bearSet.has(r.as_of_date) && r.ret_21d !== null).map(r => r.ret_21d as number);

      // Score quintiles: split by composite_score rank, compute avg21d per quintile
      const scored = sRows.filter(r => r.ret_21d !== null).slice().sort((a, b) => a.composite_score - b.composite_score);
      const qn = Math.floor(scored.length / 5);
      const scoreQuintiles = [0, 1, 2, 3, 4].map(i => {
        const slice = scored.slice(i * qn, i === 4 ? scored.length : (i + 1) * qn);
        return avgFn(slice.map(r => r.ret_21d as number));
      });

      // Rank 1–5 avg21d
      const rankAvg = [1, 2, 3, 4, 5].map(rank =>
        avgFn(sRows.filter(x => x.rank === rank && x.ret_21d !== null).map(x => x.ret_21d as number))
      );

      // Per-ticker aggregation (min 4 appearances)
      const tickerMap = new Map<string, number[]>();
      for (const row of sRows.filter(r => r.ret_21d !== null)) {
        const arr = tickerMap.get(row.ticker) ?? [];
        arr.push(row.ret_21d as number);
        tickerMap.set(row.ticker, arr);
      }
      const rev = s === 'bearish';
      const tickerStats = [...tickerMap.entries()]
        .filter(([, arr]) => arr.length >= 4)
        .map(([ticker, arr]) => ({
          ticker, n: arr.length,
          avg21d: avgFn(arr) ?? 0,
          hr: hrFn(arr, rev) ?? 0,
        }))
        // bearish: best = most negative (stock fell); others: best = most positive
        .sort((a, b) => rev ? a.avg21d - b.avg21d : b.avg21d - a.avg21d);

      return {
        strategy: s,
        n: sRows.length,
        avg21d: avgFn(r21),
        hr21d: hrFn(r21, rev),
        bullAvg21d: avgFn(bullR),
        bullHr21d: hrFn(bullR, rev),
        bullN: bullR.length,
        bearAvg21d: avgFn(bearR),
        bearHr21d: hrFn(bearR, rev),
        bearN: bearR.length,
        scoreQuintiles,
        rankAvg,
        topTickers: tickerStats.slice(0, 5),
        worstTickers: tickerStats.slice(-5).reverse(),
      };
    });

    // Monthly hit rate breakdown
    const months = [...new Set(allDates.map(d => d.slice(0, 7)))].sort();
    const monthly: ReplayChartMonthlyRow[] = months.map(ym => {
      const mDates = allDates.filter(d => d.startsWith(ym));
      const bul = mDates.filter(d => bullSet.has(d)).length;
      const bea = mDates.filter(d => bearSet.has(d)).length;
      const regime: ReplayChartMonthlyRow['regime'] =
        bul > bea * 2 ? 'bull' : bea > bul * 2 ? 'bear' : 'mix';

      const mHr = (strat: string): number | null => {
        const r = outcomes.filter(x => x.strategy === strat && x.as_of_date.startsWith(ym) && x.ret_21d !== null);
        const isRev = strat === 'bearish';
        return r.length ? Math.round(r.filter(x => isRev ? (x.ret_21d as number) < 0 : (x.ret_21d as number) > 0).length / r.length * 100) : null;
      };

      return {
        month: ym,
        label: new Date(ym + '-15').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
        regime,
        buy: mHr('buy'),
        bullish: mHr('bullish'),
        income: mHr('income'),
        wheel: mHr('wheel'),
        bearish: mHr('bearish'),
      };
    });

    return {
      dateRange: {
        from: meta.mn ?? '',
        to: meta.mx ?? '',
        dates: meta.n,
        picks: outcomes.filter(r => r.ret_21d !== null).length,
      },
      regimeDates: { bull: bullSet.size, bear: bearSet.size },
      strategies,
      monthly,
    };
  }

  getDateRange(): { from: string | null; to: string | null } {
    type Row = { min_date: string | null; max_date: string | null };
    const row = this.db.prepare(
      'SELECT MIN(as_of_date) as min_date, MAX(as_of_date) as max_date FROM replay_briefs'
    ).get() as Row;
    return { from: row.min_date, to: row.max_date };
  }

  // Coverage of options_premium_history (populated by daily-options-premium-history
  // job). "Matured" = captured at least MATURITY_DAYS ago, so the recommended option
  // would have expired and realized ROC is computable. Surfaces an in-app note in
  // Brief Replay once enough matured days accrue to make real income/wheel ROC worthwhile.
  getPremiumHistoryReadiness(): PremiumHistoryReadiness {
    const MATURITY_DAYS  = 45; // ~max DTE of the recommended structures
    const THRESHOLD_DAYS = 40; // ~2 months of matured captures before ROC is meaningful

    type Row = { total: number; days: number; min_d: string | null; max_d: string | null; matured: number };
    const row = this.db.prepare(`
      SELECT
        COUNT(*)                                   AS total,
        COUNT(DISTINCT as_of_date)                 AS days,
        MIN(as_of_date)                            AS min_d,
        MAX(as_of_date)                            AS max_d,
        COUNT(DISTINCT CASE WHEN as_of_date <= date('now', '-${MATURITY_DAYS} days')
                            THEN as_of_date END)   AS matured
      FROM options_premium_history
    `).get() as Row;

    return {
      totalRows:     row.total,
      days:          row.days,
      fromDate:      row.min_d,
      toDate:        row.max_d,
      maturedDays:   row.matured,
      thresholdDays: THRESHOLD_DAYS,
      ready:         row.matured >= THRESHOLD_DAYS,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private loadCandidates(): string[] {
    const REF_TICKERS = new Set<string>(['SPY', 'XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLP', 'XLY', 'XLB', 'XLRE', 'XLU', 'XLC']);
    type Row = { ticker: string };
    const rows = this.db.prepare(`
      SELECT DISTINCT ticker FROM constituents
      WHERE index_name IN ('sp500', 'russell1000', 'etf')
      ORDER BY ticker ASC
    `).all() as Row[];
    return rows.map(r => r.ticker).filter(t => !REF_TICKERS.has(t));
  }

  private loadPriceCache(tickers: string[], from: string, to: string): Map<string, PriceRow[]> {
    const ph = tickers.map(() => '?').join(',');
    type Row = { ticker: string; date: string; close: number; high: number; low: number; volume: number };
    const rows = this.db.prepare(`
      SELECT ticker, date, close, high, low, volume
      FROM historical_prices
      WHERE ticker IN (${ph}) AND date >= ? AND date <= ?
      ORDER BY ticker, date ASC
    `).all(...tickers, from, to) as Row[];

    const cache = new Map<string, PriceRow[]>();
    for (const r of rows) {
      if (!cache.has(r.ticker)) cache.set(r.ticker, []);
      cache.get(r.ticker)!.push({ date: r.date, close: r.close, high: r.high, low: r.low, volume: r.volume });
    }
    return cache;
  }

  private loadIvCache(tickers: string[], from: string, to: string): Map<string, IvRow[]> {
    const ph = tickers.map(() => '?').join(',');
    type Row = { ticker: string; date: string; atm_iv: number };
    const rows = this.db.prepare(`
      SELECT ticker, date, atm_iv
      FROM iv_history
      WHERE ticker IN (${ph}) AND date >= ? AND date <= ?
      ORDER BY ticker, date ASC
    `).all(...tickers, from, to) as Row[];

    const cache = new Map<string, IvRow[]>();
    for (const r of rows) {
      if (!cache.has(r.ticker)) cache.set(r.ticker, []);
      cache.get(r.ticker)!.push({ date: r.date, atm_iv: r.atm_iv });
    }
    return cache;
  }

  private loadFundamentals(tickers: string[]): Map<string, {
    fundamentalScore: number | null;
    epsGrowth: number | null;
    revenueGrowth: number | null;
    fcfToNetIncome: number | null;
    roic: number | null;
    netDebtToEbitda: number | null;
    revenueGrowth5Y: number | null;
    epsGrowth5Y: number | null;
  }> {
    const ph = tickers.map(() => '?').join(',');
    type Row = { ticker: string; payload_json: string };
    const rows = this.db.prepare(
      `SELECT ticker, payload_json FROM fundamentals_cache WHERE ticker IN (${ph})`
    ).all(...tickers) as Row[];

    const map = new Map<string, ReturnType<typeof this.loadFundamentals> extends Map<string, infer V> ? V : never>();
    for (const row of rows) {
      const p = JSON.parse(row.payload_json) as ScreenResultPayload;
      const nd = p.netDebtToEbitda ?? (p.debtToEquity != null ? +(p.debtToEquity * 2.5).toFixed(2) : null);
      map.set(row.ticker, {
        fundamentalScore: this.scoreFundamentals(p),
        epsGrowth:        p.epsGrowth,
        revenueGrowth:    p.revenueGrowth,
        fcfToNetIncome:   p.fcfToNetIncome ?? null,
        roic:             p.roic ?? null,
        netDebtToEbitda:  nd,
        revenueGrowth5Y:  p.revenueGrowth5Y ?? null,
        epsGrowth5Y:      p.epsGrowth5Y ?? null,
      });
    }
    return map;
  }

  private scoreFundamentals(data: ScreenResultPayload): number | null {
    let score = 0, max = 0;
    if (data.roe !== null) { max += 15; score += Math.min(15, Math.max(0, (data.roe / 20) * 15)); }
    if (data.profitMargin !== null) { max += 10; score += Math.min(10, Math.max(0, (data.profitMargin / 15) * 10)); }
    if (data.roic !== null) { max += 15; score += Math.min(15, Math.max(0, (data.roic / 20) * 15)); }
    if (data.fcfToNetIncome !== null) { max += 15; score += Math.min(15, Math.max(0, (data.fcfToNetIncome / 100) * 15)); }
    if (data.epsGrowth !== null) { max += 15; score += Math.min(15, Math.max(0, (data.epsGrowth / 20) * 15)); }
    if (data.revenueGrowth !== null) { max += 10; score += Math.min(10, Math.max(0, (data.revenueGrowth / 15) * 10)); }
    if (data.debtToEquity !== null) { max += 10; score += Math.min(10, Math.max(0, (1 - data.debtToEquity / 2) * 10)); }
    if (data.freeCashFlow !== null && data.freeCashFlow > 0) { max += 10; score += 10; }
    return max > 0 ? Math.round((score / max) * 100) : null;
  }

  private loadSectorMap(tickers: string[]): Map<string, string> {
    const ph = tickers.map(() => '?').join(',');
    type Row = { ticker: string; sector: string | null };
    const rows = this.db.prepare(`
      SELECT ticker, json_extract(payload_json, '$.sector') AS sector
      FROM fundamentals_cache WHERE ticker IN (${ph})
    `).all(...tickers) as Row[];

    const map = new Map<string, string>();
    for (const row of rows) {
      if (!row.sector) continue;
      const etf = SECTOR_ETF[row.sector] ?? sectorStringToEtf(row.sector);
      if (etf) map.set(row.ticker, etf);
    }
    return map;
  }

  private ticker90dReturn(ticker: string, asOf: string, priceCache: Map<string, PriceRow[]>): number | null {
    const prices = priceCache.get(ticker);
    if (!prices || prices.length === 0) return null;
    const endIdx = upperBound(prices, asOf);
    return return90d(prices, endIdx);
  }

  private computeIvRankAsOf(ticker: string, asOf: string, ivCache: Map<string, IvRow[]>): number | null {
    const rows = ivCache.get(ticker);
    if (!rows || rows.length === 0) return null;

    // Filter to date <= asOf, take last 252
    let endIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.date <= asOf) { endIdx = i; break; }
    }
    if (endIdx < 0) return null;

    const startIdx = Math.max(0, endIdx - 251); // up to 252 rows
    const window = rows.slice(startIdx, endIdx + 1);
    if (window.length < 21) return null;

    const currentIv = window[window.length - 1]!.atm_iv;
    const ivs       = window.map(r => r.atm_iv);
    const minIv     = Math.min(...ivs);
    const maxIv     = Math.max(...ivs);
    if (maxIv === minIv) return 50;
    return ((currentIv - minIv) / (maxIv - minIv)) * 100;
  }
}
