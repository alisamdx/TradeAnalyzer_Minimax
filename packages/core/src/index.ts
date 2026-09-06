/**
 * @tradeanalyzer/core — shared, Electron-free core for the TradeAnalyzer rebuild.
 *
 * Specified in `NewApp/requirements/` (06 §2 for this package). The remaining
 * directories — `collector/`, `ingest/`, `qa/`, `providers/`, `units/`,
 * `calendar/`, `legacy/` — arrive with the build steps that need them (06 §9).
 * Nothing is created empty to look complete.
 */

/**
 * Written to `meta_run.collector_version` on every run (06 §2, §6). Kept in step
 * with this package's `version` field, which a test asserts — drift between the
 * two would mislabel every run of a generation, silently, and only visibly much
 * later.
 */
export const COLLECTOR_VERSION = '0.1.0';

export type { SqliteLike, SqliteStatementLike } from './db/sqlite-like.js';

export {
  DICTIONARY,
  DICTIONARY_VERSION,
  LAYER_ORDER,
  tableNames,
  getTable,
  allColumns,
  groupedForInspector,
  unverifiedColumns
} from './dictionary/index.js';

export type {
  ColumnEntry,
  IndexEntry,
  Layer,
  Provider,
  SqlType,
  StatusValue,
  TableEntry,
  Unit
} from './dictionary/types.js';

export { STATUS_VALUES, UNIT_STORAGE } from './dictionary/types.js';

export {
  generateDdl,
  fullSchemaSql,
  tableDdl,
  indexDdl,
  appendOnlyTriggerDdl
} from './dictionary/ddl.js';
export type { GeneratedDdl } from './dictionary/ddl.js';

export { applyDictionary, materialiseDictionary } from './dictionary/apply.js';
export type { ApplyResult } from './dictionary/apply.js';
