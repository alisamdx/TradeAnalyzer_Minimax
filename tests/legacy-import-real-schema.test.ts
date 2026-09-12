import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyDictionary, resetOffsetCache, runLegacyImport, type SqliteLike } from '@tradeanalyzer/core';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

/**
 * `legacy_import` against THIS app's real schema — built from `migrations/`,
 * not from a hand-written fake.
 *
 * Found 2026-09-12 on its first real run after a reset: `legacy_import: 0
 * config rows, 0 decisions`, in 0 seconds. Two defects, one hiding the other:
 *
 * 1. `collector-oneshot` passed the NEW GENERATION as `legacyDb` (`db as
 *    never`), so every source table read as "not present in the legacy
 *    database" and the job reported success. It had never imported a row.
 * 2. The ETF-list query read `constituents.universe`, a column that has never
 *    existed (it is `index_name`). Once (1) was fixed it would have thrown
 *    inside the import transaction.
 *
 * Core's own test builds its legacy tables from the importer's assumptions,
 * which is exactly why (2) passed there. A fixture shaped by the code under
 * test cannot tell you the code is wrong about the world.
 */

type Host = Parameters<typeof runLegacyImport>[0];

const DATE = '2026-09-11';
const STRATEGIES = ['wheel', 'bullish', 'bearish', 'income', 'buy', 'inflection'] as const;

let dir: string;
let gen: Database.Database;
let legacy: ReturnType<typeof openDatabase>;

function makeHost(): Host {
  const empty = { status: 200, body: '{}', requestedAt: `${DATE}T18:00:00-04:00`, respondedAt: `${DATE}T18:00:01-04:00` };
  return {
    openGenerationDb: () => gen as unknown as SqliteLike,
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b: Buffer) => b,
    decryptFromArchive: (b: Buffer) => b,
    polygonGet: async () => empty,
    etradeGet: async () => empty,
    httpGet: async () => empty,
    nowET: () => `${DATE}T18:00:00-04:00`,
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'TradeAnalyzer', version: 'test' }
  } as unknown as Host;
}

const count = (sql: string): number => (legacy.prepare(sql).get() as { n: number }).n;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-legacy-real-'));
  gen = new Database(join(dir, 'data.sqlite'));
  applyDictionary(gen as unknown as SqliteLike);
  gen.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) " +
      `VALUES (2, '${DATE}T16:50:00-04:00', 'pilot', 'x', 'y')`
  );
  resetOffsetCache();

  legacy = openDatabase(':memory:');
  runMigrations(legacy, MIGRATIONS_DIR);
  legacy.exec(`
    INSERT INTO watchlists (name) VALUES ('Legacy import test');
    INSERT OR IGNORE INTO constituents (ticker, index_name) VALUES ('SPY', 'etf'), ('QQQ', 'etf'), ('AAPL', 'sp500');
    INSERT INTO screen_presets (name, criteria_json) VALUES ('High IV', '{}');
    INSERT INTO payoff_strategies (name, legs_json) VALUES ('Test fly', '[]');
    INSERT OR IGNORE INTO scoring_strategy_configs (strategy, signals) VALUES ('wheel', '[]');
    INSERT INTO conviction_stocks (ticker, price_low, price_mid, price_high) VALUES ('AAPL', 180, 200, 230);
    INSERT INTO conviction_band_history (ticker, price_low, price_mid, price_high) VALUES ('AAPL', 180, 200, 230);
  `);
  const insertCandidate = legacy.prepare(
    `INSERT INTO brief_candidates (as_of_date, generated_at, strategy, ticker, composite_score, rank, disposition, slot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // Every strategy the brief scores, in both of the brief's real slot values.
  for (const strategy of STRATEGIES) {
    insertCandidate.run('2026-09-10', '2026-09-10T14:20:00.000Z', strategy, 'WIN', 70, 1, 'picked', 'intraday');
    insertCandidate.run('2026-09-10', '2026-09-10T21:30:00.000Z', strategy, 'LOSE', 41, 2, 'capped_out', 'after_close');
  }
});

afterEach(() => {
  gen.close();
  legacy.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('legacy_import against the real legacy schema', () => {
  it('finds every source table and reads every row the source query selects', () => {
    const report = runLegacyImport(makeHost(), {
      legacyDb: legacy as unknown as SqliteLike, tradingDate: DATE
    });

    const absent = report.tables.filter((t) => t.rejections.some((r) => /not present/.test(r.why)));
    expect(absent.map((t) => t.sourceTable)).toEqual([]);

    const read = Object.fromEntries(report.tables.map((t) => [t.sourceTable, t.rowsRead]));
    expect(read['watchlists']).toBe(count('SELECT COUNT(*) AS n FROM watchlists'));
    expect(read['constituents']).toBe(count("SELECT COUNT(*) AS n FROM constituents WHERE index_name = 'etf'"));
    expect(read['constituents']).toBeGreaterThanOrEqual(2);
    expect(read['screen_presets']).toBe(count('SELECT COUNT(*) AS n FROM screen_presets'));
    expect(read['payoff_strategies']).toBe(count('SELECT COUNT(*) AS n FROM payoff_strategies'));
    expect(read['scoring_strategy_configs']).toBe(count('SELECT COUNT(*) AS n FROM scoring_strategy_configs'));
    expect(read['conviction_stocks']).toBe(1);
    expect(read['conviction_band_history']).toBeGreaterThanOrEqual(1);
    expect(read['brief_candidates']).toBe(STRATEGIES.length * 2);

    expect(report.configRows).toBeGreaterThan(0);
    expect(report.decisionRows).toBe(STRATEGIES.length * 2);
  });

  it('files the brief\'s two slots as morning and after_close runs', () => {
    runLegacyImport(makeHost(), { legacyDb: legacy as unknown as SqliteLike, tradingDate: DATE });
    const slots = gen.prepare('SELECT slot FROM legacy_brief_run ORDER BY slot').all() as { slot: string }[];
    expect(slots.map((s) => s.slot)).toEqual(['after_close', 'morning']);
  });
});

describe('collector-oneshot hands the importer THIS app\'s database', () => {
  const oneshot = readFileSync(resolve('src/main/services/jobs/collector-oneshot.ts'), 'utf8');
  const index = readFileSync(resolve('src/main/index.ts'), 'utf8');

  it('passes deps.legacyDb, not the generation handle', () => {
    const start = oneshot.indexOf("request.runKind === 'legacy_import'");
    // Non-vacuity: without the anchor the slice below is the tail of the file.
    expect(start).toBeGreaterThan(-1);
    const branch = oneshot.slice(start, oneshot.indexOf('request.runKind ===', start + 1));
    expect(branch).toContain('legacyDb: deps.legacyDb');
    expect(branch).not.toContain('as never');
  });

  it('is wired with the app database at registration', () => {
    const start = index.indexOf('createCollectorOneShotJob(');
    expect(start).toBeGreaterThan(-1);
    expect(index.slice(start, index.indexOf('});', start))).toContain('legacyDb: db');
  });
});
