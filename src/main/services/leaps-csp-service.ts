// LEAPS Strategy Screener (v0.22.0)
// Pure LEAPS stock-replacement screener. Finds deep-ITM long calls (365–730 DTE)
// ranked by a 7-factor score. CSP pairing removed — CSP is covered by Analysis
// and Strategy Lab.
//
// Screening pipeline:
//   Market gate → Universe filters → Stock hard fails →
//   LEAPS contract selection + scoring → Rank → Persist

import type { DbHandle } from '../db/connection.js';
import type { DataProvider } from './data-provider.js';
import type { OptionsProvider } from './options-provider.js';
import type { TokenBucketRateLimiter } from './rate-limiter.js';
import type {
  LeapsCspGate,
  LeapsCspGateDetail,
  LeapsCspGrade,
  LeapsCspOpportunity,
  LeapsCspOpenedEntry,
  LeapsCspRunResult,
  LeapsCspRunSummary,
  LeapsCspScoreComponent,
  LeapsCspDetail,
  LeapsCspProgressDetail,
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
  iv: number;           // raw fraction from provider (e.g. 0.285)
  openInterest: number | null;
  volume: number | null;
}

interface LeapsCandidate {
  ticker: string;
  currentPrice: number;
  contract: OptionContract;
  expiry: string;
  dte: number;
  extrinsicPct: number;
  ivPct: number;
  ivr: number | null;
  subScore: number;
  scoreBreakdown: LeapsCspScoreComponent[];
  fundamentals: FundamentalsRow;
}

interface LeapsOpportunity {
  leaps: LeapsCandidate;
  score: number;
  grade: LeapsCspGrade;
  cautionFlags: string[];
}

// ─── Excluded sectors (binary risk / chain instability) ───────────────────────

const EXCLUDED_SECTORS = new Set([
  'biotechnology',
  'biopharmaceutical',
  'pharmaceutical',  // broad biotech-adjacent
  'spac',
]);

