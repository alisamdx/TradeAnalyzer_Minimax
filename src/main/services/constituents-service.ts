// Constituents service — loads and manages S&P 500 and Russell 1000 constituent lists.
// Per spec §4.2.2, the primary source is a bundled CSV maintained manually by the user.
// A 'Refresh' button triggers a Wikipedia scrape (respectful: single fetch, 7-day cache).
// The user can also import a CSV override.
// see SPEC: §4.2.2, FR-2.0b, FR-2.0c

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbHandle } from '../db/connection.js';
import { withTransaction } from '../db/connection.js';
import type { Universe, ConstituentRow, ConstituentsMeta, ConstituentWithMeta } from '@shared/types.js';

// Vanguard index-fund holdings — the automated constituent source (free public JSON,
// no key). The fund's published holdings ARE the constituent list: VOO tracks the
// S&P 500, VONE the Russell 1000. Paginated 500 rows/page.
const VANGUARD_FUND_BY_INDEX: Record<'sp500' | 'russell1000', string> = {
  sp500: 'VOO',
  russell1000: 'VONE',
};
const VANGUARD_PAGE_SIZE = 500;
const VANGUARD_MAX_PAGES = 10;

// Sanity floors — a source returning fewer rows than this is broken or truncated and
// must never overwrite a known-good list. (S&P 500 lists ~503 lines incl. dual share
// classes; Russell 1000 ~1,000-1,015.)
const MIN_ROWS_BY_INDEX: Record<'sp500' | 'russell1000', number> = {
  sp500: 480,
  russell1000: 940,
};

// Max fraction of the existing list allowed to change (adds+removes over old size) in
// one automated refresh. The annual Russell reconstitution turns over ~8-12% of names;
// anything above 25% is a corrupt feed, not a rebalance.
const MAX_TURNOVER = 0.25;

/** Result of an automated (gated) constituents refresh, including the membership diff. */
export interface ConstituentsRefreshOutcome {
  indexName: 'sp500' | 'russell1000';
  source: 'vanguard' | 'wikipedia';
  total: number;
  added: string[];
  removed: string[];
  /** The source's own as-of date, when it states one (Vanguard publishes month-end holdings). */
  asOf?: string | null;
}

interface VanguardHoldingEntity {
  ticker?: string | null;
  longName?: string | null;
}
interface VanguardHoldingsResponse {
  size?: number;
  asOfDate?: string;
  fund?: { entity?: VanguardHoldingEntity[] };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/**
 * Decode the HTML entities a Wikipedia table cell carries once its tags are stripped. The parser used
 * to store cell text as-is, so GICS sub-industries and company names reached `constituents` as
 * `Oil &amp; Gas Exploration &amp; Production` and `AT&amp;T` — and since Vanguard has no sector and
 * a refresh keeps the stored one, the escaped value then persisted indefinitely (fixed v1.1.341,
 * migration 090 repairs stored rows). One pass, so `&amp;lt;` decodes to `&lt;`, never to `<`.
 */
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code)) return m;
      // A non-breaking space is a space in a sector or company name.
      return code === 160 ? ' ' : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** Cell HTML → plain text: tags stripped, entities decoded, whitespace trimmed. */
function cellText(cellHtml: string): string {
  return decodeHtmlEntities(cellHtml.replace(/<[^>]+>/g, '')).trim();
}

function thisDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function bundledPath(index: 'sp500' | 'russell1000' | 'etf'): string {
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
    if (index === 'both' || index === 'all') {
      const sp5 = this.getConstituents('sp500');
      const rus = this.getConstituents('russell1000');
      const etf = index === 'all' ? this.getConstituents('etf') : [];
      const seen = new Set<string>();
      return [...sp5, ...rus, ...etf].filter((r) => {
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

  /**
   * Constituents for a single index WITH membership metadata (added_at), for the
   * Constituents viewer. Ordered newest-added first so recent job additions surface at
   * the top. DB-only (no bundled-CSV fallback — the viewer is about the live stored list).
   */
  getConstituentsWithMeta(index: 'sp500' | 'russell1000'): ConstituentWithMeta[] {
    const rows = this.db
      .prepare(
        `SELECT ticker, company_name, sector, added_at FROM constituents
         WHERE index_name = ? ORDER BY added_at DESC, ticker ASC`
      )
      .all(index) as Array<{ ticker: string; company_name: string | null; sector: string | null; added_at: string }>;
    return rows.map((r) => ({
      ticker: r.ticker,
      companyName: r.company_name,
      sector: r.sector,
      addedAt: r.added_at,
      indexName: index,
    }));
  }

  getMeta(index: 'sp500' | 'russell1000' | 'etf'): ConstituentsMeta | null {
    const row = this.db
      .prepare(`SELECT index_name, refreshed_at, source FROM constituents_meta WHERE index_name = ?`)
      .get(index) as { index_name: string; refreshed_at: string; source: string } | undefined;
    if (!row) return null;
    return {
      indexName: row.index_name as 'sp500' | 'russell1000' | 'etf',
      refreshedAt: row.refreshed_at,
      source: row.source as 'bundled' | 'wikipedia' | 'csv'
    };
  }

  /** Refresh from Wikipedia (respectful single fetch). Manual/UI path — no gates. */
  async refreshFromWikipedia(index: 'sp500' | 'russell1000'): Promise<ConstituentsMeta> {
    const constituents = await this.fetchWikipediaConstituents(index);
    this.applyRefresh(index, constituents, 'wikipedia', { enforceGates: false });
    return {
      indexName: index,
      refreshedAt: new Date().toISOString(),
      source: 'wikipedia'
    };
  }

  /** Refresh from Vanguard fund holdings (VOO/VONE) with sanity gates. */
  async refreshFromVanguard(index: 'sp500' | 'russell1000'): Promise<ConstituentsRefreshOutcome> {
    const { rows, asOf } = await this.fetchVanguardHoldings(VANGUARD_FUND_BY_INDEX[index]);
    return { ...this.applyRefresh(index, rows, 'vanguard', { enforceGates: true }), asOf };
  }

  /**
   * Automated refresh: Vanguard holdings primary, Wikipedia fallback, both gated so a
   * broken feed can never wipe or corrupt the stored list. Used by the batch job.
   */
  async refreshIndexAuto(index: 'sp500' | 'russell1000'): Promise<ConstituentsRefreshOutcome> {
    let vanguardError: unknown;
    try {
      return await this.refreshFromVanguard(index);
    } catch (err) {
      vanguardError = err;
    }
    try {
      const rows = await this.fetchWikipediaConstituents(index);
      return this.applyRefresh(index, rows, 'wikipedia', { enforceGates: true });
    } catch (wikiErr) {
      const v = vanguardError instanceof Error ? vanguardError.message : String(vanguardError);
      const w = wikiErr instanceof Error ? wikiErr.message : String(wikiErr);
      throw new Error(`Both constituent sources failed for ${index} — Vanguard: ${v}; Wikipedia: ${w}`);
    }
  }

  /**
   * Tickers that must never be written into `constituents` — delisted names a source
   * feed may keep listing for weeks (migration 085). Every writer below consults it,
   * because `applyRefresh` replaces a whole index and would otherwise restore them.
   */
  getExcludedTickers(): Set<string> {
    const rows = this.db
      .prepare(`SELECT ticker FROM constituents_excluded`)
      .all() as Array<{ ticker: string }>;
    return new Set(rows.map((r) => r.ticker.toUpperCase()));
  }

  /** Current tickers stored for an index (uppercased). */
  getCurrentTickers(index: 'sp500' | 'russell1000' | 'etf'): Set<string> {
    const rows = this.db
      .prepare(`SELECT ticker FROM constituents WHERE index_name = ?`)
      .all(index) as Array<{ ticker: string }>;
    return new Set(rows.map((r) => r.ticker.toUpperCase()));
  }

  /**
   * Replace an index's constituent list atomically, preserving sector/company fields
   * for carried-over tickers when the new source lacks them (Vanguard has no sector).
   * With gates on: rejects truncated feeds (row-count floor) and implausible turnover.
   */
  private applyRefresh(
    index: 'sp500' | 'russell1000',
    rows: ConstituentRow[],
    source: 'vanguard' | 'wikipedia',
    opts: { enforceGates: boolean }
  ): ConstituentsRefreshOutcome {
    // Dedupe by ticker (dual listings can repeat in scraped tables), and drop
    // excluded (delisted) tickers the feed still lists.
    const excluded = this.getExcludedTickers();
    const byTicker = new Map<string, ConstituentRow>();
    for (const r of rows) {
      const ticker = r.ticker.trim().toUpperCase();
      if (ticker && !excluded.has(ticker) && !byTicker.has(ticker)) byTicker.set(ticker, { ...r, ticker });
    }
    const fresh = [...byTicker.values()];

    if (opts.enforceGates && fresh.length < MIN_ROWS_BY_INDEX[index]) {
      throw new Error(
        `${source} returned only ${fresh.length} ${index} rows (floor ${MIN_ROWS_BY_INDEX[index]}) — refusing to overwrite the stored list`
      );
    }

    type OldRow = {
      ticker: string; company_name: string | null; sector: string | null; sub_industry: string | null; added_at: string;
    };
    const oldRows = this.db
      .prepare(`SELECT ticker, company_name, sector, sub_industry, added_at FROM constituents WHERE index_name = ?`)
      .all(index) as OldRow[];
    const oldByTicker = new Map(oldRows.map((r) => [r.ticker.toUpperCase(), r]));

    const added = fresh.map((r) => r.ticker).filter((t) => !oldByTicker.has(t)).sort();
    const removed = [...oldByTicker.keys()].filter((t) => !byTicker.has(t)).sort();

    if (opts.enforceGates && oldByTicker.size > 0) {
      const turnover = (added.length + removed.length) / oldByTicker.size;
      if (turnover > MAX_TURNOVER) {
        throw new Error(
          `${source} ${index} refresh implies ${(turnover * 100).toFixed(0)}% turnover ` +
          `(+${added.length}/−${removed.length} on ${oldByTicker.size}) — above the ${MAX_TURNOVER * 100}% guard, refusing to apply`
        );
      }
    }

    // Preserve the ORIGINAL added_at for carried-over tickers — only genuinely new
    // members get "now". Without this, the delete+reinsert would reset every ticker's
    // added_at on each refresh, so the Constituents viewer's "date added" (and any
    // "what's new" query) would show the whole index as added on the last refresh.
    const nowIso = new Date().toISOString();
    withTransaction(this.db, () => {
      this.db.prepare(`DELETE FROM constituents WHERE index_name = ?`).run(index);
      const insertStmt = this.db.prepare(
        `INSERT OR REPLACE INTO constituents (ticker, index_name, company_name, sector, sub_industry, added_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const c of fresh) {
        const old = oldByTicker.get(c.ticker);
        // Sector and sub-industry travel as a PAIR: a source that supplies a sector (Wikipedia) sets
        // both; one that supplies none (Vanguard) keeps both. Mixing a new sector with an old
        // sub-industry would pair values from different classifications.
        const hasSector = c.sector != null;
        insertStmt.run(
          c.ticker,
          index,
          c.companyName ?? old?.company_name ?? null,
          hasSector ? c.sector : old?.sector ?? null,
          hasSector ? c.subIndustry ?? null : old?.sub_industry ?? null,
          old?.added_at ?? nowIso
        );
      }
      this.db.prepare(
        `INSERT OR REPLACE INTO constituents_meta (index_name, refreshed_at, source)
         VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)`
      ).run(index, source);
    });

    return { indexName: index, source, total: fresh.length, added, removed };
  }

  /** Fetch and parse the Wikipedia constituents table for an index. */
  private async fetchWikipediaConstituents(index: 'sp500' | 'russell1000'): Promise<ConstituentRow[]> {
    return (await this.fetchWikipediaParse(index)).rows;
  }

  private async fetchWikipediaParse(index: 'sp500' | 'russell1000'): Promise<WikipediaParse> {
    const wikiUrl = index === 'sp500'
      ? 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies'
      : 'https://en.wikipedia.org/wiki/Russell_1000_Index';

    const response = await fetch(wikiUrl, {
      headers: { 'User-Agent': 'TradeAnalyzer/1.0 (desktop app; maintainer contact@example.com)' }
    });
    if (!response.ok) throw new Error(`Wikipedia fetch failed: ${response.status}`);
    return parseWikipediaConstituents(await response.text());
  }

  /**
   * Sector-only refresh (v1.1.342): sets `sector` (GICS Sector) and `sub_industry` from Wikipedia's
   * S&P 500 table for every stored constituent row of those tickers, in any index. Membership and
   * company names are untouched — Vanguard owns those.
   *
   * Why it exists: Vanguard carries no sector, so stored sectors only ever came from Wikipedia, and
   * until v1.1.342 the parser stored the SUB-INDUSTRY in `sector` (see parseWikipediaConstituents).
   * A fixed parser alone would never correct them, because Wikipedia only runs when Vanguard fails;
   * this also gives new Vanguard members a sector.
   *
   * Refuses rather than write a guess: the page must identify its sector column by the "GICS Sector"
   * header and yield at least the index's row floor.
   */
  async refreshSectorsFromWikipedia(): Promise<{ parsed: number; updated: number }> {
    const { rows, sectorFromHeader } = await this.fetchWikipediaParse('sp500');
    if (!sectorFromHeader) {
      throw new Error('Wikipedia S&P 500 table has no recognisable "GICS Sector" header — refusing to write sectors');
    }
    const withSector = rows.filter((r) => r.sector);
    if (withSector.length < MIN_ROWS_BY_INDEX.sp500) {
      throw new Error(`Wikipedia gave sectors for only ${withSector.length} S&P 500 rows (floor ${MIN_ROWS_BY_INDEX.sp500}) — refusing to write sectors`);
    }
    let updated = 0;
    withTransaction(this.db, () => {
      const stmt = this.db.prepare(
        `UPDATE constituents SET sector = ?, sub_industry = ?
          WHERE upper(ticker) = ? AND index_name IN ('sp500', 'russell1000')`
      );
      for (const r of withSector) updated += stmt.run(r.sector, r.subIndustry ?? null, r.ticker.toUpperCase()).changes;
    });
    return { parsed: withSector.length, updated };
  }

  /**
   * Fetch a Vanguard fund's full stock holdings (paginated public JSON API).
   *
   * The API moved in early September 2026 from `/investment-products/etfs/profile/api/…`
   * to `/vmf/api/…`. The old path kept answering HTTP 200 — with the site's HTML page — so
   * every refresh from ~2026-09-08 failed on `Unexpected token '<'` while the job reported
   * success. A non-JSON body is now named as such.
   *
   * The holdings are MONTH-END (`asOfDate`, e.g. 2026-07-31 in mid-September), so a
   * delisting can take six weeks to leave this list — see `constituents_excluded`.
   */
  private async fetchVanguardHoldings(fund: string): Promise<{ rows: ConstituentRow[]; asOf: string | null }> {
    const base = `https://investor.vanguard.com/vmf/api/${fund}/portfolio-holding/stock`;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TradeAnalyzer-desktop',
      Accept: 'application/json'
    };

    const rows: ConstituentRow[] = [];
    let asOf: string | null = null;
    let start = 1;
    let size = Number.POSITIVE_INFINITY;

    for (let page = 0; page < VANGUARD_MAX_PAGES && start <= size; page++) {
      const res = await fetch(`${base}?start=${start}&count=${VANGUARD_PAGE_SIZE}`, { headers });
      if (!res.ok) throw new Error(`Vanguard holdings fetch failed (${fund}): HTTP ${res.status}`);
      let json: VanguardHoldingsResponse;
      try {
        json = (await res.json()) as VanguardHoldingsResponse;
      } catch (err) {
        throw new Error(
          `Vanguard holdings (${fund}) did not return JSON — the API has probably moved ` +
          `(${err instanceof Error ? err.message : String(err)})`
        );
      }
      asOf ??= typeof json.asOfDate === 'string' ? json.asOfDate.slice(0, 10) : null;
      size = json.size ?? 0;
      const entities = json.fund?.entity ?? [];
      if (entities.length === 0) break;
      for (const e of entities) {
        const ticker = (e.ticker ?? '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '');
        if (!ticker) continue;
        // Vanguard holdings carry no sector — applyRefresh preserves the stored one.
        rows.push({ ticker, companyName: e.longName ? decodeHtmlEntities(e.longName).trim() || null : null, sector: null });
      }
      start += VANGUARD_PAGE_SIZE;
    }
    return { rows, asOf };
  }

  /** Parse constituents from the bundled CSV (one-time setup). */
  loadBundled(index: 'sp500' | 'russell1000' | 'etf'): ConstituentRow[] {
    const path = bundledPath(index);
    if (!existsSync(path)) return [];
    const text = readFileSync(path, 'utf8');
    return parseConstituentsCsv(text);
  }

  /** Bootstrap the DB from a bundled CSV (used on first run if DB cache is empty). */
  bootstrapFromBundled(index: 'sp500' | 'russell1000' | 'etf'): void {
    const rows = this.loadBundled(index);
    if (rows.length === 0) return;
    const excluded = this.getExcludedTickers();
    const insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO constituents (ticker, index_name, company_name, sector, added_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    );
    for (const r of rows) {
      if (excluded.has(r.ticker.toUpperCase())) continue;
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
  importFromCsv(filePath: string, index: 'sp500' | 'russell1000' | 'etf'): number {
    const text = readFileSync(filePath, 'utf8');
    const rows = parseConstituentsCsv(text);
    const excluded = this.getExcludedTickers();
    const insertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO constituents (ticker, index_name, company_name, sector, added_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    );
    let count = 0;
    for (const r of rows) {
      if (excluded.has(r.ticker.toUpperCase())) continue;
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

  /** The constituent rows of the best Wikipedia table on the page. */
  private parseWikipediaTable(html: string): ConstituentRow[] {
    return parseWikipediaConstituents(html).rows;
  }
}

// ─── Wikipedia parsing (pure, exported for tests) ────────────────────────────

/** Which header names mean which column. Compared lower-cased, decoded, whitespace-collapsed. */
const HEADER_TICKER = new Set(['symbol', 'ticker', 'ticker symbol']);
const HEADER_COMPANY = new Set(['security', 'company', 'company name', 'name']);
const HEADER_SECTOR = new Set(['gics sector', 'sector']);
const HEADER_SUB_INDUSTRY = new Set(['gics sub-industry', 'gics sub industry', 'sub-industry', 'sub industry', 'industry']);

export interface WikipediaParse {
  rows: ConstituentRow[];
  /**
   * True only when the sector column was identified by its HEADER ("GICS Sector"). A sector found by
   * the content fallback may be any short text column — before v1.1.342 it was the sub-industry —
   * so a sector-only refresh must not write it.
   */
  sectorFromHeader: boolean;
}

/**
 * Parse the constituents table from a Wikipedia list page.
 *
 * Columns are found by HEADER NAME first. Until v1.1.342 they were guessed from the first data row's
 * content, and on the S&P 500 page that row is 3M: its two-character name failed the
 * "company names are longer than 3 characters" test, every choice shifted one column right, and
 * `company_name` got the GICS Sector while `sector` got the GICS Sub-Industry. The content guess
 * remains only as a fallback for a table whose headers are not recognised.
 */
export function parseWikipediaConstituents(html: string): WikipediaParse {
  const tableRegex = /<table[^>]*class="wikitable[^"]*"[^>]*>[\s\S]*?<\/table>/gi;
  // Rows carry attributes since Wikipedia moved to Parsoid HTML (`<tr id="mwLQ">`); a bare
  // `<tr>` pattern matched none of the 504 rows, so the fallback parsed 0 from ~2026-09-08.
  const rowRegex = /<tr(?:\s[^>]*)?>[\s\S]*?<\/tr>/gi;
  const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;

  const looksLikeTicker = (cellHtml: string): boolean => {
    const text = cellHtml.replace(/<[^>]+>/g, '').trim().toUpperCase();
    // Valid tickers: 1-5 letters, possibly with . or - (like BRK.B, BRK-B)
    return /^[A-Z]{1,5}[.-]?[A-Z0-9]{0,2}$/.test(text) && text.length >= 1 && text.length <= 8;
  };
  const looksLikeCompany = (cellHtml: string): boolean => {
    const text = cellText(cellHtml);
    return text.length > 3 && text.length < 100 && !looksLikeTicker(cellHtml) && !/^[\d.-]+$/.test(text);
  };
  const headerKey = (cellHtml: string): string => cellText(cellHtml).toLowerCase().replace(/\s+/g, ' ');

  let best: WikipediaParse = { rows: [], sectorFromHeader: false };

  for (const tableEntry of html.matchAll(tableRegex)) {
    const tableHtml = tableEntry[0]!;
    const rows = [...tableHtml.matchAll(rowRegex)].map((m) => [...m[0]!.matchAll(cellRegex)].map((c) => c[1]!));
    if (rows.length < 10) continue;

    const header = rows[0]!.map(headerKey);
    const byName = (names: Set<string>): number => header.findIndex((h) => names.has(h));
    let tickerCol = byName(HEADER_TICKER);
    let companyCol = byName(HEADER_COMPANY);
    let sectorCol = byName(HEADER_SECTOR);
    let subCol = byName(HEADER_SUB_INDUSTRY);
    let sectorFromHeader = sectorCol >= 0;

    if (tickerCol < 0 || companyCol < 0) {
      // Fallback: guess from the first data row's content. Never trusted for a sector-only refresh.
      const sample = rows.slice(1).find((r) => r.length >= 2) ?? [];
      if (sample.length < 2) continue;
      tickerCol = sample.findIndex((c) => looksLikeTicker(c));
      companyCol = sample.findIndex((c, i) => i !== tickerCol && looksLikeCompany(c));
      sectorCol = -1;
      subCol = -1;
      sectorFromHeader = false;
      for (let i = 2; i < sample.length; i++) {
        if (i === tickerCol || i === companyCol) continue;
        // Decoded: an escaped `&amp;` adds 4 characters to the 40-character cap (v1.1.341).
        const text = cellText(sample[i]!);
        if (text.length > 2 && text.length < 40 && !looksLikeTicker(sample[i]!) && !/^[\d.-]+$/.test(text)) {
          sectorCol = i;
          break;
        }
      }
    }
    if (tickerCol < 0 || companyCol < 0) continue;

    const parsed: ConstituentRow[] = [];
    for (const cells of rows.slice(1)) {
      if (cells.length <= Math.max(tickerCol, companyCol)) continue;
      const ticker = cells[tickerCol]!.replace(/<[^>]+>/g, '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '');
      if (!ticker || ticker.length > 8) continue;
      const at = (col: number): string | null => (col >= 0 && cells[col] !== undefined ? cellText(cells[col]!) || null : null);
      parsed.push({ ticker, companyName: at(companyCol), sector: at(sectorCol), subIndustry: at(subCol) });
    }
    if (parsed.length > best.rows.length) best = { rows: parsed, sectorFromHeader };
  }
  return best;
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