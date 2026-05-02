// Constituents service — loads and manages S&P 500 and Russell 1000 constituent lists.
// Per spec §4.2.2, the primary source is a bundled CSV maintained manually by the user.
// A 'Refresh' button triggers a Wikipedia scrape (respectful: single fetch, 7-day cache).
// The user can also import a CSV override.
// see SPEC: §4.2.2, FR-2.0b, FR-2.0c

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbHandle } from '../db/connection.js';
import type { Universe, ConstituentRow, ConstituentsMeta } from '@shared/types.js';

function thisDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function bundledPath(index: 'sp500' | 'russell1000'): string {
  return join(thisDir(), '..', 'assets', 'constituents', `${index}.csv`);
}

export class ConstituentsService {
  constructor(private readonly db: DbHandle) {
    this.db
      .prepare(`CREATE TABLE IF NOT EXISTS constituents (
        ticker TEXT NOT NULL,
        index_name TEXT NOT NULL,
        company_name TEXT,
        sector TEXT,
        added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (ticker, index_name)
      )`)
      .run();
    this.db
      .prepare(`CREATE TABLE IF NOT EXISTS constituents_meta (
        index_name TEXT PRIMARY KEY,
        refreshed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        source TEXT NOT NULL DEFAULT 'bundled'
      )`)
      .run();
    this.db
      .prepare(`CREATE INDEX IF NOT EXISTS idx_constituents_index ON constituents (index_name)`)
      .run();
  }

  /**
   * Load constituents for the given index.
   * Priority: (1) SQLite cache if fresh, (2) bundled CSV, (3) empty list.
   */
  getConstituents(index: Universe): ConstituentRow[] {
    if (index === 'both') {
      const sp5 = this.getConstituents('sp500');
      const rus = this.getConstituents('russell1000');
      const seen = new Set<string>();
      return [...sp5, ...rus].filter((r) => {
        if (seen.has(r.ticker)) return false;
        seen.add(r.ticker);
        return true;
      });
    }

    const rows = this.db
      .prepare(
        `SELECT ticker, company_name, sector FROM constituents
         WHERE index_name = ? ORDER BY ticker ASC`
      )
      .all(index) as Array<{ ticker: string; company_name: string | null; sector: string | null }>;

    if (rows.length > 0) return rows.map((r) => ({
      ticker: r.ticker,
      companyName: r.company_name,
      sector: r.sector
    }));

    // Fall back to bundled CSV.
    return this.loadBundled(index);
  }

  getMeta(index: 'sp500' | 'russell1000'): ConstituentsMeta | null {
    const row = this.db
      .prepare(`SELECT index_name, refreshed_at, source FROM constituents_meta WHERE index_name = ?`)
      .get(index) as { index_name: string; refreshed_at: string; source: string } | undefined;
    if (!row) return null;
    return {
      indexName: row.index_name as 'sp500' | 'russell1000',
      refreshedAt: row.refreshed_at,
      source: row.source as 'bundled' | 'wikipedia' | 'csv'
    };
  }

  /** Refresh from Wikipedia (respectful single fetch). */
  async refreshFromWikipedia(index: 'sp500' | 'russell1000'): Promise<ConstituentsMeta> {
    const wikiUrl = index === 'sp500'
      ? 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies'
      : 'https://en.wikipedia.org/wiki/Russell_1000_Index';

    const response = await fetch(wikiUrl, {
      headers: { 'User-Agent': 'TradeAnalyzer/1.0 (desktop app; maintainer contact@example.com)' }
    });
    if (!response.ok) throw new Error(`Wikipedia fetch failed: ${response.status}`);
    const html = await response.text();

    const constituents = this.parseWikipediaTable(html);
    const source = 'wikipedia' as const;

    // Upsert into DB.
    const insertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO constituents (ticker, index_name, company_name, sector, added_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    );
    const touchMeta = this.db.prepare(
      `INSERT OR REPLACE INTO constituents_meta (index_name, refreshed_at, source)
       VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)`
    );
    const clearStmt = this.db.prepare(`DELETE FROM constituents WHERE index_name = ?`);

    clearStmt.run(index);
    for (const c of constituents) {
      insertStmt.run(c.ticker, index, c.companyName, c.sector);
    }
    touchMeta.run(index, source);

    return {
      indexName: index,
      refreshedAt: new Date().toISOString(),
      source
    };
  }