function isBiotech(sector: string | null): boolean {
  if (!sector) return false;
  const s = sector.toLowerCase();
  return EXCLUDED_SECTORS.has(s) || s.includes('biotech') || s.includes('biopharm');
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

// US market holidays on which options expire the prior Thursday instead of Friday.
const MARKET_HOLIDAY_FRIDAYS = new Set([
  '2024-03-29', // Good Friday
  '2025-04-18', // Good Friday
  '2025-07-04', // Independence Day (Friday)
  '2026-04-03', // Good Friday
  '2026-06-19', // Juneteenth (Friday)
  '2026-12-25', // Christmas (Friday)
  '2027-01-01', // New Year's Day (Friday)
  '2027-03-26', // Good Friday
  '2028-04-14', // Good Friday
]);

/** If date falls on a market-holiday Friday, move back to Thursday. */
function adjustForHoliday(ymd: string): string {
  if (!MARKET_HOLIDAY_FRIDAYS.has(ymd)) return ymd;
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function dteDays(expiryYMD: string): number {
  // Use 21:00 UTC (~4pm ET winter) as settlement reference.
  const exp = new Date(expiryYMD + 'T21:00:00Z');
  return Math.round((exp.getTime() - Date.now()) / 86_400_000);
}

/** 3rd Friday of January for a given year, adjusted for market holidays. */
function thirdFridayOfJanuary(year: number): string {
  const d = new Date(Date.UTC(year, 0, 1));
  const dow = d.getUTCDay();
  const daysToFri = (5 - dow + 7) % 7;
  d.setUTCDate(1 + daysToFri + 14); // +2 weeks = 3rd Friday
  return adjustForHoliday(d.toISOString().slice(0, 10));
}

/** Returns expiry dates in YYYY-MM-DD that are 365–730 DTE (LEAPS window). */
function leapsExpiryDates(): string[] {
  const now = new Date();
  const thisYear = now.getFullYear();
  const candidates: string[] = [];
  for (let y = thisYear; y <= thisYear + 3; y++) {
    candidates.push(thirdFridayOfJanuary(y));
    // Also try June LEAPS (3rd Friday June)
    const d = new Date(Date.UTC(y, 5, 1));
    const dow = d.getUTCDay();
    const daysToFri = (5 - dow + 7) % 7;
    d.setUTCDate(1 + daysToFri + 14);
    candidates.push(adjustForHoliday(d.toISOString().slice(0, 10)));
  }
  return candidates.filter(e => {
    const dte = dteDays(e);
    return dte >= 365 && dte <= 730;
  });
}

// ─── Scoring helpers ──────────────────────────────────────────────────────────

function grade(score: number): LeapsCspGrade {
  if (score >= 9.0) return 'A+';
  if (score >= 8.0) return 'A';
  if (score >= 7.0) return 'B';
  if (score >= 6.0) return 'C';
  return 'F';
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class LeapsCspService {
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
    onProgressDetail?: (detail: LeapsCspProgressDetail) => void,
    watchlistId?: number,
  ): Promise<LeapsCspRunResult> {
    const log = (msg: string) => { onProgress?.(msg); };
    const progress = (detail: LeapsCspProgressDetail) => { onProgressDetail?.(detail); };
    const isEtf = universe === 'etf';

    log('Checking market gate…');
    progress({ phase: 'gate', current: 0, total: 1 });
    const { gate, detail, effect } = await this.checkMarketGate();

    log(`Market gate: ${gate} — ${effect}`);
    progress({ phase: 'gate', current: 1, total: 1 });

    // Under a FAIL gate, suppress new LEAPS opportunities unless overridden
    if (gate === 'FAIL' && !forceRun) {
      log('Market gate FAIL: LEAPS suppressed. Returning empty run.');
      return this.persistRun(
        { gate, detail, effect, universe, watchlistId: watchlistId ?? null },
        [],
      );
    }

    if (gate === 'FAIL' && forceRun) {
      log('⚠ Gate override active — running despite FAIL conditions.');
    }

    let tickers: string[];
    if (watchlistId != null) {
      log(`Loading tickers from watchlist ${watchlistId}…`);
      progress({ phase: 'universe', current: 0, total: 1 });
      tickers = this.getWatchlistTickers(watchlistId);
      log(`${tickers.length} tickers from watchlist`);
      progress({ phase: 'universe', current: 1, total: 1 });
    } else {
      log('Loading universe from screener cache…');
      progress({ phase: 'universe', current: 0, total: 1 });
      tickers = this.getScreenedTickers(universe);
      log(`${tickers.length} tickers from screener cache`);
      progress({ phase: 'universe', current: 1, total: 1 });
    }

    if (tickers.length === 0) {
      log(watchlistId != null
        ? 'Watchlist is empty. Add tickers to the watchlist first.'
        : 'No tickers found. Ensure constituents are loaded (Data Sync) and try again.');
      return this.persistRun({ gate, detail, effect, universe, watchlistId: watchlistId ?? null }, []);
    }

    log('Loading cached fundamentals & quotes…');
    const fundamentalsMap = this.loadFundamentalsCache(tickers);
    const quotesMap = this.loadQuoteCache(tickers);

    // For tickers missing cached data, fetch on-demand (essential for watchlist runs
    // where the screener hasn't been run yet)
    const missingFundamentals = tickers.filter(t => !fundamentalsMap.has(t));
    const missingQuotes = tickers.filter(t => !quotesMap.has(t));
    const missingTickers = [...new Set([...missingFundamentals, ...missingQuotes])];

    if (missingTickers.length > 0) {
      log(`Fetching on-demand data for ${missingTickers.length} tickers…`);
    }
    let fetchFailCount = 0;
    for (const ticker of missingTickers) {
      await this.rateLimiter.acquire();
      const quote = await this.safeQuote(ticker);
      if (quote) {
        quotesMap.set(ticker, { ticker, last: quote.last, volume: quote.volume });
      } else {
        log(`  ${ticker}: quote fetch failed`);
        fetchFailCount++;
      }

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
      } catch (err) {
        log(`  ${ticker}: fundamentals fetch failed — ${err instanceof Error ? err.message : String(err)}`);
        fetchFailCount++;
      }
    }
    if (fetchFailCount > 0) {
      log(`${fetchFailCount} fetch failures for on-demand tickers`);
    }

    log('Applying universe filters…');
    const filtered = tickers.filter(t => {
      const f = fundamentalsMap.get(t);
      const q = quotesMap.get(t);
      return this.passUniverseFilter(t, f, q, log, isEtf);
    });
    const rejected = tickers.filter(t => !filtered.includes(t));
    if (rejected.length > 0 && rejected.length <= 20) {
      log(`Rejected tickers: ${rejected.join(', ')}`);
    }
    log(`${filtered.length} of ${tickers.length} tickers pass universe filters`);

    // ── Resolve LEAPS expiry dates from provider ────────────────────────────
    // For E*Trade we fetch the real exchange-listed expirations for a sample
    // ticker and pick dates in the 365–730 DTE LEAPS window.
    // Polygon returns [] from getOptionsExpirations, so we fall back to the
    // locally-generated standard third-Friday dates.
    let leapsExpiries = leapsExpiryDates();

    if (filtered.length > 0) {
      try {
        const sampleTicker = filtered[0]!;
        await this.rateLimiter.acquire();
        const providerExpiries = await this.optionsProvider.getOptionsExpirations(sampleTicker);
        if (providerExpiries.length > 0) {
          const realLeaps = providerExpiries.filter(e => {
            const d = dteDays(e);
            return d >= 365 && d <= 730;
          });
          if (realLeaps.length > 0) {
            leapsExpiries = realLeaps;
            log(`${this.optionsProvider.name}: ${realLeaps.length} LEAPS expirations: ${realLeaps.join(', ')}`);
          } else {
            log('Provider has no expirations in 365–730 DTE window — using generated LEAPS dates');
          }
        } else {
          log('Provider returned no expirations — using generated default dates');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Expiration fetch failed (${msg}) — using generated default dates`);
      }
    }

    // ── LEAPS candidates ────────────────────────────────────────────────────
    log('Screening LEAPS candidates…');
    const leapsCandidates: LeapsCandidate[] = [];

    log(`LEAPS expiry window: ${leapsExpiries.join(', ')}`);

    if (leapsExpiries.length === 0) {
      log('No valid LEAPS expiry dates found in 365–730 DTE window.');
      return this.persistRun({ gate, detail, effect, universe, watchlistId: watchlistId ?? null }, []);
    }

    let skipNoPrice = 0, skipHardFail = 0, skipIvr = 0, skipNoChain = 0, skipNoContract = 0;
    const leapsTotal = filtered.length;
    let leapsIdx = 0;
    for (const ticker of filtered) {
      leapsIdx++;
      progress({ phase: 'leaps', current: leapsIdx, total: leapsTotal, ticker });
      const f = fundamentalsMap.get(ticker);
      const q = quotesMap.get(ticker);
      const currentPrice = q?.last ?? null;
      if (!currentPrice || currentPrice <= 0) { skipNoPrice++; continue; }

      // Check stock hard fails for LEAPS leg
      const failReason = this.leapsStockHardFail(ticker, f, q);
      if (failReason) { skipHardFail++; continue; }

      // Fetch IV for IVR computation
      await this.rateLimiter.acquire();
      const ivData = await this.fetchIvData(ticker);

      // IVR > 80 on underlying → reject for LEAPS (IV crush risk)
      if (ivData.ivr !== null && ivData.ivr > 80) { skipIvr++; continue; }

      // Try each LEAPS expiry, keep best contract
      let best: LeapsCandidate | null = null;
      let chainCount = 0;
      let totalCalls = 0;
      let callsWithDelta = 0;
      for (const expiry of leapsExpiries) {
        await this.rateLimiter.acquire();
        const chain = await this.safeGetChain(ticker, expiry);
        if (!chain) continue;
        chainCount++;

        const calls = chain.filter(c => c.side === 'call');
        totalCalls += calls.length;
        callsWithDelta += calls.filter(c => c.delta !== null).length;
        const contract = this.selectLeapsContract(calls, currentPrice);
        if (!contract) continue;

        const dte = dteDays(expiry);
        const intrinsic = Math.max(0, currentPrice - contract.strike);
        const midPrice = (contract.bid + contract.ask) / 2;
        const extrinsicPct = midPrice > 0 ? ((midPrice - intrinsic) / midPrice) * 100 : 999;

        // LEAPS contract hard fails
        const hardFailReason = this.passLeapsContractHardFails(contract, midPrice, extrinsicPct);
        if (hardFailReason) {
          log(`  ${ticker}/${expiry}: best contract Δ${(contract.delta ?? 0).toFixed(2)} strike $${contract.strike} rejected — ${hardFailReason}`);
          continue;
        }

        const ivPct = contract.iv * 100;
        const { score, breakdown } = this.scoreLeapsLeg(
          contract, dte, extrinsicPct, ivData, f, currentPrice, isEtf,
        );

        const candidate: LeapsCandidate = {
          ticker,
          currentPrice,
          contract,
          expiry,
          dte,
          extrinsicPct,
          ivPct,
          ivr: ivData.ivr,
          subScore: score,
          scoreBreakdown: breakdown,
          fundamentals: f ?? { ticker, marketCap: null, sector: null, roe: null, debtToEquity: null, freeCashFlow: null, peRatio: null },
        };
        if (!best || score > best.subScore) best = candidate;
      }

      if (!best && chainCount === 0) {
        skipNoChain++;
      } else if (!best) {
        skipNoContract++;
        if (totalCalls > 0 && callsWithDelta === 0) {
          log(`  ${ticker}: ${totalCalls} calls, 0 have delta data — provider not returning greeks`);
        } else if (callsWithDelta > 0 && callsWithDelta < totalCalls) {
          log(`  ${ticker}: ${callsWithDelta}/${totalCalls} calls have delta, but none in 0.70–0.90 range`);
        } else {
          log(`  ${ticker}: ${totalCalls} calls, all filtered out by LEAPS contract criteria`);
        }
      }

      if (best) leapsCandidates.push(best);
    }

    if (leapsCandidates.length === 0) {
      log(`LEAPS screening skip summary: noPrice=${skipNoPrice} hardFail=${skipHardFail} ivr=${skipIvr} noChain=${skipNoChain} noContract=${skipNoContract}`);
    }

    log(`${leapsCandidates.length} qualifying LEAPS candidates`);
    if (leapsCandidates.length === 0) {
      return this.persistRun({ gate, detail, effect, universe, watchlistId: watchlistId ?? null }, []);
    }

    // ── Score and rank LEAPS opportunities ──────────────────────────────────
    log('Ranking LEAPS opportunities…');
    const opportunities: LeapsOpportunity[] = leapsCandidates.map(leaps => {
      const flags = this.cautionFlags(leaps);
      const cautionDeduction = flags.length * 0.3;
      const finalScore = clamp(
        Math.round((leaps.subScore - cautionDeduction) * 10) / 10,
        0, 10,
      );
      return {
        leaps,
        score: finalScore,
        grade: grade(finalScore),
        cautionFlags: flags,
      };
    });

    opportunities.sort((a, b) => b.score - a.score);

    log(`${opportunities.length} ranked opportunities`);
    return this.persistRun({ gate, detail, effect, universe, watchlistId: watchlistId ?? null }, opportunities);
  }

  getRecentRuns(): LeapsCspRunSummary[] {
    const rows = this.db.prepare(`
      SELECT id, run_at, universe, watchlist_id, market_gate, gate_detail_json, gate_effect,
             candidate_count, opportunity_count
      FROM leaps_csp_runs
      ORDER BY id DESC
      LIMIT 20
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
      marketGate: r.market_gate as LeapsCspGate,
      gateDetail: JSON.parse(r.gate_detail_json) as LeapsCspGateDetail,
      gateEffect: r.gate_effect,
      candidateCount: r.candidate_count,
      opportunityCount: r.opportunity_count,
    }));
  }

  getRun(runId: number): LeapsCspRunResult | null {
    const runRow = this.db.prepare(`
      SELECT id, run_at, universe, watchlist_id, market_gate, gate_detail_json, gate_effect,
             candidate_count, opportunity_count
      FROM leaps_csp_runs WHERE id = ?
    `).get(runId) as {
      id: number; run_at: string; universe: string; watchlist_id: number | null;
      market_gate: string; gate_detail_json: string; gate_effect: string;
      candidate_count: number; opportunity_count: number;
    } | undefined;

    if (!runRow) return null;

    const oppRows = this.db.prepare(`
      SELECT * FROM leaps_csp_opportunities WHERE run_id = ? ORDER BY rank
    `).all(runId) as Array<Record<string, unknown>>;

    return {
      run: {
        id: runRow.id,
        runAt: runRow.run_at,
        universe: runRow.universe,
        watchlistId: runRow.watchlist_id,
        marketGate: runRow.market_gate as LeapsCspGate,
        gateDetail: JSON.parse(runRow.gate_detail_json) as LeapsCspGateDetail,
        gateEffect: runRow.gate_effect,
        candidateCount: runRow.candidate_count,
        opportunityCount: runRow.opportunity_count,
      },
      opportunities: oppRows.map(r => this.rowToOpportunity(r)),
    };
  }

  markOpened(
    opportunityId: number,
    entry: { leapsEntryDebit?: number; notes?: string },
  ): void {
    this.db.prepare(`
      INSERT INTO leaps_csp_opened (opportunity_id, opened_at, leaps_entry_debit, csp_entry_credit, notes)
      VALUES (?, ?, ?, NULL, ?)
    `).run(
      opportunityId,
      new Date().toISOString(),
      entry.leapsEntryDebit ?? null,
      entry.notes ?? null,
    );
  }

  getOpenedPositions(): LeapsCspOpenedEntry[] {
    return (this.db.prepare(`
      SELECT id, opportunity_id, opened_at, leaps_entry_debit, notes
      FROM leaps_csp_opened ORDER BY id DESC
    `).all() as Array<Record<string, unknown>>).map(r => ({
      id: r['id'] as number,
      opportunityId: r['opportunity_id'] as number,
      openedAt: r['opened_at'] as string,
      leapsEntryDebit: r['leaps_entry_debit'] as number | null,
      notes: r['notes'] as string | null,
    }));
  }

  deleteRun(runId: number): void {
    this.db.prepare('DELETE FROM leaps_csp_runs WHERE id = ?').run(runId);
  }

  // ── Market Gate ─────────────────────────────────────────────────────────────

  private async checkMarketGate(): Promise<{ gate: LeapsCspGate; detail: LeapsCspGateDetail; effect: string }> {
    const noData: LeapsCspGateDetail = {
      spx: null, spx50d: null, spx200d: null,
      vix: null, vix5dChangePct: null,
      hygIefRatio: null, hygIefTrend: null,
    };

    try {
      // Fetch SPX price + bars (for 50d/200d MAs)
      await this.rateLimiter.acquire();
      const spxQuote = await this.safeQuote('SPY'); // use SPY as SPX proxy

      await this.rateLimiter.acquire();
      const spxBars = await this.safeBars('SPY', 'day', 210);

      // Fetch VIX
      await this.rateLimiter.acquire();
      const vixQuote = await this.safeQuote('VIX');

      await this.rateLimiter.acquire();
      const vixBars = await this.safeBars('VIX', 'day', 10);

      // Fetch HYG + IEF for credit spread ratio
      const [hygQ, iefQ] = await Promise.all([
        (await this.rateLimiter.acquire(), this.safeQuote('HYG')),
        (await this.rateLimiter.acquire(), this.safeQuote('IEF')),
      ]);

      const spxPrice = spxQuote?.last ?? null;
      const vixPrice = vixQuote?.last ?? null;

      // Compute SPX SMAs
      const closes = spxBars.map(b => b.c);
      const sma = (n: number) => {
        if (closes.length < n) return null;
        const slice = closes.slice(-n);
        return slice.reduce((a, b) => a + b, 0) / n;
      };
      const spx50d = sma(50);
      const spx200d = sma(200);

      // VIX 5-day change
      let vix5dChangePct: number | null = null;
      if (vixBars.length >= 6 && vixPrice !== null) {
        const prior = vixBars[vixBars.length - 6]?.c;
        if (prior && prior > 0) vix5dChangePct = ((vixPrice - prior) / prior) * 100;
      }

      // HYG/IEF ratio
      const hygPrice = hygQ?.last ?? null;
      const iefPrice = iefQ?.last ?? null;
      let hygIefRatio: number | null = null;
      let hygIefTrend: 'up' | 'down' | 'flat' | null = null;
      if (hygPrice && iefPrice && iefPrice > 0) {
        hygIefRatio = hygPrice / iefPrice;
        hygIefTrend = 'flat'; // detailed trend requires historical ratio
      }

      const detail: LeapsCspGateDetail = {
        spx: spxPrice,
        spx50d,
        spx200d,
        vix: vixPrice,
        vix5dChangePct,
        hygIefRatio,
        hygIefTrend,
      };

      // ── Gate logic ───────────────────────────────────────────────────────
      const failConditions: string[] = [];
      const cautionConditions: string[] = [];

      if (spxPrice !== null && spx50d !== null) {
        const pctFrom50d = ((spxPrice - spx50d) / spx50d) * 100;
        if (pctFrom50d < -1) failConditions.push('SPX below 50d MA');
        else if (Math.abs(pctFrom50d) <= 1) cautionConditions.push('SPX near 50d MA');
      }

      if (spxPrice !== null && spx200d !== null) {
        const pctFrom200d = ((spxPrice - spx200d) / spx200d) * 100;
        if (pctFrom200d < 0) failConditions.push('SPX below 200d MA');
        else if (pctFrom200d < 2) cautionConditions.push('SPX near 200d MA');
      }

      if (vixPrice !== null) {
        if (vixPrice > 28) failConditions.push(`VIX ${vixPrice.toFixed(1)} > 28 (panic)`);
        else if (vixPrice >= 22) cautionConditions.push(`VIX ${vixPrice.toFixed(1)} elevated`);
      }

      if (vix5dChangePct !== null) {
        if (vix5dChangePct > 40) failConditions.push(`VIX spiked +${vix5dChangePct.toFixed(0)}% in 5d`);
        else if (vix5dChangePct > 20) cautionConditions.push(`VIX up +${vix5dChangePct.toFixed(0)}% in 5d`);
      }

      let gate: LeapsCspGate;
      let effect: string;

      if (failConditions.length > 0) {
        gate = 'FAIL';
        effect = `LEAPS suppressed (${failConditions[0]})`;
      } else if (cautionConditions.length > 0) {
        gate = 'CAUTION';
        effect = `Filtered to A/A+ only (${cautionConditions[0]})`;
      } else {
        gate = 'PASS';
        effect = 'Normal — all grades shown';
      }

      return { gate, detail, effect };
    } catch {
      return {
        gate: 'CAUTION',
        detail: noData,
        effect: 'Market data unavailable — proceeding with caution',
      };
    }
  }

  // ── Universe loading from screener cache ────────────────────────────────────

  private getScreenedTickers(universe: string): string[] {
    const univKey =
      universe === 'sp500'       ? 'sp500' :
      universe === 'russell1000' ? 'russell1000' :
      universe === 'etf'         ? 'etf' :
      null; // null = 'both' → no filter

    const universeClause = univKey === null ? `1=1` : `sr.universe = '${univKey}'`;

    const rows = this.db.prepare(`
      SELECT DISTINCT res.ticker
      FROM screen_results res
      JOIN screen_runs sr ON res.screen_run_id = sr.id
      WHERE ${universeClause}
      ORDER BY res.rowid DESC
      LIMIT 2000
    `).all() as Array<{ ticker: string }>;

    if (rows.length > 0) {
      return [...new Set(rows.map(r => r.ticker))];
    }

    // No screener results yet — fall back to constituents table for the full universe
    const indexClause = univKey === null ? `1=1` : `index_name = '${univKey}'`;
    const constRows = this.db.prepare(`
      SELECT ticker FROM constituents WHERE ${indexClause} ORDER BY ticker ASC
    `).all() as Array<{ ticker: string }>;

    return constRows.map(r => r.ticker);
  }

  private getWatchlistTickers(watchlistId: number): string[] {
    const rows = this.db.prepare(
      'SELECT ticker FROM watchlist_items WHERE watchlist_id = ? ORDER BY id',
    ).all(watchlistId) as Array<{ ticker: string }>;
    return rows.map(r => r.ticker);
  }

  private loadFundamentalsCache(tickers: string[]): Map<string, FundamentalsRow> {
    const result = new Map<string, FundamentalsRow>();
    if (tickers.length === 0) return result;

    const placeholders = tickers.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT ticker, payload_json FROM fundamentals_cache WHERE ticker IN (${placeholders})
    `).all(...tickers) as Array<{ ticker: string; payload_json: string }>;

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

    const placeholders = tickers.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT ticker, last, volume FROM quote_cache WHERE ticker IN (${placeholders})
    `).all(...tickers) as Array<{ ticker: string; last: number | null; volume: number | null }>;

    for (const r of rows) {
      result.set(r.ticker, { ticker: r.ticker, last: r.last, volume: r.volume });
    }
    return result;
  }

  // ── Universe filter ─────────────────────────────────────────────────────────

  private passUniverseFilter(
    ticker: string,
    f: FundamentalsRow | undefined,
    q: QuoteRow | undefined,
    log?: (msg: string) => void,
    isEtf = false,
  ): boolean {
    if (!f || !q) {
      log?.(`  ${ticker} failed: ${!f ? 'no fundamentals' : 'no quote'}`);
      return false;
    }
    const price = q.last ?? 0;
    const volume = q.volume ?? 0;
    if (price < 10) { log?.(`  ${ticker} failed: price $${price.toFixed(2)} < $10`); return false; }
    if (volume < 2_000_000) { log?.(`  ${ticker} failed: volume ${volume} < 2M`); return false; }
    if (!isEtf) {
      const marketCap = f.marketCap ?? 0;
      if (marketCap < 10_000_000_000) { log?.(`  ${ticker} failed: marketCap $${(marketCap / 1e9).toFixed(1)}B < $10B`); return false; }
      if (isBiotech(f.sector)) { log?.(`  ${ticker} failed: biotech sector (${f.sector})`); return false; }
    }
    return true;
  }

  // ── Stock hard fails — LEAPS leg ────────────────────────────────────────────

  private leapsStockHardFail(
    _ticker: string,
    f: FundamentalsRow | undefined,
    q: QuoteRow | undefined,
  ): string | null {
    if (!f || !q) return 'missing data';
    return null;
  }

  // ── LEAPS contract selection ────────────────────────────────────────────────

  private selectLeapsContract(
    calls: OptionContract[],
    currentPrice: number,
  ): OptionContract | null {
    // Filter to delta 0.70–0.90 range
    const inBand = calls.filter(c => c.delta !== null && c.delta >= 0.70 && c.delta <= 0.90);
    if (inBand.length > 0) {
      inBand.sort((a, b) => Math.abs((a.delta ?? 0) - 0.80) - Math.abs((b.delta ?? 0) - 0.80));
      const itm = inBand.filter(c => c.strike < currentPrice);
      return itm[0] ?? inBand[0] ?? null;
    }

    // Fallback: no greeks available — select by moneyness (5–20% ITM ≈ delta 0.70–0.85)
    if (calls.length === 0) return null;
    const itmCalls = calls.filter(c => {
      if (c.strike >= currentPrice) return false;
      const pctBelow = (currentPrice - c.strike) / currentPrice;
      return pctBelow >= 0.05 && pctBelow <= 0.20;
    });
    itmCalls.sort((a, b) => {
      const aDist = Math.abs((currentPrice - a.strike) / currentPrice - 0.10);
      const bDist = Math.abs((currentPrice - b.strike) / currentPrice - 0.10);
      return aDist - bDist;
    });
    return itmCalls[0] ?? null;
  }

  // ── LEAPS contract hard fails ───────────────────────────────────────────────
  //
  //  spreadPct ≤ 15%   — LEAPS markets are less liquid; a $1.50 spread on a $20
  //                       option is 7.5%, which is normal and acceptable.
  //  extrinsicPct ≤ 50% — For 400–700 DTE with IV > 20%, even a well-chosen
  //                       delta-0.80 call has 25–40% extrinsic. The hard fail
  //                       removes truly egregious outliers (>50%).
  //  openInterest ≥ 10 — Minimum real-market liquidity signal.

  private passLeapsContractHardFails(
    contract: OptionContract,
    midPrice: number,
    extrinsicPct: number,
  ): string | null {
    if (midPrice <= 0) return 'zero mid-price';
    const spread = contract.ask - contract.bid;
    const spreadPct = spread / midPrice * 100;
    if (contract.bid !== contract.ask && spreadPct > 15) {
      return `spread ${spreadPct.toFixed(1)}% > 15%`;
    }
    if ((contract.openInterest ?? 0) < 10) {
      return `OI ${contract.openInterest ?? 0} < 10`;
    }
    if (extrinsicPct > 50) {
      return `extrinsic ${extrinsicPct.toFixed(1)}% > 50%`;
    }
    return null;
  }

  // ── LEAPS leg scoring ───────────────────────────────────────────────────────

  private scoreLeapsLeg(
    contract: OptionContract,
    dte: number,
    extrinsicPct: number,
    ivData: IvData,
    f: FundamentalsRow | undefined,
    _currentPrice: number,
    isEtf = false,
  ): { score: number; breakdown: LeapsCspScoreComponent[] } {
    const components: Array<{ name: string; weight: number; rawScore: number }> = [];

    // 1. Stock trend strength (20%) — approximated via ROE / fundamentals quality
    let trendScore = 5;
    const roe = f?.roe ?? null;
    if (roe !== null && roe >= 20) trendScore = 10;
    else if (roe !== null && roe >= 15) trendScore = 7;
    components.push({ name: 'Stock trend strength', weight: 0.20, rawScore: trendScore });

    // 2. Delta in target band (15%)
    let deltaScore = 0;
    const delta = contract.delta ?? 0;
    if (delta >= 0.78 && delta <= 0.82) deltaScore = 10;
    else if (delta >= 0.75 && delta <= 0.85) deltaScore = 8;
    else if ((delta >= 0.70 && delta < 0.75) || (delta > 0.85 && delta <= 0.90)) deltaScore = 5;
    components.push({ name: 'Delta in target band', weight: 0.15, rawScore: deltaScore });

    // 3. Extrinsic % of premium (20%)
    let extScore = 0;
    if (extrinsicPct <= 5) extScore = 10;
    else if (extrinsicPct <= 8) extScore = 8;
    else if (extrinsicPct <= 12) extScore = 5;
    else if (extrinsicPct <= 15) extScore = 2;
    components.push({ name: 'Extrinsic % of premium', weight: 0.20, rawScore: extScore });

    // 4. IV state on contract (15%)
    let ivScore = 5;
    const ivr = ivData.ivr ?? 50;
    if (ivr < 30) ivScore = 10;
    else if (ivr < 50) ivScore = 8;
    else if (ivr < 60) ivScore = 5;
    else if (ivr < 80) ivScore = 2;
    else ivScore = 0;
    components.push({ name: 'IV state (IVR)', weight: 0.15, rawScore: ivScore });

    // 5. Liquidity — spread + OI (10%)
    let liqScore = 0;
    const midPrice = (contract.bid + contract.ask) / 2;
    const spreadPct = midPrice > 0 ? ((contract.ask - contract.bid) / midPrice) * 100 : 99;
    const oi = contract.openInterest ?? 0;
    if (spreadPct < 2 && oi > 500) liqScore = 10;
    else if (spreadPct < 3 && oi > 250) liqScore = 8;
    else if (spreadPct < 5 && oi > 100) liqScore = 5;
    components.push({ name: 'Liquidity', weight: 0.10, rawScore: liqScore });

    // 6. Fundamental grade (10%) — proxy: ROE + D/E
    let fundScore: number;
    if (isEtf) {
      fundScore = 7;
    } else {
      fundScore = 5;
      const de = f?.debtToEquity ?? null;
      if (roe !== null && roe >= 20 && de !== null && de < 1.0) fundScore = 10;
      else if (roe !== null && roe >= 15) fundScore = 8;
      else if (roe !== null && roe >= 10) fundScore = 5;
    }
    components.push({ name: 'Fundamental grade', weight: 0.10, rawScore: fundScore });

    // 7. Distance to next earnings (10%) — ETFs have no earnings → 10/10
    const earningsScore = isEtf ? 10 : 8;
    components.push({ name: 'Distance to earnings', weight: 0.10, rawScore: earningsScore });

    const weightedSum = components.reduce((acc, c) => acc + c.rawScore * c.weight, 0);
    const score = clamp(Math.round(weightedSum * 10) / 10, 0, 10);

    const breakdown: LeapsCspScoreComponent[] = components.map(c => ({
      name: c.name,
      weight: c.weight,
      rawScore: c.rawScore,
      weightedScore: Math.round(c.rawScore * c.weight * 100) / 100,
    }));

    return { score, breakdown };
    void dte;
  }

  // ── Caution flags ───────────────────────────────────────────────────────────

  private cautionFlags(leaps: LeapsCandidate): string[] {
    const flags: string[] = [];
    // LEAPS premium > 25% of stock price
    if (leaps.contract.bid > 0) {
      const premiumPct = ((leaps.contract.bid + leaps.contract.ask) / 2) / leaps.currentPrice * 100;
      if (premiumPct > 25) flags.push('HIGH_LEAPS_PREMIUM');
    }
    // IVR between 60–80 on underlying (elevated but not disqualifying)
    if (leaps.ivr !== null && leaps.ivr >= 60 && leaps.ivr <= 80) {
      flags.push('LEAPS_IV_ELEVATED');
    }
    return flags;
  }

  // ── IV data helper ──────────────────────────────────────────────────────────

  private ivFailLogged = false;

  private async fetchIvData(ticker: string): Promise<IvData> {
    try {
      const result = await this.optionsProvider.getOptionsIVAndPremium(ticker, null, null);
      const { currentIv, iv52WkHigh, iv52WkLow } = result;
      // IVR = (current - low) / (high - low) × 100  (see docs/formulas.md#iv-rank)
      let ivr: number | null = null;
      if (currentIv !== null && iv52WkHigh !== null && iv52WkLow !== null) {
        const range = iv52WkHigh - iv52WkLow;
        if (range > 0) ivr = clamp(((currentIv - iv52WkLow) / range) * 100, 0, 100);
      }
      return { currentIv, iv52WkHigh, iv52WkLow, ivr };
    } catch (err) {
      if (!this.ivFailLogged) {
        this.ivFailLogged = true;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[LEAPS] IV data fetch failed for ${ticker}: ${msg}`);
      }
      return { currentIv: null, iv52WkHigh: null, iv52WkLow: null, ivr: null };
    }
  }

  // ── Safe fetch wrappers ─────────────────────────────────────────────────────

  private chainFailLogged = false;

  private async safeGetChain(ticker: string, expiry: string): Promise<OptionContract[] | null> {
    try {
      const chain = await this.optionsProvider.getOptionsChain(ticker, expiry);
      return chain.contracts as OptionContract[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.chainFailLogged) {
        this.chainFailLogged = true;
        console.warn(`[LEAPS] Options chain fetch failed for ${ticker}/${expiry}: ${msg}`);
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
    } catch {
      return null;
    }
  }

  private async safeBars(ticker: string, tf: 'day', lookbackDays: number): Promise<Array<{ c: number }>> {
    try {
      const bars = await this.dataProvider.getHistoricalBars(ticker, tf, lookbackDays);
      return bars.map((b) => ({ c: b.c }));
    } catch {
      return [];
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  private persistRun(
    meta: { gate: LeapsCspGate; detail: LeapsCspGateDetail; effect: string; universe: string; watchlistId: number | null },
    opportunities: LeapsOpportunity[],
  ): LeapsCspRunResult {
    const runAt = new Date().toISOString();

    const runId = (this.db.prepare(`
      INSERT INTO leaps_csp_runs
        (run_at, universe, watchlist_id, market_gate, gate_detail_json, gate_effect, candidate_count, opportunity_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runAt,
      meta.universe,
      meta.watchlistId,
      meta.gate,
      JSON.stringify(meta.detail),
      meta.effect,
      opportunities.length,
      opportunities.length,
    ) as { lastInsertRowid: number }).lastInsertRowid;

    const insertOpp = this.db.prepare(`
      INSERT INTO leaps_csp_opportunities (
        run_id, rank, pairing_mode,
        leaps_ticker, leaps_current_price, leaps_strike, leaps_expiry, leaps_dte,
        leaps_delta, leaps_premium, leaps_extrinsic_pct, leaps_iv_pct, leaps_ivr, leaps_oi, leaps_sub_score,
        csp_ticker, csp_current_price, csp_strike, csp_expiry, csp_dte,
        csp_delta, csp_premium, csp_collateral, csp_ann_return_pct, csp_iv_pct, csp_ivr, csp_oi, csp_sub_score,
        combined_score, grade, caution_flags, total_cash_to_deploy, detail_json
      ) VALUES (
        ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      )
    `);

    const resultOpportunities: LeapsCspOpportunity[] = opportunities.map((p, idx) => {
      const leapsMid = (p.leaps.contract.bid + p.leaps.contract.ask) / 2;
      const leapsPremiumPerContract = leapsMid * 100;

      const detail: LeapsCspDetail = {
        leapsScoreBreakdown: p.leaps.scoreBreakdown,
      };

      const id = (insertOpp.run(
        runId, idx + 1, 'leaps_only',
        p.leaps.ticker, p.leaps.currentPrice, p.leaps.contract.strike, p.leaps.expiry, p.leaps.dte,
        p.leaps.contract.delta, leapsPremiumPerContract, p.leaps.extrinsicPct,
        p.leaps.ivPct, p.leaps.ivr, p.leaps.contract.openInterest, p.leaps.subScore,
        // CSP columns — always null
        null, null, null, null, null,
        null, null, null, null, null, null, null, null,
        p.score, p.grade, p.cautionFlags.join(',') || null,
        leapsPremiumPerContract, JSON.stringify(detail),
      ) as { lastInsertRowid: number }).lastInsertRowid;

      return {
        id: Number(id),
        runId: Number(runId),
        rank: idx + 1,
        leapsTicker: p.leaps.ticker,
        leapsCurrentPrice: p.leaps.currentPrice,
        leapsStrike: p.leaps.contract.strike,
        leapsExpiry: p.leaps.expiry,
        leapsDte: p.leaps.dte,
        leapsDelta: p.leaps.contract.delta,
        leapsPremium: leapsPremiumPerContract,
        leapsExtrinsicPct: p.leaps.extrinsicPct,
        leapsIvPct: p.leaps.ivPct,
        leapsIvr: p.leaps.ivr,
        leapsOi: p.leaps.contract.openInterest,
        leapsSubScore: p.leaps.subScore,
        combinedScore: p.score,
        grade: p.grade,
        cautionFlags: p.cautionFlags,
        totalCashToDeploy: leapsPremiumPerContract,
        detail,
      };
    });

    const runSummary: LeapsCspRunSummary = {
      id: Number(runId),
      runAt,
      universe: meta.universe,
      watchlistId: meta.watchlistId,
      marketGate: meta.gate,
      gateDetail: meta.detail,
      gateEffect: meta.effect,
      candidateCount: opportunities.length,
      opportunityCount: opportunities.length,
    };

    return { run: runSummary, opportunities: resultOpportunities };
  }

  // ── Row mapper ──────────────────────────────────────────────────────────────

  private rowToOpportunity(r: Record<string, unknown>): LeapsCspOpportunity {
    const flags = r['caution_flags'] ? String(r['caution_flags']).split(',').filter(Boolean) : [];
    let detail: LeapsCspDetail = { leapsScoreBreakdown: [] };
    try {
      const parsed = JSON.parse(r['detail_json'] as string) as Record<string, unknown>;
      detail = {
        leapsScoreBreakdown: (parsed['leapsScoreBreakdown'] as LeapsCspScoreComponent[]) ?? [],
      };
    } catch { /* use default */ }

    return {
      id: r['id'] as number,
      runId: r['run_id'] as number,
      rank: r['rank'] as number,
      leapsTicker: r['leaps_ticker'] as string,
      leapsCurrentPrice: r['leaps_current_price'] as number | null,
      leapsStrike: r['leaps_strike'] as number,
      leapsExpiry: r['leaps_expiry'] as string,
      leapsDte: r['leaps_dte'] as number | null,
      leapsDelta: r['leaps_delta'] as number | null,
      leapsPremium: r['leaps_premium'] as number | null,
      leapsExtrinsicPct: r['leaps_extrinsic_pct'] as number | null,
      leapsIvPct: r['leaps_iv_pct'] as number | null,
      leapsIvr: r['leaps_ivr'] as number | null,
      leapsOi: r['leaps_oi'] as number | null,
      leapsSubScore: r['leaps_sub_score'] as number,
      combinedScore: r['combined_score'] as number,
      grade: r['grade'] as LeapsCspGrade,
      cautionFlags: flags,
      totalCashToDeploy: r['total_cash_to_deploy'] as number | null,
      detail,
    };
  }
}
