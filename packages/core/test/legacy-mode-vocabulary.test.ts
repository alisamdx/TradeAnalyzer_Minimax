import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDictionary } from '../src/dictionary/apply.js';
import { DICTIONARY, getTable } from '../src/dictionary/index.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { TableEntry } from '../src/dictionary/types.js';

/**
 * `legacy_brief_candidate.mode` and the existing app's `STRATEGIES` are ONE
 * vocabulary, and this asserts they are spelled the same.
 *
 * They were not, from the day the contract shipped. The dictionary enum was
 * `['wheel', 'buy', 'options', 'bullish', 'bearish']` — copied from CLAUDE.md's
 * prose about the *analysis* engine rather than from either source type, and
 * matching neither: the analysis engine's value is `options_income`, the brief's
 * is `income`, and `'options'` was an orphan nothing could ever write.
 *
 * The brief scores all six strategies every run, so every hand-off carried
 * `income` candidates, every insert violated the CHECK inside the write
 * transaction, and `indexAndIngest` recorded `parse_status = 'failed'` with zero
 * rows. Three hand-offs over two days, `legacy_brief_candidate` at 0 rows, and
 * nothing said so: a hand-off runs as a MANUAL run, manual runs are not
 * gate-evaluated, and the parse error was computed and discarded.
 *
 * Two things hid it, and this file removes both:
 *   1. An `as` cast at the hand-off site silenced the compiler. Deleted.
 *   2. Every fixture used `mode: 'wheel'` — inside the four values the two lists
 *      happened to share. **A fixture drawn from the overlap of two vocabularies
 *      cannot test that they agree.**
 */

const MODE_COLUMN = () => {
  const table = getTable('legacy_brief_candidate');
  const column = table?.columns.find((c) => c.column === 'mode');
  if (!column) throw new Error('legacy_brief_candidate.mode is missing from the dictionary');
  return column;
};

/**
 * The existing app's list, read from ITS source rather than restated here.
 *
 * Restating it would make this test agree with a copy — the exact failure it
 * exists to catch. `scoring-service.ts` is outside this package, so it is read
 * as text: `core` must not import from the host application.
 */
function briefStrategies(): readonly string[] {
  const src = readFileSync(
    fileURLToPath(new URL('../../../src/main/services/scoring-service.ts', import.meta.url)),
    'utf8'
  );
  const m = src.match(/export const STRATEGIES:\s*ScoringStrategy\[\]\s*=\s*\[([^\]]+)\]/);
  if (!m) throw new Error('Could not read STRATEGIES from scoring-service.ts');
  return (m[1] as string).split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

describe('the legacy mode vocabulary', () => {
  it('is exactly the existing app\'s scoring strategies', () => {
    const declared = [...(MODE_COLUMN().enumValues ?? [])].sort();
    const actual = [...briefStrategies()].sort();
    expect(declared).toEqual(actual);
  });

  it('has no value the brief cannot produce', () => {
    // `'options'` sat here for six versions and nothing ever wrote it. An enum
    // value no producer can emit is indistinguishable from one that is simply
    // never exercised — until the day a missing value rejects every row.
    const declared = MODE_COLUMN().enumValues ?? [];
    for (const value of declared) expect(briefStrategies()).toContain(value);
  });
});

