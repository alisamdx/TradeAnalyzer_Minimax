import type { SqliteLike } from '../db/sqlite-like.js';
import type { CollectorHost } from './host.js';
import { beginRun, finishRun, captureRuleId, type RunHandle } from './run.js';
import { captureResponse } from './capture.js';

/**
 * `legacy_import` — the one-time backward import (04 §7.4, Q19).
 *
 * **Only two of Q19's five categories are copied, and the other three have no
 * code path at all** — not a flag, not a disabled branch. Secrets are
 * re-entered when the new exe takes over (category 2); provider market data is
 * re-fetched under the new rules (category 3); the book is re-synced from the
 * broker, because the old rows carry "estimated from last mark" P&L that real
 * fills proved wrong in both directions (category 4). A category that cannot be
 * copied by accident is better than one guarded by a boolean somebody flips.
 *
 * **It does not ATTACH.** 04 §7.4 drafted an attach of the old database, but
 * the job executes *inside* the old app, which already holds a write-capable
 * connection to that file — so the handle is passed in. Attaching a second one
 * to a file this process has open would add a connection for no gain and
 * re-introduce the Windows WAL problem the attach note was worrying about.
 *
 * **Re-running it is safe, but not in the way 04 §7.4 assumed.** That section
 * says a second import "writes nothing already present (natural keys)" — and
 * `naturalKey` in the dictionary is **metadata only**: the DDL generator emits
 * no unique index from it, so `INSERT OR IGNORE` has nothing to conflict on and
 * dedups nothing. Two different behaviours are correct for the two halves, and
 * both are now explicit rather than assumed:
 *
 * - **Configuration is versioned per import.** `import_run_id` is part of its
 *   declared natural key, so each import is a distinct event and recording it
 *   again is the append-only behaviour, not a duplicate. It also answers a
 *   question a deduplicated table could not: what the configuration looked like
 *   at each import.
 * - **Decisions are deduplicated**, by checking the declared natural key before
 *   inserting. Their key carries no import id, so a second import genuinely
 *   would have duplicated 62 briefs' worth of history.
 */

export const LEGACY_IMPORT_RULE = {
  categories: [1, 5],
  neverCopied: [2, 3, 4],
  origin: 'legacy_import'
} as const;

export type ConfigKind =
  | 'watchlist'
  | 'conviction_stock'
  | 'conviction_band'
  | 'etf_list'
  | 'scoring_config'
  | 'screen_preset'
  | 'payoff_strategy';

export interface ImportedTable {
  readonly sourceTable: string;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly rowsRejected: number;
  readonly rejections: readonly { readonly key: string; readonly why: string }[];
}

export interface LegacyImportReport {
  readonly runId: number;
  /**
   * The import's own `meta_run.run_id`.
   *
   * A number, not a composite string: the dictionary declares `import_run_id`
   * as an INTEGER foreign key back to `meta_run`, so the import is identified
   * by its run like everything else. A text key would have been a second
   * identity for the same thing.
   */
  readonly importRunId: number;
  readonly tables: readonly ImportedTable[];
  readonly configRows: number;
  readonly decisionRows: number;
  readonly rejected: number;
}

/** A rejection is a finding, not a silent skip: it names the row and the reason. */
type Validation = { ok: true } | { ok: false; why: string };

/**
 * Category 1's sources, one per `config_kind`.
 *
 * `keyOf` must be stable across imports — it is half the natural key, so an
 * unstable one (a rowid, a timestamp) would make a re-run duplicate rather
 * than no-op.
 */
interface ConfigSource {
  readonly kind: ConfigKind;
  readonly table: string;
  readonly query: string;
  keyOf(row: Record<string, unknown>): string;
  validate(row: Record<string, unknown>): Validation;
}

const ok: Validation = { ok: true };

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The one validator Q19 asks for by name.
 *
 * "The old conviction table held inverted bands for three weeks — the import
 * must catch that, not carry it." An inverted band never throws: it just
 * computes the wrong zone, so it fed wrong Buy-zone alerts and the brief's
 * conviction callout silently. Bands are only compared where both values
 * exist; a missing band is incomplete, not inverted.
 */
