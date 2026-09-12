import { col, nullable, type TableEntry } from '../types.js';
import { defineTable } from '../standard-columns.js';

/**
 * Infrastructure tables — 02 §1.
 *
 * These describe the collection itself rather than the market: which generation
 * this is, which run wrote what, which rule was in force, and where each
 * provider response is archived. They carry no standard columns, because they
 * *are* the thing the standard columns point at.
 */

const RUN_KINDS = [
  'daily',
  'backfill_bars',
  'bootstrap_iv',
  'legacy_import',
  'replay',
  'manual'
] as const;

export const PROVIDERS = [
  'polygon',
  'etrade',
  'edgar',
  'finnhub',
  'treasury',
  'fred',
  'ivolatility',
  'marketdata',
  'finra',
  // Not a vendor: the host application itself, for lists it already maintains.
  // The universe's index membership is the case — it is host-side configuration
  // (04 §4.1), and attributing it to a data vendor would be a lie in the one
  // column that says where a row came from.
  'host_app'
] as const;

export const metaTables: readonly TableEntry[] = [
  defineTable({
    table: 'meta_generation',
    layer: 'meta',
    domain: 'generation',
    description:
      'One row per generation (P14). Every generation file describes itself; the newest also ' +
      'records its predecessor, so a chain of resets is readable from any link in it.',
    naturalKey: ['generation_no'],
    appendOnly: false,
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.int('generation_no', 'Generation number; `1` is the pilot.', { primaryKey: true, sourceProvider: 'collector' }),
      col.ts('opened_at', 'When this generation was created.', { sourceProvider: 'collector' }),
      nullable(col.ts('closed_at', 'When this generation stopped being written to.'), 'still the current generation'),
      col.enumOf('status', ['pilot', 'production', 'closed'], 'Where this generation stands. Only a `production` generation is trusted for analysis.', { sourceProvider: 'collector' }),
      { column: 'db_path', type: 'TEXT', unit: 'path', nullable: false, description: 'Path to this generation\'s SQLite file.', sourceProvider: 'collector' },
      { column: 'archive_path', type: 'TEXT', unit: 'path', nullable: false, description: 'Path to this generation\'s response archive.', sourceProvider: 'collector' },
      nullable(col.int('predecessor_no', 'The generation this one replaced.'), 'generation 1 — there was no predecessor'),
      nullable(col.text('reset_reason', 'Why the predecessor was closed.'), 'not a reset — this generation was opened fresh'),
      nullable(col.ts('pilot_exit_at', 'When the 20-clean-day criterion was met and the operator promoted this generation.'), 'still in pilot, or never promoted'),
      nullable(col.date('iv_stitch_date', 'Readers use `ext_iv_history` before this date and `derived_iv30_daily` from it onward (Q17).'), 'no external IV history has been loaded yet'),
      // Last, because a nullable column added to a populated table is appended.
      nullable(
        col.json(
          'pilot_exit_evidence_json',
          'The whole pilot-exit checklist as it stood at the moment of promotion (03 §8, B10a): the streak, ' +
            'every zero-fire and threshold ruling, every domain inspection, the replay record. A status flag ' +
            'says the generation was promoted; this says on what evidence, and it cannot drift afterwards.'
        ),
        'not promoted'
      )
    ],
    indexes: []
  }),

  defineTable({
    table: 'meta_domain_inspection',
    layer: 'meta',
    domain: 'generation',
    description:
      'The operator\'s record that a domain has been looked at by a person (D5, 03 §8 step 3). One row per ' +
      'inspection, never edited: inspecting a domain again appends, so the history of who looked when stays ' +
      'readable. Promotion needs at least one row for every domain the gate reports on.',
    naturalKey: ['domain', 'inspected_at'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.int('inspection_id', 'Inspection identifier.', { primaryKey: true, sourceProvider: 'operator' }),
      col.text('domain', 'The gate domain inspected — the same vocabulary as `qa_domain_day_status.domain`.', { sourceProvider: 'operator' }),
      col.ts('inspected_at', 'When the operator recorded it.', { sourceProvider: 'operator' }),
      col.text('inspected_by', 'The application and version the operator recorded it from.', { sourceProvider: 'operator' }),
      nullable(col.text('note', 'What was looked at and what it showed, in the operator\'s words.'), 'no note was given')
    ],
    indexes: [{ columns: ['domain'] }]
  }),

  defineTable({
    table: 'meta_open_handle',
    layer: 'meta',
    domain: 'generation',
    description:
      'One row per application AND resolved path, replaced on each re-open of that same pair. Not a fact ' +
      'about the market and not needed by anything downstream — it exists so that "are the two ' +
      'applications actually looking at the same file" is an ANSWERABLE question. Both exes write ' +
      'here on open, so a reader that sees only one of them is seeing a split file set, which is ' +
      'the shape that destroyed gen-001 on 2026-09-07: a containerised launch redirected one app ' +
      'onto a private copy of data.sqlite while the write-ahead log stayed shared. Every path ' +
      'reads back perfectly from inside such a process, so inference cannot settle it — the only ' +
      'honest test is to make both processes report what they see (CLAUDE.md). Keyed on ' +
      '(app_name, db_path), NOT on app_name alone: with one row per application the upsert ' +
      'only ever holds the LATEST open, so an earlier redirected open is overwritten by the ' +
      'next healthy one and the split becomes unaskable. Measured 2026-09-09 — a corrupt ' +
      'generation reported both apps on the same path, which was true of their last opens ' +
      'and said nothing about the ones that mattered. A second row here is permanent ' +
      'evidence that an application once resolved a different file.',
    naturalKey: ['app_name', 'db_path'],
    appendOnly: false,
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.text('app_name', 'Which application opened it — `TradeAnalyzer` (the collector host) or `TradeAnalyzer 2` (the inspector).', { sourceProvider: 'collector' }),
      col.text('app_version', 'That application\'s version, so a stale row names the build that wrote it.', { sourceProvider: 'collector' }),
      col.ts('opened_at', 'When that application last opened this generation.', { sourceProvider: 'collector' }),
      nullable(
        col.ts(
          'closed_at',
          'When that application closed it again. NULL means it either still holds the file or died ' +
            'without closing, and the difference matters. An open interval here that overlaps another ' +
            'row is TWO APPLICATIONS WRITING AT ONCE — which is the question this table was added to ' +
            'answer and could not, because it recorded opens only. Two open timestamps are consistent ' +
            'with any amount of overlap or none, so on 2026-09-09 a corruption investigation had to ' +
            'take "the other application was closed" on recollection, at the exact point where ' +
            'concurrency was the live hypothesis.'
        ),
        'still open, or the process died without closing'
      ),
      col.int('process_id', 'The operating-system process that opened it.', { sourceProvider: 'collector' }),
      { column: 'db_path', type: 'TEXT', unit: 'path', nullable: false, description: 'The path that application resolved for this database. Two different values here mean two different files, whatever the pointer says — and because it is part of the key, a second path is recorded rather than overwriting the first.', sourceProvider: 'collector' },
      col.int('dictionary_version', 'The dictionary version that application was built against.', { sourceProvider: 'collector' })
    ],
    // A UNIQUE INDEX rather than a composite PRIMARY KEY: the generator emits
    // `PRIMARY KEY` inline on the column, so marking two columns produces
    // `table "meta_open_handle" has more than one primary key`. The index gives
    // the same identity and the same `ON CONFLICT (app_name, db_path)` target.
    indexes: [{ columns: ['app_name', 'db_path'], unique: true }]
  }),

  defineTable({
    table: 'meta_run',
    layer: 'meta',
    domain: 'generation',
    description: 'One row per collector run — one slot on one day, or one one-shot job.',
    naturalKey: ['run_id'],
    appendOnly: false,
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.int('run_id', 'Run identifier, referenced by every row the run wrote.', { primaryKey: true, sourceProvider: 'collector' }),
      col.enumOf('run_kind', RUN_KINDS, 'What kind of run this was.', { sourceProvider: 'collector' }),
      col.enumOf('slot', ['after_close', 'morning'], 'Which daily slot. Stage 1 has only `after_close`; `morning` is declared now so a second slot never needs a schema change.', { sourceProvider: 'collector' }),
      col.date('trading_date', 'The `as_of_date` this run captures.', { sourceProvider: 'collector' }),
      col.ts('started_at', 'When the run began.', { sourceProvider: 'collector' }),
      nullable(col.ts('finished_at', 'When the run ended.'), 'still running, or the host died mid-run'),
      col.enumOf('status', ['running', 'complete', 'failed', 'cancelled'], 'How the run ended.', { sourceProvider: 'collector' }),
      col.text('host_app', 'Which application hosted the collector (Q4) — in stage 1, the existing app.', { sourceProvider: 'collector' }),
      col.text('host_version', 'The host application\'s version.', { sourceProvider: 'collector' }),
      col.ident('collector_version', '`@tradeanalyzer/core`\'s version. Replay equivalence (AC-4) is only meaningful between runs that agree here.', { sourceProvider: 'collector' }),
      col.int('dictionary_version', 'The dictionary version in force. A change means the schema moved.', { sourceProvider: 'collector' }),
      nullable(
        col.enumOf(
          'gate_verdict',
          ['green', 'amber', 'red'],
          'The gate verdict **at the moment the run finished**, never updated afterwards. It is a ' +
            'historical fact about the run, not a live usability flag — usability is ' +
            '`qa_domain_day_status` and only that (03 §4). A stored `usable` column would go stale the ' +
            'first time an exception was resolved the next day.',
          { sourceProvider: 'collector' }
        ),
        'the run has not finished, so the gate has not been evaluated'
      ),
      nullable(col.date('reach_from', 'How far back an order/transaction pull reached on its first run.'), 'not an account-history run')
    ],
    indexes: [
      { columns: ['trading_date', 'slot'] },
      { columns: ['run_kind', 'started_at'] }
    ]
  }),

  defineTable({
    table: 'meta_capture_rule',
    layer: 'meta',
    domain: 'generation',
    description:
      'Versioned capture definitions (P6). A change creates a new row; runs reference the row in ' +
      'force at the time, so a past row still answers "what were we asking for when this was captured".',
    naturalKey: ['domain', 'version'],
    appendOnly: false,
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.int('capture_rule_id', 'Rule identifier.', { primaryKey: true, sourceProvider: 'collector' }),
      col.text('domain', 'Which capture domain the rule governs — `chain`, `bars`, `quotes`, and so on.', { sourceProvider: 'collector' }),
      col.int('version', 'Version within the domain, starting at 1.', { sourceProvider: 'collector' }),
      col.json('definition_json', 'The rule itself, machine-readable, e.g. `{ "maxDte": 90, "extraMonthlies": 2, "allStrikes": true }`.', { sourceProvider: 'collector' }),
      col.text('description', 'The rule in a sentence, for the operator.', { sourceProvider: 'operator' }),
      col.ts('valid_from', 'When this version took effect.', { sourceProvider: 'collector' }),
      nullable(col.ts('valid_to', 'When this version was superseded.'), 'this is the version currently in force')
    ],
    indexes: [{ columns: ['domain', 'version'], unique: true }]
  }),

  defineTable({
    table: 'meta_response',
    layer: 'meta',
    domain: 'archive',
    description:
      'The raw archive index (P2) — one row per provider call. The body lives in the archive file; ' +
      'this row says where. Every raw row points back here, which is what makes AC-1 possible.',
    naturalKey: ['source_response_id'],
    appendOnly: false,
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.int('source_response_id', 'Response identifier.', { primaryKey: true, sourceProvider: 'collector' }),
      col.int('run_id', 'The run that made the call.', { references: { table: 'meta_run', column: 'run_id' }, sourceProvider: 'collector' }),
      col.enumOf('provider', PROVIDERS, 'Which provider was called.', { sourceProvider: 'collector' }),
      col.text('endpoint', 'The path called, **with the account key masked** (P15).', { sourceProvider: 'collector' }),
      col.json('params_json', 'Query parameters, secrets removed.', { sourceProvider: 'collector' }),
      col.ts('requested_at', 'When the request went out.', { sourceProvider: 'collector' }),
      nullable(col.ts('responded_at', 'When the response came back.'), 'no response — the request faulted or timed out'),
      nullable(col.int('http_status', 'The HTTP status returned.'), 'network fault: no status was ever received (a dormant E*Trade token can terminate the stream rather than answer 401)'),
      { column: 'byte_length', type: 'INTEGER', unit: 'bytes', nullable: true, nullMeaning: 'no body was received', description: 'Uncompressed body size.', sourceProvider: 'collector' },
      { column: 'archive_file', type: 'TEXT', unit: 'path', nullable: false, description: 'Archive file holding the body, relative to the generation directory, e.g. `archive/etrade/2026-09-05/optionchains.jsonl.gz`.', sourceProvider: 'collector' },
      col.int('archive_offset', 'Line number of this response within the archive file.', { sourceProvider: 'collector' }),
      { column: 'sha256', type: 'TEXT', unit: 'sha256', nullable: true, nullMeaning: 'no body was received', description: 'Digest of the uncompressed body; the archive integrity check compares against it.', sourceProvider: 'collector' },
      {
        column: 'dedup_hash', type: 'TEXT', unit: 'sha256', nullable: false, unique: true,
        description:
          'sha256(provider + endpoint + params_json + body) — the idempotence key of 04 §2.2. It makes ' +
          're-ingesting an *identical* response a no-op (crash recovery, replay). It does **not** make ' +
          're-running a day idempotent: a fresh call returns a different body and correctly appends a new ' +
          'version (P1).',
        sourceProvider: 'collector'
      },
      col.flag('encrypted', '`1` for account-domain files, which are written through safeStorage/DPAPI (Q20, P15).', { sourceProvider: 'collector' }),
      {
        column: 'at_provider_cap', type: 'INTEGER', unit: 'flag', nullable: false,
        description:
          '`1` when the response size equals a known provider cap (P8). Finnhub\'s bulk earnings ' +
          'calendar caps at 1,500 and truncates from the FRONT, so a payload *at* the cap is evidence of ' +
          'truncation and triggers subdivision — trusting one put an earnings date a quarter late in the ' +
          'existing app.',
        sourceProvider: 'collector'
      },
      col.enumOf('parse_status', ['ok', 'partial', 'failed'], 'How ingestion went. A failed parse still keeps the archive row — that is the point of archiving first.', { sourceProvider: 'collector' }),
      nullable(col.int('parsed_row_count', 'How many rows ingestion produced from this response. AC-5 compares this to what is stored.'), 'not parsed yet, or the parse failed before counting'),
      nullable(
        col.text(
          'parse_error',
          'Why ingestion failed, when it did — the parser\'s own message, or the HTTP status for a ' +
            'non-2xx. Until v14 this was computed and **thrown away**: `parse_status` said *that* a ' +
            'parse failed and nothing said *why*. The legacy brief hand-off then failed identically ' +
            'three times over two days, writing zero rows each time, and recovering the reason took ' +
            'an hour of reading source instead of one query. A failure that cannot explain itself is ' +
            'a failure somebody has to re-derive.'
        ),
        'the parse succeeded, or the response was never parsed'
      ),
      // LAST, and deliberately without a `references` clause. `applyDictionary`
      // adds a column to a populated table with a bare `ALTER TABLE … ADD
      // COLUMN <type>`, so a declared foreign key would leave the stored DDL
      // permanently different from the generated one and this table reported as
      // drifted on every open. The link is still enforced where it matters: the
      // id is only ever written by `ensureRecipe`, in the same transaction.
      nullable(
        col.int(
          'ingest_recipe_id',
          'The recipe in `meta_ingest_recipe` that turned this response into rows — which parser, built ' +
            'with which arguments. It is what makes a replay a re-run of the SAME parse rather than a ' +
            'reconstruction of it (04 §7.5, AC-4).'
        ),
        'no ingestion module ran on this response — a routing document, a list the universe ' +
          'reconciliation reads whole, or an archive-only import — or it was captured before recipes were ' +
          'recorded, which its run\'s `dictionary_version` below 11 says. Replay counts the two separately'
      ),
      // Also last, also without `references`, for the same reason as above.
      nullable(
        col.int(
          'capture_rule_id',
          'The capture rule version in force when the call was made (P6). Until B9b it was recorded only on ' +
            'the rows a response produced, so a response that produced none — an empty list, a failed parse — ' +
            'could not say which rule asked for it, and a replay could not rebuild the rows it did produce ' +
            'without guessing.'
        ),
        'the call was not rule-driven (reference and calendar data is captured unconditionally), or it was ' +
          'captured before this column existed — its run\'s `dictionary_version` below 11 says which'
      )
    ],
    indexes: [
      { columns: ['run_id'] },
      { columns: ['provider', 'requested_at'] },
      { columns: ['archive_file'] },
      { columns: ['dedup_hash'], unique: true }
    ]
  }),

  defineTable({
    table: 'meta_ingest_recipe',
    layer: 'meta',
    domain: 'archive',
    description:
      'How a response was turned into rows: which ingestion module, built with which arguments (B9b, 04 ' +
      '§7.5). The archive keeps every response\'s bytes, but until this table it did not keep the arguments ' +
      'its parser was built with — the rule\'s expiration selection, the sticky set, the order fingerprints ' +
      'already stored — so a replay would have had to reconstruct them, and a reconstructed replay that ' +
      'reports "equal" cannot fail on the case it exists for. Content-addressed: one row per distinct recipe, ' +
      'so an unchanged CIK map or universe list is stored once rather than once per response. The account ' +
      'key never appears here, only its digest (P15).',
    naturalKey: ['recipe_sha256'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.int('recipe_id', 'Recipe identifier, referenced by `meta_response.ingest_recipe_id`.', { primaryKey: true, sourceProvider: 'collector' }),
      {
        column: 'recipe_sha256', type: 'TEXT', unit: 'sha256', nullable: false, unique: true,
        description: 'sha256 of the module name and the canonical (key-sorted) JSON of its arguments — the recipe\'s identity.',
        sourceProvider: 'collector'
      },
      col.ident('module', 'The ingestion module, by its name in `core`\'s recipe registry — `etrade_chain`, `polygon_bars`, `edgar_form4`.', { sourceProvider: 'collector' }),
      col.json('args_json', 'The arguments the module was built with, as canonical JSON. Maps and sets are stored as sorted arrays.', { sourceProvider: 'collector' }),
      col.ts('first_seen_at', 'When a capture first used this recipe.', { sourceProvider: 'collector' })
    ],
    indexes: [{ columns: ['recipe_sha256'], unique: true }]
  }),

  defineTable({
    table: 'meta_saved_question',
    layer: 'meta',
    domain: 'inspector',
    description:
      'Saved questions (05 §11.2, B9c): a named filter, sort, version mode and column set over one table, ' +
      'stored in the generation so a question travels with the data it was asked of. Validated with the ' +
      'same rules the Data view runs, so a stored question can always be asked. Nothing is deleted: saving ' +
      'under a name in use retires the old row and writes a new one, so what a name meant last week stays ' +
      'readable.',
    naturalKey: ['name', 'created_at'],
    appendOnly: true,
    validRangeColumn: 'retired_at',
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.int('question_id', 'Question identifier.', { primaryKey: true, sourceProvider: 'operator' }),
      col.text('name', 'The name the operator gave it. Unique among questions still in use.', { sourceProvider: 'operator' }),
      col.ident('table_name', 'The table it is asked of.', { sourceProvider: 'operator' }),
      col.json('definition_json', 'Filters, sort, version mode, as-of date and visible columns, as validated at save.', { sourceProvider: 'operator' }),
      nullable(col.text('note', 'What the question is for, in the operator\'s words.'), 'no note was given'),
      col.ts('created_at', 'When this definition was saved.', { sourceProvider: 'operator' }),
      col.text('created_by', 'The application and version that saved it.', { sourceProvider: 'operator' }),
      nullable(col.ts('retired_at', 'When it stopped being in use — replaced under the same name, or retired.'), 'still in use')
    ],
    indexes: [{ columns: ['name'] }, { columns: ['table_name'] }]
  }),

  defineTable({
    table: 'meta_job_request',
    layer: 'meta',
    domain: 'jobs',
    description:
      'The one-shot job queue (04 §1.1). In stage 1 the operator drives jobs from the new exe but the ' +
      'old app executes them, because it holds the provider transports and the E*Trade token (Q4). ' +
      'This table is the entire interface between the two applications — no IPC, no socket, no shared ' +
      'process. It is the one exception to append-only: it is a control table, not a fact, and its ' +
      'state is *meant* to move. Its history survives in the `meta_run` row each execution creates.',
    naturalKey: ['request_id'],
    appendOnly: false,
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.int('request_id', 'Request identifier.', { primaryKey: true, sourceProvider: 'collector' }),
      col.ts('requested_at', 'When the request was queued.', { sourceProvider: 'collector' }),
      col.text('requested_by', 'The application and version that queued it.', { sourceProvider: 'collector' }),
      col.enumOf('run_kind', ['universe_seed', 'backfill_bars', 'bootstrap_iv', 'legacy_import', 'replay', 'reset'], 'Which one-shot job to run.', { sourceProvider: 'operator' }),
      col.json('params_json', 'The job\'s parameters, e.g. `{ "sourceGeneration": 1, "target": "scratch" }`.', { sourceProvider: 'operator' }),
      col.enumOf('state', ['queued', 'claimed', 'running', 'complete', 'failed', 'cancelled'], 'Where the request stands. Claiming is a single conditional UPDATE, so two hosts can never run one job.', { sourceProvider: 'collector' }),
      nullable(col.ts('claimed_at', 'When a host claimed it.'), 'not claimed yet — still queued, or cancelled before a host saw it'),
      nullable(col.text('claimed_by_host', 'Which host took it.'), 'not claimed yet'),
      nullable(col.int('run_id', 'The run created when execution started.', { references: { table: 'meta_run', column: 'run_id' } }), 'execution has not started'),
      nullable(col.ts('finished_at', 'When execution ended.'), 'not finished'),
      nullable(col.json('result_json', 'The job\'s own report — the replay diff, the import rejection summary, the bootstrap overlap distribution.'), 'not finished, or the job produces no report'),
      nullable(col.text('error', 'Why the job failed.'), 'the job did not fail')
    ],
    indexes: [{ columns: ['state', 'requested_at'] }]
  }),

  defineTable({
    table: 'meta_dictionary',
    layer: 'meta',
    domain: 'generation',
    description:
      'The dictionary itself, materialised into the generation at startup so the inspector reads ' +
      'columns the same way it reads data, and so a generation opened years later still explains its ' +
      'own columns without the code that wrote them.',
    naturalKey: ['dictionary_version', 'table_name', 'column_name'],
    appendOnly: false,
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.int('dictionary_version', 'The dictionary version these rows describe.', { sourceProvider: 'collector' }),
      col.text('table_name', 'The table.', { sourceProvider: 'collector' }),
      col.text('column_name', 'The column.', { sourceProvider: 'collector' }),
      col.int('ordinal', 'Column order within the table, so the inspector renders them as declared.', { sourceProvider: 'collector' }),
      col.enumOf('layer', ['meta', 'ref', 'raw', 'ext', 'derived', 'legacy', 'qa'], 'The table\'s prefix layer; the inspector groups by it.', { sourceProvider: 'collector' }),
      col.text('domain', 'The table\'s domain within its layer.', { sourceProvider: 'collector' }),
      col.text('table_description', 'What the table holds.', { sourceProvider: 'collector' }),
      col.enumOf('sql_type', ['INTEGER', 'REAL', 'TEXT'], 'The storage class.', { sourceProvider: 'collector' }),
      col.text('unit', 'The unit the value is stored in — the inspector\'s unit badge.', { sourceProvider: 'collector' }),
      col.flag('nullable', 'Whether the column admits null.', { sourceProvider: 'collector' }),
      nullable(col.text('null_meaning', 'What a null means here. AC-3 requires this whenever `nullable` is 1.'), 'the column is not nullable'),
      nullable(col.text('status_column', 'The companion status column, when null has more than one meaning.'), 'null has a single meaning, stated in `null_meaning`'),
      nullable(col.json('enum_values', 'The fixed set, when the unit is `enum`. Rendered as filter chips.'), 'not an enumerated column'),
      nullable(col.text('unit_column', 'Which column names the unit of this value, when the unit varies per row.'), 'the unit is fixed and stated in `unit`'),
      nullable(col.text('converter', 'The named converter that produced this value from the provider representation.'), 'stored exactly as the provider sent it — no conversion'),
      nullable(col.text('source_provider', 'Where the value comes from.'), 'written by the collector about itself'),
      nullable(col.text('source_field', 'The provider\'s own field path, verbatim.'), 'no single provider field maps to this column'),
      col.text('description', 'What the column means.', { sourceProvider: 'collector' }),
      col.flag('is_primary_key', 'Whether the column is the table\'s primary key.', { sourceProvider: 'collector' }),
      nullable(col.text('references_table', 'The table this column references.'), 'not a foreign key'),
      col.json('natural_key', 'The table\'s natural key, repeated on every column row so a single query answers version mode.', { sourceProvider: 'collector' }),
      col.flag('append_only', 'Whether the table refuses UPDATE and DELETE (AC-2).', { sourceProvider: 'collector' }),
      nullable(col.text('verify_note', 'The 02 §16 verify-list note, when this field has not yet been observed in a live response.'), 'the field has been observed in a live response')
    ],
    indexes: [
      { columns: ['dictionary_version', 'table_name', 'column_name'], unique: true },
      { columns: ['table_name'] }
    ]
  })
];
