/**
 * @tradeanalyzer/core — shared, Electron-free core for the TradeAnalyzer rebuild.
 *
 * Specified in `NewApp/requirements/` (06 §2 for this package). The remaining
 * directories — `collector/`, `ingest/`, `qa/`, `providers/`, `units/`,
 * `calendar/`, `legacy/` — arrive with the build steps that need them (06 §9).
 * Nothing is created empty to look complete.
 */

export { COLLECTOR_VERSION } from './version.js';

export { etTimestamp, etDate } from './time.js';

export type { SqliteLike, SqliteStatementLike } from './db/sqlite-like.js';

export { assertNotRedirected, detectRedirect, shadowSuffixes } from './db/appdata-redirect.js';
export type { RedirectFinding } from './db/appdata-redirect.js';
export { recordOpenHandle, recordCloseHandle } from './db/open-handle.js';
export type { OpenHandleFacts } from './db/open-handle.js';

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

export * from './collector/index.js';
export * from './qa/index.js';

// Phase 9's derivation (B7b). Exported as a pure function in its own right, not
// only through the phase that stores it, so a study or a replay can recompute a
// stored row and compare rather than trust it (P4).
export {
  deriveIv30,
  IV30_DERIVATION_VERSION,
  TARGET_DTE as IV30_TARGET_DTE
} from './derive/iv30.js';
export type { Iv30Input, Iv30Row, Iv30ContractRow } from './derive/iv30.js';