  /** Parse constituents from the bundled CSV (one-time setup). */
  loadBundled(index: 'sp500' | 'russell1000'): ConstituentRow[] {
    const path = bundledPath(index);
    if (!existsSync(path)) return [];
    const text = readFileSync(path, 'utf8');
    return parseConstituentsCsv(text);
  }

  /** Bootstrap the DB from a bundled CSV (used on first run if DB cache is empty). */
  bootstrapFromBundled(index: 'sp500' | 'russell1000'): void {
    const rows = this.loadBundled(index);
    if (rows.length === 0) return;
    const insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO constituents (ticker, index_name, company_name, sector, added_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    );
    for (const r of rows) {
      insertStmt.run(r.ticker, index, r.companyName, r.sector);
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO constituents_meta (index_name, refreshed_at, source)
         VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'bundled')`
      )
      .run(index);
  }

  /** Import constituents from a CSV file (user override). */
  importFromCsv(filePath: string, index: 'sp500' | 'russell1000'): number {
    const text = readFileSync(filePath, 'utf8');
    const rows = parseConstituentsCsv(text);
    const insertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO constituents (ticker, index_name, company_name, sector, added_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    );
    let count = 0;
    for (const r of rows) {
      insertStmt.run(r.ticker, index, r.companyName, r.sector);
      count++;
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO constituents_meta (index_name, refreshed_at, source)
         VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'csv')`
      )
      .run(index);
    return count;
  }

  // ─── Wikipedia parsing ────────────────────────────────────────────────────

  private parseWikipediaTable(html: string): ConstituentRow[] {
    const rows: ConstituentRow[] = [];
    // Simple regex-based extraction — works for the standard Wikipedia S&P/Russell tables.
    // Extracts ticker from the first column link hrefs (/wiki/SYMBOL) and company name from text.
    const tableRegex = /<table[^>]*class="wikitable[^"]*"[^>]*>[\s\S]*?<\/table>/gi;
    const rowRegex = /<tr>[\s\S]*?<\/tr>/gi;
    const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    const linkRegex = /href="\/wiki\/([^"#\s]+)"/;

    const tableMatch = tableRegex.exec(html);
    if (!tableMatch) return [];
    const tableHtml = tableMatch[0]!;
    const matches = tableHtml.matchAll(rowRegex);
    let headerSeen = false;

    for (const rowMatch of matches) {
      const rowHtml = rowMatch[0]!;
      if (!headerSeen) { headerSeen = true; continue; }
      const cells = [...rowHtml.matchAll(cellRegex)].map((m) => m[1]!);
      if (cells.length < 2) continue;

      // Ticker is in the first cell (sometimes a link).
      const firstCell = cells[0]!;
      const linkMatch = linkRegex.exec(firstCell);
      const ticker = (linkMatch ? linkMatch[1]! : firstCell).toUpperCase().replace(/[^A-Z0-9.-]/g, '');
      if (!ticker) continue;

      // Company name: strip HTML tags from the second cell.
      const companyName = cells[1]!.replace(/<[^>]+>/g, '').trim() || null;
      // Sector: often in the 3rd or 4th cell depending on the table format.
      let sector: string | null = null;
      for (let i = 2; i < cells.length; i++) {
        const cleaned = cells[i]!.replace(/<[^>]+>/g, '').trim();
        if (cleaned && !/^[\d.-]+$/.test(cleaned) && cleaned.length > 2 && cleaned.length < 40) {
          sector = cleaned;
          break;
        }
      }

      rows.push({ ticker, companyName, sector });
    }

    return rows;
  }
}

// ─── CSV helpers (local, not the watchlist CSV service) ──────────────────────

function parseConstituentsCsv(text: string): ConstituentRow[] {
  const lines = text.replace(/^\xef\xbb\xbf/, '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0]!.toLowerCase().split(',').map((h) => h.trim());
  const tickerIdx = header.indexOf('ticker');
  const nameIdx = header.indexOf('company_name');
  const sectorIdx = header.indexOf('sector');
  if (tickerIdx === -1) return [];

  const rows: ConstituentRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const ticker = (cells[tickerIdx] ?? '').replace(/[^A-Z0-9.-]/g, '').toUpperCase();
    if (!ticker) continue;
    rows.push({
      ticker,
      companyName: nameIdx >= 0 ? (cells[nameIdx] || null) : null,
      sector: sectorIdx >= 0 ? (cells[sectorIdx] || null) : null
    });
  }
  return rows;
}