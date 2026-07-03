// Universe = All + Filters Prefill batch job (v1.1.114).
// Covers: (1) getConstituents('all') = sp500 + russell1000 + etf deduplicated,
// (2) per-ticker ETF calibration in a mixed 'all' scan (ETF thresholds apply only
//     to ETF names — a universe-wide flag would mis-calibrate one side),
// (3) saveRun/getSavedRuns round-trip incl. stale shape_version filtering,
// (4) FiltersPrefillJob: runs every template over Universe=All, stores results,
//     continues past a failing template, and stops cleanly on abort.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { ConstituentsService } from '../src/main/services/constituents-service.js';
import { FilterTemplatesService } from '../src/main/services/filter-templates-service.js';
import { FiltersPrefillJob, DEFAULT_PREFILL_TEMPLATES } from '../src/main/services/jobs/filters-prefill-job.js';
import { QuoteCache, FundamentalsCache } from '../src/main/services/cache-service.js';
import { FILTER_TEMPLATES, FILTER_RESULTS_SHAPE_VERSION } from '../src/shared/filter-templates.js';
import type { DataProvider, QuoteSnapshot } from '../src/main/services/data-provider.js';
import type { FilterTemplateResult } from '../src/shared/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedConstituent(db: DbHandle, index: string, ticker: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO constituents (index_name, ticker, company_name, sector) VALUES (?, ?, ?, NULL)`
  ).run(index, ticker, `${ticker} Corp`);
}

function fakeQuote(ticker: string, ivRank: number | null): QuoteSnapshot {
  return {
    ticker, last: 100, prevClose: 99, bid: 99.9, ask: 100.1, volume: 1_000_000,
    dayHigh: 101, dayLow: 99, ivRank, ivPercentile: null, fetchedAt: new Date().toISOString(),
  };
}

/** DataProvider stub — only the methods the exercised templates touch. */
function fakeDataProvider(ivRankByTicker: Record<string, number | null>): DataProvider {
  return {
    name: 'fake',
    getQuote: async (t: string) => fakeQuote(t, ivRankByTicker[t] ?? null),
    getFundamentals: async () => { throw new Error('not used'); },
    getEarningsCalendar: async () => { throw new Error('not used'); },
    getHistoricalBars: async () => [],
    getOptionsChain: async () => { throw new Error('not used'); },
    getOptionsIV: async () => ({ currentIv: null, iv52WkHigh: null, iv52WkLow: null }),
    getIndexConstituents: async () => [],
    ping: async () => undefined,
  };
}

function makeService(db: DbHandle, dataProvider: DataProvider): FilterTemplatesService {
  return new FilterTemplatesService(
    db, dataProvider, null, new QuoteCache(db), new FundamentalsCache(db), new ConstituentsService(db)
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Universe 'all'", () => {
  let db: DbHandle;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    seedConstituent(db, 'sp500', 'AAA');
    seedConstituent(db, 'sp500', 'SHARED');
    seedConstituent(db, 'russell1000', 'SHARED'); // overlaps sp500 — must dedupe
    seedConstituent(db, 'russell1000', 'BBB');
    seedConstituent(db, 'etf', 'ETF1');
  });

  afterEach(() => { db.close(); });

  it("getConstituents('all') is the deduplicated union of sp500 + russell1000 + etf", () => {
    const svc = new ConstituentsService(db);
    const tickers = svc.getConstituents('all').map(c => c.ticker).sort();
    expect(tickers).toEqual(['AAA', 'BBB', 'ETF1', 'SHARED']);
  });

  it("applies ETF calibration per-ticker in a mixed 'all' scan (iv_rank_high)", async () => {
    // IV rank 40: above the ETF 'high' threshold (30) but below the stock threshold (70).
    // In an 'all' scan only the ETF must match — proving the flag is per-ticker.
    const svc = makeService(db, fakeDataProvider({ AAA: 40, SHARED: 40, BBB: 40, ETF1: 40 }));
    const results = await svc.runTemplate('iv_rank_high', 'universe', 'all');
    expect(results.map(r => r.ticker)).toEqual(['ETF1']);
    expect(results[0]!.matchReason).toContain('ETF');
  });

  it("stock names still match iv_rank_high in an 'all' scan above the stock threshold", async () => {
    const svc = makeService(db, fakeDataProvider({ AAA: 80, SHARED: 10, BBB: 10, ETF1: 10 }));
    const results = await svc.runTemplate('iv_rank_high', 'universe', 'all');
    expect(results.map(r => r.ticker)).toEqual(['AAA']);
  });
});

describe('saveRun / getSavedRuns', () => {
  let db: DbHandle;
  let svc: FilterTemplatesService;

  const sample: FilterTemplateResult[] = [
    { ticker: 'AAA', watchlists: ['All'], lastPrice: 100, metrics: { rsi: 75 }, matchReason: 'RSI 75' },
  ];

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    svc = makeService(db, fakeDataProvider({}));
  });

  afterEach(() => { db.close(); });

  it('round-trips a stored run and overwrites on re-save (latest-only)', () => {
    svc.saveRun('rsi_overbought', 'all', sample, '2026-07-02T21:30:00.000Z');
    svc.saveRun('rsi_overbought', 'all', [], '2026-07-03T21:30:00.000Z'); // overwrite

    const runs = svc.getSavedRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.templateId).toBe('rsi_overbought');
    expect(runs[0]!.ranAt).toBe('2026-07-03T21:30:00.000Z');
    expect(runs[0]!.resultCount).toBe(0);
    expect(runs[0]!.results).toEqual([]);
  });

  it('ignores rows written by an older shape version', () => {
    db.prepare(`
      INSERT INTO filter_template_runs (template_id, ran_at, universe, result_count, results_json, shape_version)
      VALUES ('rsi_oversold', '2026-07-01T21:30:00.000Z', 'all', 1, ?, ?)
    `).run(JSON.stringify(sample), FILTER_RESULTS_SHAPE_VERSION - 1);

    expect(svc.getSavedRuns()).toHaveLength(0);
  });
});

