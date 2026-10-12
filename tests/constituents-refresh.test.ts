import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { ConstituentsService } from '../src/main/services/constituents-service.js';

// The job imports fetchAndStorePrices for the new-member price bootstrap — mock the
// module so no Polygon call is ever attempted; the mock records the tickers fetched.
const fetchAndStorePricesMock = vi.fn(
  async (_svc: unknown, _provider: unknown, _ticker: string, _range: string) => 250
);
vi.mock('../src/main/services/historical-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/historical-service.js')>();
  return { ...actual, fetchAndStorePrices: fetchAndStorePricesMock };
});

const { ConstituentsRefreshJob } = await import('../src/main/services/jobs/constituents-refresh-job.js');

// ─── Vanguard API mock ────────────────────────────────────────────────────────

type Holding = { ticker: string; longName: string };

function makeHoldings(count: number, prefix = 'T'): Holding[] {
  return Array.from({ length: count }, (_, i) => ({ ticker: `${prefix}${i}`, longName: `${prefix} Corp ${i}` }));
}

/** Stub global fetch to serve paginated Vanguard holdings per fund (VOO / VONE). */
function stubVanguardFetch(byFund: Record<string, Holding[] | 'error'>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const m = /\/api\/([A-Z]+)\/portfolio-holding\/stock/.exec(url);
    const fund = m?.[1] ?? '';
    const holdings = byFund[fund];
    if (holdings === undefined || holdings === 'error') {
      return { ok: false, status: 500 } as Response;
    }
    const start = parseInt(new URL(url).searchParams.get('start') ?? '1', 10);
    const page = holdings.slice(start - 1, start - 1 + 500);
    return {
      ok: true,
      json: async () => ({ size: holdings.length, fund: { entity: page } }),
    } as Response;
  }));
}