export function validateBandOrder(row: Record<string, unknown>): Validation {
  const low = num(row['price_low']);
  const mid = num(row['price_mid']);
  const high = num(row['price_high']);

  if (low !== null && mid !== null && low >= mid) {
    return { ok: false, why: `price_low ${low} is not below price_mid ${mid}` };
  }
  if (mid !== null && high !== null && mid >= high) {
    return { ok: false, why: `price_mid ${mid} is not below price_high ${high}` };
  }
  if (low !== null && high !== null && low >= high) {
    return { ok: false, why: `price_low ${low} is not below price_high ${high}` };
  }
  return ok;
}

function requireKey(field: string) {
  return (row: Record<string, unknown>): Validation => {
    const v = row[field];
    return typeof v === 'string' && v.trim() !== ''
      ? ok
      : { ok: false, why: `${field} is missing or empty, so the row has no stable identity` };
  };
}

export const CONFIG_SOURCES: readonly ConfigSource[] = [
  {
    kind: 'watchlist',
    table: 'watchlists',
    query: 'SELECT * FROM watchlists',
    keyOf: (r) => String(r['name'] ?? r['id'] ?? ''),
    validate: requireKey('name')
  },
  {
    kind: 'conviction_stock',
    table: 'conviction_stocks',
    query: 'SELECT * FROM conviction_stocks',
    keyOf: (r) => String(r['ticker'] ?? ''),
    validate: (r) => {
      const key = requireKey('ticker')(r);
      return key.ok ? validateBandOrder(r) : key;
    }
  },
  {
    kind: 'conviction_band',
    table: 'conviction_band_history',
    query: 'SELECT * FROM conviction_band_history',
    // The history is append-only in the old app, so ticker alone is not unique;
    // the change timestamp completes the identity.
    keyOf: (r) => `${String(r['ticker'] ?? '')}:${String(r['changed_at'] ?? r['id'] ?? '')}`,
    validate: requireKey('ticker')
  },
  {
    kind: 'etf_list',
    table: 'constituents',
    // `index_name`, the column the old app actually has (migration 002; the ETF
    // list is `index_name = 'etf'`, as `universe-sources.ts` reads it). This
    // said `universe = 'etf'` — a column that has never existed — and it was
    // never caught because the importer was handed the new generation instead
    // of the old database until v1.1.237, so no query ever reached a real table.
    query: "SELECT * FROM constituents WHERE index_name = 'etf'",
    keyOf: (r) => String(r['ticker'] ?? ''),
    validate: requireKey('ticker')
  },
  {
    kind: 'scoring_config',
    table: 'scoring_strategy_configs',
    query: 'SELECT * FROM scoring_strategy_configs',
    keyOf: (r) => `${String(r['strategy'] ?? '')}:${String(r['version'] ?? '')}`,
    validate: requireKey('strategy')
  },
  {
    kind: 'screen_preset',
    table: 'screen_presets',
    query: 'SELECT * FROM screen_presets',
    keyOf: (r) => String(r['name'] ?? r['id'] ?? ''),
    validate: requireKey('name')
  },
  {
    kind: 'payoff_strategy',
    table: 'payoff_strategies',
    query: 'SELECT * FROM payoff_strategies',
    keyOf: (r) => String(r['name'] ?? r['id'] ?? ''),
    validate: requireKey('name')
  }
];

