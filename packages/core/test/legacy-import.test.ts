import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost, ProviderResponse } from '../src/collector/host.js';
import { resetOffsetCache } from '../src/collector/archive.js';
import { runLegacyImport, validateBandOrder, CONFIG_SOURCES } from '../src/collector/legacy-import.js';

/**
 * `legacy_import` — the one-time backward import (04 §7.4, Q19).
 *
 * The legacy database here is a **fake with the real table names and the real
 * column names the importer reads**, built in a temp file. That is the whole
 * value: the importer's queries are exercised, so a renamed column fails here
 * rather than on the operator's one-shot run against a database nobody wants
 * to experiment on.
 */

let dir: string;
let raw: Database.Database;
let legacy: Database.Database;

const DATE = '2026-09-09';

function db(): SqliteLike { return raw as unknown as SqliteLike; }
function legacyDb(): SqliteLike { return legacy as unknown as SqliteLike; }

function makeHost(): CollectorHost {
  const empty: ProviderResponse = {
    status: 200, body: '{}', requestedAt: `${DATE}T18:00:00-04:00`, respondedAt: `${DATE}T18:00:01-04:00`
  };
  return {
    openGenerationDb: () => db(),
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => b,
    decryptFromArchive: (b) => b,
    polygonGet: async () => empty,
    etradeGet: async () => empty,
    httpGet: async () => empty,
    nowET: () => `${DATE}T18:00:00-04:00`,
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'TradeAnalyzer', version: '1.1.217' }
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-b8-import-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
  raw.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) " +
      "VALUES (1, '2026-09-09T00:00:00-04:00', 'pilot', 'x', 'y')"
  );

  legacy = new Database(join(dir, 'legacy.sqlite'));
  legacy.exec(`
    CREATE TABLE watchlists (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE conviction_stocks (
      ticker TEXT PRIMARY KEY, price_low REAL, price_mid REAL, price_high REAL);
    CREATE TABLE screen_presets (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE constituents (ticker TEXT, index_name TEXT);
    CREATE TABLE brief_candidates (
      as_of_date TEXT, slot TEXT, strategy TEXT, ticker TEXT,
      composite_score REAL, rank INTEGER, disposition TEXT);

    INSERT INTO watchlists (name) VALUES ('Core'), ('Watch');
    INSERT INTO conviction_stocks VALUES
      ('AAPL', 180, 200, 230),
      ('MSFT', 433, 409, 500),
      ('NOWT', 123, 108, 200);
    INSERT INTO screen_presets (name) VALUES ('High IV');
    -- The ETF list, as the old app stores it: index_name, not a 'universe' column.
    INSERT INTO constituents VALUES ('SPY', 'etf'), ('AAPL', 'sp500');
    INSERT INTO brief_candidates VALUES
      ('2026-09-01', 'intraday',    'wheel', 'WIN',  71.5, 1, 'picked'),
      ('2026-09-01', 'intraday',    'wheel', 'LOSE', 44.0, 2, 'failed_liquidity'),
      ('2026-09-01', 'after_close', 'wheel', 'WIN',  70.0, 1, 'picked');
  `);
  resetOffsetCache();
});

