/**
 * @tradeanalyzer/core — shared, Electron-free core for the TradeAnalyzer rebuild.
 *
 * Specified in `NewApp/requirements/` (06 §2 for this package). Stage 1 fills in
 * `dictionary/`, `collector/`, `ingest/`, `qa/`, `providers/`, `units/`,
 * `calendar/` and `legacy/` in build-order steps B2 onward; at B1 the package
 * exists, compiles, and is guarded by the purity test.
 */

/**
 * Written to `meta_run.collector_version` on every run (06 §2, §6).
 * Kept in step with this package's `version` field.
 */
export const COLLECTOR_VERSION = '0.1.0';

/**
 * Written to `meta_run.dictionary_version` and `meta_dictionary.dictionary_version`
 * (02 §0.5). A plain integer, bumped on **any** change to **any** dictionary
 * entry — it is what tells a reader whether two generations share a schema.
 * Stays 0 until the dictionary itself lands at B2.
 */
export const DICTIONARY_VERSION = 0;

export type { SqliteLike, SqliteStatementLike } from './db/sqlite-like.js';
