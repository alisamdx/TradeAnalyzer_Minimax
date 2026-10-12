import { createHash } from 'node:crypto';
import type { SqliteLike } from '../db/sqlite-like.js';
import type { CollectorHost, ProviderName } from './host.js';
import { readArchivedResponse, type ArchiveLine } from './archive.js';
import { indexAndIngest } from './capture.js';
import { beginRun, finishRun, type RunHandle } from './run.js';
import { runDerivePhase } from './phases/derive.js';
import { parseStoredRecipe, RecipeError, type IngestRecipe } from '../ingest/recipes.js';
import { DICTIONARY, DICTIONARY_VERSION } from '../dictionary/index.js';
import type { TableEntry } from '../dictionary/types.js';
import { COLLECTOR_VERSION } from '../version.js';

/**
 * `replay` — 04 §7.5, P4, AC-4 (B9b).
 *
 * Re-runs the CURRENT ingestion code over a run's archived responses into a
 * fresh scratch database, then compares the result with what the generation
 * holds. Equal means today's code reproduces what was stored; different means
 * either the code changed how it parses, or something stored is not what that
 * parse produced — and the diff says which rows.
 *
 * **What it replays, and what it refuses to pretend about.** A response is
 * replayed only when it carries a recipe (`meta_response.ingest_recipe_id`),
 * because the recipe is the only faithful record of how it was parsed. Every
 * response that could not be replayed is COUNTED, by reason — no recipe, captured
 * before recipes existed, archive line unreadable, digest mismatch — and a
 * replay that replayed nothing is `nothing_replayable`, never `equal`. An
 * equivalence check that "passes" on zero comparisons is the zero-overlap trap
 * this project has now written up three times.
 *
 * **What it compares.** Per replayed response, the rows that response produced,
 * over the dictionary's fact columns: every column except the primary key and
 * the reference columns (`run_id`, `source_response_id`, `capture_rule_id`, an
 * order leg's `order_row_id` — surrogates that necessarily differ in a fresh
 * database). `observed_at` is kept for raw rows, where it comes from the
 * archived response, and excluded for derived rows, where it is the
 * derivation's own clock: re-deriving a day deliberately appends a later
 * version, so that value is bookkeeping rather than a fact about the market.
 *
 * Rows written by code other than a parser — the universe reconciliation, the
 * legacy import, sticky pins — are outside the comparison by construction:
 * their responses carry no recipe, and the comparison is keyed on responses.
 *
 * The source generation is only ever READ.
 */

/** Recipes are recorded from this dictionary version on; a run older than it has none to replay. */
export const RECIPES_FROM_DICTIONARY = 11;

export interface ReplayCoverage {
  readonly considered: number;
  readonly replayed: number;
  /** Archived for provenance only — no parser ran, so there is nothing to re-run. */
  readonly noIngest: number;
  /** Captured before recipes were recorded; cannot be replayed without guessing. */
  readonly beforeRecipes: number;
  /** The archive line was missing or could not be decrypted. */
  readonly unreadable: number;
  /** The archived body no longer hashes to the digest recorded at capture. */
  readonly digestMismatch: number;
  /** A recorded recipe the current code cannot build — an unknown module or bad arguments. */
  readonly badRecipe: number;
}

export interface TableDiff {
  readonly table: string;
  /** The fact columns compared. */
  readonly columns: readonly string[];
  readonly sourceRows: number;
  readonly replayRows: number;
  readonly matched: number;
  /** Rows the replay produced that the generation does not hold. */
  readonly added: number;
  /** Rows the generation holds that the replay did not produce. */
  readonly removed: number;
  /** Of those, pairs that share a natural key — the same fact, with a different value. */
  readonly changed: number;
  readonly addedSamples: readonly Readonly<Record<string, unknown>>[];
  readonly removedSamples: readonly Readonly<Record<string, unknown>>[];
}

export type ReplayVerdict = 'equal' | 'equal_on_replayed' | 'different' | 'nothing_replayable';

export interface ReplayReport {
  readonly sourceRunIds: readonly number[];
  readonly tradingDates: readonly string[];
  readonly coverage: ReplayCoverage;
  /** Up to 20 responses that could not be replayed, each with its reason. */
  readonly problems: readonly string[];
  readonly derivedCompared: boolean;
  readonly derivedNote: string | null;
  readonly tables: readonly TableDiff[];
  readonly verdict: ReplayVerdict;
}

