// Collared LEAPS Strategy Screener
// Position = long deep-ITM LEAPS call + long OTM protective put on same underlying.
// The put is insurance on the LEAPS; its strike, expiry, and cost derive from the LEAPS chosen.
//
// Pipeline:
//   Market gate → Universe filters → LEAPS candidate selection →
//   Put candidate generation (up to 12 per LEAPS: 4 expiries × 3 floor bands) →
//   Combined structure hard fails → Score (3 sub-scores) → P&L grid → Rank → Persist

import { withTransaction } from '../db/connection.js';
import type { DbHandle } from '../db/connection.js';
import type { DataProvider } from './data-provider.js';
import type { OptionsProvider } from './options-provider.js';
import type { TokenBucketRateLimiter } from './rate-limiter.js';
import type {
  CollaredLeapsGate,
  CollaredLeapsGateDetail,
  CollaredLeapsGrade,
  CollaredLeapsOpportunity,
  CollaredLeapsRunResult,
  CollaredLeapsRunSummary,
  CollaredLeapsScoreComponent,
  CollaredLeapsDetail,
  CollaredLeapsPnlPoint,
  CollaredLeapsOpenedEntry,
  CollaredLeapsProgressDetail,
} from '@shared/types.js';

// ─── Internal working types ───────────────────────────────────────────────────

interface FundamentalsRow {
  ticker: string;
  marketCap: number | null;
  sector: string | null;
  roe: number | null;
  debtToEquity: number | null;
  freeCashFlow: number | null;
  peRatio: number | null;
}

interface QuoteRow {
  ticker: string;
  last: number | null;
  volume: number | null;
}

interface IvData {
  currentIv: number | null;   // percentage, e.g. 28.5
  iv52WkHigh: number | null;
  iv52WkLow: number | null;
  ivr: number | null;         // 0–100
}

interface OptionContract {
  strike: number;
  side: 'call' | 'put';
  bid: number;
  ask: number;
  delta: number | null;
  iv: number;                 // raw fraction from provider (e.g. 0.285)
  openInterest: number | null;
  volume: number | null;
}

interface LeapsCandidate {
  ticker: string;
  spot: number;
  ma200d: number | null;
  contract: OptionContract;
  expiry: string;
  dte: number;
  midPrice: number;
  debit: number;              // midPrice × 100
  extrinsicPct: number;
  spreadPct: number;
  ivPct: number;
  ivr: number | null;
  subScore: number;
  scoreBreakdown: CollaredLeapsScoreComponent[];
}

interface PutCandidate {
  contract: OptionContract;
  expiry: string;
  dte: number;
  midPrice: number;
  debit: number;              // midPrice × 100
  spreadPct: number;
  ivPct: number;
  ivr: number | null;
  subScore: number;
  scoreBreakdown: CollaredLeapsScoreComponent[];
}

interface StructuralMetrics {
  costDragPct: number;
  floorDepthPct: number;
  breakeven: number;
  maxLossAtPut: number;
  maxLossAtZero: number;      // can be negative (put over-insures)
  upsideRetentionPct: number;
  hedgeEfficiencyPct: number;
  rrRatio: number | null;
}

interface CollaredPair {
  leaps: LeapsCandidate;
  put: PutCandidate;
  metrics: StructuralMetrics;
  structuralSubScore: number;
  structuralScoreBreakdown: CollaredLeapsScoreComponent[];
  combinedScore: number;
  grade: CollaredLeapsGrade;
  cautionFlags: string[];
  gateSurvived: boolean;
  pnlGrid: CollaredLeapsPnlPoint[];
  pnlGrid180d?: CollaredLeapsPnlPoint[];
  pnlGrid90d?: CollaredLeapsPnlPoint[];
  pnlGrid30d?: CollaredLeapsPnlPoint[];
}

// ─── Excluded sectors ─────────────────────────────────────────────────────────

const EXCLUDED_SECTORS = new Set(['biotechnology', 'biopharmaceutical', 'pharmaceutical', 'spac']);