describe('ConstituentsService — Vanguard refresh', () => {
  let db: DbHandle;
  let svc: ConstituentsService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    svc = new ConstituentsService(db);
  });

  afterEach(() => {
    db.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('populates an index from paginated Vanguard holdings and reports the diff', async () => {
    stubVanguardFetch({ VONE: makeHoldings(1002, 'R') });

    const outcome = await svc.refreshIndexAuto('russell1000');

    expect(outcome.source).toBe('vanguard');
    expect(outcome.total).toBe(1002);
    expect(outcome.added.length).toBe(1002); // empty table → everything is new
    expect(outcome.removed).toEqual([]);
    expect(svc.getConstituents('russell1000').length).toBe(1002);
    expect(svc.getMeta('russell1000')?.source).toBe('vanguard');
  });

  it('preserves sector and company name for carried-over tickers (Vanguard has no sector)', async () => {
    // Seed the full stored list directly; T0 carries a sector (as a Wikipedia/CSV
    // import would have set).
    for (const h of makeHoldings(503)) {
      db.prepare(
        `INSERT INTO constituents (ticker, index_name, company_name, sector) VALUES (?,?,?,?)`
      ).run(h.ticker, 'sp500', h.longName, h.ticker === 'T0' ? 'Technology' : null);
    }

    // Small legit change: T502 out, NEW1 in.
    const next = [...makeHoldings(502), { ticker: 'NEW1', longName: 'Newcomer Inc' }];
    stubVanguardFetch({ VOO: next });
    const outcome = await svc.refreshIndexAuto('sp500');

    expect(outcome.added).toEqual(['NEW1']);
    expect(outcome.removed).toEqual(['T502']);
    const t0 = svc.getConstituents('sp500').find((r) => r.ticker === 'T0');
    expect(t0?.sector).toBe('Technology'); // preserved across the Vanguard refresh
  });

  it('rejects a truncated feed (row-count floor) and keeps the stored list', async () => {
    for (const h of makeHoldings(503)) {
      db.prepare(`INSERT INTO constituents (ticker, index_name) VALUES (?,'sp500')`).run(h.ticker);
    }
    stubVanguardFetch({ VOO: makeHoldings(100) }); // truncated feed

    await expect(svc.refreshFromVanguard('sp500')).rejects.toThrow(/floor/);
    expect(svc.getConstituents('sp500').length).toBe(503); // untouched
  });

  it('rejects implausible turnover and keeps the stored list', async () => {
    for (const h of makeHoldings(503)) {
      db.prepare(`INSERT INTO constituents (ticker, index_name) VALUES (?,'sp500')`).run(h.ticker);
    }
    stubVanguardFetch({ VOO: makeHoldings(503, 'X') }); // 100% different tickers

    await expect(svc.refreshFromVanguard('sp500')).rejects.toThrow(/turnover/);
    expect(svc.getConstituents('sp500').find((r) => r.ticker === 'T0')).toBeDefined();
  });

  it('preserves added_at for carried-over tickers and stamps only new members', async () => {
    // Seed a stored list with a known-old added_at on all rows.
    const oldDate = '2020-01-01T00:00:00.000Z';
    for (const h of makeHoldings(503)) {
      db.prepare(
        `INSERT INTO constituents (ticker, index_name, added_at) VALUES (?, 'sp500', ?)`
      ).run(h.ticker, oldDate);
    }

    // Refresh with one member swapped out (T502 → NEW1) — a legit small change.
    const next = [...makeHoldings(502), { ticker: 'NEW1', longName: 'Newcomer Inc' }];
    stubVanguardFetch({ VOO: next });
    const before = Date.now();
    await svc.refreshIndexAuto('sp500');

    const meta = svc.getConstituentsWithMeta('sp500');
    const carried = meta.find((r) => r.ticker === 'T0');
    const fresh = meta.find((r) => r.ticker === 'NEW1');

    expect(carried?.addedAt).toBe(oldDate);           // original date preserved
    expect(new Date(fresh!.addedAt).getTime()).toBeGreaterThanOrEqual(before); // new member stamped now
    // Newest-added first ordering puts the fresh member ahead of the carried ones.
    expect(meta[0]?.ticker).toBe('NEW1');
  });

  it('keeps excluded (delisted) tickers out even when the feed still lists them', async () => {
    // Migration 085 seeds the six tickers delisted in August 2026, 092 the three from October.
    expect([...svc.getExcludedTickers()].sort()).toEqual(
      ['AVB', 'EA', 'EQR', 'LBRDA', 'LBRDK', 'PSKY', 'QRVO', 'WBD', 'WBS']
    );

    for (const h of makeHoldings(503)) {
      db.prepare(`INSERT INTO constituents (ticker, index_name) VALUES (?,'sp500')`).run(h.ticker);
    }
    // The feed swaps T502 for EA — a dead name a stale source keeps listing.
    const next = [...makeHoldings(502), { ticker: 'EA', longName: 'Electronic Arts' }];
    stubVanguardFetch({ VOO: next });
    const outcome = await svc.refreshIndexAuto('sp500');

    expect(outcome.added).toEqual([]);
    expect(outcome.removed).toEqual(['T502']);
    expect(svc.getConstituents('sp500').find((r) => r.ticker === 'EA')).toBeUndefined();
  });

  it('migration 085 removed excluded tickers already stored', () => {
    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM constituents WHERE ticker IN ('AVB','EA','EQR','LBRDA','LBRDK','WBS','PSKY','QRVO','WBD')`)
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('falls back to Wikipedia when Vanguard is down', async () => {
    // Vanguard 500s; Wikipedia serves a wikitable with enough rows to clear the floor.
    const rows = makeHoldings(503)
      .map((h) => `<tr><td>${h.ticker}</td><td>${h.longName}</td><td>Industrials</td></tr>`)
      .join('');
    const html = `<table class="wikitable"><tr><th>Symbol</th><th>Security</th><th>Sector</th></tr>${rows}</table>`;

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('vanguard.com')) return { ok: false, status: 500 } as Response;
      return { ok: true, text: async () => html } as Response;
    }));

    const outcome = await svc.refreshIndexAuto('sp500');
    expect(outcome.source).toBe('wikipedia');
    expect(outcome.total).toBeGreaterThanOrEqual(480);
  });

  it('parses Parsoid-style Wikipedia rows that carry attributes (<tr id="…">)', async () => {
    // The live page since ~2026-09-08: every row has an id, and a bare `<tr>` pattern found none.
    const rows = makeHoldings(503)
      .map((h, i) => `<tr id="mwR${i}">\n<td id="c${i}a"><a rel="mw:ExtLink nofollow" href="https://www.nyse.com/quote/XNYS:${h.ticker}" class="external text">${h.ticker}</a></td>\n<td id="c${i}b"><a href="x" title="${h.longName}">${h.longName}</a></td>\n<td id="c${i}c">Industrials</td></tr>`)
      .join('\n');
    const html = `<table class="wikitable sortable mw-collapsible sticky-header" id="constituents">\n<tbody id="mwIA"><tr id="mwIQ">\n<th id="h1">Symbol</th>\n<th id="h2">Security</th><th id="h3">GICS Sector</th></tr>\n${rows}</tbody></table>`;

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('vanguard.com')) return { ok: false, status: 500 } as Response;
      return { ok: true, text: async () => html } as Response;
    }));

    const outcome = await svc.refreshIndexAuto('sp500');
    expect(outcome.source).toBe('wikipedia');
    expect(outcome.total).toBe(503);
    expect(svc.getConstituents('sp500').find((r) => r.ticker === 'T0')?.sector).toBe('Industrials');
  });

  it('decodes HTML entities in Wikipedia sector and company cells (v1.1.341)', async () => {
    // Stored as page source until v1.1.341: the spread shadow report printed
    // `Oil &amp; Gas Exploration &amp; Production`, which a sector cap counts as its own sector.
    const rows = makeHoldings(503)
      .map((h, i) => i === 0
        ? `<tr><td>${h.ticker}</td><td>AT&amp;T Inc.</td><td>Oil &amp; Gas Exploration &amp; Production</td></tr>`
        : `<tr><td>${h.ticker}</td><td>${h.longName}</td><td>Industrials</td></tr>`)
      .join('');
    const html = `<table class="wikitable"><tr><th>Symbol</th><th>Security</th><th>Sector</th></tr>${rows}</table>`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('vanguard.com')) return { ok: false, status: 500 } as Response;
      return { ok: true, text: async () => html } as Response;
    }));

    await svc.refreshIndexAuto('sp500');
    const t0 = svc.getConstituents('sp500').find((r) => r.ticker === 'T0');
    expect(t0?.sector).toBe('Oil & Gas Exploration & Production');
    expect(t0?.companyName).toBe('AT&T Inc.');
  });

  it('calls Vanguard at its moved /vmf/api/ path, and names an HTML answer instead of a JSON parse error', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('vanguard.com')) {
        return { ok: true, status: 200, json: async () => { throw new SyntaxError(`Unexpected token '<', "<!doctype "... is not valid JSON`); } } as unknown as Response;
      }
      return { ok: false, status: 503 } as Response;
    }));

    await expect(svc.refreshFromVanguard('sp500')).rejects.toThrow(/did not return JSON — the API has probably moved/);
    expect(urls[0]).toContain('https://investor.vanguard.com/vmf/api/VOO/portfolio-holding/stock');
  });

  it("carries Vanguard's month-end as-of date into the outcome", async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const start = parseInt(new URL(url).searchParams.get('start') ?? '1', 10);
      const all = makeHoldings(1002, 'R');
      return { ok: true, json: async () => ({ size: all.length, asOfDate: '2026-07-31T00:00:00-04:00', fund: { entity: all.slice(start - 1, start - 1 + 500) } }) } as Response;
    }));
    const outcome = await svc.refreshIndexAuto('russell1000');
    expect(outcome.asOf).toBe('2026-07-31');
  });

  it('throws only when BOTH sources fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 }) as Response));
    await expect(svc.refreshIndexAuto('sp500')).rejects.toThrow(/Both constituent sources failed/);
  });
});

describe('ConstituentsRefreshJob', () => {
  let db: DbHandle;
  const noop = () => {};
  const signal = new AbortController().signal;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    fetchAndStorePricesMock.mockClear();
  });

  afterEach(() => {
    db.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubService(
    outcomes: Record<string, { added: string[]; removed: string[]; total: number } | Error>,
    sectors: { parsed: number; updated: number } | Error = { parsed: 503, updated: 1100 },
  ) {
    return {
      refreshIndexAuto: vi.fn(async (index: 'sp500' | 'russell1000') => {
        const o = outcomes[index];
        if (o instanceof Error) throw o;
        return { indexName: index, source: 'vanguard' as const, ...o };
      }),
      refreshSectorsFromWikipedia: vi.fn(async () => {
        if (sectors instanceof Error) throw sectors;
        return sectors;
      }),
    } as unknown as ConstituentsService;
  }

  it('a failed sector refresh alone is a warning that keeps the stored sectors (v1.1.342)', async () => {
    const svc = stubService(
      { sp500: { added: [], removed: [], total: 503 }, russell1000: { added: [], removed: [], total: 1002 } },
      new Error('Wikipedia fetch failed: 503'),
    );
    const result = await new ConstituentsRefreshJob(db, svc, () => 'polygon-key').run(noop, signal);
    expect(result.status).toBe('warning');
    expect(result.notes).toContain('sectors: refresh FAILED — kept stored sectors');
  });

  it('reports the sector refresh in the notes when it succeeds', async () => {
    const svc = stubService({ sp500: { added: [], removed: [], total: 503 }, russell1000: { added: [], removed: [], total: 1002 } });
    const result = await new ConstituentsRefreshJob(db, svc, () => 'polygon-key').run(noop, signal);
    expect(result.status).toBe('success');
    expect(result.notes).toContain('sectors: 1100 rows set from Wikipedia (503 S&P 500 names)');
  });

  it('bootstraps 1Y prices only for added tickers with no history at all', async () => {
    // AAPL already has bars (e.g. tracked via a watchlist) — must NOT be re-fetched.
    db.prepare(
      `INSERT INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES ('AAPL','2026-06-30',1,1,1,1,100)`
    ).run();

    const svc = stubService({
      sp500:       { added: ['AAPL', 'NEWCO'], removed: ['OLDCO'], total: 503 },
      russell1000: { added: ['NEWCO', 'FRESH'], removed: [], total: 1002 }, // NEWCO in both — deduped
    });

    const job = new ConstituentsRefreshJob(db, svc, () => 'polygon-key');
    const result = await job.run(noop, signal);

    expect(result.status).toBe('success');
    const fetched = fetchAndStorePricesMock.mock.calls.map((c) => c[2]).sort();
    expect(fetched).toEqual(['FRESH', 'NEWCO']); // AAPL skipped, NEWCO once
    expect(result.notes).toContain('NEWCO');
    expect(result.notes).toContain('OLDCO');
  });

  it('returns warning (not failed, not success) when a source outage hits both indices — stale list is usable', async () => {
    const svc = stubService({
      sp500:       new Error('Vanguard down'),
      russell1000: new Error('Vanguard down'),
    });

    const job = new ConstituentsRefreshJob(db, svc, () => 'polygon-key');
    const result = await job.run(noop, signal);

    // The orchestrator halts the nightly chain on a failed sub-job; a stale constituent
    // list must never do that. Nor may it read as green — it did not refresh anything.
    expect(result.status).toBe('warning');
    expect(result.tickersFailed).toBe(2);
    expect(result.notes).toContain('kept existing list');
    expect(fetchAndStorePricesMock).not.toHaveBeenCalled();
  });
});

describe('HTML entities in constituents (v1.1.341)', () => {
  it('decodeHtmlEntities decodes named and numeric entities in one pass', async () => {
    const { decodeHtmlEntities } = await import('../src/main/services/constituents-service.js');
    expect(decodeHtmlEntities('Oil &amp; Gas Exploration &amp; Production')).toBe('Oil & Gas Exploration & Production');
    expect(decodeHtmlEntities('Moody&#39;s &#x26; Co &quot;A&quot;')).toBe(`Moody's & Co "A"`);
    expect(decodeHtmlEntities('Lowe&#039;s&nbsp;Cos')).toBe("Lowe's Cos");
    expect(decodeHtmlEntities('a &amp;lt; b')).toBe('a &lt; b');      // one pass, never `<`
    expect(decodeHtmlEntities('Johnson & Johnson')).toBe('Johnson & Johnson');
    expect(decodeHtmlEntities('&bogus; stays')).toBe('&bogus; stays');
  });

  it('migration 090 repairs stored escaped sectors and names, and is idempotent', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    db.prepare(`INSERT INTO constituents (ticker, index_name, company_name, sector) VALUES (?, 'sp500', ?, ?)`)
      .run('XOM', 'Exxon Mobil', 'Oil &amp; Gas Exploration &amp; Production');
    db.prepare(`INSERT INTO constituents (ticker, index_name, company_name, sector) VALUES (?, 'sp500', ?, ?)`)
      .run('T', 'AT&amp;T Inc.', 'Telecom &amp;lt;x&amp;gt;');
    db.prepare(`INSERT INTO constituents (ticker, index_name, company_name, sector) VALUES (?, 'sp500', ?, ?)`)
      .run('JNJ', 'Johnson & Johnson', 'Pharmaceuticals');

    const sql = readFileSync(join(MIGRATIONS_DIR, '090_constituents_decode_entities.sql'), 'utf8');
    db.exec(sql);
    db.exec(sql);   // a second application changes nothing

    const get = (t: string) => db.prepare(`SELECT company_name, sector FROM constituents WHERE ticker = ?`).get(t) as
      { company_name: string; sector: string };
    expect(get('XOM').sector).toBe('Oil & Gas Exploration & Production');
    expect(get('T').company_name).toBe('AT&T Inc.');
    expect(get('JNJ')).toEqual({ company_name: 'Johnson & Johnson', sector: 'Pharmaceuticals' });
    db.close();
  });
});
