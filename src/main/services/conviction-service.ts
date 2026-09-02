// Conviction List service — CRUD for personal price conviction bands.
// Single permanent list per user (not multi-list like watchlists).
// Band history written automatically on every edit for audit trail.
// Recommendation engine derives suggested bands from existing analysis data.
// v0.24.0

import Anthropic from '@anthropic-ai/sdk';
import type { DbHandle } from '../db/connection.js';
import { withTransaction } from '../db/connection.js';
import { secureGet } from './secure-settings.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConvictionStock {
  ticker: string;
  priceLow: number | null;
  priceMid: number | null;
  priceHigh: number | null;
  note: string | null;
  inPlay: boolean;            // on/off "pay attention / may act on this" flag
  addedAt: string;
  updatedAt: string;
  // Live overlays (joined at read time)
  currentPrice: number | null;
  iv: number | null;          // latest atm_iv as percentage
  ivRank: number | null;      // 0–100
  zone: ConvictionZone;
}

export type ConvictionZone = 'buy' | 'mid' | 'watch' | 'high' | 'unset';

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

// ─── Zone computation ─────────────────────────────────────────────────────────

function computeZone(
  currentPrice: number | null,
  priceLow: number | null,
  priceMid: number | null,
  priceHigh: number | null,
): ConvictionZone {
  if (!currentPrice || (!priceLow && !priceMid && !priceHigh)) return 'unset';
  if (priceHigh !== null && currentPrice >= priceHigh) return 'high';
  if (priceLow !== null && currentPrice <= priceLow) return 'buy';
  if (priceMid !== null && priceLow !== null && currentPrice <= priceMid) return 'mid';
  if (priceMid !== null && currentPrice <= priceMid) return 'mid';
  return 'watch';
}

// ─── Band ordering invariant ────────────────────────────────────────
// Bands must be strictly increasing: low < mid < high. Any band may be null
// (a partial band is legitimate) — nulls are skipped, present pairs are compared.
//
// This is enforced HERE, not only in the edit modal, because the modal is not the
// only writer: the AI review "Apply" path merges LLM-recommended values field-by-field
// into whatever is already stored, so a recommended low can land above an untouched
// mid. That produced inverted bands that sat unnoticed for three weeks, silently
// feeding wrong buy-zone alerts and the daily-brief conviction callout.

export function validateBandOrder(
  ticker: string,
  priceLow: number | null | undefined,
  priceMid: number | null | undefined,
  priceHigh: number | null | undefined,
): void {
  const low = priceLow ?? null;
  const mid = priceMid ?? null;
  const high = priceHigh ?? null;
  const at = (v: number): string => `$${v}`;

  if (low !== null && mid !== null && low >= mid) {
    throw new Error(`${ticker}: Low entry (${at(low)}) must be less than Mid price (${at(mid)})`);
  }
  if (mid !== null && high !== null && mid >= high) {
    throw new Error(`${ticker}: Mid price (${at(mid)}) must be less than High / Never Enter (${at(high)})`);
  }
  if (low !== null && high !== null && low >= high) {
    throw new Error(`${ticker}: Low entry (${at(low)}) must be less than High / Never Enter (${at(high)})`);
  }
}

// ─── IV Rank computation ──────────────────────────────────────────────────────

