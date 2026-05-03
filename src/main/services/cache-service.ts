// Cache service — manages all market-data cache tables.
// TTLs per NFR-3: fundamentals 24h, quotes 60s, options 5min.
// Provides get/upsert semantics; callers check `fetchedAt` to decide staleness.
// see SPEC: NFR-3

import type { DbHandle } from '../db/connection.js';
import type { DerivedRatios } from '@shared/types.js';

// ─── TTL constants (seconds) ─────────────────────────────────────────────────

export const TTL_SECONDS = {
  FUNDAMENTALS: 86_400,   // 24 h
  QUOTE: 60,              // 1 min
  OPTIONS: 300            // 5 min
} as const;

// ─── SQL table creation ──────────────────────────────────────────────────────

export function initCacheTables(db: DbHandle): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fundamentals_cache (
      ticker TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS quote_cache (
      ticker TEXT PRIMARY KEY,
      last REAL,
      prev_close REAL,
      bid REAL,
      ask REAL,
      volume INTEGER,
      day_high REAL,
      day_low REAL,
      iv_rank REAL,
      iv_percentile REAL,
      fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS options_cache (
      ticker TEXT NOT NULL,
      expiration TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (ticker, expiration)
    );
    CREATE INDEX IF NOT EXISTS idx_options_cache_ticker ON options_cache (ticker);
  `);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isStale(fetchedAt: string, ttlSeconds: number): boolean {
  const then = new Date(fetchedAt).getTime();
  return Date.now() - then > ttlSeconds * 1000;
}

// ─── Quote cache ─────────────────────────────────────────────────────────────

export interface CachedQuote {
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
  distance52WkHigh?: number | null;
  distance52WkLow?: number | null;
  fetchedAt: string;
}

export class QuoteCache {
  private readonly upsertStmt;
  private readonly getStmt;

  constructor(private readonly db: DbHandle) {
    this.upsertStmt = db.prepare(`
      INSERT OR REPLACE INTO quote_cache
        (ticker, last, prev_close, bid, ask, volume, day_high, day_low, iv_rank, iv_percentile, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);
    this.getStmt = db.prepare(
      `SELECT ticker, last, prev_close, bid, ask, volume, day_high, day_low,
              iv_rank, iv_percentile, fetched_at
         FROM quote_cache WHERE ticker = ?`
    );
  }

  get(ticker: string): CachedQuote | null {
    const row = this.getStmt.get(ticker) as {
      ticker: string; last: number | null; prev_close: number | null;
      bid: number | null; ask: number | null; volume: number | null;
      day_high: number | null; day_low: number | null;
      iv_rank: number | null; iv_percentile: number | null; fetched_at: string;
    } | undefined;
    if (!row) return null;
    return {
      ticker: row.ticker,
      last: row.last,
      prevClose: row.prev_close,
      bid: row.bid,
      ask: row.ask,
      volume: row.volume,
      dayHigh: row.day_high,
      dayLow: row.day_low,
      ivRank: row.iv_rank,
      ivPercentile: row.iv_percentile,
      fetchedAt: row.fetched_at
    };
  }

  upsert(quote: CachedQuote): void {
    this.upsertStmt.run(
      quote.ticker, quote.last, quote.prevClose, quote.bid, quote.ask,
      quote.volume, quote.dayHigh, quote.dayLow, quote.ivRank, quote.ivPercentile
    );
  }

  isStale(ticker: string): boolean {
    const row = this.getStmt.get(ticker) as { fetched_at: string } | undefined;
    if (!row) return true;
    return isStale(row.fetched_at, TTL_SECONDS.QUOTE);
  }

  getStaleTickers(tickers: string[]): string[] {
    if (tickers.length === 0) return [];
    const placeholders = tickers.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT ticker, fetched_at FROM quote_cache WHERE ticker IN (${placeholders})`
      )
      .all(...tickers) as Array<{ ticker: string; fetched_at: string }>;
    return rows
      .filter((r) => isStale(r.fetched_at, TTL_SECONDS.QUOTE))
      .map((r) => r.ticker);
  }
}

// ─── Fundamentals cache ───────────────────────────────────────────────────────

export class FundamentalsCache {
  private readonly upsertStmt;
  private readonly getStmt;

  constructor(private readonly db: DbHandle) {
    this.upsertStmt = db.prepare(`
      INSERT OR REPLACE INTO fundamentals_cache (ticker, payload_json, fetched_at)
      VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);
    this.getStmt = db.prepare(
      `SELECT ticker, payload_json, fetched_at FROM fundamentals_cache WHERE ticker = ?`
    );
  }

  get(ticker: string): { ratios: DerivedRatios; fetchedAt: string } | null {
    const row = this.getStmt.get(ticker) as
      | { ticker: string; payload_json: string; fetched_at: string }
      | undefined;
    if (!row) return null;
    try {
      return {
        ratios: JSON.parse(row.payload_json) as DerivedRatios,
        fetchedAt: row.fetched_at
      };
    } catch {
      return null;
    }
  }

  upsert(ticker: string, ratios: DerivedRatios): void {
    this.upsertStmt.run(ticker, JSON.stringify(ratios));
  }

  isStale(ticker: string): boolean {
    const row = this.getStmt.get(ticker) as { fetched_at: string } | undefined;
    if (!row) return true;
    return isStale(row.fetched_at, TTL_SECONDS.FUNDAMENTALS);
  }
}

// ─── Options cache ───────────────────────────────────────────────────────────

export class OptionsCache {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listStmt;

  constructor(private readonly db: DbHandle) {
    this.upsertStmt = db.prepare(`
      INSERT OR REPLACE INTO options_cache (ticker, expiration, payload_json, fetched_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);
    this.getStmt = db.prepare(
      `SELECT ticker, expiration, payload_json, fetched_at
         FROM options_cache WHERE ticker = ? AND expiration = ?`
    );
    this.listStmt = db.prepare(
      `SELECT ticker, expiration, payload_json, fetched_at
         FROM options_cache WHERE ticker = ? ORDER BY expiration ASC`
    );
  }

  get(ticker: string, expiration: string): { payload: unknown; fetchedAt: string } | null {
    const row = this.getStmt.get(ticker, expiration) as
      | { ticker: string; expiration: string; payload_json: string; fetched_at: string }
      | undefined;
    if (!row) return null;
    try {
      return { payload: JSON.parse(row.payload_json), fetchedAt: row.fetched_at };
    } catch {
      return null;
    }
  }

  listExpirations(ticker: string): string[] {
    const rows = this.listStmt.all(ticker) as Array<{
      ticker: string; expiration: string; payload_json: string; fetched_at: string;
    }>;
    return rows.map((r) => r.expiration);
  }

  upsert(ticker: string, expiration: string, payload: unknown): void {
    this.upsertStmt.run(ticker, expiration, JSON.stringify(payload));
  }

  isStale(ticker: string, expiration: string): boolean {
    const row = this.getStmt.get(ticker, expiration) as
      | { fetched_at: string }
      | undefined;
    if (!row) return true;
    return isStale(row.fetched_at, TTL_SECONDS.OPTIONS);
  }
}