afterEach(() => {
  raw.close();
  legacy.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('category 1 — user-authored configuration', () => {
  it('rejects an inverted conviction band instead of carrying it', () => {
    // Q19 names this case: "the old conviction table held inverted bands for
    // three weeks — the import must catch that, not carry it." An inverted
    // band never throws, it just computes the wrong zone, so it fed wrong
    // Buy-zone alerts silently for three weeks.
    const report = runLegacyImport(makeHost(), { legacyDb: legacyDb(), tradingDate: DATE });
    const conviction = report.tables.find((t) => t.sourceTable === 'conviction_stocks')!;

    expect(conviction.rowsRead).toBe(3);
    expect(conviction.rowsWritten).toBe(1);   // AAPL only
    expect(conviction.rowsRejected).toBe(2);  // MSFT 433/409, NOWT 123/108
    expect(conviction.rejections.map((r) => r.key).sort()).toEqual(['MSFT', 'NOWT']);
    expect(conviction.rejections[0]!.why).toMatch(/not below/);
  });

  it('lists every rejected row with its reason, rather than counting them', () => {
    runLegacyImport(makeHost(), { legacyDb: legacyDb(), tradingDate: DATE });
    const log = raw
      .prepare("SELECT rejection_report_json FROM legacy_import_log WHERE source_table = 'conviction_stocks'")
      .get() as { rejection_report_json: string };

    // A count says the import dropped something; the list says what and why,
    // which is the difference between a finding and a rumour.
    const rejections = JSON.parse(log.rejection_report_json) as { key: string; why: string }[];
    expect(rejections).toHaveLength(2);
    expect(rejections.every((r) => r.why.length > 0)).toBe(true);
  });

  it('copies the valid configuration and stamps its origin', () => {
    runLegacyImport(makeHost(), { legacyDb: legacyDb(), tradingDate: DATE });
    const kinds = raw
      .prepare('SELECT config_kind, COUNT(*) AS n FROM legacy_config_import GROUP BY config_kind ORDER BY config_kind')
      .all() as { config_kind: string; n: number }[];

    expect(kinds).toEqual([
      { config_kind: 'conviction_stock', n: 1 },
      { config_kind: 'etf_list', n: 1 },
      { config_kind: 'screen_preset', n: 1 },
      { config_kind: 'watchlist', n: 2 }
    ]);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM legacy_config_import WHERE origin <> 'legacy_import'").get())
      .toEqual({ n: 0 });
  });

  it('records an absent source table rather than skipping it silently', () => {
    // "This install had no payoff strategies" and "the importer forgot payoff
    // strategies" must not look the same in the log.
    const report = runLegacyImport(makeHost(), { legacyDb: legacyDb(), tradingDate: DATE });
    const missing = report.tables.find((t) => t.sourceTable === 'payoff_strategies')!;
    expect(missing.rowsRead).toBe(0);
    expect(missing.rejections[0]!.why).toMatch(/not present/);
  });

  it('names a source for every configured kind', () => {
    // The dictionary's `config_kind` enum and the importer's source list must
    // not drift: a kind with no source would be a category quietly not copied.
    expect(CONFIG_SOURCES.map((s) => s.kind).sort()).toEqual([
      'conviction_band', 'conviction_stock', 'etf_list',
      'payoff_strategy', 'scoring_config', 'screen_preset', 'watchlist'
    ]);
  });
});

describe('category 5 — the old app\'s stored decisions', () => {
  it('marks every imported decision pre_collector = 1', () => {
    runLegacyImport(makeHost(), { legacyDb: legacyDb(), tradingDate: DATE });
    const runs = raw.prepare('SELECT pre_collector FROM legacy_brief_run').all() as { pre_collector: number }[];

    // These rows are survivors-only and incomplete; rows handed over live
    // carry the losers and both slots. Pooling a biased sample with an
    // unbiased one, with nothing to tell them apart, is the failure this flag
    // exists to prevent.
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.pre_collector === 1)).toBe(true);
  });

  it('keeps the two daily slots as separate runs', () => {
    runLegacyImport(makeHost(), { legacyDb: legacyDb(), tradingDate: DATE });
    const runs = raw.prepare('SELECT slot FROM legacy_brief_run ORDER BY slot').all() as { slot: string }[];
    // The old app's `intraday` is this vocabulary's `morning`.
    expect(runs.map((r) => r.slot)).toEqual(['after_close', 'morning']);
  });

  it('imports the losers too', () => {
    const report = runLegacyImport(makeHost(), { legacyDb: legacyDb(), tradingDate: DATE });
    expect(report.decisionRows).toBe(3);
    const survived = raw
      .prepare('SELECT ticker, survived FROM legacy_brief_candidate ORDER BY ticker, survived')
      .all() as { ticker: string; survived: number }[];
    expect(survived.filter((r) => r.survived === 0).map((r) => r.ticker)).toEqual(['LOSE']);
  });
});