const CHUNK = 400;
const SAMPLES = 5;
const MAX_PROBLEMS = 20;

const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',');

/** Everything the comparison holds a replay to. */
export function factColumns(entry: TableEntry): readonly string[] {
  return entry.columns
    .filter((c) => c.primaryKey !== true)
    .filter((c) => c.references === undefined)
    .filter((c) => !(entry.layer === 'derived' && c.column === 'observed_at'))
    .map((c) => c.column);
}

function* rowsOf(
  db: SqliteLike,
  table: string,
  columns: readonly string[],
  filterColumn: string,
  ids: readonly number[]
): Generator<Record<string, unknown>> {
  const select = columns.map(quote).join(', ');
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = db
      .prepare(`SELECT ${select} FROM ${quote(table)} WHERE ${quote(filterColumn)} IN (${placeholders(chunk.length)})`)
      .all(...chunk) as Record<string, unknown>[];
    yield* rows;
  }
}

function digestOf(values: readonly unknown[]): string {
  return createHash('sha1').update(JSON.stringify(values)).digest('hex');
}

/**
 * Multiset comparison of one table, in three streaming passes so a day's
 * several hundred thousand chain rows are never held as objects at once: count
 * the source's row digests; walk the replay, matching against the counts; walk
 * the source again for what is left over. A row that appears twice must appear
 * twice — a set comparison would call a duplicated insert "equal".
 */
function diffTable(
  entry: TableEntry,
  source: { readonly db: SqliteLike; readonly column: string; readonly ids: readonly number[] },
  replay: { readonly db: SqliteLike; readonly column: string; readonly ids: readonly number[] }
): TableDiff {
  const columns = factColumns(entry);
  const keyColumns = entry.naturalKey.filter((k) => columns.includes(k));
  const valuesOf = (row: Record<string, unknown>): unknown[] => columns.map((c) => row[c] ?? null);
  const keyOf = (row: Record<string, unknown>): string => digestOf(keyColumns.map((c) => row[c] ?? null));

  const counts = new Map<string, number>();
  let sourceRows = 0;
  for (const row of rowsOf(source.db, entry.table, columns, source.column, source.ids)) {
    const d = digestOf(valuesOf(row));
    counts.set(d, (counts.get(d) ?? 0) + 1);
    sourceRows++;
  }

  let replayRows = 0;
  let matched = 0;
  let added = 0;
  const addedKeys = new Map<string, number>();
  const addedSamples: Record<string, unknown>[] = [];
  for (const row of rowsOf(replay.db, entry.table, columns, replay.column, replay.ids)) {
    replayRows++;
    const d = digestOf(valuesOf(row));
    const c = counts.get(d) ?? 0;
    if (c > 0) {
      counts.set(d, c - 1);
      matched++;
    } else {
      added++;
      const k = keyOf(row);
      addedKeys.set(k, (addedKeys.get(k) ?? 0) + 1);
      if (addedSamples.length < SAMPLES) addedSamples.push(row);
    }
  }

  let removed = 0;
  let changed = 0;
  const removedSamples: Record<string, unknown>[] = [];
  if (matched < sourceRows) {
    for (const row of rowsOf(source.db, entry.table, columns, source.column, source.ids)) {
      const d = digestOf(valuesOf(row));
      const c = counts.get(d) ?? 0;
      if (c === 0) continue;
      counts.set(d, c - 1);
      removed++;
      const k = keyOf(row);
      const a = addedKeys.get(k) ?? 0;
      if (a > 0 && keyColumns.length > 0) {
        addedKeys.set(k, a - 1);
        changed++;
      }
      if (removedSamples.length < SAMPLES) removedSamples.push(row);
    }
  }

  return {
    table: entry.table, columns, sourceRows, replayRows, matched, added, removed, changed,
    addedSamples, removedSamples
  };
}

interface SourceResponse {
  source_response_id: number;
  run_id: number;
  provider: string;
  endpoint: string;
  params_json: string;
  archive_file: string;
  archive_offset: number;
  sha256: string | null;
  byte_length: number | null;
  dedup_hash: string;
  encrypted: number;
  at_provider_cap: number;
  ingest_recipe_id: number | null;
  capture_rule_id: number | null;
}

