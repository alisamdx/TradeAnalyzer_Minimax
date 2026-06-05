// Conviction List service — CRUD for personal price conviction bands.
// Single permanent list per user (not multi-list like watchlists).
// Band history written automatically on every edit for audit trail.
// Recommendation engine derives suggested bands from existing analysis data.
// v0.24.0

import type { DbHandle } from '../db/connection.js';
import { withTransaction } from '../db/connection.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConvictionStock {
  ticker: string;
  priceLow: number | null;
  priceMid: number | null;
  priceHigh: number | null;
  note: string | null;
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
      price_high: number | null; note: string | null;
      added_at: string; updated_at: string;
    };
    const rows = this.db.prepare(
      `SELECT ticker, price_low, price_mid, price_high, note, added_at, updated_at
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
      const latestIv = ivs.length > 0 ? ivs[0]! * 100 : null; // decimal → percentage
      const ivRank = computeIvRank(ivs.map(v => v * 100));
      return {
        ticker: r.ticker,
        priceLow: r.price_low,
        priceMid: r.price_mid,
        priceHigh: r.price_high,
        note: r.note,
        addedAt: r.added_at,
        updatedAt: r.updated_at,
        currentPrice,
        iv: latestIv,
        ivRank,
        zone: computeZone(currentPrice, r.price_low, r.price_mid, r.price_high),
      };
    });
  }

  // ── Add ───────────────────────────────────────────────────────────────────

  add(input: ConvictionInput): ConvictionStock {
    const ticker = input.ticker.trim().toUpperCase();
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
    const ivs = ivRows.map(r => r.atm_iv * 100);
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
    const priceHigh = round(currentPrice * (1 + premiumPct), 1.0);
    const priceHighBasis =
      `Current $${currentPrice.toFixed(2)} +${Math.round(premiumPct * 100)}%` +
      (ivRank !== null ? ` (IVR ${Math.round(ivRank)})` : ' (no IV data)');

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
      price_high: number | null; note: string | null;
      added_at: string; updated_at: string;
    };
    const row = this.db.prepare(
      `SELECT ticker, price_low, price_mid, price_high, note, added_at, updated_at
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
    ).all(ticker) as IvRow[]).map(r => r.atm_iv * 100);

    return {
      ticker: row.ticker,
      priceLow: row.price_low,
      priceMid: row.price_mid,
      priceHigh: row.price_high,
      note: row.note,
      addedAt: row.added_at,
      updatedAt: row.updated_at,
      currentPrice,
      iv: ivRows.length > 0 ? ivRows[0]! : null,
      ivRank: computeIvRank(ivRows),
      zone: computeZone(currentPrice, row.price_low, row.price_mid, row.price_high),
    };
  }
}

// Round to nearest step (e.g. 0.5 or 1.0)
function round(val: number, step: number): number {
  return Math.round(val / step) * step;
}
