import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { OperatorHost } from '../src/collector/host.js';
import { saveQuestion, retireQuestion, listQuestions } from '../src/inspector/saved-questions.js';
import type { QuestionDefinition } from '../src/inspector/filters.js';

/**
 * Saved questions (05 §11.2, B9c): stored in the generation, validated by the
 * rules that run them, and never deleted.
 */

let dir: string;
let raw: Database.Database;
const db = (): SqliteLike => raw as unknown as SqliteLike;
const host = (now = '2026-09-10T20:00:00-04:00'): OperatorHost => ({ nowET: () => now, hostApp: { name: 'TradeAnalyzer 2', version: 'test' } });

const def = (over: Partial<QuestionDefinition> = {}): QuestionDefinition => ({
  filters: [{ column: 'ticker', op: 'eq', value: 'SPY' }],
  sortColumn: 'strike',
  sortDescending: false,
  versionMode: 'latest',
  asOf: null,
  columns: null,
  ...over
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-questions-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('saving a question', () => {
  it('stores it in the generation and lists it for its table', () => {
    const q = saveQuestion(db(), host(), { name: 'SPY chain', table: 'raw_option_contract_snapshot', definition: def(), note: 'weekly look' });
    expect(q.id).toBeGreaterThan(0);
    expect(listQuestions(db(), 'raw_option_contract_snapshot').map((x) => x.name)).toEqual(['SPY chain']);
    expect(listQuestions(db(), 'raw_daily_bar')).toEqual([]);
    expect(listQuestions(db())[0]!.definition.filters).toEqual([{ column: 'ticker', op: 'eq', value: 'SPY' }]);
  });

  it('replaces a name in use by retiring the old definition, never by editing it', () => {
    saveQuestion(db(), host('2026-09-10T20:00:00-04:00'), { name: 'SPY chain', table: 'raw_option_contract_snapshot', definition: def() });
    saveQuestion(db(), host('2026-09-10T21:00:00-04:00'), {
      name: 'SPY chain', table: 'raw_option_contract_snapshot', definition: def({ sortDescending: true })
    });
    const inUse = listQuestions(db());
    expect(inUse).toHaveLength(1);
    expect(inUse[0]!.definition.sortDescending).toBe(true);
    // What the name meant before is still there to read.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM meta_saved_question WHERE retired_at IS NOT NULL').get()).toEqual({ n: 1 });
  });

  it('refuses a definition the Data view could not run, and writes nothing', () => {
    expect(() =>
      saveQuestion(db(), host(), {
        name: 'broken', table: 'raw_option_contract_snapshot',
        definition: def({ filters: [{ column: 'no_such_column', op: 'eq', value: 1 }] })
      })
    ).toThrow(/no column "no_such_column"/);
    expect(() =>
      saveQuestion(db(), host(), { name: 'x', table: 'raw_option_contract_snapshot', definition: def({ filters: [{ column: 'strike', op: 'contains', value: '5' }] }) })
    ).toThrow(/cannot be filtered with "contains"/);
    expect(() => saveQuestion(db(), host(), { name: '  ', table: 'raw_option_contract_snapshot', definition: def() })).toThrow(/needs a name/);
    expect(() => saveQuestion(db(), host(), { name: 'x', table: 'sqlite_master', definition: def() })).toThrow(/declares no table/);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM meta_saved_question').get()).toEqual({ n: 0 });
  });

  it('refuses "latest" on a table with no versions to choose between', () => {
    expect(() =>
      saveQuestion(db(), host(), { name: 'x', table: 'qa_exception', definition: def({ filters: [], sortColumn: null, versionMode: 'latest' }) })
    ).toThrow(/no versions/);
  });
});

describe('retiring a question', () => {
  it('stamps retired_at and nothing else, once', () => {
    const q = saveQuestion(db(), host(), { name: 'SPY chain', table: 'raw_option_contract_snapshot', definition: def() });
    retireQuestion(db(), host(), q.id);
    expect(listQuestions(db())).toEqual([]);
    expect(() => retireQuestion(db(), host(), q.id)).toThrow(/No saved question/);
    // The table's trigger permits closing the range and nothing else.
    expect(() => raw.prepare("UPDATE meta_saved_question SET name = 'renamed' WHERE question_id = ?").run(q.id)).toThrow();
    expect(() => raw.prepare('DELETE FROM meta_saved_question').run()).toThrow(/append-only/);
  });
});