describe('provenance and re-runnability', () => {
  it('archives what it read, so an imported row can be traced to it', () => {
    runLegacyImport(makeHost(), { legacyDb: legacyDb(), tradingDate: DATE });

    // AC-1 for the import: the rows read out of the old database ARE the
    // source, so archiving them makes `source_response_id` a true claim rather
    // than a convenient one — including for the rows that were rejected, which
    // is the only way a disputed rejection can be re-examined.
    const orphans = raw
      .prepare('SELECT COUNT(*) AS n FROM legacy_config_import WHERE source_response_id IS NULL')
      .get();
    expect(orphans).toEqual({ n: 0 });

    const archived = raw
      .prepare("SELECT COUNT(*) AS n FROM meta_response WHERE endpoint LIKE 'legacy/import/%'")
      .get() as { n: number };
    expect(archived.n).toBeGreaterThan(0);
  });

  it('re-running versions the configuration and does NOT duplicate the decisions', () => {
    // 04 §7.4 said a second import "writes nothing already present (natural
    // keys)". `naturalKey` is metadata only — the DDL generator emits no
    // unique index from it — so `INSERT OR IGNORE` would have read as
    // protection while providing none. The two halves want different
    // behaviour and both are now explicit.
    const host = makeHost();
    runLegacyImport(host, { legacyDb: legacyDb(), tradingDate: DATE });
    const firstConfig = raw.prepare('SELECT COUNT(*) AS n FROM legacy_config_import').get() as { n: number };
    const firstDecisions = raw.prepare('SELECT COUNT(*) AS n FROM legacy_brief_candidate').get() as { n: number };

    runLegacyImport(host, { legacyDb: legacyDb(), tradingDate: DATE });

    // Configuration: `import_run_id` is part of its natural key, so each
    // import is an event. That also answers what the config looked like at
    // each import, which a deduplicated table could not.
    expect((raw.prepare('SELECT COUNT(*) AS n FROM legacy_config_import').get() as { n: number }).n)
      .toBe(firstConfig.n * 2);

    // Decisions: keyed with no import id, so without the check a second
    // import would duplicate 62 briefs' worth of history.
    expect((raw.prepare('SELECT COUNT(*) AS n FROM legacy_brief_candidate').get() as { n: number }).n)
      .toBe(firstDecisions.n);
    expect((raw.prepare('SELECT COUNT(*) AS n FROM legacy_brief_run').get() as { n: number }).n).toBe(2);
  });
});

describe('validateBandOrder', () => {
  it('accepts a well-ordered band and an incomplete one', () => {
    expect(validateBandOrder({ price_low: 1, price_mid: 2, price_high: 3 }).ok).toBe(true);
    // A missing band is incomplete, not inverted — rejecting it would refuse
    // rows the operator simply had not finished filling in.
    expect(validateBandOrder({ price_low: 1, price_high: 3 }).ok).toBe(true);
    expect(validateBandOrder({}).ok).toBe(true);
  });

  it('rejects each inversion, including the pair that skips the middle', () => {
    expect(validateBandOrder({ price_low: 3, price_mid: 2 }).ok).toBe(false);
    expect(validateBandOrder({ price_mid: 3, price_high: 2 }).ok).toBe(false);
    // low vs high with no mid present: neither pairwise check above covers it.
    expect(validateBandOrder({ price_low: 5, price_high: 4 }).ok).toBe(false);
  });

  it('rejects equal bounds, which make a zone of zero width', () => {
    expect(validateBandOrder({ price_low: 2, price_mid: 2, price_high: 3 }).ok).toBe(false);
  });
});