/** A source table the old install may simply not have. Absent is not an error. */
function tableExists(db: SqliteLike, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

export function runLegacyImport(
  host: CollectorHost,
  args: { readonly legacyDb: SqliteLike; readonly tradingDate: string }
): LegacyImportReport {
  const db: SqliteLike = host.openGenerationDb();
  const run: RunHandle = beginRun(db, host, {
    kind: 'legacy_import',
    tradingDate: args.tradingDate
  });

  try {
    const ruleId = captureRuleId(
      db, host, 'legacy_import', LEGACY_IMPORT_RULE,
      'Q19 categories 1 and 5 only; 2, 3 and 4 have no code path.'
    );
    const observedAt = host.nowET();
    const importRunId = run.runId;

    /**
     * Archives what was READ from a source table, and returns the response id
     * every row copied out of it will point at.
     *
     * `legacy_config_import.source_response_id` is NOT NULL, and for a moment
     * that looked like the `derived_iv30_daily` problem again — a row with no
     * response to name. It is not: **the rows read out of the old database are
     * the source**, so archiving them makes the claim true rather than
     * convenient. Any imported row can then be traced back to a verbatim copy
     * of what the importer actually saw, including the rows it rejected, which
     * is exactly AC-1's guarantee and is the only way a disputed rejection can
     * be re-examined later.
     */
    const archive = (table: string, rows: readonly unknown[]): number =>
      captureResponse({
        host, db, runId: run.runId, asOfDate: args.tradingDate, provider: 'host_app',
        endpoint: `legacy/import/${table}`, slug: 'legacy-import',
        params: { table, rows: String(rows.length) },
        response: {
          status: 200, body: JSON.stringify(rows),
          requestedAt: observedAt, respondedAt: observedAt
        },
        captureRuleId: ruleId
        // Archiving only, so no recipe. The rows are written below, where the
        // validator's verdict is also available to the rejection report — an
        // ingest module returns rows and cannot also report what it refused.
        // This used to pass `ingest: () => []`, which from B9b would have been
        // a recipe for "a parser that writes nothing", and a replay would then
        // have reported every imported row as missing. No recipe says what is
        // true: these rows are not the output of a parse.
      }).sourceResponseId;

    const ctx = {
      run_id: run.runId,
      as_of_date: args.tradingDate,
      observed_at: observedAt,
      capture_rule_id: ruleId
    };

    const tables: ImportedTable[] = [];
    let configRows = 0;
    let rejected = 0;

    // Not `OR IGNORE`: there is no unique index to conflict on, so it would
    // have read as protection while providing none. Each import is an event.
    const insertConfig = db.prepare(
      `INSERT INTO legacy_config_import
         (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
          import_run_id, config_kind, config_key, payload_json, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy_import')`
    );

    const importAll = db.transaction(() => {
      for (const source of CONFIG_SOURCES) {
        if (!tableExists(args.legacyDb, source.table)) {
          // Recorded with zero counts rather than skipped silently: "this
          // install had no screen presets" and "the importer forgot screen
          // presets" must not look the same in the log.
          tables.push({
            sourceTable: source.table, rowsRead: 0, rowsWritten: 0, rowsRejected: 0,
            rejections: [{ key: '(table)', why: 'not present in the legacy database' }]
          });
          continue;
        }

        const rows = args.legacyDb.prepare(source.query).all() as Record<string, unknown>[];
        const responseId = archive(source.table, rows);
        const rejections: { key: string; why: string }[] = [];
        let written = 0;

        for (const row of rows) {
          const key = source.keyOf(row);
          const verdict = source.validate(row);
          if (!verdict.ok) {
            rejections.push({ key: key || '(no key)', why: verdict.why });
            continue;
          }
          insertConfig.run(
            ctx.run_id, ctx.as_of_date, ctx.observed_at, ctx.capture_rule_id,
            responseId, importRunId, source.kind, key, JSON.stringify(row)
          );
          written += 1;
        }

        configRows += written;
        rejected += rejections.length;
        tables.push({
          sourceTable: source.table,
          rowsRead: rows.length,
          rowsWritten: written,
          rowsRejected: rejections.length,
          rejections
        });
      }

      const decisions = importDecisions(db, args.legacyDb, ctx, importRunId, archive);
      tables.push(...decisions.tables);

      const logRow = db.prepare(
        `INSERT INTO legacy_import_log
           (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
            import_run_id, source_table, rows_read, rows_written, rows_rejected,
            rejection_report_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const logResponseId = archive('_manifest', tables);
      for (const t of tables) {
        logRow.run(
          ctx.run_id, ctx.as_of_date, ctx.observed_at, ctx.capture_rule_id,
          logResponseId, importRunId, t.sourceTable,
          t.rowsRead, t.rowsWritten, t.rowsRejected,
          // **Every rejected row is listed**, not counted. A count says the
          // import dropped something; the list says what and why, which is the
          // difference between a finding and a rumour.
          JSON.stringify(t.rejections)
        );
      }

      return decisions.rows;
    });

    const decisionRows = importAll();
    finishRun(db, host, run, 'complete');

    return { runId: run.runId, importRunId, tables, configRows, decisionRows, rejected };
  } catch (err) {
    finishRun(db, host, run, 'failed');
    throw err;
  }
}

/**
 * Category 5 — the old app's stored decisions, into `legacy_*` with
 * `pre_collector = 1`.
 *
 * **That flag is the whole point.** These rows are survivors-only and
 * incomplete: `daily_briefs` kept the picks and not the candidates it rejected,
 * and for most of its life stored one slot per day and deleted the other. Rows
 * handed over live (04 §8) carry the losers and both slots. Pooling the two
 * silently would put a biased sample and an unbiased one in the same table with
 * nothing to tell them apart.
 */
function importDecisions(
  db: SqliteLike,
  legacy: SqliteLike,
  ctx: Record<string, unknown>,
  importRunId: number,
  archive: (table: string, rows: readonly unknown[]) => number
): { tables: ImportedTable[]; rows: number } {
  const tables: ImportedTable[] = [];
  let rows = 0;

  if (!tableExists(legacy, 'brief_candidates')) {
    tables.push({
      sourceTable: 'brief_candidates', rowsRead: 0, rowsWritten: 0, rowsRejected: 0,
      rejections: [{ key: '(table)', why: 'not present in the legacy database' }]
    });
    return { tables, rows };
  }

  // `brief_candidates` is the richer source and the only one that kept losers
  // (from v1.1.x onward). Each distinct (as_of_date, slot) is one legacy run.
  const candidates = legacy
    .prepare(
      `SELECT as_of_date, slot, strategy, ticker, composite_score, rank, disposition
         FROM brief_candidates ORDER BY as_of_date, slot, strategy, rank`
    )
    .all() as {
    as_of_date: string; slot: string; strategy: string; ticker: string;
    composite_score: number | null; rank: number; disposition: string;
  }[];

  const responseId = archive('brief_candidates', candidates);

  // Deduplicated on the declared natural key, because nothing in the schema
  // does it: a second import would otherwise duplicate every brief in the
  // history. Checked rather than `OR IGNORE`, for the same reason.
  const runExists = db.prepare('SELECT 1 AS present FROM legacy_brief_run WHERE legacy_run_id = ?');
  const candidateExists = db.prepare(
    'SELECT 1 AS present FROM legacy_brief_candidate WHERE legacy_run_id = ? AND ticker = ? AND mode = ?'
  );

  const insertRun = db.prepare(
    `INSERT INTO legacy_brief_run
       (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
        legacy_run_id, trading_date, slot, legacy_app_version, brief_id, emailed_at, pre_collector)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'imported', NULL, NULL, 1)`
  );
  const insertCandidate = db.prepare(
    `INSERT INTO legacy_brief_candidate
       (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
        legacy_run_id, ticker, mode, considered_rank, survived,
        composite_score, composite_score_status, final_disposition)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const seenRuns = new Set<string>();
  const rejections: { key: string; why: string }[] = [];

  for (const c of candidates) {
    // The old app's slot vocabulary is `intraday` / `after_close`.
    const slot = c.slot === 'intraday' ? 'morning' : 'after_close';
    const legacyRun = `${c.as_of_date}:${slot}:imported`;

    if (!seenRuns.has(legacyRun) && runExists.get(legacyRun) === undefined) {
      insertRun.run(
        ctx['run_id'], ctx['as_of_date'], ctx['observed_at'], ctx['capture_rule_id'],
        responseId, legacyRun, c.as_of_date, slot
      );
      seenRuns.add(legacyRun);
    }

    if (candidateExists.get(legacyRun, c.ticker, c.strategy) !== undefined) continue;

    const score = num(c.composite_score);
    insertCandidate.run(
      ctx['run_id'], ctx['as_of_date'], ctx['observed_at'], ctx['capture_rule_id'],
      responseId, legacyRun, c.ticker, c.strategy, c.rank,
      c.disposition === 'picked' ? 1 : 0,
      score, score === null ? 'omitted' : 'ok',
      c.disposition
    );
    rows += 1;
  }

  tables.push({
    sourceTable: 'brief_candidates',
    rowsRead: candidates.length,
    rowsWritten: rows,
    rowsRejected: rejections.length,
    rejections
  });
  void importRunId;
  return { tables, rows };
}