function isBiotech(sector: string | null): boolean {
  if (!sector) return false;
  const s = sector.toLowerCase();
  return EXCLUDED_SECTORS.has(s) || s.includes('biotech') || s.includes('biopharm');
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function dteDays(expiryYMD: string): number {
  const exp = new Date(expiryYMD + 'T16:00:00Z');
  return Math.round((exp.getTime() - Date.now()) / 86_400_000);
}

function thirdFridayOfJanuary(year: number): string {
  const d = new Date(Date.UTC(year, 0, 1));
  const dow = d.getUTCDay();
  const daysToFri = (5 - dow + 7) % 7;
  d.setUTCDate(1 + daysToFri + 14);
  return d.toISOString().slice(0, 10);
}

/** LEAPS expiry dates: 365–730 DTE window (Jan + Jun LEAPS). */
function leapsExpiryDates(): string[] {
  const now = new Date();
  const thisYear = now.getFullYear();
  const candidates: string[] = [];
  for (let y = thisYear; y <= thisYear + 3; y++) {
    candidates.push(thirdFridayOfJanuary(y));
    const d = new Date(Date.UTC(y, 5, 1));
    const dow = d.getUTCDay();
    const daysToFri = (5 - dow + 7) % 7;
    d.setUTCDate(1 + daysToFri + 14);
    candidates.push(d.toISOString().slice(0, 10));
  }
  return candidates.filter(e => { const d = dteDays(e); return d >= 365 && d <= 730; });
}

/**
 * Generate up to 4 put expiry date candidates for a given LEAPS DTE.
 * In priority order: match LEAPS, LEAPS-90d, 180 DTE, 90 DTE.
 * All clamped to [60, leapsDte].
 */
function putExpiryTargets(leapsExpiry: string): Array<{ label: string; targetDte: number }> {
  const leapsDte = dteDays(leapsExpiry);
  return [
    { label: 'match-leaps', targetDte: leapsDte },
    { label: 'leaps-minus-90', targetDte: leapsDte - 90 },
    { label: '180d', targetDte: 180 },
    { label: '90d', targetDte: 90 },
  ].filter(t => t.targetDte >= 60 && t.targetDte <= leapsDte);
}

/** Nearest Friday date to a given DTE target from today. */
function fridayNearDte(targetDte: number): string {
  const now = new Date();
  const target = new Date(now.getTime() + targetDte * 86_400_000);
  const dow = target.getUTCDay();
  // Snap to nearest Friday
  const daysToFri = (5 - dow + 7) % 7;
  const daysBack = dow >= 1 ? dow - 5 : 0;
  const snap = daysToFri <= Math.abs(daysBack) ? daysToFri : -Math.abs(daysBack === 0 ? 0 : daysBack);
  target.setUTCDate(target.getUTCDate() + (daysToFri <= 3 ? daysToFri : daysToFri - 7));
  return target.toISOString().slice(0, 10);
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function gradeScore(score: number): CollaredLeapsGrade {
  if (score >= 9.0) return 'A+';
  if (score >= 8.0) return 'A';
  if (score >= 7.0) return 'B';
  if (score >= 6.0) return 'C';
  return 'F';
}

// ─── Black-Scholes for time-horizon P&L grids ─────────────────────────────────
// see docs/formulas.md#black-scholes

/** Abramowitz & Stegun approximation for standard normal CDF (error < 7.5e-8). */
function normCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422820 * Math.exp(-0.5 * x * x);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return x > 0 ? 1 - p : p;
}

/**
 * Black-Scholes option price.
 * @param S  current spot
 * @param K  strike
 * @param T  time to expiry in years (must be > 0)
 * @param iv implied volatility as fraction (e.g. 0.285)
 * @param r  risk-free rate (e.g. 0.05)
 * @param isCall true for call, false for put
 */
function bsPrice(S: number, K: number, T: number, iv: number, r: number, isCall: boolean): number {
  if (T <= 0 || iv <= 0 || S <= 0 || K <= 0) {
    // At expiry or degenerate: intrinsic only
    return isCall ? Math.max(0, S - K) : Math.max(0, K - S);
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * T) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  if (isCall) {
    return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  } else {
    return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
  }
}

// ─── P&L grid builders ────────────────────────────────────────────────────────

interface GridParams {
  spot: number;
  kCall: number;
  kPut: number;
  leapsDebit: number;
  putDebit: number;
  leapsIv: number;    // fraction
  putIv: number;      // fraction
  remainingYears: number;
}

/** Compute 200-point P&L grid from 50% to 150% of spot. */
function buildPnlGrid(p: GridParams): CollaredLeapsPnlPoint[] {
  const totalDebit = p.leapsDebit + p.putDebit;
  const points: CollaredLeapsPnlPoint[] = [];
  for (let i = 0; i < 200; i++) {
    const price = p.spot * (0.5 + i * (1.0 / 199));
    let nakedPnl: number;
    let collarPnl: number;
    if (p.remainingYears <= 0) {
      // Expiry: intrinsic only
      nakedPnl = Math.max(0, price - p.kCall) * 100 - p.leapsDebit;
      collarPnl = Math.max(0, price - p.kCall) * 100 + Math.max(0, p.kPut - price) * 100 - totalDebit;
    } else {
      const r = 0.05;
      const leapsVal = bsPrice(price, p.kCall, p.remainingYears, p.leapsIv, r, true) * 100;
      const putVal = bsPrice(price, p.kPut, p.remainingYears, p.putIv, r, false) * 100;
      nakedPnl = leapsVal - p.leapsDebit;
      collarPnl = leapsVal + putVal - totalDebit;
    }
    points.push({ price: Math.round(price * 100) / 100, collarPnl: Math.round(collarPnl * 100) / 100, nakedPnl: Math.round(nakedPnl * 100) / 100 });
  }
  return points;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class CollaredLeapsService {
  constructor(
    private readonly db: DbHandle,
    private readonly dataProvider: DataProvider,
    private readonly optionsProvider: OptionsProvider,
    private readonly rateLimiter: TokenBucketRateLimiter,
  ) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  async runScreen(
    universe: 'sp500' | 'russell1000' | 'both' | 'etf',
    onProgress?: (msg: string) => void,
    forceRun = false,
    onProgressDetail?: (detail: CollaredLeapsProgressDetail) => void,
    watchlistId?: number,
  ): Promise<CollaredLeapsRunResult> {
    const log = (msg: string) => { onProgress?.(msg); };
    const isEtf = universe === 'etf';
    const progress = (detail: CollaredLeapsProgressDetail) => { onProgressDetail?.(detail); };

    // ── Phase 1: Market gate ─────────────────────────────────────────────────
    log('Checking market gate…');
    progress({ phase: 'gate', current: 0, total: 1 });
    const { gate, detail: gateDetail, effect: gateEffect } = await this.checkMarketGate();
    log(`Market gate: ${gate} — ${gateEffect}`);
    progress({ phase: 'gate', current: 1, total: 1 });

    // Collared LEAPS SURVIVES fail gate (collar = defined risk by design).
    // We still run but tighten structural requirements in the scoring phase.
    if (gate === 'FAIL') {
      log('Market gate FAIL: only strong-protection collars will be surfaced (costDrag ≤ 15%, floorDepth ≥ 12%).');
    }

    // ── Phase 2: Universe loading ────────────────────────────────────────────
    let tickers: string[];
    if (watchlistId != null) {
      log(`Loading tickers from watchlist ${watchlistId}…`);
      progress({ phase: 'universe', current: 0, total: 1 });
      tickers = this.getWatchlistTickers(watchlistId);
      log(`${tickers.length} tickers from watchlist`);
    } else {
      log('Loading universe from screener cache…');
      progress({ phase: 'universe', current: 0, total: 1 });
      tickers = this.getScreenedTickers(universe);
      log(`${tickers.length} tickers from screener cache`);
    }
    progress({ phase: 'universe', current: 1, total: 1 });

    if (tickers.length === 0) {
      log(watchlistId != null
        ? 'Watchlist is empty. Add tickers to the watchlist first.'
        : 'No tickers found. Ensure constituents are loaded (Data Sync) and try again.');
      return this.persistRun({ gate, gateDetail, gateEffect, universe, watchlistId: watchlistId ?? null }, 0, []);
    }

    // ── Phase 3: Load cached fundamentals & quotes, fetch missing on-demand ─
    log('Loading cached fundamentals & quotes…');
    const fundamentalsMap = this.loadFundamentalsCache(tickers);
    const quotesMap = this.loadQuoteCache(tickers);

    const missingFundamentals = tickers.filter(t => !fundamentalsMap.has(t));
    const missingQuotes = tickers.filter(t => !quotesMap.has(t));
    const missingTickers = [...new Set([...missingFundamentals, ...missingQuotes])];

    if (missingTickers.length > 0) {
      log(`Fetching on-demand data for ${missingTickers.length} tickers…`);
    }
    for (const ticker of missingTickers) {
      await this.rateLimiter.acquire();
      const q = await this.safeQuote(ticker);
      if (q) quotesMap.set(ticker, { ticker, last: q.last, volume: q.volume });

      await this.rateLimiter.acquire();
      try {
        const ratios = await this.dataProvider.getFundamentals(ticker);
        fundamentalsMap.set(ticker, {
          ticker,
          marketCap: ratios.marketCap ?? null,
          sector: ratios.sector ?? null,
          roe: ratios.roe ?? null,
          debtToEquity: ratios.debtToEquity ?? null,
          freeCashFlow: ratios.freeCashFlow ?? null,
          peRatio: ratios.peRatio ?? null,
        });
      } catch { /* skip */ }
    }

    // ── Universe filters ─────────────────────────────────────────────────────
    log('Applying universe filters…');
    const filtered = tickers.filter(t => this.passUniverseFilter(t, fundamentalsMap.get(t), quotesMap.get(t), isEtf));
    log(`${filtered.length} of ${tickers.length} tickers pass universe filters`);

    if (filtered.length === 0) {
      return this.persistRun({ gate, gateDetail, gateEffect, universe, watchlistId: watchlistId ?? null }, 0, []);
    }

    // ── Resolve expiry dates from provider ──────────────────────────────────
    // One call per sample ticker gives us all listed expirations; derive both
    // the LEAPS window (365–730 DTE) and the put window (60–730 DTE) from it.
    let leapsExpiries = leapsExpiryDates();
    let allPutExpiries: string[] = [];   // real provider dates for put legs
    if (filtered.length > 0) {
      try {
        await this.rateLimiter.acquire();
        const providerExpiries = await this.optionsProvider.getOptionsExpirations(filtered[0]!);
        if (providerExpiries.length > 0) {
          const realLeaps = providerExpiries.filter(e => { const d = dteDays(e); return d >= 365 && d <= 730; });
          if (realLeaps.length > 0) {
            leapsExpiries = realLeaps;
            log(`Provider: ${realLeaps.length} LEAPS expirations: ${realLeaps.join(', ')}`);
          }
          allPutExpiries = providerExpiries.filter(e => { const d = dteDays(e); return d >= 60 && d <= 730; });
          log(`Provider: ${allPutExpiries.length} put-range expirations available`);
        }
      } catch { /* use generated dates */ }
    }

    if (leapsExpiries.length === 0) {
      log('No valid LEAPS expiry dates found in 365–730 DTE window.');
      return this.persistRun({ gate, gateDetail, gateEffect, universe, watchlistId: watchlistId ?? null }, filtered.length, []);
    }

    // ── Phase 4: LEAPS candidate selection ───────────────────────────────────
    log(`Screening LEAPS candidates (expiries: ${leapsExpiries.join(', ')})…`);
    const leapsCandidates: LeapsCandidate[] = [];
    let skipNoPrice = 0, skipNoChain = 0, skipNoContract = 0, skipIvr = 0;
    const leapsTotal = filtered.length;

    for (let i = 0; i < filtered.length; i++) {
      const ticker = filtered[i]!;
      progress({ phase: 'leaps', current: i + 1, total: leapsTotal, ticker });

      const q = quotesMap.get(ticker);
      const spot = q?.last ?? null;
      if (!spot || spot <= 0) { skipNoPrice++; continue; }

      // Fetch IV for IVR computation + IVR > 80 hard fail
      await this.rateLimiter.acquire();
      const ivData = await this.fetchIvData(ticker);
      if (ivData.ivr !== null && ivData.ivr > 80) { skipIvr++; continue; }

      // Fetch 200d MA (historical bars)
      await this.rateLimiter.acquire();
      const bars = await this.safeBars(ticker, 'day', 210);
      const closes = bars.map(b => b.c);
      const ma200d = closes.length >= 200
        ? closes.slice(-200).reduce((a, b) => a + b, 0) / 200
        : null;

      // Try each LEAPS expiry, keep best-scored contract
      let best: LeapsCandidate | null = null;
      let chainCount = 0;
      for (const expiry of leapsExpiries) {
        await this.rateLimiter.acquire();
        const chain = await this.safeGetChain(ticker, expiry);
        if (!chain) continue;
        chainCount++;

        const calls = chain.filter(c => c.side === 'call');
        const contract = this.selectLeapsContract(calls, spot);
        if (!contract) continue;

        const dte = dteDays(expiry);
        const midPrice = (contract.bid + contract.ask) / 2;
        const intrinsic = Math.max(0, spot - contract.strike);
        const extrinsicPct = midPrice > 0 ? ((midPrice - intrinsic) / midPrice) * 100 : 999;
        const spreadPct = midPrice > 0 ? ((contract.ask - contract.bid) / midPrice) * 100 : 99;

        if (this.passLeapsContractHardFails(contract, midPrice, extrinsicPct)) continue;

        const ivPct = contract.iv * 100;
        const { score, breakdown } = this.scoreLeapsLeg(contract, dte, extrinsicPct, ivData);

        const candidate: LeapsCandidate = {
          ticker, spot, ma200d,
          contract, expiry, dte,
          midPrice, debit: midPrice * 100,
          extrinsicPct, spreadPct, ivPct,
          ivr: ivData.ivr,
          subScore: score,
          scoreBreakdown: breakdown,
        };
        if (!best || score > best.subScore) best = candidate;
      }

      if (chainCount === 0) skipNoChain++;
      else if (!best) skipNoContract++;
      if (best) leapsCandidates.push(best);
    }

    log(`${leapsCandidates.length} qualifying LEAPS candidates (skipNoPrice=${skipNoPrice} skipIvr=${skipIvr} skipNoChain=${skipNoChain} skipNoContract=${skipNoContract})`);

    if (leapsCandidates.length === 0) {
      return this.persistRun({ gate, gateDetail, gateEffect, universe, watchlistId: watchlistId ?? null }, filtered.length, []);
    }

    // ── Phase 5: Put candidate generation ────────────────────────────────────
    log('Generating put candidates…');
    const pairs: CollaredPair[] = [];
    const putTotal = leapsCandidates.length;

    for (let i = 0; i < leapsCandidates.length; i++) {
      const leaps = leapsCandidates[i]!;
      progress({ phase: 'puts', current: i + 1, total: putTotal, ticker: leaps.ticker });

      const expiryTargets = putExpiryTargets(leaps.expiry);
      let bestPair: CollaredPair | null = null;

      // Build the pool of real put expiries for this LEAPS candidate.
      // Provider dates if available; fall back to computed Fridays.
      const leapsDteCeil = dteDays(leaps.expiry);
      const resolvedPutExpiries: string[] = allPutExpiries.length > 0
        ? allPutExpiries.filter(e => { const d = dteDays(e); return d >= 60 && d <= leapsDteCeil; })
        : expiryTargets
            .map(t => fridayNearDte(t.targetDte))
            .filter(e => { const d = dteDays(e); return d >= 60 && d <= leapsDteCeil; });

      for (const expTarget of expiryTargets) {
        // Pick the real expiry closest to the target DTE
        let putExpiry: string;
        if (resolvedPutExpiries.length > 0) {
          putExpiry = resolvedPutExpiries.reduce((best, e) =>
            Math.abs(dteDays(e) - expTarget.targetDte) < Math.abs(dteDays(best) - expTarget.targetDte) ? e : best,
          );
        } else {
          putExpiry = fridayNearDte(expTarget.targetDte);
        }
        const putDte = dteDays(putExpiry);

        if (putDte < 60 || putDte > leapsDteCeil) continue;

        await this.rateLimiter.acquire();
        const chain = await this.safeGetChain(leaps.ticker, putExpiry);
        if (!chain) continue;

        const puts = chain.filter(c => c.side === 'put');
        if (puts.length === 0) continue;

        // Three floor-depth bands
        const bands = [
          { lo: leaps.spot * 0.82, hi: leaps.spot * 0.86 },   // shallow: ~14–18% below
          { lo: leaps.spot * 0.86, hi: leaps.spot * 0.90 },   // mid: ~10–14% below
          { lo: leaps.spot * 0.90, hi: leaps.spot * 0.94 },   // tight: ~6–10% below
        ];

        for (const band of bands) {
          const bandMid = (band.lo + band.hi) / 2;
          // Find put closest to band midpoint; allow ±1 strike outside the band
          // if no strike falls exactly within it (handles wide strike spacing).
          const inBand = puts
            .filter(c => c.strike >= band.lo && c.strike <= band.hi)
            .sort((a, b) => Math.abs(a.strike - bandMid) - Math.abs(b.strike - bandMid));
          const nearBand = inBand.length > 0
            ? inBand
            : puts
                .filter(c => c.strike >= leaps.spot * 0.78 && c.strike <= leaps.spot * 0.94)
                .sort((a, b) => Math.abs(a.strike - bandMid) - Math.abs(b.strike - bandMid))
                .slice(0, 1);

          if (nearBand.length === 0) continue;
          const contract = nearBand[0]!;

          const midPrice = (contract.bid + contract.ask) / 2;
          if (midPrice <= 0) continue;
          const spreadPct = ((contract.ask - contract.bid) / midPrice) * 100;

          // Put leg hard fails
          const delta = contract.delta ?? null;
          // Delta -0.30 to -0.07 (allow very-OTM protective puts at shallow floor)
          if (delta !== null && (delta < -0.30 || delta > -0.07)) continue;
          if (contract.strike < leaps.spot * 0.78 || contract.strike > leaps.spot * 0.94) continue;
          if (putDte < 60 || putDte > leapsDteCeil) continue;
          // Spread: percentage cap only — absolute-dollar caps are wrong for options
          if (spreadPct > 15) continue;
          if ((contract.openInterest ?? 0) < 100) continue;

          // Score put leg
          const putIvData = await this.fetchIvDataCached(leaps.ticker);
          const ivPct = contract.iv * 100;
          const { score: putScore, breakdown: putBreakdown } = this.scorePutLeg(
            contract, midPrice, putDte, leaps, putIvData,
          );

          const putCandidate: PutCandidate = {
            contract, expiry: putExpiry, dte: putDte,
            midPrice, debit: midPrice * 100,
            spreadPct, ivPct, ivr: putIvData.ivr,
            subScore: putScore, scoreBreakdown: putBreakdown,
          };

          // Compute structural metrics
          const metrics = this.computeStructuralMetrics(leaps, putCandidate);

          // Combined structure hard fails
          if (metrics.costDragPct > 25) continue;
          if (metrics.maxLossAtZero >= (leaps.debit + putCandidate.debit) * 0.65) continue;
          if (metrics.upsideRetentionPct < 75) continue;

          // Score structural quality
          const { score: structScore, breakdown: structBreakdown } = this.scoreStructural(metrics, leaps, putCandidate);

          // Combined score
          const isCAUTION = gate === 'CAUTION';
          const leapsW = isCAUTION ? 0.30 : 0.35;
          const putW = isCAUTION ? 0.30 : 0.25;
          const structW = 0.40;
          let combined = leaps.subScore * leapsW + putCandidate.subScore * putW + structScore * structW;

          // Caution flags
          const flags = this.computeCautionFlags(metrics, leaps, putCandidate, gate);
          const deduction = Math.min(flags.length * 0.25, 1.0);
          combined = clamp(round1(combined - deduction), 0, 10);

          const gradeVal = gradeScore(combined);
          const gateSurvived = gate === 'FAIL'
            ? (metrics.costDragPct <= 15 && metrics.floorDepthPct >= 12)
            : true;

          // P&L grids
          const gridParams: GridParams = {
            spot: leaps.spot,
            kCall: leaps.contract.strike,
            kPut: contract.strike,
            leapsDebit: leaps.debit,
            putDebit: putCandidate.debit,
            leapsIv: leaps.contract.iv,
            putIv: contract.iv,
            remainingYears: 0,
          };
          const pnlGrid = buildPnlGrid(gridParams);

          const leapsDte = dteDays(leaps.expiry);
          const pnlGrid180d = leapsDte >= 190 ? buildPnlGrid({ ...gridParams, remainingYears: 180 / 365 }) : undefined;
          const pnlGrid90d = leapsDte >= 100 ? buildPnlGrid({ ...gridParams, remainingYears: 90 / 365 }) : undefined;
          const pnlGrid30d = leapsDte >= 40 ? buildPnlGrid({ ...gridParams, remainingYears: 30 / 365 }) : undefined;

          const pair: CollaredPair = {
            leaps, put: putCandidate,
            metrics, structuralSubScore: structScore, structuralScoreBreakdown: structBreakdown,
            combinedScore: combined, grade: gradeVal,
            cautionFlags: flags, gateSurvived,
            pnlGrid, pnlGrid180d, pnlGrid90d, pnlGrid30d,
          };

          // Keep best pair per LEAPS (highest structural sub-score)
          if (!bestPair || structScore > bestPair.structuralSubScore) bestPair = pair;
        }
      }

      if (bestPair) pairs.push(bestPair);
    }

    progress({ phase: 'structural', current: pairs.length, total: pairs.length });
    log(`${pairs.length} collar opportunities after structure hard fails`);

    // ── Phase 6: Sort, filter, persist ───────────────────────────────────────
    progress({ phase: 'persist', current: 0, total: 1 });

    // Default view excludes F-grade; persist all ≥ C + all FAIL-gate gate-survived
    const toSave = pairs
      .filter(p => p.combinedScore >= 6.0 || p.gateSurvived)
      .sort((a, b) => b.combinedScore - a.combinedScore);

    log(`Persisting ${toSave.length} opportunities (grade ≥ C or gate-survived)…`);
    const result = this.persistRun(
      { gate, gateDetail, gateEffect, universe, watchlistId: watchlistId ?? null },
      filtered.length,
      toSave,
    );

    progress({ phase: 'persist', current: 1, total: 1 });
    log(`Done — ${result.opportunities.length} opportunities ranked.`);
    return result;
  }

  getRecentRuns(): CollaredLeapsRunSummary[] {
    const rows = this.db.prepare(`
      SELECT id, run_at, universe, watchlist_id, market_gate, gate_detail_json, gate_effect,
             candidate_count, opportunity_count
      FROM collared_leaps_runs
      ORDER BY id DESC LIMIT 20
    `).all() as Array<{
      id: number; run_at: string; universe: string; watchlist_id: number | null;
      market_gate: string; gate_detail_json: string; gate_effect: string;
      candidate_count: number; opportunity_count: number;
    }>;

    return rows.map(r => ({
      id: r.id,
      runAt: r.run_at,
      universe: r.universe,
      watchlistId: r.watchlist_id,
      marketGate: r.market_gate as CollaredLeapsGate,
      gateDetail: JSON.parse(r.gate_detail_json) as CollaredLeapsGateDetail,
      gateEffect: r.gate_effect,
      candidateCount: r.candidate_count,
      opportunityCount: r.opportunity_count,
    }));
  }

  getRun(runId: number): CollaredLeapsRunResult | null {
    const runRow = this.db.prepare(`
      SELECT id, run_at, universe, watchlist_id, market_gate, gate_detail_json, gate_effect,
             candidate_count, opportunity_count
      FROM collared_leaps_runs WHERE id = ?
    `).get(runId) as {
      id: number; run_at: string; universe: string; watchlist_id: number | null;
      market_gate: string; gate_detail_json: string; gate_effect: string;
      candidate_count: number; opportunity_count: number;
    } | undefined;

    if (!runRow) return null;

    const oppRows = this.db.prepare(
      'SELECT * FROM collared_leaps_opportunities WHERE run_id = ? ORDER BY rank',
    ).all(runId) as Array<Record<string, unknown>>;

    return {
      run: {
        id: runRow.id,
        runAt: runRow.run_at,
        universe: runRow.universe,
        watchlistId: runRow.watchlist_id,
        marketGate: runRow.market_gate as CollaredLeapsGate,
        gateDetail: JSON.parse(runRow.gate_detail_json) as CollaredLeapsGateDetail,
        gateEffect: runRow.gate_effect,
        candidateCount: runRow.candidate_count,
        opportunityCount: runRow.opportunity_count,
      },
      opportunities: oppRows.map(r => this.rowToOpportunity(r)),
    };
  }

  markOpened(
    opportunityId: number,
    entry: { leapsEntryDebit?: number; putEntryDebit?: number; notes?: string },
  ): void {
    this.db.prepare(`
      INSERT INTO collared_leaps_opened (opportunity_id, opened_at, leaps_entry_debit, put_entry_debit, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      opportunityId,
      new Date().toISOString(),
      entry.leapsEntryDebit ?? null,
      entry.putEntryDebit ?? null,
      entry.notes ?? null,
    );
  }

  getOpenedPositions(): CollaredLeapsOpenedEntry[] {
    return (this.db.prepare(`
      SELECT id, opportunity_id, opened_at, leaps_entry_debit, put_entry_debit, notes
      FROM collared_leaps_opened ORDER BY id DESC
    `).all() as Array<Record<string, unknown>>).map(r => ({
      id: r['id'] as number,
      opportunityId: r['opportunity_id'] as number,
      openedAt: r['opened_at'] as string,
      leapsEntryDebit: r['leaps_entry_debit'] as number | null,
      putEntryDebit: r['put_entry_debit'] as number | null,
      notes: r['notes'] as string | null,
    }));
  }

  deleteRun(runId: number): void {
    this.db.prepare('DELETE FROM collared_leaps_runs WHERE id = ?').run(runId);
  }

  // ── Market Gate ─────────────────────────────────────────────────────────────

  private async checkMarketGate(): Promise<{ gate: CollaredLeapsGate; detail: CollaredLeapsGateDetail; effect: string }> {
    const noData: CollaredLeapsGateDetail = {
      spx: null, spx50d: null, spx200d: null,
      vix: null, vix5dChangePct: null,
      hygIefRatio: null, hygIefTrend: null,
    };

    try {
      await this.rateLimiter.acquire();
      const spxQuote = await this.safeQuote('SPY');
      await this.rateLimiter.acquire();
      const spxBars = await this.safeBars('SPY', 'day', 210);
      await this.rateLimiter.acquire();
      const vixQuote = await this.safeQuote('VIX');
      await this.rateLimiter.acquire();
      const vixBars = await this.safeBars('VIX', 'day', 10);
      const [hygQ, iefQ] = await Promise.all([
        (await this.rateLimiter.acquire(), this.safeQuote('HYG')),
        (await this.rateLimiter.acquire(), this.safeQuote('IEF')),
      ]);

      const spxPrice = spxQuote?.last ?? null;
      const vixPrice = vixQuote?.last ?? null;
      const closes = spxBars.map(b => b.c);
      const sma = (n: number) => {
        if (closes.length < n) return null;
        return closes.slice(-n).reduce((a, b) => a + b, 0) / n;
      };
      const spx50d = sma(50);
      const spx200d = sma(200);

      let vix5dChangePct: number | null = null;
      if (vixBars.length >= 6 && vixPrice !== null) {
        const prior = vixBars[vixBars.length - 6]?.c;
        if (prior && prior > 0) vix5dChangePct = ((vixPrice - prior) / prior) * 100;
      }

      const hygPrice = hygQ?.last ?? null;
      const iefPrice = iefQ?.last ?? null;
      let hygIefRatio: number | null = null;
      const hygIefTrend: 'flat' | null = null;
      if (hygPrice && iefPrice && iefPrice > 0) hygIefRatio = hygPrice / iefPrice;

      const detail: CollaredLeapsGateDetail = {
        spx: spxPrice, spx50d, spx200d,
        vix: vixPrice, vix5dChangePct,
        hygIefRatio, hygIefTrend,
      };

      const failConditions: string[] = [];
      const cautionConditions: string[] = [];

      if (spxPrice !== null && spx50d !== null) {
        const pct = ((spxPrice - spx50d) / spx50d) * 100;
        if (pct < -1) failConditions.push('SPX below 50d MA');
        else if (Math.abs(pct) <= 1) cautionConditions.push('SPX near 50d MA');
      }
      if (spxPrice !== null && spx200d !== null) {
        const pct = ((spxPrice - spx200d) / spx200d) * 100;
        if (pct < 0) failConditions.push('SPX below 200d MA');
        else if (pct < 2) cautionConditions.push('SPX near 200d MA');
      }
      if (vixPrice !== null) {
        if (vixPrice > 28) failConditions.push(`VIX ${vixPrice.toFixed(1)} > 28`);
        else if (vixPrice >= 22) cautionConditions.push(`VIX ${vixPrice.toFixed(1)} elevated`);
      }
      if (vix5dChangePct !== null) {
        if (vix5dChangePct > 40) failConditions.push(`VIX spiked +${vix5dChangePct.toFixed(0)}% in 5d`);
        else if (vix5dChangePct > 20) cautionConditions.push(`VIX up +${vix5dChangePct.toFixed(0)}% in 5d`);
      }

      let gate: CollaredLeapsGate;
      let effect: string;
      if (failConditions.length > 0) {
        gate = 'FAIL';
        effect = `Strong-protection-only mode (${failConditions[0]}) — collars with costDrag ≤ 15% and floorDepth ≥ 12% still shown`;
      } else if (cautionConditions.length > 0) {
        gate = 'CAUTION';
        effect = `Filtered to A/A+ only (${cautionConditions[0]}) — put leg weighted higher`;
      } else {
        gate = 'PASS';
        effect = 'Normal — all grades shown';
      }
      return { gate, detail, effect };
    } catch {
      return { gate: 'CAUTION', detail: noData, effect: 'Market data unavailable — proceeding with caution' };
    }
  }

  // ── Universe loading ─────────────────────────────────────────────────────────

  private getScreenedTickers(universe: string): string[] {
    const univKey =
      universe === 'sp500'       ? 'sp500' :
      universe === 'russell1000' ? 'russell1000' :
      universe === 'etf'         ? 'etf' :
      null; // null = 'both' → no filter

    const clause = univKey === null ? '1=1' : `sr.universe = '${univKey}'`;
    const rows = this.db.prepare(`
      SELECT DISTINCT res.ticker
      FROM screen_results res
      JOIN screen_runs sr ON res.screen_run_id = sr.id
      WHERE ${clause}
      ORDER BY res.rowid DESC LIMIT 2000
    `).all() as Array<{ ticker: string }>;

    if (rows.length > 0) return [...new Set(rows.map(r => r.ticker))];

    const idxClause = univKey === null ? '1=1' : `index_name = '${univKey}'`;
    return (this.db.prepare(`SELECT ticker FROM constituents WHERE ${idxClause} ORDER BY ticker`).all() as Array<{ ticker: string }>).map(r => r.ticker);
  }

  private getWatchlistTickers(watchlistId: number): string[] {
    return (this.db.prepare('SELECT ticker FROM watchlist_items WHERE watchlist_id = ? ORDER BY id').all(watchlistId) as Array<{ ticker: string }>).map(r => r.ticker);
  }

  private loadFundamentalsCache(tickers: string[]): Map<string, FundamentalsRow> {
    const result = new Map<string, FundamentalsRow>();
    if (tickers.length === 0) return result;
    const ph = tickers.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT ticker, payload_json FROM fundamentals_cache WHERE ticker IN (${ph})`).all(...tickers) as Array<{ ticker: string; payload_json: string }>;
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload_json) as Record<string, unknown>;
        result.set(r.ticker, {
          ticker: r.ticker,
          marketCap: (p['marketCap'] as number | null) ?? null,
          sector: (p['sector'] as string | null) ?? null,
          roe: (p['roe'] as number | null) ?? null,
          debtToEquity: (p['debtToEquity'] as number | null) ?? null,
          freeCashFlow: (p['freeCashFlow'] as number | null) ?? null,
          peRatio: (p['peRatio'] as number | null) ?? null,
        });
      } catch { /* skip malformed */ }
    }
    return result;
  }

  private loadQuoteCache(tickers: string[]): Map<string, QuoteRow> {
    const result = new Map<string, QuoteRow>();
    if (tickers.length === 0) return result;
    const ph = tickers.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT ticker, last, volume FROM quote_cache WHERE ticker IN (${ph})`).all(...tickers) as Array<{ ticker: string; last: number | null; volume: number | null }>;
    // Only include rows where last is non-null — a null-last row is effectively
    // missing data and must be re-fetched on-demand rather than blocking the
    // on-demand fetch path (passUniverseFilter would fail it anyway).
    for (const r of rows) {
      if (r.last !== null) result.set(r.ticker, { ticker: r.ticker, last: r.last, volume: r.volume });
    }
    return result;
  }

  // ── Universe filter ──────────────────────────────────────────────────────────

  private passUniverseFilter(
    _ticker: string,
    f: FundamentalsRow | undefined,
    q: QuoteRow | undefined,
    isEtf = false,
  ): boolean {
    if (!f || !q) return false;
    const price = q.last ?? 0;
    const volume = q.volume ?? 0;
    if (price < 10) return false;
    if (volume < 2_000_000) return false;
    if (!isEtf) {
      // ETFs don't report market cap or sector in fundamentals — skip these checks
      const marketCap = f.marketCap ?? 0;
      if (marketCap < 10_000_000_000) return false;
      if (isBiotech(f.sector)) return false;
    }
    return true;
  }

  // ── LEAPS contract selection ─────────────────────────────────────────────────

  private selectLeapsContract(calls: OptionContract[], spot: number): OptionContract | null {
    const inBand = calls.filter(c => c.delta !== null && c.delta >= 0.70 && c.delta <= 0.90);
    if (inBand.length > 0) {
      inBand.sort((a, b) => Math.abs((a.delta ?? 0) - 0.80) - Math.abs((b.delta ?? 0) - 0.80));
      return inBand.filter(c => c.strike < spot)[0] ?? inBand[0] ?? null;
    }
    const itmCalls = calls.filter(c => {
      if (c.strike >= spot) return false;
      const pct = (spot - c.strike) / spot;
      return pct >= 0.05 && pct <= 0.20;
    });
    itmCalls.sort((a, b) => Math.abs((spot - a.strike) / spot - 0.10) - Math.abs((spot - b.strike) / spot - 0.10));
    return itmCalls[0] ?? null;
  }

  /** Returns truthy (rejection reason) if contract fails LEAPS hard fails. */
  private passLeapsContractHardFails(contract: OptionContract, midPrice: number, extrinsicPct: number): string | null {
    if (midPrice <= 0) return 'zero mid-price';
    const spread = contract.ask - contract.bid;
    const spreadPct = spread / midPrice * 100;
    if (contract.bid !== contract.ask && spreadPct > 15) return `spread ${spreadPct.toFixed(1)}% > 15%`;
    if ((contract.openInterest ?? 0) < 10) return `OI ${contract.openInterest ?? 0} < 10`;
    if (extrinsicPct > 50) return `extrinsic ${extrinsicPct.toFixed(1)}% > 50%`;
    return null;
  }

  // ── LEAPS sub-score (weight 0.35 in combined) ────────────────────────────────

  private scoreLeapsLeg(
    contract: OptionContract,
    dte: number,
    extrinsicPct: number,
    ivData: IvData,
  ): { score: number; breakdown: CollaredLeapsScoreComponent[] } {
    const comps: Array<{ name: string; weight: number; rawScore: number }> = [];
    void dte;

    // Delta in target band (0.20)
    const delta = contract.delta ?? 0;
    let deltaScore = 0;
    if (delta >= 0.78 && delta <= 0.82) deltaScore = 10;
    else if (delta >= 0.75 && delta <= 0.85) deltaScore = 8;
    else if ((delta >= 0.70 && delta < 0.75) || (delta > 0.85 && delta <= 0.90)) deltaScore = 5;
    comps.push({ name: 'Delta in target band', weight: 0.20, rawScore: deltaScore });

    // DTE quality (0.15)
    let dteScore = 5;
    if (dte >= 540 && dte <= 650) dteScore = 10;
    else if (dte >= 450 && dte <= 730) dteScore = 8;
    else if (dte >= 365) dteScore = 5;
    comps.push({ name: 'DTE quality', weight: 0.15, rawScore: dteScore });

    // Extrinsic % of premium (0.25)
    let extScore = 0;
    if (extrinsicPct <= 3) extScore = 10;
    else if (extrinsicPct <= 6) extScore = 8;
    else if (extrinsicPct <= 10) extScore = 5;
    else if (extrinsicPct <= 15) extScore = 2;
    comps.push({ name: 'Extrinsic % of premium', weight: 0.25, rawScore: extScore });

    // Liquidity (0.20)
    const mid = (contract.bid + contract.ask) / 2;
    const spreadPct = mid > 0 ? ((contract.ask - contract.bid) / mid) * 100 : 99;
    const oi = contract.openInterest ?? 0;
    let liqScore = 0;
    if (spreadPct < 2 && oi > 500) liqScore = 10;
    else if (spreadPct < 5 && oi > 200) liqScore = 8;
    else if (oi >= 100) liqScore = 5;
    comps.push({ name: 'Liquidity', weight: 0.20, rawScore: liqScore });

    // IV state / IVR (0.20) — low IVR = cheap premium = good for LEAPS buyer
    const ivr = ivData.ivr ?? 50;
    let ivrScore = 5;
    if (ivr < 25) ivrScore = 10;
    else if (ivr < 40) ivrScore = 8;
    else if (ivr < 55) ivrScore = 5;
    else if (ivr < 75) ivrScore = 2;
    else ivrScore = 0;
    comps.push({ name: 'IV state (IVR)', weight: 0.20, rawScore: ivrScore });

    return this.computeScore(comps);
  }

  // ── Put sub-score (weight 0.25 in combined) ──────────────────────────────────

  private scorePutLeg(
    contract: OptionContract,
    midPrice: number,
    putDte: number,
    leaps: LeapsCandidate,
    ivData: IvData,
  ): { score: number; breakdown: CollaredLeapsScoreComponent[] } {
    const comps: Array<{ name: string; weight: number; rawScore: number }> = [];
    void putDte;

    // Floor placement vs 200d MA (0.25)
    let floorScore = 5;
    if (leaps.ma200d !== null) {
      const ma = leaps.ma200d;
      if (contract.strike <= ma * 0.97) floorScore = 10;       // below 200d MA — strategic floor
      else if (contract.strike <= ma) floorScore = 7;           // at 200d MA — good
      else if (contract.strike <= ma * 1.03) floorScore = 3;   // slightly above — marginal
      else floorScore = 0;                                       // well above 200d MA
    }
    comps.push({ name: 'Floor vs 200d MA', weight: 0.25, rawScore: floorScore });

    // Cost efficiency: costDrag (0.20)
    const costDragPct = (midPrice * 100) / leaps.debit * 100;
    let costScore = 0;
    if (costDragPct <= 6) costScore = 10;
    else if (costDragPct <= 10) costScore = 8;
    else if (costDragPct <= 15) costScore = 5;
    else if (costDragPct <= 20) costScore = 2;
    comps.push({ name: 'Cost efficiency', weight: 0.20, rawScore: costScore });

    // Duration alignment with LEAPS (0.15)
    const leapsDte = dteDays(leaps.expiry);
    const ratio = leapsDte > 0 ? putDte / leapsDte : 0;
    let durScore = 0;
    if (ratio >= 0.85) durScore = 10;
    else if (ratio >= 0.70) durScore = 8;
    else if (putDte >= 180) durScore = 5;
    else if (putDte >= 90) durScore = 2;
    comps.push({ name: 'Duration alignment', weight: 0.15, rawScore: durScore });

    // Delta band (0.15) — delta is negative for puts
    const delta = contract.delta ?? null;
    let deltaScore = 0;
    if (delta !== null) {
      if (delta >= -0.20 && delta <= -0.15) deltaScore = 10;
      else if (delta >= -0.25 && delta <= -0.10) deltaScore = 7;
      else if (delta >= -0.30) deltaScore = 3;
    } else {
      deltaScore = 5; // no greeks — neutral
    }
    comps.push({ name: 'Delta in target band', weight: 0.15, rawScore: deltaScore });

    // IV state on put (0.15) — higher IVR = more expensive insurance = worse
    const ivr = ivData.ivr ?? 50;
    let ivScore = 5;
    if (ivr > 60) ivScore = 2;       // expensive insurance
    else if (ivr > 40) ivScore = 5;
    else if (ivr > 25) ivScore = 7;
    else ivScore = 10;               // cheap insurance = good
    comps.push({ name: 'IV state (put cost)', weight: 0.15, rawScore: ivScore });

    // Liquidity (0.10)
    const spreadPct = midPrice > 0 ? ((contract.ask - contract.bid) / midPrice) * 100 : 99;
    const oi = contract.openInterest ?? 0;
    let liqScore = 0;
    if (spreadPct < 2 && oi > 500) liqScore = 10;
    else if (oi > 200) liqScore = 8;
    else if (oi >= 100) liqScore = 5;
    comps.push({ name: 'Liquidity', weight: 0.10, rawScore: liqScore });

    return this.computeScore(comps);
  }

  // ── Structural metrics ───────────────────────────────────────────────────────

  private computeStructuralMetrics(leaps: LeapsCandidate, put: PutCandidate): StructuralMetrics {
    const totalDebit = leaps.debit + put.debit;
    const kCall = leaps.contract.strike;
    const kPut = put.contract.strike;
    const spot = leaps.spot;

    const costDragPct = (put.debit / leaps.debit) * 100;
    const floorDepthPct = ((spot - kPut) / spot) * 100;
    const breakeven = kCall + totalDebit / 100;

    // Max loss if stock = kPut at LEAPS expiry
    const intrinsicAtPut = Math.max(0, kPut - kCall) * 100; // LEAPS is ITM (kCall < kPut always for collars)
    const maxLossAtPut = totalDebit - intrinsicAtPut;

    // Max loss at $0 (can be negative if put over-insures)
    const maxLossAtZero = totalDebit - kPut * 100;

    // Upside retention at +20%
    const target20 = spot * 1.20;
    const nakedLeapsPnl20 = (target20 - kCall) * 100 - leaps.debit;
    const collarPnl20 = (target20 - kCall) * 100 - totalDebit; // put expires OTM at +20%
    const upsideRetentionPct = nakedLeapsPnl20 > 0
      ? clamp((collarPnl20 / nakedLeapsPnl20) * 100, 0, 200)
      : 100; // naked is also losing — collar no worse

    // Hedge efficiency: how much does the put reduce max loss vs naked LEAPS
    const nakedMaxLoss = leaps.debit; // naked LEAPS: lose entire debit at worst
    const hedgeEfficiencyPct = nakedMaxLoss > 0
      ? clamp(((nakedMaxLoss - maxLossAtPut) / nakedMaxLoss) * 100, 0, 100)
      : 0;

    // R/R ratio (use +25% as max profit estimate)
    const maxProfitEst = (spot * 1.25 - kCall) * 100 - totalDebit;
    const rrRatio = maxLossAtPut > 0 ? maxProfitEst / maxLossAtPut : null;

    return {
      costDragPct,
      floorDepthPct,
      breakeven,
      maxLossAtPut,
      maxLossAtZero,
      upsideRetentionPct,
      hedgeEfficiencyPct,
      rrRatio,
    };
  }

  // ── Structural quality sub-score (weight 0.40 in combined) ──────────────────

  private scoreStructural(
    m: StructuralMetrics,
    leaps: LeapsCandidate,
    put: PutCandidate,
  ): { score: number; breakdown: CollaredLeapsScoreComponent[] } {
    const totalDebit = leaps.debit + put.debit;
    const comps: Array<{ name: string; weight: number; rawScore: number }> = [];

    // Upside retention at +20% (0.30)
    let retScore = 0;
    if (m.upsideRetentionPct >= 90) retScore = 10;
    else if (m.upsideRetentionPct >= 82) retScore = 8;
    else if (m.upsideRetentionPct >= 75) retScore = 5;
    comps.push({ name: 'Upside retention @ +20%', weight: 0.30, rawScore: retScore });

    // Max loss as % of total debit (0.25)
    const maxLossPct = totalDebit > 0 ? (m.maxLossAtPut / totalDebit) * 100 : 100;
    let mlScore = 0;
    if (maxLossPct <= 30) mlScore = 10;
    else if (maxLossPct <= 40) mlScore = 8;
    else if (maxLossPct <= 50) mlScore = 5;
    else if (maxLossPct <= 60) mlScore = 2;
    comps.push({ name: 'Max loss % of debit', weight: 0.25, rawScore: mlScore });

    // Breakeven distance from spot (0.20)
    const beDistPct = leaps.spot > 0 ? ((m.breakeven - leaps.spot) / leaps.spot) * 100 : 99;
    let beScore = 0;
    if (beDistPct <= 4) beScore = 10;
    else if (beDistPct <= 7) beScore = 8;
    else if (beDistPct <= 10) beScore = 5;
    else if (beDistPct <= 14) beScore = 2;
    comps.push({ name: 'Breakeven distance', weight: 0.20, rawScore: beScore });

    // R/R ratio (0.15)
    let rrScore = 0;
    const rr = m.rrRatio ?? 0;
    if (rr >= 3.0) rrScore = 10;
    else if (rr >= 2.0) rrScore = 8;
    else if (rr >= 1.5) rrScore = 5;
    else if (rr >= 1.0) rrScore = 2;
    comps.push({ name: 'Risk/reward ratio', weight: 0.15, rawScore: rrScore });

    // Hedge efficiency (0.10)
    let heScore = 0;
    if (m.hedgeEfficiencyPct >= 70) heScore = 10;
    else if (m.hedgeEfficiencyPct >= 50) heScore = 7;
    else if (m.hedgeEfficiencyPct >= 30) heScore = 4;
    comps.push({ name: 'Hedge efficiency', weight: 0.10, rawScore: heScore });

    return this.computeScore(comps);
  }

  // ── Caution flags ────────────────────────────────────────────────────────────

  private computeCautionFlags(
    m: StructuralMetrics,
    leaps: LeapsCandidate,
    put: PutCandidate,
    gate: CollaredLeapsGate,
  ): string[] {
    const flags: string[] = [];
    if (m.costDragPct > 18) flags.push('COST_DRAG_HIGH');
    if (m.floorDepthPct < 8) flags.push('NARROW_FLOOR');
    if (put.ivr !== null && put.ivr > 70) flags.push('PUT_IV_ELEVATED');
    if (leaps.ivr !== null && leaps.ivr >= 60) flags.push('LEAPS_IV_ELEVATED');
    if (m.breakeven > leaps.spot * 1.12) flags.push('BREAKEVEN_WIDE');
    if (put.dte < 90) flags.push('SHORT_PUT_DTE');
    if (gate === 'FAIL' && m.costDragPct <= 15 && m.floorDepthPct >= 12) flags.push('GATE_FAIL_COLLAR');
    return flags;
  }

  // ── Shared scoring helper ────────────────────────────────────────────────────

  private computeScore(comps: Array<{ name: string; weight: number; rawScore: number }>): { score: number; breakdown: CollaredLeapsScoreComponent[] } {
    const weighted = comps.reduce((acc, c) => acc + c.rawScore * c.weight, 0);
    const score = clamp(round1(weighted), 0, 10);
    const breakdown: CollaredLeapsScoreComponent[] = comps.map(c => ({
      name: c.name,
      weight: c.weight,
      rawScore: c.rawScore,
      weightedScore: Math.round(c.rawScore * c.weight * 100) / 100,
    }));
    return { score, breakdown };
  }

  // ── IV data helpers ──────────────────────────────────────────────────────────

  private ivFailLogged = false;
  private ivCache = new Map<string, IvData>();

  private async fetchIvData(ticker: string): Promise<IvData> {
    const cached = this.ivCache.get(ticker);
    if (cached) return cached;
    const result = await this.fetchIvDataCached(ticker);
    return result;
  }

  private async fetchIvDataCached(ticker: string): Promise<IvData> {
    const cached = this.ivCache.get(ticker);
    if (cached) return cached;
    try {
      const result = await this.optionsProvider.getOptionsIVAndPremium(ticker, null, null);
      const { currentIv, iv52WkHigh, iv52WkLow } = result;
      let ivr: number | null = null;
      if (currentIv !== null && iv52WkHigh !== null && iv52WkLow !== null) {
        const range = iv52WkHigh - iv52WkLow;
        if (range > 0) ivr = clamp(((currentIv - iv52WkLow) / range) * 100, 0, 100);
      }
      const data: IvData = { currentIv, iv52WkHigh, iv52WkLow, ivr };
      this.ivCache.set(ticker, data);
      return data;
    } catch (err) {
      if (!this.ivFailLogged) {
        this.ivFailLogged = true;
        console.warn(`[COLLARED-LEAPS] IV fetch failed for ${ticker}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const fallback: IvData = { currentIv: null, iv52WkHigh: null, iv52WkLow: null, ivr: null };
      this.ivCache.set(ticker, fallback);
      return fallback;
    }
  }

  // ── Safe fetch wrappers ──────────────────────────────────────────────────────

  private chainFailLogged = false;

  private async safeGetChain(ticker: string, expiry: string): Promise<OptionContract[] | null> {
    try {
      const chain = await this.optionsProvider.getOptionsChain(ticker, expiry);
      return chain.contracts as OptionContract[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.chainFailLogged) {
        this.chainFailLogged = true;
        console.warn(`[COLLARED-LEAPS] Chain fetch failed for ${ticker}/${expiry}: ${msg}`);
      }
      if (msg.includes('401') || msg.includes('403') || msg.includes('API key') || msg.includes('Unauthorized')) {
        throw new Error(`Options API auth failed for ${ticker}: ${msg}`);
      }
      return null;
    }
  }

  private async safeQuote(ticker: string): Promise<{ last: number | null; volume: number | null } | null> {
    try {
      const q = await this.dataProvider.getQuote(ticker);
      return { last: q.last, volume: q.volume };
    } catch { return null; }
  }

  private async safeBars(ticker: string, tf: 'day', lookbackDays: number): Promise<Array<{ c: number }>> {
    try {
      const bars = await this.dataProvider.getHistoricalBars(ticker, tf, lookbackDays);
      return bars.map(b => ({ c: b.c }));
    } catch { return []; }
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  private persistRun(
    meta: { gate: CollaredLeapsGate; gateDetail: CollaredLeapsGateDetail; gateEffect: string; universe: string; watchlistId: number | null },
    candidateCount: number,
    pairs: CollaredPair[],
  ): CollaredLeapsRunResult {
    const runAt = new Date().toISOString();

    return withTransaction(this.db, () => {
      const runId = (this.db.prepare(`
        INSERT INTO collared_leaps_runs
          (run_at, universe, watchlist_id, market_gate, gate_detail_json, gate_effect, candidate_count, opportunity_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runAt, meta.universe, meta.watchlistId,
        meta.gate, JSON.stringify(meta.gateDetail), meta.gateEffect,
        candidateCount, pairs.length,
      ) as { lastInsertRowid: number }).lastInsertRowid;

      const insertOpp = this.db.prepare(`
        INSERT INTO collared_leaps_opportunities (
          run_id, rank, ticker, spot, ma200d,
          leaps_strike, leaps_expiry, leaps_dte, leaps_delta, leaps_debit,
          leaps_extrinsic_pct, leaps_iv_pct, leaps_ivr, leaps_oi, leaps_spread_pct, leaps_sub_score,
          put_strike, put_expiry, put_dte, put_delta, put_debit,
          put_iv_pct, put_ivr, put_oi, put_spread_pct, put_sub_score,
          cost_drag_pct, floor_depth_pct, breakeven,
          max_loss_at_put, max_loss_at_zero, upside_retention_pct, hedge_efficiency_pct, rr_ratio,
          structural_sub_score, combined_score, grade, caution_flags, gate_survived, detail_json
        ) VALUES (
          ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
        )
      `);

      const opportunities: CollaredLeapsOpportunity[] = pairs.map((p, idx) => {
        const detail: CollaredLeapsDetail = {
          leapsScoreBreakdown: p.leaps.scoreBreakdown,
          putScoreBreakdown: p.put.scoreBreakdown,
          structuralScoreBreakdown: p.structuralScoreBreakdown,
          pnlGrid: p.pnlGrid,
          pnlGrid180d: p.pnlGrid180d,
          pnlGrid90d: p.pnlGrid90d,
          pnlGrid30d: p.pnlGrid30d,
        };

        const id = (insertOpp.run(
          Number(runId), idx + 1, p.leaps.ticker, p.leaps.spot, p.leaps.ma200d,
          p.leaps.contract.strike, p.leaps.expiry, p.leaps.dte, p.leaps.contract.delta, p.leaps.debit,
          p.leaps.extrinsicPct, p.leaps.ivPct, p.leaps.ivr, p.leaps.contract.openInterest, p.leaps.spreadPct, p.leaps.subScore,
          p.put.contract.strike, p.put.expiry, p.put.dte, p.put.contract.delta, p.put.debit,
          p.put.ivPct, p.put.ivr, p.put.contract.openInterest, p.put.spreadPct, p.put.subScore,
          p.metrics.costDragPct, p.metrics.floorDepthPct, p.metrics.breakeven,
          p.metrics.maxLossAtPut, p.metrics.maxLossAtZero, p.metrics.upsideRetentionPct, p.metrics.hedgeEfficiencyPct, p.metrics.rrRatio,
          p.structuralSubScore, p.combinedScore, p.grade,
          p.cautionFlags.length > 0 ? p.cautionFlags.join(',') : null,
          p.gateSurvived ? 1 : 0,
          JSON.stringify(detail),
        ) as { lastInsertRowid: number }).lastInsertRowid;

        return {
          id: Number(id),
          runId: Number(runId),
          rank: idx + 1,
          ticker: p.leaps.ticker,
          spot: p.leaps.spot,
          ma200d: p.leaps.ma200d,
          leapsStrike: p.leaps.contract.strike,
          leapsExpiry: p.leaps.expiry,
          leapsDte: p.leaps.dte,
          leapsDelta: p.leaps.contract.delta,
          leapsDebit: p.leaps.debit,
          leapsExtrinsicPct: p.leaps.extrinsicPct,
          leapsIvPct: p.leaps.ivPct,
          leapsIvr: p.leaps.ivr,
          leapsOi: p.leaps.contract.openInterest,
          leapsSpreadPct: p.leaps.spreadPct,
          leapsSubScore: p.leaps.subScore,
          putStrike: p.put.contract.strike,
          putExpiry: p.put.expiry,
          putDte: p.put.dte,
          putDelta: p.put.contract.delta,
          putDebit: p.put.debit,
          putIvPct: p.put.ivPct,
          putIvr: p.put.ivr,
          putOi: p.put.contract.openInterest,
          putSpreadPct: p.put.spreadPct,
          putSubScore: p.put.subScore,
          costDragPct: p.metrics.costDragPct,
          floorDepthPct: p.metrics.floorDepthPct,
          breakeven: p.metrics.breakeven,
          maxLossAtPut: p.metrics.maxLossAtPut,
          maxLossAtZero: p.metrics.maxLossAtZero,
          upsideRetentionPct: p.metrics.upsideRetentionPct,
          hedgeEfficiencyPct: p.metrics.hedgeEfficiencyPct,
          rrRatio: p.metrics.rrRatio,
          structuralSubScore: p.structuralSubScore,
          combinedScore: p.combinedScore,
          grade: p.grade,
          cautionFlags: p.cautionFlags,
          gateSurvived: p.gateSurvived,
          detail,
        };
      });

      const run: CollaredLeapsRunSummary = {
        id: Number(runId),
        runAt,
        universe: meta.universe,
        watchlistId: meta.watchlistId,
        marketGate: meta.gate,
        gateDetail: meta.gateDetail,
        gateEffect: meta.gateEffect,
        candidateCount,
        opportunityCount: pairs.length,
      };

      return { run, opportunities };
    });
  }

  private rowToOpportunity(r: Record<string, unknown>): CollaredLeapsOpportunity {
    const detail = JSON.parse(r['detail_json'] as string) as CollaredLeapsDetail;
    return {
      id: r['id'] as number,
      runId: r['run_id'] as number,
      rank: r['rank'] as number,
      ticker: r['ticker'] as string,
      spot: r['spot'] as number,
      ma200d: r['ma200d'] as number | null,
      leapsStrike: r['leaps_strike'] as number,
      leapsExpiry: r['leaps_expiry'] as string,
      leapsDte: r['leaps_dte'] as number | null,
      leapsDelta: r['leaps_delta'] as number | null,
      leapsDebit: r['leaps_debit'] as number,
      leapsExtrinsicPct: r['leaps_extrinsic_pct'] as number | null,
      leapsIvPct: r['leaps_iv_pct'] as number | null,
      leapsIvr: r['leaps_ivr'] as number | null,
      leapsOi: r['leaps_oi'] as number | null,
      leapsSpreadPct: r['leaps_spread_pct'] as number | null,
      leapsSubScore: r['leaps_sub_score'] as number,
      putStrike: r['put_strike'] as number,
      putExpiry: r['put_expiry'] as string,
      putDte: r['put_dte'] as number | null,
      putDelta: r['put_delta'] as number | null,
      putDebit: r['put_debit'] as number,
      putIvPct: r['put_iv_pct'] as number | null,
      putIvr: r['put_ivr'] as number | null,
      putOi: r['put_oi'] as number | null,
      putSpreadPct: r['put_spread_pct'] as number | null,
      putSubScore: r['put_sub_score'] as number,
      costDragPct: r['cost_drag_pct'] as number,
      floorDepthPct: r['floor_depth_pct'] as number,
      breakeven: r['breakeven'] as number,
      maxLossAtPut: r['max_loss_at_put'] as number | null,
      maxLossAtZero: r['max_loss_at_zero'] as number,
      upsideRetentionPct: r['upside_retention_pct'] as number,
      hedgeEfficiencyPct: r['hedge_efficiency_pct'] as number,
      rrRatio: r['rr_ratio'] as number | null,
      structuralSubScore: r['structural_sub_score'] as number,
      combinedScore: r['combined_score'] as number,
      grade: r['grade'] as CollaredLeapsGrade,
      cautionFlags: r['caution_flags'] ? (r['caution_flags'] as string).split(',') : [],
      gateSurvived: (r['gate_survived'] as number) === 1,
      detail,
    };
  }
}
