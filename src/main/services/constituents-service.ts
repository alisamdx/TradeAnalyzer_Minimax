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
    // Find all wikitable tables and pick the one with the most valid tickers.
    // S&P 500: Column 1 = Ticker, Column 2 = Company name
    // Russell 1000: Column 1 = Company name, Column 2 = Ticker
    const tableRegex = /<table[^>]*class="wikitable[^"]*"[^>]*>[\s\S]*?<\/table>/gi;
    const rowRegex = /<tr>[\s\S]*?<\/tr>/gi;
    const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;

    const allTables = [...html.matchAll(tableRegex)];
    if (allTables.length === 0) return [];

    // Helper to detect if a cell looks like a valid ticker (e.g., "AAPL", "MSFT", "BRK.B")
    const looksLikeTicker = (cellHtml: string): boolean => {
      const text = cellHtml.replace(/<[^>]+>/g, '').trim().toUpperCase();
      // Valid tickers: 1-5 letters, possibly with . or - (like BRK.B, BRK-B)
      return /^[A-Z]{1,5}[.-]?[A-Z0-9]{0,2}$/.test(text) && text.length >= 1 && text.length <= 8;
    };

    // Helper to detect if a cell looks like a company name
    const looksLikeCompany = (cellHtml: string): boolean => {
      const text = cellHtml.replace(/<[^>]+>/g, '').trim();
      // Company names usually have spaces, are longer, don't look like tickers
      return text.length > 3 && text.length < 100 && !looksLikeTicker(cellHtml) && !/^[\d.-]+$/.test(text);
    };

    // Helper to parse rows from a table with given column positions
    const parseTable = (tableHtml: string, tickerCol: number, companyCol: number, sectorCol: number): ConstituentRow[] => {
      const results: ConstituentRow[] = [];
      const matches = tableHtml.matchAll(rowRegex);
      let headerSeen = false;

      for (const rowMatch of matches) {
        const rowHtml = rowMatch[0]!;
        if (!headerSeen) { headerSeen = true; continue; }
        const cells = [...rowHtml.matchAll(cellRegex)].map((m) => m[1]!);
        if (cells.length <= Math.max(tickerCol, companyCol)) continue;

        const tickerCell = cells[tickerCol]!;
        const cleaned = tickerCell.replace(/<[^>]+>/g, '').trim().toUpperCase();
        const ticker = cleaned.replace(/[^A-Z0-9.-]/g, '');
        if (!ticker || ticker.length > 8) continue;

        const companyName = cells[companyCol]?.replace(/<[^>]+>/g, '').trim() || null;
        const sector = sectorCol >= 0 && cells[sectorCol]
          ? cells[sectorCol]!.replace(/<[^>]+>/g, '').trim() || null
          : null;

        results.push({ ticker, companyName, sector });
      }
      return results;
    };

    // Try each table and pick the one with the most valid tickers
    let bestRows: ConstituentRow[] = [];
    let bestCount = 0;

    for (const tableEntry of allTables) {
      const tableHtml = tableEntry[0]!;
      const matches = [...tableHtml.matchAll(rowRegex)];

      // Skip tables with very few rows
      if (matches.length < 10) continue;

      // Sample a few non-header rows to determine column layout
      let sampleRow: string[] = [];
      let headerSkipped = false;
      for (const rowMatch of matches) {
        const rowHtml = rowMatch[0]!;
        if (!headerSkipped) { headerSkipped = true; continue; }
        sampleRow = [...rowHtml.matchAll(cellRegex)].map((m) => m[1]!);
        if (sampleRow.length >= 2) break;
      }

      if (sampleRow.length < 2) continue;

      // Detect column positions based on content
      let tickerCol = -1, companyCol = -1, sectorCol = -1;

      // Find which column has tickers
      for (let i = 0; i < sampleRow.length; i++) {
        if (looksLikeTicker(sampleRow[i]!)) {
          tickerCol = i;
          break;
        }
      }

      // Find company name (not a ticker, looks like a name)
      for (let i = 0; i < sampleRow.length; i++) {
        if (i !== tickerCol && looksLikeCompany(sampleRow[i]!)) {
          companyCol = i;
          break;
        }
      }

      // Find sector (usually 3rd or 4th column with sector-like content)
      for (let i = 2; i < sampleRow.length; i++) {
        if (i !== tickerCol && i !== companyCol) {
          const text = sampleRow[i]!.replace(/<[^>]+>/g, '').trim();
          // Valid sectors: don't look like tickers or numbers, reasonable length
          if (text.length > 2 && text.length < 40 && !looksLikeTicker(sampleRow[i]!) && !/^[\d.-]+$/.test(text)) {
            sectorCol = i;
            break;
          }
        }
      }

      if (tickerCol >= 0 && companyCol >= 0) {
        const rows = parseTable(tableHtml, tickerCol, companyCol, sectorCol);
        if (rows.length > bestCount) {
          bestCount = rows.length;
          bestRows = rows;
        }
      }
    }

    return bestRows;
  }
}

// ─── CSV helpers (local, not the watchlist CSV service) ──────────────────────

function parseConstituentsCsv(text: string): ConstituentRow[] {
  const lines = text.replace(/^\xef\xbb\xbf/, '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0]!.toLowerCase().split(',').map((h) => h.trim());

  // Support multiple formats:
  // 1. ticker, company_name, sector (standard)
  // 2. Symbol, Name (Barchart format)
  // 3. Ticker, Company (alternative)
  let tickerIdx = header.indexOf('ticker');
  let nameIdx = header.indexOf('company_name');
  let sectorIdx = header.indexOf('sector');

  // Try alternative column names if not found
  if (tickerIdx === -1) tickerIdx = header.indexOf('symbol');
  if (nameIdx === -1) nameIdx = header.indexOf('name');
  if (nameIdx === -1) nameIdx = header.indexOf('company');

  if (tickerIdx === -1) return [];

  const rows: ConstituentRow[] = [];
  // Skip header (line 0) and footer/source info (last line)
  for (let i = 1; i < lines.length - 1; i++) {
    // Handle CSV with quoted fields that may contain commas
    const cells = parseCSVLine(lines[i]!);
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

/** Parse a CSV line handling quoted fields with commas inside. */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim().replace(/^"|"$/g, ''));
  return result;
}