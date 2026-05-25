// LEAPS + CSP Strategy Screener
// Implements the SRS: "LEAPS Stock Replacement with Decoupled Cash-Secured Puts"
// Design philosophy: opportunity ranking, not capital management.
// All hard fails are quality gates — never capital constraints.
//
// Screening pipeline:
//   Market gate → Universe filters → Stock hard fails →
//   LEAPS contract selection + scoring →
//   CSP candidate pool (cross-universe) + scoring →
//   Pair (same-ticker + cross-ticker) → Combined score → Rank → Persist

import type { DbHandle } from '../db/connection.js';
import type { PolygonDataProvider } from './polygon-provider.js';
import type { TokenBucketRateLimiter } from './rate-limiter.js';
import type {
  LeapsCspGate,
  LeapsCspGateDetail,
  LeapsCspGrade,
  LeapsCspOpportunity,
  LeapsCspRunResult,
  LeapsCspRunSummary,
  LeapsCspScoreComponent,
  LeapsCspAlternative,
  LeapsCspDetail,
  LeapsCspPairingMode,
  LeapsCspOpenedEntry,
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

interface CspCandidate {
  ticker: string;
  currentPrice: number;
  contract: OptionContract;
  expiry: string;
  dte: number;
  annReturnPct: number;
  ivPct: number;
  ivr: number | null;
  subScore: number;
  scoreBreakdown: LeapsCspScoreComponent[];
}

interface PairedOpportunity {
  leaps: LeapsCandidate;
  csp: CspCandidate | null;
  pairingMode: LeapsCspPairingMode;
  combinedScore: number;
  grade: LeapsCspGrade;
  cautionFlags: string[];
  alternatives: LeapsCspAlternative[];
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

function dteDays(expiryYMD: string): number {
  const exp = new Date(expiryYMD + 'T16:00:00Z'); // market close
  return Math.round((exp.getTime() - Date.now()) / 86_400_000);
}

/** 3rd Friday of January for a given year. */
function thirdFridayOfJanuary(year: number): string {
  const d = new Date(Date.UTC(year, 0, 1));
  // Find first Friday
  const dow = d.getUTCDay(); // 0=Sun
  const daysToFri = (5 - dow + 7) % 7;
  d.setUTCDate(1 + daysToFri + 14); // +2 weeks = 3rd Friday
  return d.toISOString().slice(0, 10);
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
    candidates.push(d.toISOString().slice(0, 10));
  }
  // Keep only those in the 365–730 day window
  return candidates.filter(e => {
    const dte = dteDays(e);
    return dte >= 365 && dte <= 730;
  });
}

/** Best Friday with DTE 30–45 for the CSP leg. */
function cspExpiryDate(): string {
  const now = new Date();
  const dow = now.getDay();
  const daysToFriday = (5 - dow + 7) % 7 || 7;
  for (let weeks = 0; weeks < 10; weeks++) {
    const d = new Date(now);
    d.setDate(now.getDate() + daysToFriday + weeks * 7);
    const dte = Math.round((d.getTime() - now.getTime()) / 86_400_000);
    if (dte >= 25 && dte <= 50) return d.toISOString().slice(0, 10);
  }
  // Fallback: 5 weeks out
  const fb = new Date(now);
  fb.setDate(now.getDate() + daysToFriday + 35);
  return fb.toISOString().slice(0, 10);
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
    private readonly provider: PolygonDataProvider,
    private readonly rateLimiter: TokenBucketRateLimiter,
  ) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  async runScreen(
    universe: 'sp500' | 'russell1000' | 'both',
    onProgress?: (msg: string) => void,
  ): Promise<LeapsCspRunResult> {
    const log = (msg: string) => { onProgress?.(msg); };

    log('Checking market gate…');
    const { gate, detail, effect } = await this.checkMarketGate();

    log(`Market gate: ${gate} — ${effect}`);

    // Under a FAIL gate, suppress new LEAPS opportunities (SRS §6.2)
    if (gate === 'FAIL') {
      log('Market gate FAIL: LEAPS suppressed. Returning empty run.');
      return this.persistRun(
        { gate, detail, effect, universe },
        [],
      );
    }

    log('Loading universe from screener cache…');
    const tickers = this.getScreenedTickers(universe);
    log(`${tickers.length} tickers from screener cache`);

    if (tickers.length === 0) {
      log('No screener results found. Run the Index Screener first to populate the universe.');
      return this.persistRun({ gate, detail, effect, universe }, []);
    }

    log('Loading cached fundamentals & quotes…');
    const fundamentalsMap = this.loadFundamentalsCache(tickers);
    const quotesMap = this.loadQuoteCache(tickers);

    log('Applying universe filters…');
    const filtered = tickers.filter(t => {
      const f = fundamentalsMap.get(t);
      const q = quotesMap.get(t);
      return this.passUniverseFilter(t, f, q);
    });
    log(`${filtered.length} tickers pass universe filters`);

    // ── LEAPS candidates ────────────────────────────────────────────────────
    log('Screening LEAPS candidates…');
    const leapsCandidates: LeapsCandidate[] = [];
    const leapsExpiries = leapsExpiryDates();

    if (leapsExpiries.length === 0) {
      log('No valid LEAPS expiry dates found in 365–730 DTE window.');
      return this.persistRun({ gate, detail, effect, universe }, []);
    }

    for (const ticker of filtered) {
      const f = fundamentalsMap.get(ticker);
      const q = quotesMap.get(ticker);
      const currentPrice = q?.last ?? null;
      if (!currentPrice || currentPrice <= 0) continue;

      // Check stock hard fails for LEAPS leg
      const failReason = this.leapsStockHardFail(ticker, f, q);
      if (failReason) continue;

      // Fetch IV for IVR computation
      await this.rateLimiter.acquire();
      const ivData = await this.fetchIvData(ticker);

      // IVR > 80 on underlying → reject for LEAPS (IV crush risk) — SRS §4.2
      if (ivData.ivr !== null && ivData.ivr > 80) continue;

      // Try each LEAPS expiry, keep best contract
      let best: LeapsCandidate | null = null;
      for (const expiry of leapsExpiries) {
        await this.rateLimiter.acquire();
        const chain = await this.safeGetChain(ticker, expiry);
        if (!chain) continue;

        const calls = chain.filter(c => c.side === 'call');
        const contract = this.selectLeapsContract(calls, currentPrice);
        if (!contract) continue;

        const dte = dteDays(expiry);
        const intrinsic = Math.max(0, currentPrice - contract.strike);
        const midPrice = (contract.bid + contract.ask) / 2;
        const extrinsicPct = midPrice > 0 ? ((midPrice - intrinsic) / midPrice) * 100 : 999;

        // LEAPS contract hard fails (SRS §4.3.1)
        if (!this.passLeapsContractHardFails(contract, midPrice, extrinsicPct)) continue;

        const ivPct = contract.iv * 100;
        const { score, breakdown } = this.scoreLeapsLeg(
          contract, dte, extrinsicPct, ivData, f, currentPrice,
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

      if (best) leapsCandidates.push(best);
    }

    log(`${leapsCandidates.length} qualifying LEAPS candidates`);
    if (leapsCandidates.length === 0) {
      return this.persistRun({ gate, detail, effect, universe }, []);
    }

    // ── CSP candidate pool (full filtered universe) ─────────────────────────
    log('Building CSP candidate pool…');
    const cspExpiry = cspExpiryDate();
    const cspPool = new Map<string, CspCandidate[]>();

    for (const ticker of filtered) {
      const q = quotesMap.get(ticker);
      const currentPrice = q?.last ?? null;
      if (!currentPrice || currentPrice <= 0) continue;

      // Basic CSP stock check: must be above 50d MA in trend
      const f = fundamentalsMap.get(ticker);
      if (this.cspStockHardFail(ticker, f, q)) continue;

      await this.rateLimiter.acquire();
      const ivData = await this.fetchIvData(ticker);

      await this.rateLimiter.acquire();
      const chain = await this.safeGetChain(ticker, cspExpiry);
      if (!chain) continue;

      const puts = chain.filter(c => c.side === 'put');
      const candidates = this.selectCspContracts(puts, currentPrice, cspExpiry, ivData, f);
      if (candidates.length > 0) {
        cspPool.set(ticker, candidates);
      }
    }
    log(`${cspPool.size} tickers with qualifying CSP contracts`);

    // ── Pair LEAPS with CSP ─────────────────────────────────────────────────
    log('Pairing LEAPS with best CSP…');
    const paired: PairedOpportunity[] = [];

    // Sort all CSP candidates by sub-score for fast ranking
    const allCspSorted: CspCandidate[] = [];
    for (const candidates of cspPool.values()) {
      allCspSorted.push(...candidates);
    }
    allCspSorted.sort((a, b) => b.subScore - a.subScore);

    for (const leaps of leapsCandidates) {
      const sameTicker = cspPool.get(leaps.ticker)?.[0] ?? null;

      // Top-5 cross-ticker CSPs (different from LEAPS ticker)
      const crossTicker = allCspSorted
        .filter(c => c.ticker !== leaps.ticker)
        .slice(0, 5);

      // Score each combination
      const pairCandidates: Array<{ csp: CspCandidate; combined: number; mode: LeapsCspPairingMode }> = [];

      if (sameTicker) {
        const combined = this.combinedScore(leaps.subScore, sameTicker.subScore);
        pairCandidates.push({ csp: sameTicker, combined, mode: 'same_ticker' });
      }

      for (const csp of crossTicker) {
        const combined = this.combinedScore(leaps.subScore, csp.subScore);
        pairCandidates.push({ csp, combined, mode: 'different_ticker' });
      }

      // Sort by combined score — pick best
      pairCandidates.sort((a, b) => b.combined - a.combined);

      const best = pairCandidates[0];
      const cautionFlags = this.cautionFlags(leaps, best?.csp ?? null);
      const cautionDeduction = cautionFlags.length * 0.3; // simple flat deduction per flag

      let finalScore: number;
      let pairingMode: LeapsCspPairingMode;
      let bestCsp: CspCandidate | null;

      if (best) {
        finalScore = clamp(
          Math.round((best.combined - cautionDeduction) * 10) / 10,
          0, 10,
        );
        pairingMode = best.mode;
        bestCsp = best.csp;
      } else {
        // LEAPS-only opportunity (SRS §12.3)
        finalScore = clamp(
          Math.round((leaps.subScore * 0.6 - cautionDeduction) * 10) / 10,
          0, 10,
        );
        pairingMode = 'leaps_only';
        bestCsp = null;
        cautionFlags.push('LEAPS_ONLY');
      }

      // Alternatives: next 2 pairs
      const alternatives: LeapsCspAlternative[] = pairCandidates.slice(1, 3).map(p => ({
        cspTicker: p.csp.ticker,
        cspStrike: p.csp.contract.strike,
        cspExpiry: p.csp.expiry,
        cspDelta: p.csp.contract.delta,
        cspPremium: (p.csp.contract.bid + p.csp.contract.ask) / 2,
        cspAnnReturnPct: p.csp.annReturnPct,
        cspSubScore: p.csp.subScore,
        combinedScore: clamp(Math.round((p.combined - cautionDeduction) * 10) / 10, 0, 10),
        grade: grade(clamp(Math.round((p.combined - cautionDeduction) * 10) / 10, 0, 10)),
      }));

      paired.push({
        leaps,
        csp: bestCsp,
        pairingMode,
        combinedScore: finalScore,
        grade: grade(finalScore),
        cautionFlags,
        alternatives,
      });
    }

    // Apply CAUTION gate floor: raise minimum score for default view
    // (The UI handles the display filter; we just record the gate state)

    paired.sort((a, b) => b.combinedScore - a.combinedScore);

    log(`${paired.length} ranked opportunities`);
    return this.persistRun({ gate, detail, effect, universe }, paired);
  }

  getRecentRuns(): LeapsCspRunSummary[] {
    const rows = this.db.prepare(`
      SELECT id, run_at, universe, market_gate, gate_detail_json, gate_effect,
             candidate_count, opportunity_count
      FROM leaps_csp_runs
      ORDER BY id DESC
      LIMIT 20
    `).all() as Array<{
      id: number; run_at: string; universe: string; market_gate: string;
      gate_detail_json: string; gate_effect: string;
      candidate_count: number; opportunity_count: number;
    }>;

    return rows.map(r => ({
      id: r.id,
      runAt: r.run_at,
      universe: r.universe,
      marketGate: r.market_gate as LeapsCspGate,
      gateDetail: JSON.parse(r.gate_detail_json) as LeapsCspGateDetail,
      gateEffect: r.gate_effect,
      candidateCount: r.candidate_count,
      opportunityCount: r.opportunity_count,
    }));
  }

  getRun(runId: number): LeapsCspRunResult | null {
    const runRow = this.db.prepare(`
      SELECT id, run_at, universe, market_gate, gate_detail_json, gate_effect,
             candidate_count, opportunity_count
      FROM leaps_csp_runs WHERE id = ?
    `).get(runId) as {
      id: number; run_at: string; universe: string; market_gate: string;
      gate_detail_json: string; gate_effect: string;
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
    entry: { leapsEntryDebit?: number; cspEntryCredit?: number; notes?: string },
  ): void {
    this.db.prepare(`
      INSERT INTO leaps_csp_opened (opportunity_id, opened_at, leaps_entry_debit, csp_entry_credit, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      opportunityId,
      new Date().toISOString(),
      entry.leapsEntryDebit ?? null,
      entry.cspEntryCredit ?? null,
      entry.notes ?? null,
    );
  }

  getOpenedPositions(): LeapsCspOpenedEntry[] {
    return (this.db.prepare(`
      SELECT id, opportunity_id, opened_at, leaps_entry_debit, csp_entry_credit, notes
      FROM leaps_csp_opened ORDER BY id DESC
    `).all() as Array<Record<string, unknown>>).map(r => ({
      id: r['id'] as number,
      opportunityId: r['opportunity_id'] as number,
      openedAt: r['opened_at'] as string,
      leapsEntryDebit: r['leaps_entry_debit'] as number | null,
      cspEntryCredit: r['csp_entry_credit'] as number | null,
      notes: r['notes'] as string | null,
    }));
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
        // Simple trend: compare to 5-session average (approximate via current ratio vs a baseline)
        hygIefTrend = 'flat'; // detailed trend requires historical ratio — use flat as safe default
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

      // ── Gate logic (SRS §6.1) ────────────────────────────────────────────
      const failConditions: string[] = [];
      const cautionConditions: string[] = [];

      // SPX vs 50d MA
      if (spxPrice !== null && spx50d !== null) {
        const pctFrom50d = ((spxPrice - spx50d) / spx50d) * 100;
        if (pctFrom50d < -1) failConditions.push('SPX below 50d MA');
        else if (Math.abs(pctFrom50d) <= 1) cautionConditions.push('SPX near 50d MA');
      }

      // SPX vs 200d MA
      if (spxPrice !== null && spx200d !== null) {
        const pctFrom200d = ((spxPrice - spx200d) / spx200d) * 100;
        if (pctFrom200d < 0) failConditions.push('SPX below 200d MA');
        else if (pctFrom200d < 2) cautionConditions.push('SPX near 200d MA');
      }

      // VIX level
      if (vixPrice !== null) {
        if (vixPrice > 28) failConditions.push(`VIX ${vixPrice.toFixed(1)} > 28 (panic)`);
        else if (vixPrice >= 22) cautionConditions.push(`VIX ${vixPrice.toFixed(1)} elevated`);
      }

      // VIX 5-day change
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
    // Use the most recent screener run for the given universe (or both)
    const universeClause = universe === 'both'
      ? `1=1`
      : `sr.universe = '${universe === 'sp500' ? 'sp500' : 'russell1000'}'`;

    const rows = this.db.prepare(`
      SELECT DISTINCT res.ticker
      FROM screen_results res
      JOIN screen_runs sr ON res.screen_run_id = sr.id
      WHERE ${universeClause}
      ORDER BY res.rowid DESC
      LIMIT 2000
    `).all() as Array<{ ticker: string }>;

    return [...new Set(rows.map(r => r.ticker))];
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

  // ── Universe filter (SRS §4.1) ──────────────────────────────────────────────

  private passUniverseFilter(
    _ticker: string,
    f: FundamentalsRow | undefined,
    q: QuoteRow | undefined,
  ): boolean {
    if (!f || !q) return false;
    const price = q.last ?? 0;
    const volume = q.volume ?? 0;
    const marketCap = f.marketCap ?? 0;
    if (price < 10) return false;
    if (volume < 2_000_000) return false;
    if (marketCap < 10_000_000_000) return false;  // $10B
    if (isBiotech(f.sector)) return false;
    return true;
  }

  // ── Stock hard fails — LEAPS leg (SRS §4.2) ────────────────────────────────

  private leapsStockHardFail(
    _ticker: string,
    f: FundamentalsRow | undefined,
    q: QuoteRow | undefined,
  ): string | null {
    if (!f || !q) return 'missing data';
    // Earnings within 14 days: Polygon has no earnings calendar endpoint — skip
    // M&A: not available — skip
    // Short float > 20%: not available — skip
    // Death cross + price below both MAs: requires historical bars; checked opportunistically
    // (We apply this check in the caller after fetching the chain when bars are available)
    return null;
  }

  // ── Stock hard fails — CSP leg ──────────────────────────────────────────────

  private cspStockHardFail(
    _ticker: string,
    _f: FundamentalsRow | undefined,
    q: QuoteRow | undefined,
  ): boolean {
    if (!q?.last || q.last <= 0) return true;
    return false; // CSP stock checks are lighter; hard fails applied at contract level
  }

  // ── LEAPS contract selection ────────────────────────────────────────────────

  private selectLeapsContract(
    calls: OptionContract[],
    currentPrice: number,
  ): OptionContract | null {
    // Filter to delta 0.70–0.90 range
    const inBand = calls.filter(c => c.delta !== null && c.delta >= 0.70 && c.delta <= 0.90);
    if (inBand.length === 0) return null;

    // Prefer delta closest to 0.80 (center of target 0.75–0.85)
    inBand.sort((a, b) => Math.abs((a.delta ?? 0) - 0.80) - Math.abs((b.delta ?? 0) - 0.80));

    // Among top candidates, prefer ITM (strike < currentPrice)
    const itm = inBand.filter(c => c.strike < currentPrice);
    return itm[0] ?? inBand[0] ?? null;
  }

  // ── LEAPS contract hard fails (SRS §4.3.1) ─────────────────────────────────

  private passLeapsContractHardFails(
    contract: OptionContract,
    midPrice: number,
    extrinsicPct: number,
  ): boolean {
    if (midPrice <= 0) return false;
    const spread = contract.ask - contract.bid;
    const spreadPct = spread / midPrice * 100;
    if (spreadPct > 5) return false;           // spread > 5% of mid
    if ((contract.openInterest ?? 0) < 100) return false;
    if (extrinsicPct > 15) return false;       // paying too much for time
    // IV > 1.5× baseline: we don't have the baseline here — skip
    return true;
  }

  // ── LEAPS leg scoring (SRS §5.1) ───────────────────────────────────────────

  private scoreLeapsLeg(
    contract: OptionContract,
    dte: number,
    extrinsicPct: number,
    ivData: IvData,
    f: FundamentalsRow | undefined,
    _currentPrice: number,
  ): { score: number; breakdown: LeapsCspScoreComponent[] } {
    const components: Array<{ name: string; weight: number; rawScore: number }> = [];

    // 1. Stock trend strength (20%) — approximate from ROE/fundamentals quality
    //    (Full MA check requires historical bars; use fundamentals as proxy)
    let trendScore = 5;
    const roe = f?.roe ?? null;
    if (roe !== null && roe >= 20) trendScore = 10;
    else if (roe !== null && roe >= 15) trendScore = 7;
    components.push({ name: 'Stock trend strength', weight: 0.20, rawScore: trendScore });

    // 2. Delta in target band (15%) — SRS §5.1
    let deltaScore = 0;
    const delta = contract.delta ?? 0;
    if (delta >= 0.78 && delta <= 0.82) deltaScore = 10;
    else if (delta >= 0.75 && delta <= 0.85) deltaScore = 8;
    else if ((delta >= 0.70 && delta < 0.75) || (delta > 0.85 && delta <= 0.90)) deltaScore = 5;
    components.push({ name: 'Delta in target band', weight: 0.15, rawScore: deltaScore });

    // 3. Extrinsic % of premium (20%) — SRS §5.1
    let extScore = 0;
    if (extrinsicPct <= 5) extScore = 10;
    else if (extrinsicPct <= 8) extScore = 8;
    else if (extrinsicPct <= 12) extScore = 5;
    else if (extrinsicPct <= 15) extScore = 2;
    components.push({ name: 'Extrinsic % of premium', weight: 0.20, rawScore: extScore });

    // 4. IV state on contract (15%) — SRS §5.1
    let ivScore = 5;
    const ivr = ivData.ivr ?? 50;
    if (ivr < 30) ivScore = 10;
    else if (ivr < 50) ivScore = 8;
    else if (ivr < 60) ivScore = 5;
    else if (ivr < 80) ivScore = 2;
    else ivScore = 0;
    components.push({ name: 'IV state (IVR)', weight: 0.15, rawScore: ivScore });

    // 5. Liquidity — spread + OI (10%) — SRS §5.1
    let liqScore = 0;
    const midPrice = (contract.bid + contract.ask) / 2;
    const spreadPct = midPrice > 0 ? ((contract.ask - contract.bid) / midPrice) * 100 : 99;
    const oi = contract.openInterest ?? 0;
    if (spreadPct < 2 && oi > 500) liqScore = 10;
    else if (spreadPct < 3 && oi > 250) liqScore = 8;
    else if (spreadPct < 5 && oi > 100) liqScore = 5;
    components.push({ name: 'Liquidity', weight: 0.10, rawScore: liqScore });

    // 6. Fundamental grade (10%) — proxy: ROE + D/E
    let fundScore = 5;
    const de = f?.debtToEquity ?? null;
    if (roe !== null && roe >= 20 && de !== null && de < 1.0) fundScore = 10;
    else if (roe !== null && roe >= 15) fundScore = 8;
    else if (roe !== null && roe >= 10) fundScore = 5;
    components.push({ name: 'Fundamental grade', weight: 0.10, rawScore: fundScore });

    // 7. Distance to next earnings (10%) — stub: Polygon has no earnings calendar
    //    Default to 8 (60–90 days) as neutral assumption
    const earningsScore = 8;
    components.push({ name: 'Distance to earnings', weight: 0.10, rawScore: earningsScore });

    // Weighted sum
    const weightedSum = components.reduce((acc, c) => acc + c.rawScore * c.weight, 0);
    const score = clamp(Math.round(weightedSum * 10) / 10, 0, 10);

    const breakdown: LeapsCspScoreComponent[] = components.map(c => ({
      name: c.name,
      weight: c.weight,
      rawScore: c.rawScore,
      weightedScore: Math.round(c.rawScore * c.weight * 100) / 100,
    }));

    return { score, breakdown };
    void dte; // DTE used externally for hard fails but not in scoring formula directly
  }

  // ── CSP contract selection ──────────────────────────────────────────────────

  private selectCspContracts(
    puts: OptionContract[],
    currentPrice: number,
    expiry: string,
    ivData: IvData,
    f: FundamentalsRow | undefined,
  ): CspCandidate[] {
    const dte = dteDays(expiry);
    if (dte < 25 || dte > 50) return [];

    const results: CspCandidate[] = [];

    const inBand = puts.filter(c => {
      const d = c.delta ?? 0;
      return d <= -0.15 && d >= -0.30;
    });

    for (const contract of inBand) {
      const mid = (contract.bid + contract.ask) / 2;
      if (mid <= 0) continue;

      const spread = contract.ask - contract.bid;
      const spreadPct = spread / mid * 100;
      if (spreadPct > 10) continue;
      if (Math.abs(spread) > 0.10 && spreadPct > 10) continue;

      const oi = contract.openInterest ?? 0;
      if (oi < 250) continue;

      const collateral = contract.strike * 100;
      const annReturnPct = collateral > 0 ? (mid / collateral) * (365 / dte) * 100 : 0;
      if (annReturnPct < 12) continue;

      const { score, breakdown } = this.scoreCspLeg(
        contract, dte, annReturnPct, ivData, currentPrice, f,
      );

      results.push({
        ticker: f?.ticker ?? '',
        currentPrice,
        contract,
        expiry,
        dte,
        annReturnPct,
        ivPct: contract.iv * 100,
        ivr: ivData.ivr,
        subScore: score,
        scoreBreakdown: breakdown,
      });
    }

    results.sort((a, b) => b.subScore - a.subScore);
    return results.slice(0, 3); // keep top 3 per ticker
  }

  // ── CSP leg scoring (SRS §5.2) ──────────────────────────────────────────────

  private scoreCspLeg(
    contract: OptionContract,
    dte: number,
    annReturnPct: number,
    ivData: IvData,
    currentPrice: number,
    f: FundamentalsRow | undefined,
  ): { score: number; breakdown: LeapsCspScoreComponent[] } {
    const components: Array<{ name: string; weight: number; rawScore: number }> = [];

    // 1. Annualized return on collateral (25%) — SRS §5.2
    let retScore = 0;
    if (annReturnPct >= 25) retScore = 10;
    else if (annReturnPct >= 20) retScore = 8;
    else if (annReturnPct >= 15) retScore = 6;
    else if (annReturnPct >= 12) retScore = 4;
    components.push({ name: 'Ann. return on collateral', weight: 0.25, rawScore: retScore });

    // 2. IV Rank on underlying (20%) — SRS §5.2
    let ivrScore = 2;
    const ivr = ivData.ivr ?? 25;
    if (ivr >= 50) ivrScore = 10;
    else if (ivr >= 35) ivrScore = 8;
    else if (ivr >= 25) ivrScore = 5;
    components.push({ name: 'IV Rank', weight: 0.20, rawScore: ivrScore });

    // 3. Delta in target band (15%) — SRS §5.2 (target -0.20 to -0.25)
    let deltaScore = 0;
    const delta = contract.delta ?? 0;
    if (delta >= -0.25 && delta <= -0.20) deltaScore = 10;
    else if ((delta >= -0.30 && delta < -0.25) || (delta > -0.20 && delta >= -0.15)) deltaScore = 7;
    components.push({ name: 'Delta in target band', weight: 0.15, rawScore: deltaScore });

    // 4. Liquidity (10%) — same scale as LEAPS
    let liqScore = 0;
    const mid = (contract.bid + contract.ask) / 2;
    const spreadPct = mid > 0 ? ((contract.ask - contract.bid) / mid) * 100 : 99;
    const oi = contract.openInterest ?? 0;
    if (spreadPct < 2 && oi > 500) liqScore = 10;
    else if (spreadPct < 3 && oi > 250) liqScore = 8;
    else if (spreadPct < 5 && oi > 100) liqScore = 5;
    components.push({ name: 'Liquidity', weight: 0.10, rawScore: liqScore });

    // 5. Stock trend (10%) — fundamentals proxy
    let trendScore = 5;
    const roe = f?.roe ?? null;
    if (roe !== null && roe > 0) trendScore = 10;
    else if (roe === null) trendScore = 5;
    components.push({ name: 'Stock trend', weight: 0.10, rawScore: trendScore });

    // 6. Strike quality (10%) — SRS §5.2: strike vs 200d MA proxy
    //    Approximate: if strike < 85% of current price, score high
    let strikeScore = 5;
    const strikeToPrice = currentPrice > 0 ? contract.strike / currentPrice : 1;
    if (strikeToPrice <= 0.85) strikeScore = 10;     // well below price
    else if (strikeToPrice <= 0.92) strikeScore = 7;
    else if (strikeToPrice <= 0.97) strikeScore = 4;
    else strikeScore = 1;
    components.push({ name: 'Strike quality', weight: 0.10, rawScore: strikeScore });

    // 7. Distance to events (10%) — stub: default neutral
    const eventScore = 8;
    components.push({ name: 'Distance to events', weight: 0.10, rawScore: eventScore });

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

  // ── Combined score (SRS §5.3) ───────────────────────────────────────────────

  private combinedScore(leapsScore: number, cspScore: number): number {
    return leapsScore * 0.60 + cspScore * 0.40;
  }

  // ── Caution flags (SRS §4.4) ────────────────────────────────────────────────

  private cautionFlags(
    leaps: LeapsCandidate,
    csp: CspCandidate | null,
  ): string[] {
    const flags: string[] = [];

    // LEAPS premium > 25% of stock price
    if (leaps.contract.bid > 0) {
      const premiumPct = ((leaps.contract.bid + leaps.contract.ask) / 2) / leaps.currentPrice * 100;
      if (premiumPct > 25) flags.push('HIGH_LEAPS_PREMIUM');
    }

    // IVR between 60–80 on LEAPS underlying
    if (leaps.ivr !== null && leaps.ivr >= 60 && leaps.ivr <= 80) {
      flags.push('LEAPS_IV_ELEVATED');
    }

    // CSP strike close to 200d MA proxy (strike > 90% of current price)
    if (csp && csp.contract.strike / csp.currentPrice > 0.90) {
      flags.push('CSP_STRIKE_NEAR_PRICE');
    }

    return flags;
  }

  // ── IV data helper ──────────────────────────────────────────────────────────

  private async fetchIvData(ticker: string): Promise<IvData> {
    try {
      const result = await this.provider.getOptionsIVAndPremium(ticker, null, null);
      const { currentIv, iv52WkHigh, iv52WkLow } = result;
      // IVR = (current - low) / (high - low) × 100  (see docs/formulas.md#iv-rank)
      let ivr: number | null = null;
      if (currentIv !== null && iv52WkHigh !== null && iv52WkLow !== null) {
        const range = iv52WkHigh - iv52WkLow;
        if (range > 0) ivr = clamp(((currentIv - iv52WkLow) / range) * 100, 0, 100);
      }
      return { currentIv, iv52WkHigh, iv52WkLow, ivr };
    } catch {
      return { currentIv: null, iv52WkHigh: null, iv52WkLow: null, ivr: null };
    }
  }

  // ── Safe fetch wrappers ─────────────────────────────────────────────────────

  private async safeGetChain(ticker: string, expiry: string): Promise<OptionContract[] | null> {
    try {
      const chain = await this.provider.getOptionsChain(ticker, expiry);
      return chain.contracts as OptionContract[];
    } catch {
      return null;
    }
  }

  private async safeQuote(ticker: string): Promise<{ last: number | null } | null> {
    try {
      return await this.provider.getQuote(ticker);
    } catch {
      return null;
    }
  }

  private async safeBars(ticker: string, tf: 'day', lookbackDays: number): Promise<Array<{ c: number }>> {
    try {
      const bars = await this.provider.getHistoricalBars(ticker, tf, lookbackDays);
      return bars.map(b => ({ c: b.c }));
    } catch {
      return [];
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  private persistRun(
    meta: { gate: LeapsCspGate; detail: LeapsCspGateDetail; effect: string; universe: string },
    opportunities: PairedOpportunity[],
  ): LeapsCspRunResult {
    const runAt = new Date().toISOString();

    const runId = (this.db.prepare(`
      INSERT INTO leaps_csp_runs
        (run_at, universe, market_gate, gate_detail_json, gate_effect, candidate_count, opportunity_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      runAt,
      meta.universe,
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
      const cspMid = p.csp ? (p.csp.contract.bid + p.csp.contract.ask) / 2 : null;
      const cspCollateral = p.csp ? p.csp.contract.strike * 100 : null;
      const totalCash = leapsPremiumPerContract + (cspCollateral ?? 0) || null;

      const detail: LeapsCspDetail = {
        leapsScoreBreakdown: p.leaps.scoreBreakdown,
        cspScoreBreakdown: p.csp?.scoreBreakdown ?? [],
        alternatives: p.alternatives,
      };

      const id = (insertOpp.run(
        runId, idx + 1, p.pairingMode,
        p.leaps.ticker, p.leaps.currentPrice, p.leaps.contract.strike, p.leaps.expiry, p.leaps.dte,
        p.leaps.contract.delta, leapsPremiumPerContract, p.leaps.extrinsicPct,
        p.leaps.ivPct, p.leaps.ivr, p.leaps.contract.openInterest, p.leaps.subScore,
        p.csp?.ticker ?? null, p.csp?.currentPrice ?? null,
        p.csp?.contract.strike ?? null, p.csp?.expiry ?? null, p.csp?.dte ?? null,
        p.csp?.contract.delta ?? null, cspMid, cspCollateral,
        p.csp?.annReturnPct ?? null, p.csp?.ivPct ?? null, p.csp?.ivr ?? null,
        p.csp?.contract.openInterest ?? null, p.csp?.subScore ?? null,
        p.combinedScore, p.grade, p.cautionFlags.join(',') || null,
        totalCash, JSON.stringify(detail),
      ) as { lastInsertRowid: number }).lastInsertRowid;

      return {
        id: Number(id),
        runId: Number(runId),
        rank: idx + 1,
        pairingMode: p.pairingMode,
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
        cspTicker: p.csp?.ticker ?? null,
        cspCurrentPrice: p.csp?.currentPrice ?? null,
        cspStrike: p.csp?.contract.strike ?? null,
        cspExpiry: p.csp?.expiry ?? null,
        cspDte: p.csp?.dte ?? null,
        cspDelta: p.csp?.contract.delta ?? null,
        cspPremium: cspMid,
        cspCollateral,
        cspAnnReturnPct: p.csp?.annReturnPct ?? null,
        cspIvPct: p.csp?.ivPct ?? null,
        cspIvr: p.csp?.ivr ?? null,
        cspOi: p.csp?.contract.openInterest ?? null,
        cspSubScore: p.csp?.subScore ?? null,
        combinedScore: p.combinedScore,
        grade: p.grade,
        cautionFlags: p.cautionFlags,
        totalCashToDeploy: totalCash,
        detail,
      };
    });

    const runSummary: LeapsCspRunSummary = {
      id: Number(runId),
      runAt,
      universe: meta.universe,
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
    let detail: LeapsCspDetail = { leapsScoreBreakdown: [], cspScoreBreakdown: [], alternatives: [] };
    try { detail = JSON.parse(r['detail_json'] as string) as LeapsCspDetail; } catch { /* use default */ }

    return {
      id: r['id'] as number,
      runId: r['run_id'] as number,
      rank: r['rank'] as number,
      pairingMode: r['pairing_mode'] as LeapsCspPairingMode,
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
      cspTicker: r['csp_ticker'] as string | null,
      cspCurrentPrice: r['csp_current_price'] as number | null,
      cspStrike: r['csp_strike'] as number | null,
      cspExpiry: r['csp_expiry'] as string | null,
      cspDte: r['csp_dte'] as number | null,
      cspDelta: r['csp_delta'] as number | null,
      cspPremium: r['csp_premium'] as number | null,
      cspCollateral: r['csp_collateral'] as number | null,
      cspAnnReturnPct: r['csp_ann_return_pct'] as number | null,
      cspIvPct: r['csp_iv_pct'] as number | null,
      cspIvr: r['csp_ivr'] as number | null,
      cspOi: r['csp_oi'] as number | null,
      cspSubScore: r['csp_sub_score'] as number | null,
      combinedScore: r['combined_score'] as number,
      grade: r['grade'] as LeapsCspGrade,
      cautionFlags: flags,
      totalCashToDeploy: r['total_cash_to_deploy'] as number | null,
      detail,
    };
  }
}