describe('the v14 enum change on an EMPTY candidate table', () => {
  let dir: string;
  let raw: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ta-v14-'));
    raw = new Database(join(dir, 'gen.sqlite'));
  });

  afterEach(() => {
    raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A candidate row that is valid in EVERY respect except the one under test.
   *
   * `source_response_id` is NOT NULL with a foreign key, and `run_id` references
   * `meta_run` — so a row missing either throws before the `mode` CHECK is ever
   * reached. The first version of this test omitted `source_response_id` and
   * "passed": it asserted only that something threw, and the thing that threw
   * was the fixture. **A test that passes for the wrong reason is worse than one
   * that fails**, so the insert is complete and the assertion names the column.
   */
  function insertCandidate(mode: string): void {
    raw.exec(
      'INSERT INTO legacy_brief_candidate (run_id, as_of_date, observed_at, source_response_id, ' +
        'legacy_run_id, ticker, mode, considered_rank, survived, composite_score, composite_score_status) ' +
        `VALUES (1,'2026-09-11','t',1,'2026-09-11:after_close:nobrief','AAPL','${mode}',1,1,0.7,'ok')`
    );
  }

  /** The rows the foreign keys point at, so a failure can only be the CHECK. */
  function seedProvenance(): void {
    raw.exec(
      "INSERT INTO meta_run (run_id, run_kind, slot, trading_date, started_at, status, host_app, host_version, collector_version, dictionary_version) " +
        "VALUES (1,'manual','after_close','2026-09-11','t','complete','test','0','0',14)"
    );
    raw.exec(
      "INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) " +
        "VALUES (1,1,'host_app','legacy/brief-handoff','{}','t','a',0,'h',0,0,'failed')"
    );
  }

  /** The dictionary as it stood at v13: the old five-value `mode` enum. */
  function v13Dictionary(): TableEntry[] {
    return DICTIONARY.map((t) =>
      t.table === 'legacy_brief_candidate'
        ? {
            ...t,
            columns: t.columns.map((c) =>
              c.column === 'mode'
                ? { ...c, enumValues: ['wheel', 'buy', 'options', 'bullish', 'bearish'] }
                : c
            )
          }
        : t
    );
  }

  it('rebuilds the table and leaves its foreign-key children intact', () => {
    const db = raw as unknown as SqliteLike;
    raw.pragma('foreign_keys = ON');
    applyDictionary(db, v13Dictionary());
    seedProvenance();

    // The bug, reproduced. Only the REFUSAL is asserted here: the table is
    // append-only, so a row inserted to prove the other direction could never be
    // removed — and this test's whole precondition is an EMPTY table, which is
    // what sends `applyDictionary` down the rebuild path rather than the
    // populated one. The accepted-value half runs on its own database below.
    expect(() => insertCandidate('income')).toThrow(/CHECK constraint failed/);

    const result = applyDictionary(db);
    expect(result.tablesRebuilt).toContain('legacy_brief_candidate');
    // Reported drift would mean the change did NOT apply — the populated-table
    // path. It must be a clean rebuild, or gen-001 needs a new generation.
    expect(result.driftBlocked).not.toContain('legacy_brief_candidate');

    // The children carry foreign keys to the table just dropped and recreated.
    // `PRAGMA foreign_keys = OFF` is a no-op inside a transaction (CLAUDE.md), so
    // a rebuild of a parent is exactly where a cascade would quietly empty them.
    for (const child of [
      'legacy_brief_candidate_gate',
      'legacy_brief_candidate_signal',
      'legacy_brief_leg',
      'legacy_critic_verdict'
    ]) {
      expect(() => raw.prepare(`SELECT COUNT(*) FROM "${child}"`).get()).not.toThrow();
    }

    // And the value that failed a moment ago now inserts.
    insertCandidate('income');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM legacy_brief_candidate').get()).toEqual({ n: 1 });
  });

  it('the old enum accepted the four shared values — so the refusal above is the mode, not the fixture', () => {
    // The other direction, on its own database. `legacy_brief_candidate` is
    // append-only, so a row written here could not be deleted, and the test
    // above needs its table empty to exercise the rebuild path at all.
    //
    // Without this, the refusal above proves only that *something* threw. The
    // pair is what distinguishes "the enum rejected `income`" from "the fixture
    // was malformed" — which is the mistake the first draft of this file made.
    const other = new Database(join(dir, 'accepts.sqlite'));
    try {
      other.pragma('foreign_keys = ON');
      const odb = other as unknown as SqliteLike;
      applyDictionary(odb, v13Dictionary());

      other.exec(
        "INSERT INTO meta_run (run_id, run_kind, slot, trading_date, started_at, status, host_app, host_version, collector_version, dictionary_version) " +
          "VALUES (1,'manual','after_close','2026-09-11','t','complete','test','0','0',13)"
      );
      other.exec(
        "INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) " +
          "VALUES (1,1,'host_app','legacy/brief-handoff','{}','t','a',0,'h',0,0,'failed')"
      );
      other.exec(
        'INSERT INTO legacy_brief_candidate (run_id, as_of_date, observed_at, source_response_id, ' +
          'legacy_run_id, ticker, mode, considered_rank, survived, composite_score, composite_score_status) ' +
          "VALUES (1,'2026-09-11','t',1,'2026-09-11:after_close:nobrief','AAPL','wheel',1,1,0.7,'ok')"
      );

      expect(other.prepare('SELECT COUNT(*) AS n FROM legacy_brief_candidate').get()).toEqual({ n: 1 });
    } finally {
      other.close();
    }
  });
});
