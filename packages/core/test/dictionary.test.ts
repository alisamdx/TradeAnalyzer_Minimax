import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  DICTIONARY,
  DICTIONARY_VERSION,
  allColumns,
  getTable,
  groupedForInspector,
  tableNames,
  unverifiedColumns
} from '../src/dictionary/index.js';
import { UNIT_STORAGE, STATUS_VALUES } from '../src/dictionary/types.js';
import { generateDdl, fullSchemaSql } from '../src/dictionary/ddl.js';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import { defineTable } from '../src/dictionary/standard-columns.js';
import { col } from '../src/dictionary/types.js';

/**
 * Dictionary conformance — AC-3.
 *
 * "Every column in the database has a data-dictionary entry; every nullable
 * column has a stated null meaning." The second half is the one that needs a
 * test: a missing entry shows up the moment anyone looks at a table, but a
 * nullable column with no stated meaning looks exactly like a nullable column
 * with one until the day someone has to decide what a blank cell means — and by
 * then the person who knew has forgotten.
 *
 * The round-trip through a real SQLite database is deliberate. Asserting the
 * dictionary against itself proves only that it is internally consistent; the
 * claim worth testing is that the schema **the database actually gets** is the
 * one the dictionary describes.
 */

function open(): { db: SqliteLike; close: () => void } {
  const raw = new Database(':memory:');
  return { db: raw as unknown as SqliteLike, close: () => raw.close() };
}