export function runReplay(args: {
  readonly source: SqliteLike;
  readonly target: SqliteLike;
  readonly host: CollectorHost;
  readonly runIds: readonly number[];
}): ReplayReport {
  const { source, target, host } = args;
  const runIds = [...new Set(args.runIds)];

  const runs = source
    .prepare(
      `SELECT run_id, run_kind, slot, trading_date, dictionary_version FROM meta_run
        WHERE run_id IN (${placeholders(runIds.length)})`
    )
    .all(...runIds) as { run_id: number; run_kind: string; slot: string; trading_date: string; dictionary_version: number }[];
  if (runs.length !== runIds.length) {
    const found = new Set(runs.map((r) => r.run_id));
    throw new Error(`No run ${runIds.filter((id) => !found.has(id)).join(', ')} in this generation.`);
  }
  if (runs.some((r) => r.run_kind === 'replay')) {
    throw new Error('A replay run holds no captures of its own to replay.');
  }

  // Capture rules are configuration, copied verbatim so every replayed row's
  // `capture_rule_id` resolves in the scratch database.
  const rules = source
    .prepare('SELECT capture_rule_id, domain, version, definition_json, description, valid_from, valid_to FROM meta_capture_rule')
    .all() as Record<string, unknown>[];
  const insertRule = target.prepare(
    `INSERT OR IGNORE INTO meta_capture_rule
       (capture_rule_id, domain, version, definition_json, description, valid_from, valid_to)
     VALUES (?,?,?,?,?,?,?)`
  );
  for (const r of rules) {
    insertRule.run(r['capture_rule_id'], r['domain'], r['version'], r['definition_json'], r['description'], r['valid_from'], r['valid_to']);
  }

  // One replay run per source run — inserted directly rather than through
  // `beginRun`, which would fold two source runs of the same day into one.
  const now = host.nowET();
  const runMap = new Map<number, RunHandle>();
  for (const r of runs) {
    const info = target
      .prepare(
        `INSERT INTO meta_run (
           run_kind, slot, trading_date, started_at, status,
           host_app, host_version, collector_version, dictionary_version
         ) VALUES ('replay', ?, ?, ?, 'running', ?, ?, ?, ?)`
      )
      .run(r.slot, r.trading_date, now, host.hostApp.name, host.hostApp.version, COLLECTOR_VERSION, DICTIONARY_VERSION);
    runMap.set(r.run_id, {
      runId: Number(info.lastInsertRowid), tradingDate: r.trading_date, kind: 'replay', startedAt: now, resumed: false
    });
  }
  const dictVersionOf = new Map(runs.map((r) => [r.run_id, r.dictionary_version]));

  const responses = source
    .prepare(
      `SELECT source_response_id, run_id, provider, endpoint, params_json, archive_file, archive_offset,
              sha256, byte_length, dedup_hash, encrypted, at_provider_cap, ingest_recipe_id, capture_rule_id
         FROM meta_response WHERE run_id IN (${placeholders(runIds.length)})
        ORDER BY source_response_id`
    )
    .all(...runIds) as SourceResponse[];
  const recipeRow = source.prepare('SELECT module, args_json FROM meta_ingest_recipe WHERE recipe_id = ?');

  const coverage = {
    considered: 0, replayed: 0, noIngest: 0, beforeRecipes: 0, unreadable: 0, digestMismatch: 0, badRecipe: 0
  };
  const problems: string[] = [];
  const note = (r: SourceResponse, why: string): void => {
    if (problems.length < MAX_PROBLEMS) problems.push(`response ${r.source_response_id} (${r.archive_file}): ${why}`);
  };
  /** Runs where a parsed response could not be replayed — their derivations cannot be compared fairly. */
  const runsWithGaps = new Set<number>();
  const idMap = new Map<number, number>();

  for (const r of responses) {
    coverage.considered++;

    if (r.ingest_recipe_id === null) {
      if ((dictVersionOf.get(r.run_id) ?? 0) < RECIPES_FROM_DICTIONARY) {
        coverage.beforeRecipes++;
        runsWithGaps.add(r.run_id);
      } else {
        coverage.noIngest++;
      }
      continue;
    }

    let recipe: IngestRecipe;
    try {
      const stored = recipeRow.get(r.ingest_recipe_id) as { module: string; args_json: string } | undefined;
      if (!stored) throw new RecipeError(`recipe ${r.ingest_recipe_id} is not recorded`);
      recipe = parseStoredRecipe(stored.module, stored.args_json);
    } catch (err) {
      coverage.badRecipe++;
      runsWithGaps.add(r.run_id);
      note(r, err instanceof Error ? err.message : String(err));
      continue;
    }

    let line: ArchiveLine;
    try {
      line = readArchivedResponse(host, r.archive_file, r.archive_offset);
    } catch (err) {
      coverage.unreadable++;
      runsWithGaps.add(r.run_id);
      note(r, err instanceof Error ? err.message : String(err));
      continue;
    }

    if (r.sha256 !== null && createHash('sha256').update(Buffer.from(line.body, 'utf8')).digest('hex') !== r.sha256) {
      coverage.digestMismatch++;
      runsWithGaps.add(r.run_id);
      note(r, 'the archived body no longer hashes to the digest recorded at capture');
      continue;
    }

    // The as-of date a capture used is the archive directory it wrote into:
    // `archive/<provider>/<as_of_date>/<slug>.<ext>`.
    const asOfDate = r.archive_file.split('/')[2] ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      coverage.unreadable++;
      runsWithGaps.add(r.run_id);
      note(r, 'the archive path does not carry an as-of date');
      continue;
    }

    const run = runMap.get(r.run_id) as RunHandle;
    const result = indexAndIngest({
      db: target,
      now: host.nowET(),
      runId: run.runId,
      asOfDate,
      provider: r.provider as ProviderName,
      endpoint: r.endpoint,
      paramsJson: r.params_json,
      response: {
        status: line.status,
        body: line.body,
        requestedAt: line.requestedAt,
        respondedAt: line.respondedAt,
        ...(line.error ? { error: line.error } : {})
      },
      location: {
        archiveFile: r.archive_file,
        archiveOffset: r.archive_offset,
        sha256: r.sha256 ?? '',
        byteLength: r.byte_length ?? 0
      },
      dedupHash: r.dedup_hash,
      encrypted: r.encrypted === 1,
      atProviderCap: r.at_provider_cap === 1,
      captureRuleId: r.capture_rule_id,
      recipe
    });
    idMap.set(r.source_response_id, result.sourceResponseId);
    coverage.replayed++;
  }

  // Derivations run over the rebuilt raw layer, for runs whose source derived
  // anything — and only where every parsed response of the run was replayed,
  // since a derivation over a partial chain would differ for a reason that has
  // nothing to do with the code.
  const derivedTables = DICTIONARY.filter((t) => t.layer === 'derived');
  const derivedRuns = runs.filter((r) =>
    derivedTables.some(
      (t) => (source.prepare(`SELECT COUNT(*) AS n FROM ${quote(t.table)} WHERE run_id = ?`).get(r.run_id) as { n: number }).n > 0
    )
  );
  const comparableDerivedRuns = derivedRuns.filter((r) => !runsWithGaps.has(r.run_id));
  for (const r of comparableDerivedRuns) runDerivePhase(target, host, runMap.get(r.run_id) as RunHandle);
  const derivedCompared = derivedRuns.length > 0 && comparableDerivedRuns.length === derivedRuns.length;
  const derivedNote =
    derivedRuns.length === 0
      ? null
      : derivedCompared
        ? null
        : `${derivedRuns.length - comparableDerivedRuns.length} run(s) with derived rows were not compared: ` +
          'some of their parsed responses could not be replayed, so a derivation over the rebuilt data would ' +
          'differ for reasons unrelated to the code.';

  target.prepare("UPDATE meta_run SET status = 'complete', finished_at = ? WHERE run_kind = 'replay'").run(host.nowET());

  const sourceIds = [...idMap.keys()];
  const targetIds = [...idMap.values()];
  // Compared over the columns the SOURCE could have filled: those in the dictionary of the oldest
  // run replayed (v1.1.284). A nullable column added since is null on every earlier row and filled
  // by today's parser — `raw_insider_transaction.line_no` (v19), `provider_symbol` (v1.1.257) — so
  // comparing it reports `different` for a change that is growth, not a parser disagreement.
  // `TableDiff.columns` lists what was compared, so the narrowing is visible in the report.
  const oldestVersion = Math.min(...runs.map((r) => r.dictionary_version));
  const columnsThen = source.prepare(
    'SELECT column_name FROM meta_dictionary WHERE table_name = ? AND dictionary_version = ?'
  );
  const comparable = (entry: TableEntry): TableEntry => {
    const then = new Set((columnsThen.all(entry.table, oldestVersion) as { column_name: string }[]).map((r) => r.column_name));
    // A table the old dictionary did not have holds no old rows: nothing to narrow.
    return then.size === 0 ? entry : { ...entry, columns: entry.columns.filter((c) => then.has(c.column)) };
  };
  const tables: TableDiff[] = [];
  for (const entry of DICTIONARY) {
    if (entry.layer === 'derived') continue;
    if (!['raw', 'ext', 'legacy'].includes(entry.layer)) continue;
    if (!entry.columns.some((c) => c.column === 'source_response_id')) continue;
    const diff = diffTable(
      comparable(entry),
      { db: source, column: 'source_response_id', ids: sourceIds },
      { db: target, column: 'source_response_id', ids: targetIds }
    );
    if (diff.sourceRows > 0 || diff.replayRows > 0) tables.push(diff);
  }
  if (derivedCompared) {
    const targetRunIds = comparableDerivedRuns.map((r) => (runMap.get(r.run_id) as RunHandle).runId);
    for (const entry of derivedTables) {
      const diff = diffTable(
        entry,
        { db: source, column: 'run_id', ids: comparableDerivedRuns.map((r) => r.run_id) },
        { db: target, column: 'run_id', ids: targetRunIds }
      );
      if (diff.sourceRows > 0 || diff.replayRows > 0) tables.push(diff);
    }
  }

  const gaps = coverage.beforeRecipes + coverage.unreadable + coverage.digestMismatch + coverage.badRecipe;
  const verdict: ReplayVerdict =
    coverage.replayed === 0
      ? 'nothing_replayable'
      : tables.some((t) => t.added > 0 || t.removed > 0)
        ? 'different'
        : gaps > 0 || (derivedRuns.length > 0 && !derivedCompared)
          ? 'equal_on_replayed'
          : 'equal';

  return {
    sourceRunIds: runIds,
    tradingDates: [...new Set(runs.map((r) => r.trading_date))].sort(),
    coverage,
    problems,
    derivedCompared,
    derivedNote,
    tables,
    verdict
  };
}

