import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DICTIONARY } from '../src/dictionary/index.js';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import {
  assertAnchored, filterSql, indexedColumns, opsFor, validateFilter, validateDefinition, versionPartition,
  FilterRefused, SMALL_TABLE_ROWS
} from '../src/inspector/filters.js';

/**
 * The inspector's filter model (05 §3.2, §8, B9c). Dictionary-driven, so every
 * assertion here is against a real table's declaration.
 */

const chain = DICTIONARY.find((t) => t.table === 'raw_option_contract_snapshot')!;
const col = (name: string) => chain.columns.find((c) => c.column === name)!;

describe('what each column type accepts', () => {
  it('offers operators by type, and null tests only where the dictionary allows a null', () => {
    expect(opsFor(col('strike'))).toEqual(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']);
    expect(opsFor(col('right'))).toEqual(['eq', 'ne', 'in']);
    expect(opsFor(col('expiration_date'))).toEqual(['eq', 'lt', 'lte', 'gt', 'gte']);
    expect(opsFor(col('observed_at'))).toEqual(['lt', 'lte', 'gt', 'gte']);
    expect(opsFor(col('ticker'))).toEqual(['eq', 'ne', 'contains']);
    expect(opsFor(col('iv'))).toContain('is_null');
    expect(opsFor(col('in_the_money'))).toEqual(['eq', 'is_null', 'not_null']);
  });

  it('refuses what a column cannot mean, and says what it can', () => {
    expect(() => validateFilter(chain, { column: 'nope', op: 'eq', value: 1 })).toThrow(/no column "nope"/);
    expect(() => validateFilter(chain, { column: 'strike', op: 'contains', value: '5' })).toThrow(/accepts: eq, ne/);
    expect(() => validateFilter(chain, { column: 'strike', op: 'gt', value: 'abc' })).toThrow(/needs a number/);
    expect(() => validateFilter(chain, { column: 'right', op: 'eq', value: 'straddle' })).toThrow(/Its values are: call, put/);
    expect(() => validateFilter(chain, { column: 'expiration_date', op: 'eq', value: '18/09/2026' })).toThrow(/yyyy-mm-dd/);
    expect(() => validateFilter(chain, { column: 'ticker', op: 'is_null' })).toThrow(/never null/);
    expect(() => validateFilter(chain, { column: 'in_the_money', op: 'eq', value: 2 })).toThrow(/0\/1 flag/);
  });

  it('cleans values: numbers from strings, enum lists from commas', () => {
    expect(validateFilter(chain, { column: 'strike', op: 'gte', value: ' 600 ' })).toEqual({ column: 'strike', op: 'gte', value: 600 });
    expect(validateFilter(chain, { column: 'right', op: 'in', value: 'call, put' })).toEqual({ column: 'right', op: 'in', value: ['call', 'put'] });
  });

  it('widens a bare date on a timestamp to the whole ET day', () => {
    // "observed on or before the 9th" must include 17:05 on the 9th.
    expect(validateFilter(chain, { column: 'observed_at', op: 'lte', value: '2026-09-09' }).value).toBe('2026-09-09T99');
    expect(validateFilter(chain, { column: 'observed_at', op: 'gte', value: '2026-09-09' }).value).toBe('2026-09-09');
    expect('2026-09-09T17:05:01-04:00' <= '2026-09-09T99').toBe(true);
    expect('2026-09-10T00:00:01-04:00' <= '2026-09-09T99').toBe(false);
  });
});

describe('the SQL', () => {
  it('binds every value as a parameter and escapes LIKE wildcards', () => {
    const { conditions, params } = filterSql([
      validateFilter(chain, { column: 'ticker', op: 'contains', value: '50%_x' }),
      validateFilter(chain, { column: 'right', op: 'in', value: ['call', 'put'] }),
      validateFilter(chain, { column: 'iv', op: 'is_null' })
    ], 'q');
    expect(conditions).toEqual([`q."ticker" LIKE ? ESCAPE '\\'`, 'q."right" IN (?,?)', 'q."iv" IS NULL']);
    expect(params).toEqual(['%50\\%\\_x%', 'call', 'put']);
  });

  it('matches a literal % rather than treating it as a wildcard, on real SQLite', () => {
    const raw = new Database(':memory:');
    const db = raw as unknown as SqliteLike;
    applyDictionary(db);
    const insert = raw.prepare(
      `INSERT INTO qa_exception (fingerprint, check_id, domain, key, severity, base_severity, state, detail, evidence_json,
         first_seen_run_id, last_seen_run_id, consecutive_runs, remediations_json, affects_trading_dates_json, still_firing)
       VALUES (?, 'QC-204', 'bars', 'k', 'warning', 'warning', 'open', ?, '{}', 1, 1, 1, '[]', '[]', 1)`
    );
    insert.run('a', 'a 50% step');
    insert.run('b', 'a 50 step up');
    const exc = DICTIONARY.find((t) => t.table === 'qa_exception')!;
    const { conditions, params } = filterSql([validateFilter(exc, { column: 'detail', op: 'contains', value: '50%' })]);
    const rows = raw.prepare(`SELECT detail FROM qa_exception WHERE ${conditions.join(' AND ')}`).all(...params);
    expect(rows).toEqual([{ detail: 'a 50% step' }]);
    raw.close();
  });
});

describe('anchoring a large query on an index (05 §8)', () => {
  it('knows which columns an index can start from, ignoring partial indexes', () => {
    expect([...indexedColumns(chain)].sort()).toEqual(['as_of_date', 'osi_symbol', 'row_id', 'source_response_id', 'ticker']);
    const sticky = DICTIONARY.find((t) => t.table === 'ref_sticky_contract')!;
    // Two indexes on osi_symbol, one of them partial: still counted once, from the full one.
    expect(indexedColumns(sticky).has('osi_symbol')).toBe(true);
  });

  it('lets anything through on a small table', () => {
    expect(() => assertAnchored(chain, [validateFilter(chain, { column: 'strike', op: 'gt', value: 1 })], 'all', SMALL_TABLE_ROWS)).not.toThrow();
  });

  it('refuses an unanchored filter on a large table, naming the columns that would work', () => {
    const big = SMALL_TABLE_ROWS * 20;
    expect(() => assertAnchored(chain, [validateFilter(chain, { column: 'strike', op: 'gt', value: 1 })], 'all', big))
      .toThrow(FilterRefused);
    expect(() => assertAnchored(chain, [validateFilter(chain, { column: 'strike', op: 'gt', value: 1 })], 'all', big))
      .toThrow(/as_of_date, ticker, osi_symbol|row_id/);
    // A `contains` on an indexed column cannot use the index, so it does not anchor.
    expect(() => assertAnchored(chain, [validateFilter(chain, { column: 'ticker', op: 'contains', value: 'SP' })], 'all', big))
      .toThrow(FilterRefused);
  });

  it('accepts one anchoring filter and lets the others narrow what it found', () => {
    const big = SMALL_TABLE_ROWS * 20;
    expect(() => assertAnchored(chain, [
      validateFilter(chain, { column: 'ticker', op: 'eq', value: 'SPY' }),
      validateFilter(chain, { column: 'strike', op: 'gt', value: 1 })
    ], 'all', big)).not.toThrow();
    // Unfiltered paging of a large table is fine: it is a keyset walk, not a scan.
    expect(() => assertAnchored(chain, [], 'all', big)).not.toThrow();
    // But "latest version of everything" over millions of rows is not.
    expect(() => assertAnchored(chain, [], 'latest', big)).toThrow(/latest-version view/);
  });
});

describe('versions', () => {
  it('partitions by the natural key without observed_at, and has no versions on a table without it', () => {
    expect(versionPartition(chain)).toEqual(['osi_symbol', 'as_of_date']);
    expect(versionPartition(DICTIONARY.find((t) => t.table === 'qa_exception')!)).toBeNull();
  });

  it('validates a whole question definition with the same rules', () => {
    const d = validateDefinition(chain, {
      filters: [{ column: 'strike', op: 'gte', value: '600' }], sortColumn: 'strike', sortDescending: true,
      versionMode: 'latest', asOf: '2026-09-09', columns: ['ticker', 'strike']
    });
    expect(d.filters[0]!.value).toBe(600);
    expect(() => validateDefinition(chain, { filters: [], sortColumn: 'nope', sortDescending: false, versionMode: 'all', asOf: null, columns: null }))
      .toThrow(/to sort on/);
    expect(() => validateDefinition(chain, { filters: [], sortColumn: null, sortDescending: false, versionMode: 'all', asOf: null, columns: [] }))
      .toThrow(/at least one column/);
  });
});