describe('dictionary — structure', () => {
  it('declares every table exactly once', () => {
    const names = tableNames();
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(30);
  });

  it('declares every column exactly once within its table', () => {
    for (const t of DICTIONARY) {
      const names = t.columns.map((c) => c.column);
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      expect(dupes, `${t.table} has duplicate columns`).toEqual([]);
    }
  });

  it('gives every nullable column a stated null meaning — this is AC-3', () => {
    const offenders = allColumns()
      .filter((c) => c.column.nullable && !c.column.nullMeaning)
      .map((c) => `${c.table.table}.${c.column.column}`);
    expect(offenders).toEqual([]);
  });

  it('gives no non-nullable column a null meaning', () => {
    // A stated meaning on a NOT NULL column is a leftover from an edit, and it
    // would render in the inspector as an explanation for something that cannot
    // happen.
    const offenders = allColumns()
      .filter((c) => !c.column.nullable && c.column.nullMeaning)
      .map((c) => `${c.table.table}.${c.column.column}`);
    expect(offenders).toEqual([]);
  });

  it('describes every column and every table', () => {
    const thin = allColumns()
      .filter((c) => c.column.description.trim().length < 10)
      .map((c) => `${c.table.table}.${c.column.column}`);
    expect(thin).toEqual([]);
    expect(DICTIONARY.filter((t) => t.description.trim().length < 20).map((t) => t.table)).toEqual([]);
  });

  it('stores every unit in the storage class it requires', () => {
    const wrong = allColumns()
      .filter((c) => UNIT_STORAGE[c.column.unit] !== c.column.type)
      .map((c) => `${c.table.table}.${c.column.column}: unit ${c.column.unit} wants ${UNIT_STORAGE[c.column.unit]}, declared ${c.column.type}`);
    expect(wrong).toEqual([]);
  });

  it('gives every enum column a non-empty value set, and no other column one', () => {
    const missing = allColumns()
      .filter((c) => c.column.unit === 'enum' && (c.column.enumValues?.length ?? 0) === 0)
      .map((c) => `${c.table.table}.${c.column.column}`);
    expect(missing).toEqual([]);
    const spurious = allColumns()
      .filter((c) => c.column.unit !== 'enum' && c.column.enumValues)
      .map((c) => `${c.table.table}.${c.column.column}`);
    expect(spurious).toEqual([]);
  });

  it('names a unit column for every value whose unit varies per row', () => {
    // `provider_defined` says "the unit is not fixed". A number like that with no
    // pointer to what its unit is cannot be interpreted later by anyone, so the
    // dictionary refuses to declare one without saying where the unit lives.
    const bad: string[] = [];
    for (const t of DICTIONARY) {
      const present = new Set(t.columns.map((c) => c.column));
      for (const c of t.columns) {
        if (c.unit !== 'provider_defined') continue;
        if (!c.unitColumn) { bad.push(`${t.table}.${c.column}: no unitColumn`); continue; }
        if (!present.has(c.unitColumn)) bad.push(`${t.table}.${c.column} -> missing ${c.unitColumn}`);
      }
      for (const c of t.columns) {
        if (c.unitColumn && c.unit !== 'provider_defined') bad.push(`${t.table}.${c.column}: unitColumn on a fixed-unit column`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('declares the status column of every column that names one, in the same table', () => {
    const dangling: string[] = [];
    for (const t of DICTIONARY) {
      const present = new Set(t.columns.map((c) => c.column));
      for (const c of t.columns) {
        if (c.statusColumn && !present.has(c.statusColumn)) {
          dangling.push(`${t.table}.${c.column} -> ${c.statusColumn}`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  it('gives every status column the standard status vocabulary', () => {
    const statusColumns = new Set(
      DICTIONARY.flatMap((t) => t.columns.filter((c) => c.statusColumn).map((c) => `${t.table}.${c.statusColumn}`))
    );
    const wrong: string[] = [];
    for (const t of DICTIONARY) {
      for (const c of t.columns) {
        if (!statusColumns.has(`${t.table}.${c.column}`)) continue;
        if (c.unit !== 'enum' || !c.enumValues) { wrong.push(`${t.table}.${c.column}: not an enum`); continue; }
        const unknown = c.enumValues.filter((v) => !(STATUS_VALUES as readonly string[]).includes(v));
        if (unknown.length) wrong.push(`${t.table}.${c.column}: unknown statuses ${unknown.join(', ')}`);
        if (!c.enumValues.includes('ok')) wrong.push(`${t.table}.${c.column}: missing 'ok'`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('names only real columns in every natural key', () => {
    const bad: string[] = [];
    for (const t of DICTIONARY) {
      const present = new Set(t.columns.map((c) => c.column));
      for (const k of t.naturalKey) if (!present.has(k)) bad.push(`${t.table}.${k}`);
      if (t.naturalKey.length === 0) bad.push(`${t.table}: empty natural key`);
    }
    expect(bad).toEqual([]);
  });

  it('names only real columns in every index', () => {
    const bad: string[] = [];
    for (const t of DICTIONARY) {
      const present = new Set(t.columns.map((c) => c.column));
      for (const idx of t.indexes) {
        for (const c of idx.columns) if (!present.has(c)) bad.push(`${t.table}: index on missing ${c}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('points every foreign key at a table and column that exist', () => {
    const bad: string[] = [];
    for (const t of DICTIONARY) {
      for (const c of t.columns) {
        if (!c.references) continue;
        const target = getTable(c.references.table);
        if (!target) { bad.push(`${t.table}.${c.column} -> unknown table ${c.references.table}`); continue; }
        if (!target.columns.some((x) => x.column === c.references!.column)) {
          bad.push(`${t.table}.${c.column} -> ${c.references.table}.${c.references.column} does not exist`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('gives every raw and snapshot table the six standard columns', () => {
    const required = ['row_id', 'run_id', 'as_of_date', 'observed_at', 'capture_rule_id', 'source_response_id'];
    const missing: string[] = [];
    for (const t of DICTIONARY.filter((x) => x.standardColumns)) {
      const present = new Set(t.columns.map((c) => c.column));
      for (const r of required) if (!present.has(r)) missing.push(`${t.table}.${r}`);
    }
    expect(missing).toEqual([]);
  });

  it('makes every fact table append-only, so AC-2 is enforced by the database', () => {
    const factLayers = new Set(['raw', 'ext', 'derived', 'legacy']);
    const mutable = DICTIONARY.filter((t) => factLayers.has(t.layer) && !t.appendOnly).map((t) => t.table);
    expect(mutable).toEqual([]);
  });

  it('names every table with its layer prefix', () => {
    const wrong = DICTIONARY.filter((t) => !t.table.startsWith(`${t.layer}_`)).map((t) => t.table);
    expect(wrong).toEqual([]);
  });
});

describe('dictionary — DDL round-trip against real SQLite', () => {
  it('generates a schema SQLite accepts', () => {
    const { db, close } = open();
    try {
      expect(() => applyDictionary(db)).not.toThrow();
    } finally {
      close();
    }
  });

  it('creates exactly the tables the dictionary declares, and no others', () => {
    const { db, close } = open();
    try {
      applyDictionary(db);
      const actual = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
        .map((r) => r.name)
        .sort();
      expect(actual).toEqual([...tableNames()].sort());
    } finally {
      close();
    }
  });

  it('creates exactly the columns the dictionary declares, in order, with the declared types and nullability', () => {
    const { db, close } = open();
    try {
      applyDictionary(db);
      const mismatches: string[] = [];
      for (const t of DICTIONARY) {
        const info = db.prepare(`PRAGMA table_info("${t.table}")`).all() as {
          cid: number; name: string; type: string; notnull: number; pk: number;
        }[];
        const declared = t.columns.map((c) => c.column);
        const actual = info.map((r) => r.name);
        if (JSON.stringify(actual) !== JSON.stringify(declared)) {
          mismatches.push(`${t.table}: columns ${actual.join(',')} != declared ${declared.join(',')}`);
          continue;
        }
        for (const c of t.columns) {
          const row = info.find((r) => r.name === c.column)!;
          if (row.type !== c.type) mismatches.push(`${t.table}.${c.column}: SQLite type ${row.type} != ${c.type}`);
          const notNull = row.notnull === 1 || row.pk === 1;
          if (notNull === c.nullable) {
            mismatches.push(`${t.table}.${c.column}: nullability disagrees (db notnull=${row.notnull}, pk=${row.pk}, dictionary nullable=${c.nullable})`);
          }
        }
      }
      expect(mismatches).toEqual([]);
    } finally {
      close();
    }
  });

  it('creates every declared index', () => {
    const { db, close } = open();
    try {
      applyDictionary(db);
      const created = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all() as { name: string }[]).length;
      expect(created).toBe(generateDdl().indexes.length);
    } finally {
      close();
    }
  });

  it('is idempotent — applying twice changes nothing', () => {
    const { db, close } = open();
    try {
      const first = applyDictionary(db);
      const second = applyDictionary(db);
      expect(first.tablesCreated.length).toBe(DICTIONARY.length);
      expect(second.tablesCreated).toEqual([]);
      expect(second.columnsAdded).toEqual([]);
      expect(second.dictionaryRows).toBe(first.dictionaryRows);
      const dictRows = (db.prepare('SELECT COUNT(*) AS n FROM meta_dictionary').get() as { n: number }).n;
      expect(dictRows).toBe(first.dictionaryRows);
    } finally {
      close();
    }
  });

  it('emits a full schema script that is valid on its own', () => {
    const raw = new Database(':memory:');
    try {
      expect(() => raw.exec(fullSchemaSql())).not.toThrow();
    } finally {
      raw.close();
    }
  });
});

describe('dictionary — the constraints do their job', () => {
  it('refuses an UPDATE to an append-only table (AC-2)', () => {
    const raw = new Database(':memory:');
    try {
      const db = raw as unknown as SqliteLike;
      applyDictionary(db);
      raw.exec("INSERT INTO meta_run (run_id, run_kind, slot, trading_date, started_at, status, host_app, host_version, collector_version, dictionary_version) VALUES (1,'daily','after_close','2026-09-06','2026-09-06T17:00:00-04:00','running','test','0','0.1.0',1)");
      raw.exec("INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) VALUES (1,1,'polygon','/x','{}','2026-09-06T17:00:00-04:00','a',0,'h',0,0,'ok')");
      raw.exec("INSERT INTO meta_capture_rule (capture_rule_id, domain, version, definition_json, description, valid_from) VALUES (1,'bars',1,'{}','test rule','t')");
      raw.exec("INSERT INTO raw_split (run_id, as_of_date, observed_at, capture_rule_id, source_response_id, ticker, execution_date, split_from, split_to, provider_id) VALUES (1,'2026-09-06','2026-09-06T17:00:00-04:00',1,1,'AAPL','2026-09-06',1,4,'p1')");
      expect(() => raw.exec("UPDATE raw_split SET split_to = 5")).toThrow(/append-only/);
      expect(() => raw.exec("DELETE FROM raw_split")).toThrow(/append-only/);
    } finally {
      raw.close();
    }
  });

  it('lets a validity-range table close its range, but nothing else', () => {
    // 02 §0.2: membership tables use `valid_from`/`valid_to` INSTEAD of
    // supersession, so a departure closing `valid_to` is legitimate. Turning the
    // append-only guard off for them would have been the easy fix and the wrong
    // one — "this membership ended" and "what this membership said" have to stay
    // two different acts, or the range buys nothing over an overwrite.
    const raw = new Database(':memory:');
    try {
      applyDictionary(raw as unknown as SqliteLike);
      raw.exec("INSERT INTO meta_run (run_id, run_kind, slot, trading_date, started_at, status, host_app, host_version, collector_version, dictionary_version) VALUES (1,'daily','after_close','2026-09-06','t','running','t','0','0.1.0',1)");
      raw.exec("INSERT INTO meta_capture_rule (capture_rule_id, domain, version, definition_json, description, valid_from) VALUES (1,'universe',1,'{}','t','t')");
      raw.exec("INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) VALUES (1,1,'polygon','/x','{}','t','a',0,'h',0,0,'ok')");
      raw.exec("INSERT INTO ref_universe_membership (run_id, as_of_date, observed_at, capture_rule_id, source_response_id, ticker, list_source, valid_from, valid_to, change_reason) VALUES (1,'2026-09-06','t',1,1,'AAPL','sp500','2026-09-06',NULL,'initial')");

      // Closing the range: permitted.
      expect(() =>
        raw.exec("UPDATE ref_universe_membership SET valid_to = '2026-09-07', change_reason = 'index_drop'")
      ).not.toThrow();

      // Editing the fact itself: refused.
      expect(() => raw.exec("UPDATE ref_universe_membership SET ticker = 'MSFT'"))
        .toThrow(/permits changing only/);
      // Reopening a closed range: refused.
      expect(() => raw.exec('UPDATE ref_universe_membership SET valid_to = NULL')).toThrow(/already closed/);
      // Deleting: refused, like any fact table.
      expect(() => raw.exec('DELETE FROM ref_universe_membership')).toThrow(/append-only/);
    } finally {
      raw.close();
    }
  });

  it('lets a report record its email outcome, but not rewrite the report', () => {
    // The same distinction as the registry's counters: the row's CONTENT is a
    // fact about the run and is frozen; whether the email got out is simply not
    // knowable at the moment the row is written.
    const raw = new Database(':memory:');
    try {
      applyDictionary(raw as unknown as SqliteLike);
      raw.exec("INSERT INTO meta_run (run_id, run_kind, slot, trading_date, started_at, status, host_app, host_version, collector_version, dictionary_version) VALUES (1,'daily','after_close','2026-09-06','t','running','t','0','0.1.0',1)");
      raw.exec("INSERT INTO qa_quality_report (run_id, generated_at, overall, domains_json, checks_json, email_status) VALUES (1,'t','green','{}','{}','pending')");

      expect(() => raw.exec("UPDATE qa_quality_report SET email_status='sent', email_sent_at='t2'")).not.toThrow();
      expect(() => raw.exec("UPDATE qa_quality_report SET overall='red'")).toThrow(/permits changing only/);
      expect(() => raw.exec('DELETE FROM qa_quality_report')).toThrow(/append-only/);
    } finally {
      raw.close();
    }
  });

  it('refuses a value that is not in an enum column\'s declared set', () => {
    const raw = new Database(':memory:');
    try {
      applyDictionary(raw as unknown as SqliteLike);
      expect(() =>
        raw.exec("INSERT INTO meta_run (run_id, run_kind, slot, trading_date, started_at, status, host_app, host_version, collector_version, dictionary_version) VALUES (1,'sideways','after_close','2026-09-06','t','running','test','0','0.1.0',1)")
      ).toThrow(/CHECK constraint/i);
    } finally {
      raw.close();
    }
  });

  it('refuses a value present while its status says it is missing, and vice versa', () => {
    // The invariant that makes a status column mean anything: null exactly when
    // status is not `ok`. Without it the pair drifts into a null value with `ok`
    // status (a silent gap) or a value with `omitted` (a lie), and neither raises.
    const raw = new Database(':memory:');
    try {
      applyDictionary(raw as unknown as SqliteLike);
      raw.exec("INSERT INTO meta_run (run_id, run_kind, slot, trading_date, started_at, status, host_app, host_version, collector_version, dictionary_version) VALUES (1,'daily','after_close','2026-09-06','t','running','test','0','0.1.0',1)");
      raw.exec("INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) VALUES (1,1,'etrade','/x','{}','t','a',0,'h',0,0,'ok')");
      raw.exec("INSERT INTO meta_capture_rule (capture_rule_id, domain, version, definition_json, description, valid_from) VALUES (1,'index',1,'{}','test rule','t')");

      const base = "INSERT INTO raw_index_quote (run_id, as_of_date, observed_at, capture_rule_id, source_response_id, symbol, last, open, high, low, prev_close, quote_status)";
      // present value, but status says omitted
      expect(() => raw.exec(`${base} VALUES (1,'2026-09-06','t',1,1,'VIX',18.2,17.9,18.5,17.8,18.0,'omitted')`)).toThrow(/CHECK constraint/i);
      // null value, but status says ok
      expect(() => raw.exec(`${base} VALUES (1,'2026-09-06','t',1,1,'VIX',NULL,NULL,NULL,NULL,NULL,'ok')`)).toThrow(/CHECK constraint/i);
      // coherent both ways
      expect(() => raw.exec(`${base} VALUES (1,'2026-09-06','t',1,1,'VIX',18.2,17.9,18.5,17.8,18.0,'ok')`)).not.toThrow();
      expect(() => raw.exec(`${base} VALUES (1,'2026-09-06','t',1,1,'VIX',NULL,NULL,NULL,NULL,NULL,'omitted')`)).not.toThrow();
    } finally {
      raw.close();
    }
  });

  it('refuses a flag that is neither 0 nor 1', () => {
    const raw = new Database(':memory:');
    try {
      applyDictionary(raw as unknown as SqliteLike);
      expect(() =>
        raw.exec("INSERT INTO ref_trading_day (date, is_trading_day, is_monthly_expiration, source, observed_at) VALUES ('2026-09-06', 2, 0, 'nyse_rules', 't')")
      ).toThrow(/CHECK constraint/i);
    } finally {
      raw.close();
    }
  });
});

describe('meta_dictionary — the generation explains itself', () => {
  it('materialises one row per declared column, with the null meanings intact', () => {
    const raw = new Database(':memory:');
    try {
      const db = raw as unknown as SqliteLike;
      const result = applyDictionary(db);
      expect(result.dictionaryRows).toBe(allColumns().length);

      const rows = raw.prepare('SELECT COUNT(*) AS n FROM meta_dictionary WHERE dictionary_version = ?').get(DICTIONARY_VERSION) as { n: number };
      expect(rows.n).toBe(allColumns().length);

      // AC-3 read back out of the database rather than off the source tree.
      const missing = raw.prepare("SELECT table_name, column_name FROM meta_dictionary WHERE nullable = 1 AND (null_meaning IS NULL OR null_meaning = '')").all();
      expect(missing).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it('carries the natural key on every column row, so version mode is one query', () => {
    const raw = new Database(':memory:');
    try {
      applyDictionary(raw as unknown as SqliteLike);
      const row = raw.prepare("SELECT natural_key FROM meta_dictionary WHERE table_name = 'raw_daily_bar' LIMIT 1").get() as { natural_key: string };
      expect(JSON.parse(row.natural_key)).toEqual(['ticker', 'trade_date', 'observed_at']);
    } finally {
      raw.close();
    }
  });

  it('surfaces the columns still awaiting a live response rather than burying them', () => {
    const unverified = unverifiedColumns();
    const names = unverified.map((u) => `${u.table}.${u.column}`);

    // The 02 §16 E*Trade verify list was closed on 2026-09-07 by one live chain
    // call, one quote and one portfolio call. These were on it and are not any
    // more; asserting their ABSENCE is what stops a future edit quietly
    // re-introducing an assumption as if it had been measured.
    expect(names).not.toContain('raw_option_contract_snapshot.theta');
    expect(names).not.toContain('raw_option_contract_snapshot.provider_timestamp');
    expect(names).not.toContain('raw_index_quote.symbol');
    expect(names).not.toContain('raw_account_position_snapshot.provider_position_id');
    expect(names).not.toContain('raw_account_transaction.symbol');

    // One remains, and it is a genuinely open sourcing question rather than an
    // unverified field shape: short interest has no confirmed free provider.
    expect(names).toEqual(['raw_short_interest.short_interest']);
    for (const u of unverified) expect(u.note.length).toBeGreaterThan(20);
  });

  it('converts every field whose provider representation is not what it looks like', () => {
    // Each of these was measured on 2026-09-07 and each would be silently wrong
    // without an explicit converter.
    const byName = new Map(allColumns().map((c) => [`${c.table.table}.${c.column.column}`, c.column]));
    // "y"/"n" strings, where Boolean("n") === true would make everything ITM.
    expect(byName.get('raw_option_contract_snapshot.in_the_money')?.converter).toBe('etradeYesNoToFlag');
    // Epoch SECONDS, where treating them as milliseconds lands in 1970.
    expect(byName.get('raw_option_contract_snapshot.provider_timestamp')?.converter).toBe('secondsEpochToEtTimestamp');
    // Published percent, stored as a fraction.
    expect(byName.get('raw_treasury_yield.yield')?.converter).toBe('percentToFraction');
  });
});

describe('inspector grouping (AC-13 support)', () => {
  it('groups every table under its layer, losing none', () => {
    const grouped = groupedForInspector();
    const flat = grouped.flatMap((g) => g.domains.flatMap((d) => d.tables.map((t) => t.table)));
    expect([...flat].sort()).toEqual([...tableNames()].sort());
  });

  it('orders layers meta, ref, raw, ext, derived, legacy, qa', () => {
    expect(groupedForInspector().map((g) => g.layer))
      .toEqual(['meta', 'ref', 'raw', 'ext', 'derived', 'legacy', 'qa']);
  });

  it('accepts a table the code has never heard of — this is AC-13', () => {
    // A throwaway dictionary entry must produce a real table and appear in the
    // grouping with no code change anywhere. If this needs an edit elsewhere,
    // the inspector is not schema-driven and AC-13 is not met.
    const throwaway = defineTable({
      table: 'raw_throwaway_probe',
      layer: 'raw',
      domain: 'probe',
      description: 'A table that exists only inside this test, to prove nothing is hard-coded per table.',
      naturalKey: ['probe_key', 'observed_at'],
      appendOnly: true,
      ruleDriven: false,
      standardColumns: true,
      columns: [
        col.ident('probe_key', 'The thing being probed.'),
        col.fraction('probe_value', 'Some fraction the probe measured.')
      ],
      indexes: [{ columns: ['probe_key'] }]
    });

    const extended = [...DICTIONARY, throwaway];
    const raw = new Database(':memory:');
    try {
      applyDictionary(raw as unknown as SqliteLike, extended);
      const info = raw.prepare("PRAGMA table_info('raw_throwaway_probe')").all() as { name: string }[];
      expect(info.map((r) => r.name)).toEqual([
        'row_id', 'run_id', 'as_of_date', 'observed_at', 'capture_rule_id', 'source_response_id',
        'probe_key', 'probe_value'
      ]);
      const grouped = groupedForInspector(extended);
      const rawLayer = grouped.find((g) => g.layer === 'raw')!;
      expect(rawLayer.domains.map((d) => d.domain)).toContain('probe');
      const dictRow = raw.prepare("SELECT unit, null_meaning FROM meta_dictionary WHERE table_name='raw_throwaway_probe' AND column_name='probe_value'").get() as { unit: string; null_meaning: string | null };
      expect(dictRow.unit).toBe('fraction');
      expect(dictRow.null_meaning).toBeNull();
    } finally {
      raw.close();
    }
  });
});