function computeIvRank(ivRows: number[]): number | null {
  if (ivRows.length < 21) return null;
  const current = ivRows[0]!;
  const min = Math.min(...ivRows);
  const max = Math.max(...ivRows);
  if (max === min) return 50;
  return Math.max(0, Math.min(100, ((current - min) / (max - min)) * 100));
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ConvictionService {
  constructor(private readonly db: DbHandle) {}

  // ── List ──────────────────────────────────────────────────────────────────

  list(): ConvictionStock[] {
    type Row = {
      ticker: string; price_low: number | null; price_mid: number | null;
      price_high: number | null; note: string | null; in_play: number;
      added_at: string; updated_at: string;
    };
    const rows = this.db.prepare(
      `SELECT ticker, price_low, price_mid, price_high, note, in_play, added_at, updated_at
       FROM conviction_stocks ORDER BY ticker ASC`
    ).all() as Row[];

    if (rows.length === 0) return [];

    // Batch-fetch live overlays
    const tickers = rows.map(r => r.ticker);
    const ph = tickers.map(() => '?').join(',');

    type QuoteRow = { ticker: string; last: number };
    const quotes = new Map<string, number>(
      (this.db.prepare(
        `SELECT ticker, last FROM quote_cache WHERE ticker IN (${ph}) AND last > 0`
      ).all(...tickers) as QuoteRow[]).map(r => [r.ticker, r.last])
    );

    type IvRow = { ticker: string; atm_iv: number; rn: number };
    const ivRows = this.db.prepare(`
      SELECT ticker, atm_iv,
             ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
      FROM iv_history WHERE ticker IN (${ph})
    `).all(...tickers) as IvRow[];

    const ivByTicker = new Map<string, number[]>();
    for (const r of ivRows) {
      if (r.rn > 252) continue;
      if (!ivByTicker.has(r.ticker)) ivByTicker.set(r.ticker, []);
      ivByTicker.get(r.ticker)!.push(r.atm_iv);
    }

    return rows.map(r => {
      const currentPrice = quotes.get(r.ticker) ?? null;
      const ivs = ivByTicker.get(r.ticker) ?? [];
      const latestIv = ivs.length > 0 ? ivs[0]! : null; // already stored as percentage
      const ivRank = computeIvRank(ivs);
      return {
        ticker: r.ticker,
        priceLow: r.price_low,
        priceMid: r.price_mid,
        priceHigh: r.price_high,
        note: r.note,
        inPlay: r.in_play === 1,
        addedAt: r.added_at,
        updatedAt: r.updated_at,
        currentPrice,
        iv: latestIv,
        ivRank,
        zone: computeZone(currentPrice, r.price_low, r.price_mid, r.price_high),
      };
    });
  }

  // ── In-play flag ────────────────────────────────────────────────────────────
  // Transient on/off marker ("pay attention / may act on this"). Not a band change,
  // so no band-history snapshot is written.
  setInPlay(ticker: string, inPlay: boolean): ConvictionStock {
    const t = ticker.trim().toUpperCase();
    this.db.prepare(`UPDATE conviction_stocks SET in_play = ? WHERE ticker = ?`)
      .run(inPlay ? 1 : 0, t);
    return this.get(t);
  }

  // ── Add ───────────────────────────────────────────────────────────────────

  add(input: ConvictionInput): ConvictionStock {
    const ticker = input.ticker.trim().toUpperCase();
    validateBandOrder(ticker, input.priceLow, input.priceMid, input.priceHigh);
    this.db.prepare(`
      INSERT INTO conviction_stocks (ticker, price_low, price_mid, price_high, note)
      VALUES (?, ?, ?, ?, ?)
    `).run(ticker, input.priceLow ?? null, input.priceMid ?? null,
           input.priceHigh ?? null, input.note ?? null);
    return this.get(ticker);
  }

  // ── Update ────────────────────────────────────────────────────────────────

  update(ticker: string, input: Omit<ConvictionInput, 'ticker'>): ConvictionStock {
    const t = ticker.trim().toUpperCase();
    validateBandOrder(t, input.priceLow, input.priceMid, input.priceHigh);
    const existing = this.get(t);

    withTransaction(this.db, () => {
      // Write history snapshot of the CURRENT values before overwriting
      this.db.prepare(`
        INSERT INTO conviction_band_history (ticker, price_low, price_mid, price_high, note)
        VALUES (?, ?, ?, ?, ?)
      `).run(t, existing.priceLow, existing.priceMid, existing.priceHigh, existing.note);

      this.db.prepare(`
        UPDATE conviction_stocks
        SET price_low = ?, price_mid = ?, price_high = ?, note = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE ticker = ?
      `).run(
        input.priceLow ?? null, input.priceMid ?? null,
        input.priceHigh ?? null, input.note ?? null, t
      );
    });

    return this.get(t);
  }

  // ── Remove ────────────────────────────────────────────────────────────────

  remove(ticker: string): void {
    this.db.prepare(`DELETE FROM conviction_stocks WHERE ticker = ?`)
      .run(ticker.trim().toUpperCase());
  }

  // ── Band History ──────────────────────────────────────────────────────────

  getHistory(ticker: string): ConvictionBandHistory[] {
    type Row = {
      id: number; ticker: string;
      price_low: number | null; price_mid: number | null; price_high: number | null;
      note: string | null; changed_at: string;
    };
    return (this.db.prepare(`
      SELECT id, ticker, price_low, price_mid, price_high, note, changed_at
      FROM conviction_band_history WHERE ticker = ?
      ORDER BY changed_at DESC
    `).all(ticker.trim().toUpperCase()) as Row[]).map(r => ({
      id: r.id,
      ticker: r.ticker,
      priceLow: r.price_low,
      priceMid: r.price_mid,
      priceHigh: r.price_high,
      note: r.note,
      changedAt: r.changed_at,
    }));
  }

  // ── Recommendation ────────────────────────────────────────────────────────
  // Derives suggested price bands from existing analysis data.
  // No extra API calls — reads analysis_snapshots, quote_cache, iv_history.

  recommend(ticker: string): ConvictionRecommendation {
    const t = ticker.trim().toUpperCase();
    const noData: ConvictionRecommendation = {
      priceLow: null, priceMid: null, priceHigh: null,
      priceLowBasis: 'No analysis data — run analysis on this ticker first',
      priceMidBasis: '—',
      priceHighBasis: '—',
      hasData: false,
    };

    // 1. Current price from quote_cache
    type QuoteRow = { last: number };
    const quoteRow = this.db.prepare(
      `SELECT last FROM quote_cache WHERE ticker = ? AND last > 0`
    ).get(t) as QuoteRow | undefined;
    const currentPrice = quoteRow?.last ?? null;
    if (!currentPrice) return noData;

    // 2. Latest analysis snapshot (prefer 'buy' mode, accept 'all')
    type SnapRow = { mode: string; payload_json: string; run_at: string };
    const snaps = this.db.prepare(`
      SELECT mode, payload_json, run_at FROM analysis_snapshots
      WHERE mode IN ('buy','all')
      ORDER BY id DESC LIMIT 10
    `).all() as SnapRow[];

    let entryZoneLow: number | null = null;
    let sma50: number | null = null;
    let sma200: number | null = null;
    let snapshotAge = '';

    for (const snap of snaps) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = JSON.parse(snap.payload_json) as any;
        const results = p.results ?? p;
        const buyResults: unknown[] = results.buy ?? [];
        const match = buyResults.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (r: any) => (r.ticker as string)?.toUpperCase() === t
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any;
        if (match) {
          entryZoneLow = typeof match.entryZoneLow === 'number' ? match.entryZoneLow : null;
          sma50  = match.smaStack?.sma50  ?? null;
          sma200 = match.smaStack?.sma200 ?? null;
          const ageH = Math.round((Date.now() - new Date(snap.run_at).getTime()) / 3_600_000);
          snapshotAge = ageH < 24 ? `${ageH}h ago` : `${Math.round(ageH / 24)}d ago`;
          break;
        }
      } catch { /* skip malformed */ }
    }

    // 3. IV Rank from iv_history
    type IvRow = { atm_iv: number };
    const ivRows = this.db.prepare(`
      SELECT atm_iv FROM iv_history WHERE ticker = ?
      ORDER BY date DESC LIMIT 252
    `).all(t) as IvRow[];
    const ivs = ivRows.map(r => r.atm_iv); // already stored as percentage
    const ivRank = computeIvRank(ivs);

    // ── Compute Low ──────────────────────────────────────────────────────────
    let priceLow: number | null = null;
    let priceLowBasis = '';

    if (entryZoneLow !== null && entryZoneLow > 0) {
      priceLow = round(entryZoneLow, 0.5);
      priceLowBasis = `Buy analysis entry zone${snapshotAge ? ` (${snapshotAge})` : ''}`;
    } else if (sma200 !== null && sma200 > 0 && sma200 < currentPrice) {
      priceLow = round(sma200, 0.5);
      priceLowBasis = 'SMA 200 (long-term support)';
    } else {
      priceLow = round(currentPrice * 0.85, 0.5);
      priceLowBasis = 'Current price −15% (no analysis data)';
    }

    // ── Compute Mid ──────────────────────────────────────────────────────────
    let priceMid: number | null = null;
    let priceMidBasis = '';

    if (sma50 !== null && sma50 > priceLow && sma50 < currentPrice) {
      priceMid = round(sma50, 0.5);
      priceMidBasis = 'SMA 50 (mid-term reference)';
    } else {
      priceMid = round((priceLow + currentPrice) / 2, 0.5);
      priceMidBasis = 'Midpoint between low entry and current price';
    }
    // Ensure mid > low
    if (priceMid <= priceLow) {
      priceMid = round(priceLow * 1.05, 0.5);
      priceMidBasis = 'Low entry +5%';
    }

    // ── Compute High ─────────────────────────────────────────────────────────
    const ivRankVal = ivRank ?? 50;
    const premiumPct = ivRankVal < 30 ? 0.20 : ivRankVal < 60 ? 0.25 : 0.30;
    let priceHigh = round(currentPrice * (1 + premiumPct), 1.0);
    let priceHighBasis =
      `Current $${currentPrice.toFixed(2)} +${Math.round(premiumPct * 100)}%` +
      (ivRank !== null ? ` (IVR ${Math.round(ivRank)})` : ' (no IV data)');

    // Ensure high > mid. A low anchored above the current price (an entry zone
    // from a stale snapshot) can push mid past the current-price-derived high,
    // and the whole set would then be rejected by validateBandOrder on Apply.
    if (priceHigh <= priceMid) {
      priceHigh = Math.ceil(priceMid * 1.10); // ceil, not round — must land strictly above mid
      priceHighBasis = 'Mid +10% (current price below mid reference)';
    }

    return {
      priceLow,
      priceMid,
      priceHigh,
      priceLowBasis,
      priceMidBasis,
      priceHighBasis,
      hasData: true,
    };
  }

  // ── AI Advisor ────────────────────────────────────────────────────────────
  // Gathers technical, fundamental, and IV context for all conviction stocks,
  // sends a single structured prompt to Claude, and returns per-stock
  // action signals + recommended price zones.

  async aiReview(): Promise<ConvictionAiReview[]> {
    const apiKey = secureGet(this.db, 'anthropicApiKey');
    if (!apiKey) throw new Error('Anthropic API key not configured — add it in Settings → AI.');

    const stocks = this.list();
    if (stocks.length === 0) return [];

    const tickers = stocks.map(s => s.ticker);
    const ph = tickers.map(() => '?').join(',');

    // Technical signals
    type TechRow = { ticker: string; trend_label: string | null; rsi: number | null; sma50: number | null; sma200: number | null };
    const techMap = new Map<string, TechRow>(
      (this.db.prepare(
        `SELECT ticker, trend_label, rsi, sma50, sma200 FROM technical_signals WHERE ticker IN (${ph})`
      ).all(...tickers) as TechRow[]).map(r => [r.ticker, r])
    );

    // Fundamentals — extract key fields from JSON payload
    type FundRow = { ticker: string; payload_json: string };
    const fundMap = new Map<string, { pe: number | null; epsGrowth: number | null; grade: number | null }>();
    (this.db.prepare(
      `SELECT ticker, payload_json FROM fundamentals_cache WHERE ticker IN (${ph})`
    ).all(...tickers) as FundRow[]).forEach(r => {
      try {
        const p = JSON.parse(r.payload_json) as { peRatio?: number | null; epsGrowth?: number | null; stockGrade?: number | null };
        fundMap.set(r.ticker, { pe: p.peRatio ?? null, epsGrowth: p.epsGrowth ?? null, grade: p.stockGrade ?? null });
      } catch { /* skip malformed */ }
    });

    // Upcoming earnings (within 45 days)
    type EarRow = { ticker: string; report_date: string };
    const earningsMap = new Map<string, number>(); // ticker → days away
    const todayMs = Date.now();
    (this.db.prepare(
      `SELECT ticker, report_date FROM earnings_calendar WHERE ticker IN (${ph})`
    ).all(...tickers) as EarRow[]).forEach(r => {
      const days = Math.round((new Date(r.report_date).getTime() - todayMs) / 86_400_000);
      if (days >= 0 && days <= 45) earningsMap.set(r.ticker, days);
    });

    // Build compact per-ticker context lines
    const stockLines = stocks.map(s => {
      const tech = techMap.get(s.ticker);
      const fund = fundMap.get(s.ticker);
      const earnDays = earningsMap.get(s.ticker);
      const bands = `low=${s.priceLow != null ? `$${s.priceLow}` : '?'} mid=${s.priceMid != null ? `$${s.priceMid}` : '?'} high=${s.priceHigh != null ? `$${s.priceHigh}` : '?'}`;
      const techPart = tech
        ? `trend=${tech.trend_label ?? 'unknown'} RSI=${tech.rsi?.toFixed(0) ?? '?'} SMA50=${tech.sma50?.toFixed(0) ?? '?'} SMA200=${tech.sma200?.toFixed(0) ?? '?'}`
        : 'no-tech';
      const fundPart = fund
        ? `PE=${fund.pe?.toFixed(1) ?? '?'} EPS_g=${fund.epsGrowth?.toFixed(1) ?? '?'}% grade=${fund.grade != null ? `${fund.grade}★` : '?'}`
        : 'no-fund';
      const ivPart = `IV=${s.iv?.toFixed(1) ?? '?'}% IVR=${s.ivRank != null ? Math.round(s.ivRank) : '?'}`;
      const earnPart = earnDays !== undefined ? ` earnings_in=${earnDays}d` : '';
      return `${s.ticker}: price=$${s.currentPrice?.toFixed(2) ?? '?'} zone=${s.zone} ${bands} | ${techPart} | ${fundPart} | ${ivPart}${earnPart}`;
    });

    const today = new Date().toISOString().slice(0, 10);
    const prompt = `You are a disciplined retail swing/options trader reviewing your personal conviction watchlist.
Assess each stock and recommend whether to act now, wait, reduce exposure, or remove it.

Today: ${today}

PRICE BAND DEFINITIONS:
  Low  (green): ideal entry — buy aggressively here
  Mid  (yellow): acceptable entry — still worth adding
  High (red): never buy above this price; potential exit/covered-call target

STOCKS (one per line):
${stockLines.join('\n')}

Return ONLY a valid JSON array (no markdown, no commentary) — one object per ticker:
{
  "ticker": "...",
  "action": "add"|"hold"|"reduce"|"remove",
  "zoneVerdict": "keep"|"adjust",
  "recommendedLow": number|null,
  "recommendedMid": number|null,
  "recommendedHigh": number|null,
  "riskFlag": string|null,
  "rationale": string
}

ACTION:
  add    = in buy/mid zone AND tech+fundamentals support entry NOW
  hold   = thesis intact, wait for better entry
  reduce = thesis weakening (trend reversal, stretched valuation, or analyst deterioration)
  remove = thesis broken — confirmed downtrend + poor fundamentals

ZONE ADJUST:
  keep   = current bands still appropriate
  adjust = recalibrate bands; anchor Low near SMA200 or key support, Mid near SMA50 or midpoint, High = 15-25% above current price

RISKFLAG: null if none, else max 60 chars (e.g. "Earnings in 4 days", "Trend reversed bearish", "52-wk high reached")
RATIONALE: 1 direct sentence, max 100 chars, no hedging.`;

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '[]';
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');

    type RawReview = {
      ticker: string; action: string; zoneVerdict: string;
      recommendedLow: number | null; recommendedMid: number | null; recommendedHigh: number | null;
      riskFlag: string | null; rationale: string;
    };
    const parsed = JSON.parse(jsonStr) as RawReview[];
    const stockMap = new Map(stocks.map(s => [s.ticker, s]));

    return parsed.map(r => {
      const s = stockMap.get(r.ticker);
      const validActions = ['add', 'hold', 'reduce', 'remove'] as const;
      const action = validActions.includes(r.action as ConvictionAiReview['action'])
        ? (r.action as ConvictionAiReview['action'])
        : 'hold';
      return {
        ticker: r.ticker,
        currentZone: s?.zone ?? 'unset',
        currentPrice: s?.currentPrice ?? null,
        currentLow: s?.priceLow ?? null,
        currentMid: s?.priceMid ?? null,
        currentHigh: s?.priceHigh ?? null,
        action,
        zoneVerdict: r.zoneVerdict === 'adjust' ? 'adjust' : 'keep',
        recommendedLow: r.recommendedLow,
        recommendedMid: r.recommendedMid,
        recommendedHigh: r.recommendedHigh,
        riskFlag: r.riskFlag,
        rationale: r.rationale,
      } satisfies ConvictionAiReview;
    });
  }

  // ── Sync from default watchlist ───────────────────────────────────────────

  syncFromDefaultWatchlist(): { added: string[]; skipped: string[] } {
    type WlRow = { ticker: string };
    // Find the default watchlist
    const defaultWl = this.db.prepare(
      `SELECT id FROM watchlists WHERE is_default = 1 LIMIT 1`
    ).get() as { id: number } | undefined;
    if (!defaultWl) return { added: [], skipped: [] };

    const items = this.db.prepare(
      `SELECT ticker FROM watchlist_items WHERE watchlist_id = ?`
    ).all(defaultWl.id) as WlRow[];

    const existing = new Set<string>(
      (this.db.prepare(`SELECT ticker FROM conviction_stocks`).all() as WlRow[])
        .map(r => r.ticker.toUpperCase())
    );

    const added: string[] = [];
    const skipped: string[] = [];

    withTransaction(this.db, () => {
      for (const item of items) {
        const t = item.ticker.toUpperCase();
        if (existing.has(t)) {
          skipped.push(t);
        } else {
          this.db.prepare(
            `INSERT OR IGNORE INTO conviction_stocks (ticker) VALUES (?)`
          ).run(t);
          added.push(t);
        }
      }
    });

    return { added, skipped };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private get(ticker: string): ConvictionStock {
    type Row = {
      ticker: string; price_low: number | null; price_mid: number | null;
      price_high: number | null; note: string | null; in_play: number;
      added_at: string; updated_at: string;
    };
    const row = this.db.prepare(
      `SELECT ticker, price_low, price_mid, price_high, note, in_play, added_at, updated_at
       FROM conviction_stocks WHERE ticker = ?`
    ).get(ticker) as Row | undefined;
    if (!row) throw new Error(`Conviction stock not found: ${ticker}`);

    type QuoteRow = { last: number };
    const q = this.db.prepare(
      `SELECT last FROM quote_cache WHERE ticker = ? AND last > 0`
    ).get(ticker) as QuoteRow | undefined;
    const currentPrice = q?.last ?? null;

    type IvRow = { atm_iv: number };
    const ivRows = (this.db.prepare(
      `SELECT atm_iv FROM iv_history WHERE ticker = ? ORDER BY date DESC LIMIT 252`
    ).all(ticker) as IvRow[]).map(r => r.atm_iv); // already stored as percentage

    return {
      ticker: row.ticker,
      priceLow: row.price_low,
      priceMid: row.price_mid,
      priceHigh: row.price_high,
      note: row.note,
      inPlay: row.in_play === 1,
      addedAt: row.added_at,
      updatedAt: row.updated_at,
      currentPrice,
      iv: ivRows.length > 0 ? ivRows[0]! : null,
      ivRank: computeIvRank(ivRows),
      zone: computeZone(currentPrice, row.price_low, row.price_mid, row.price_high),
    };
  }

  // ── Email report ────────────────────────────────────────────────────────────
  // Builds the My Stocks list as an HTML table for email. Includes the in-play flag;
  // omits the Actions column (UI-only, carries no information). In-play stocks sort
  // first, then by zone (buy → mid → watch → unset → high), then ticker.
  buildEmailReport(): { subject: string; html: string } {
    const stocks = this.list();
    const zoneRank: Record<ConvictionZone, number> = { buy: 0, mid: 1, watch: 2, unset: 3, high: 4 };
    const zoneLabel: Record<ConvictionZone, string> = {
      buy: 'Buy Zone', mid: 'Mid Zone', watch: 'Watch', high: 'Too High', unset: 'No Bands',
    };
    const sorted = [...stocks].sort((a, b) =>
      (Number(b.inPlay) - Number(a.inPlay)) ||
      (zoneRank[a.zone] - zoneRank[b.zone]) ||
      a.ticker.localeCompare(b.ticker)
    );

    const dollar = (v: number | null) => v === null ? '—' : `$${v.toFixed(2)}`;
    const pct = (v: number | null) => v === null ? '—' : `${v.toFixed(1)}%`;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const inPlayCount = stocks.filter(s => s.inPlay).length;

    // Column definitions — alignment is shared by header and data cells so they line up.
    type Align = 'left' | 'right' | 'center';
    const cols: { label: string; align: Align }[] = [
      { label: '🚩',          align: 'center' },
      { label: 'Ticker',      align: 'left' },
      { label: 'Zone',        align: 'left' },
      { label: 'Current',     align: 'right' },
      { label: 'Low',         align: 'right' },
      { label: 'Mid',         align: 'right' },
      { label: 'Never Above', align: 'right' },
      { label: 'IV',          align: 'right' },
      { label: 'IVR',         align: 'right' },
      { label: 'Note',        align: 'left' },
    ];
    const th = cols.map(c =>
      `<th style="text-align:${c.align};padding:6px 10px;border-bottom:2px solid #ccc;font-size:12px;color:#333;white-space:nowrap">${c.label}</th>`
    ).join('');

    const rows = sorted.map(s => {
      const zoneColor = s.zone === 'buy' ? '#1a7a3a' : s.zone === 'mid' ? '#9a7d0a' : s.zone === 'high' ? '#b3261e' : '#555';
      const bg = s.inPlay ? 'background:#fff8e1;' : '';
      const td = (v: string, align: Align, extra = '') =>
        `<td style="text-align:${align};padding:6px 10px;border-bottom:1px solid #eee;${extra}">${v}</td>`;
      return `<tr style="${bg}">
        ${td(s.inPlay ? '🚩' : '', 'center', 'font-size:14px')}
        ${td(`<strong>${esc(s.ticker)}</strong>`, 'left')}
        ${td(zoneLabel[s.zone], 'left', `color:${zoneColor};font-weight:600;white-space:nowrap`)}
        ${td(dollar(s.currentPrice), 'right', 'font-weight:600')}
        ${td(dollar(s.priceLow), 'right', 'color:#1a7a3a')}
        ${td(dollar(s.priceMid), 'right', 'color:#9a7d0a')}
        ${td(dollar(s.priceHigh), 'right', 'color:#b3261e')}
        ${td(pct(s.iv), 'right', 'color:#555')}
        ${td(s.ivRank !== null ? String(Math.round(s.ivRank)) : '—', 'right', 'color:#555')}
        ${td(s.note ? esc(s.note) : '—', 'left', 'color:#555;max-width:280px')}
      </tr>`;
    }).join('');

    const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#222">
      <h2 style="margin:0 0 4px">⭐ My Stocks — Conviction List</h2>
      <div style="color:#666;font-size:13px;margin-bottom:14px">${today} · ${stocks.length} stock${stocks.length !== 1 ? 's' : ''}${inPlayCount > 0 ? ` · 🚩 ${inPlayCount} in play` : ''}</div>
      <table style="border-collapse:collapse;font-size:13px;width:100%"><thead><tr>${th}</tr></thead><tbody>${rows || `<tr><td colspan="${cols.length}" style="padding:16px;color:#888">No stocks in your list.</td></tr>`}</tbody></table>
      <div style="color:#999;font-size:11px;margin-top:14px">🚩 = in play (flagged for attention). Zones: Buy ≤ Low, Mid ≤ Mid, Too High ≥ Never-Above.</div>
    </div>`;

    return { subject: `⭐ My Stocks${inPlayCount > 0 ? ` — ${inPlayCount} in play` : ''} (${today})`, html };
  }
}

// Round to nearest step (e.g. 0.5 or 1.0)
function round(val: number, step: number): number {
  return Math.round(val / step) * step;
}
