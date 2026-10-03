// v1.1.342 — the Wikipedia parser finds columns by HEADER, and sectors are refreshed from Wikipedia.
//
// Until v1.1.342 columns were guessed from the first data row. On the S&P 500 page that row is 3M,
// whose two-character name failed "company names are longer than 3 characters", so every choice
// shifted one column right: company_name got the GICS Sector and `sector` the GICS Sub-Industry.
// The spread mode's per-sector cap was really a per-sub-industry cap as a result (BPS-12).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { ConstituentsService, parseWikipediaConstituents } from '../src/main/services/constituents-service.js';

/** The live page's header (fetched 2026-10-03) and its first row, 3M, then filler rows. */
function sp500Page(rowCount = 503, headers = ['Symbol', 'Security', 'GICS Sector', 'GICS Sub-Industry', 'Headquarters Location', 'Date added', 'CIK', 'Founded']): string {
  const rows = [
    '<tr><td><a href="x">MMM</a></td><td><a href="y">3M</a></td><td>Industrials</td><td>Industrial Conglomerates</td><td>Saint Paul, Minnesota</td><td>1957-03-04</td><td>0000066740</td><td>1902</td></tr>',
    '<tr><td>XOM</td><td>ExxonMobil</td><td>Energy</td><td>Integrated Oil &amp; Gas</td><td>Spring, Texas</td><td>1957-03-04</td><td>0000034088</td><td>1999</td></tr>',
    ...Array.from({ length: rowCount - 2 }, (_, i) =>
      `<tr><td>T${i}</td><td>Filler Corp ${i}</td><td>Information Technology</td><td>Application Software</td><td>Austin, Texas</td><td>2001-01-01</td><td>000000${i}</td><td>1990</td></tr>`),
  ];
  const head = `<tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>`;
  return `<table class="wikitable sortable" id="constituents"><tbody>${head}${rows.join('')}</tbody></table>`;
}

describe('parseWikipediaConstituents — columns by header', () => {
  it('reads Security as the company and GICS Sector as the sector, even with 3M first', () => {
    const { rows, sectorFromHeader } = parseWikipediaConstituents(sp500Page());
    expect(sectorFromHeader).toBe(true);
    const mmm = rows.find((r) => r.ticker === 'MMM')!;
    expect(mmm).toEqual({ ticker: 'MMM', companyName: '3M', sector: 'Industrials', subIndustry: 'Industrial Conglomerates' });
    expect(rows.find((r) => r.ticker === 'XOM')!.subIndustry).toBe('Integrated Oil & Gas');
    expect(rows).toHaveLength(503);
  });

  it('falls back to content guessing for unrecognised headers, and says the sector is not trusted', () => {
    const { rows, sectorFromHeader } = parseWikipediaConstituents(sp500Page(20, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']));
    expect(sectorFromHeader).toBe(false);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('ConstituentsService.refreshSectorsFromWikipedia', () => {
  let db: DbHandle;
  let svc: ConstituentsService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    svc = new ConstituentsService(db);
    const ins = db.prepare(`INSERT INTO constituents (ticker, index_name, company_name, sector) VALUES (?, ?, ?, ?)`);
    // What the old parser stored: the sub-industry in `sector`.
    ins.run('MMM', 'sp500', '3M Co', 'Industrial Conglomerates');
    ins.run('XOM', 'sp500', 'Exxon Mobil Corp', 'Integrated Oil & Gas');
    ins.run('XOM', 'russell1000', 'Exxon Mobil Corp', 'Integrated Oil & Gas');
    ins.run('RUSONLY', 'russell1000', 'Russell Only Inc', 'Some Old Value');
  });
  afterEach(() => { db.close(); vi.unstubAllGlobals(); });

  const serve = (html: string) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => html }) as Response));
  const row = (t: string, idx: string) => db.prepare(
    `SELECT company_name, sector, sub_industry FROM constituents WHERE ticker = ? AND index_name = ?`
  ).get(t, idx) as { company_name: string; sector: string; sub_industry: string | null };

  it('sets sector and sub_industry in every index, leaving membership and names alone', async () => {
    serve(sp500Page());
    const out = await svc.refreshSectorsFromWikipedia();
    expect(out.parsed).toBe(503);
    expect(row('MMM', 'sp500')).toEqual({ company_name: '3M Co', sector: 'Industrials', sub_industry: 'Industrial Conglomerates' });
    expect(row('XOM', 'russell1000')).toEqual({ company_name: 'Exxon Mobil Corp', sector: 'Energy', sub_industry: 'Integrated Oil & Gas' });
    expect(row('RUSONLY', 'russell1000').sector).toBe('Some Old Value');   // not on the S&P page
    expect((db.prepare(`SELECT COUNT(*) AS n FROM constituents`).get() as { n: number }).n).toBe(4);
  });

  it('refuses when the sector column was not identified by its header', async () => {
    serve(sp500Page(503, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']));
    await expect(svc.refreshSectorsFromWikipedia()).rejects.toThrow(/no recognisable "GICS Sector" header/);
    expect(row('MMM', 'sp500').sector).toBe('Industrial Conglomerates');
  });

  it('refuses a truncated table', async () => {
    serve(sp500Page(100));
    await expect(svc.refreshSectorsFromWikipedia()).rejects.toThrow(/only 100 S&P 500 rows/);
  });

  it('a refresh from a source with no sector (Vanguard) keeps sector and sub_industry as a pair', async () => {
    serve(sp500Page());
    await svc.refreshSectorsFromWikipedia();
    // applyRefresh deletes and re-inserts the index; without carrying sub_industry it would be wiped
    // on every Vanguard run. Called with gates off so the 2-row fixture is not a turnover refusal.
    const apply = (svc as unknown as {
      applyRefresh: (i: 'sp500', rows: { ticker: string; companyName: string | null; sector: null }[], s: string, o: { enforceGates: boolean }) => unknown;
    }).applyRefresh.bind(svc);
    apply('sp500', [{ ticker: 'MMM', companyName: '3M Company', sector: null }, { ticker: 'XOM', companyName: null, sector: null }],
      'vanguard', { enforceGates: false });
    expect(row('MMM', 'sp500')).toEqual({ company_name: '3M Company', sector: 'Industrials', sub_industry: 'Industrial Conglomerates' });
    expect(row('XOM', 'sp500')).toEqual({ company_name: 'Exxon Mobil Corp', sector: 'Energy', sub_industry: 'Integrated Oil & Gas' });
  });
});