export interface ReplayJobReport extends ReplayReport {
  /** The replay job's own run in the source generation. */
  readonly jobRunId: number;
  /** Where the scratch database was kept — only when the replay found a difference. */
  readonly scratchPath: string | null;
}

/**
 * The one-shot job: replays one daily run (by default the latest completed one)
 * into a scratch file inside the generation's directory.
 *
 * The scratch file is **kept only when the replay found a difference** — it is
 * then the evidence, and the report names its path. An equal replay has nothing
 * to show and a day's chain is several hundred megabytes, so it is deleted.
 */
export function runReplayJob(
  host: CollectorHost,
  args: { readonly tradingDate: string; readonly runId?: number }
): ReplayJobReport {
  if (!host.openScratchDb) {
    throw new Error('This host cannot open a scratch database, so it cannot run a replay.');
  }
  const source = host.openGenerationDb();
  const job = beginRun(source, host, { kind: 'replay', tradingDate: args.tradingDate });

  try {
    const runId =
      args.runId ??
      (
        source
          // A run that captured something. Weekend runs before v1.1.350 closed `complete` with no
          // responses, and the default picked Sunday 2026-10-11's: "0/0 responses replayed".
          .prepare(
            `SELECT m.run_id FROM meta_run m
              WHERE m.run_kind = 'daily' AND m.status = 'complete'
                AND EXISTS (SELECT 1 FROM meta_response r WHERE r.run_id = m.run_id)
              ORDER BY m.run_id DESC LIMIT 1`
          )
          .get() as { run_id: number } | undefined
      )?.run_id;
    if (runId === undefined) throw new Error('There is no completed daily run in this generation to replay yet.');

    const stamp = host.nowET().replace(/[^0-9]/g, '').slice(0, 14);
    const scratch = host.openScratchDb(`replay-run${runId}-${stamp}`);
    let report: ReplayReport;
    try {
      report = runReplay({ source, target: scratch.db, host, runIds: [runId] });
    } catch (err) {
      scratch.discard();
      throw err;
    }

    const keep = report.verdict === 'different';
    if (keep) scratch.close();
    else scratch.discard();

    finishRun(source, host, job, 'complete');
    return { ...report, jobRunId: job.runId, scratchPath: keep ? scratch.path : null };
  } catch (err) {
    finishRun(source, host, job, 'failed');
    throw err;
  }
}
