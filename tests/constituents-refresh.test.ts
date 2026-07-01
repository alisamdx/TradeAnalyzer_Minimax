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

  function stubService(outcomes: Record<string, { added: string[]; removed: string[]; total: number } | Error>) {
    return {
      refreshIndexAuto: vi.fn(async (index: 'sp500' | 'russell1000') => {
        const o = outcomes[index];
        if (o instanceof Error) throw o;
        return { indexName: index, source: 'vanguard' as const, ...o };
      }),
    } as unknown as ConstituentsService;
  }

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

  it('returns success (not failed) when a source outage hits both indices — stale list is usable', async () => {
    const svc = stubService({
      sp500:       new Error('Vanguard down'),
      russell1000: new Error('Vanguard down'),
    });

    const job = new ConstituentsRefreshJob(db, svc, () => 'polygon-key');
    const result = await job.run(noop, signal);

    // The orchestrator halts the nightly chain on a failed sub-job; a stale constituent
    // list must never do that.
    expect(result.status).toBe('success');
    expect(result.tickersFailed).toBe(2);
    expect(result.notes).toContain('kept existing list');
    expect(fetchAndStorePricesMock).not.toHaveBeenCalled();
  });
});