describe('FiltersPrefillJob', () => {
  const noProgress = () => undefined;

  function stubService(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      runTemplate: vi.fn(async (templateId: string) =>
        [{ ticker: 'AAA', watchlists: ['All'], lastPrice: 1, metrics: {}, matchReason: templateId }]),
      saveRun: vi.fn(),
      ...overrides,
    } as unknown as FilterTemplatesService;
  }

  /** Minimal DbHandle stub — serves a batch_jobs.config_json row for the job's allowlist read.
   *  `enabledTemplates: null` → no config row (job falls back to DEFAULT_PREFILL_TEMPLATES). */
  function stubDb(enabledTemplates: string[] | null): import('../src/main/db/connection.js').DbHandle {
    const config_json = enabledTemplates === null ? null : JSON.stringify({ enabledTemplates });
    return {
      prepare: () => ({ get: () => (config_json === null ? undefined : { config_json }) }),
    } as unknown as import('../src/main/db/connection.js').DbHandle;
  }

  const ALL_IDS = FILTER_TEMPLATES.map(t => t.id);

  it('runs the configured templates over Universe=All and stores each result set', async () => {
    const svc = stubService();
    const job = new FiltersPrefillJob(svc, stubDb(ALL_IDS)); // enable all for this assertion
    const result = await job.run(noProgress, new AbortController().signal);

    expect(result.status).toBe('success');
    expect(result.tickersUpdated).toBe(FILTER_TEMPLATES.length);
    const runCalls = (svc.runTemplate as ReturnType<typeof vi.fn>).mock.calls;
    expect(runCalls.map(c => c[0]).sort()).toEqual([...ALL_IDS].sort());
    for (const call of runCalls) {
      expect(call[1]).toBe('universe');
      expect(call[2]).toBe('all');
    }
    expect(svc.saveRun).toHaveBeenCalledTimes(FILTER_TEMPLATES.length);
  });

  it('runs only DEFAULT_PREFILL_TEMPLATES when no allowlist is configured', async () => {
    const svc = stubService();
    const job = new FiltersPrefillJob(svc, stubDb(null));
    const result = await job.run(noProgress, new AbortController().signal);

    expect(result.status).toBe('success');
    const ran = (svc.runTemplate as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]).sort();
    expect(ran).toEqual([...DEFAULT_PREFILL_TEMPLATES].sort());
    // The unused heavy filters are never scanned.
    expect(ran).not.toContain('rsi_overbought');
    expect(ran).not.toContain('assignment_risk');
  });

  it('honors an explicit allowlist and skips everything else', async () => {
    const svc = stubService();
    const job = new FiltersPrefillJob(svc, stubDb(['wheel_vetted']));
    await job.run(noProgress, new AbortController().signal);
    const ran = (svc.runTemplate as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    expect(ran).toEqual(['wheel_vetted']);
  });

  it('skips cleanly when the allowlist is empty', async () => {
    const svc = stubService();
    const job = new FiltersPrefillJob(svc, stubDb([]));
    const result = await job.run(noProgress, new AbortController().signal);
    expect(result.status).toBe('skipped');
    expect(svc.runTemplate).not.toHaveBeenCalled();
    expect(svc.saveRun).not.toHaveBeenCalled();
  });

  it('continues past a failing template and reports it in the notes', async () => {
    const svc = stubService({
      runTemplate: vi.fn(async (templateId: string) => {
        if (templateId === 'iv_rank_high') throw new Error('provider down');
        return [];
      }),
    });
    const job = new FiltersPrefillJob(svc, stubDb(ALL_IDS));
    const result = await job.run(noProgress, new AbortController().signal);

    expect(result.status).toBe('success');
    expect(result.tickersUpdated).toBe(FILTER_TEMPLATES.length - 1);
    expect(result.tickersFailed).toBe(1);
    expect(result.notes).toContain('IV High');
    expect(svc.saveRun).toHaveBeenCalledTimes(FILTER_TEMPLATES.length - 1);
  });

  it('fails outright only when every template fails', async () => {
    const svc = stubService({
      runTemplate: vi.fn(async () => { throw new Error('all down'); }),
    });
    const job = new FiltersPrefillJob(svc, stubDb(ALL_IDS));
    const result = await job.run(noProgress, new AbortController().signal);
    expect(result.status).toBe('failed');
    expect(svc.saveRun).not.toHaveBeenCalled();
  });

  it('stops on abort without storing a partial scan', async () => {
    const ac = new AbortController();
    const svc = stubService({
      runTemplate: vi.fn(async () => {
        ac.abort(); // abort fires mid-scan of the first template
        return [{ ticker: 'PARTIAL', watchlists: [], lastPrice: 1, metrics: {}, matchReason: '' }];
      }),
    });
    const job = new FiltersPrefillJob(svc, stubDb(ALL_IDS));
    const result = await job.run(noProgress, ac.signal);

    expect(svc.saveRun).not.toHaveBeenCalled();          // partial results never stored
    expect(result.tickersUpdated).toBe(0);
    expect((svc.runTemplate as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
