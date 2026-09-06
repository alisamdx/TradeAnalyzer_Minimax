/**
 * The database surface `core` compiles against — see 06 §11.
 *
 * `core` never loads a SQLite driver. The host opens the connection and passes
 * an instance in, which is what keeps `core` free of the native binary and so
 * free of the Electron/Node ABI flip that bites the existing app (CLAUDE.md).
 *
 * **This interface is not permitted to grow to accommodate a convenience.**
 * `.pluck()`, `.raw()`, `.iterate()`, user-defined functions and the online-backup
 * API are deliberately absent: needing a driver-specific feature is the signal
 * that the work belongs in the host, not here. If a large scan ever genuinely
 * needs streaming, the host passes a callback — the interface does not widen.
 * Widening it until it re-exports `better-sqlite3` would restore exactly the
 * coupling this avoids.
 */
export interface SqliteStatementLike {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteLike {
  prepare(sql: string): SqliteStatementLike;
  exec(sql: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}
