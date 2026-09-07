import { createHash } from 'node:crypto';
import type { SqliteLike } from '../db/sqlite-like.js';
import type { CollectorHost, ProviderName, ProviderResponse } from './host.js';
import { archiveResponse } from './archive.js';

/**
 * The per-response contract — 04 §2.2.
 *
 * **Every provider call follows this path, in this order, and there is no other
 * path** (P11). Call, archive, then index-and-ingest in one transaction. A
 * second way to get data into a raw table would be a second way for provenance
 * to be missing, and it would be the one nobody remembers to check.
 */

export interface IngestContext {
  readonly runId: number;
  readonly asOfDate: string;
  readonly observedAt: string;
  readonly captureRuleId: number | null;
  readonly sourceResponseId: number;
}

/**
 * An ingestion module: **pure**, and given no database handle on purpose (04
 * §2.3). It cannot read or write anything but its own return value, which is
 * what makes replay reproducible at the byte level (AC-4) — a fixture in gives
 * fixed rows out, forever.
 */
export interface IngestedChildRows {
  readonly table: string;
  /** The child column that receives the parent's `row_id`. */
  readonly parentColumn: string;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}

export interface IngestedRowSpec {
  readonly table: string;
  readonly values: Readonly<Record<string, unknown>>;
  /**
   * Rows that cannot exist before their parent does.
   *
   * An order's legs are the case this exists for: `order_row_id` is not knowable
   * until the order row is inserted, and an ingestion module gets no database
   * handle by design (P11). Declaring the relationship instead of resolving it
   * keeps the module pure and keeps the insert inside the same transaction.
   */
  readonly children?: readonly IngestedChildRows[];
}

export type IngestModule = (body: string, ctx: IngestContext) => readonly IngestedRowSpec[];

export interface CaptureArgs {
  readonly host: CollectorHost;
  readonly db: SqliteLike;
  readonly runId: number;
  readonly asOfDate: string;
  readonly provider: ProviderName;
  /** The path as called, with any account key already masked (P15). */
  readonly endpoint: string;
  /** Names the archive file: `optionchains`, `account-portfolio`, ... (04 §6). */
  readonly slug: string;
  readonly params: Readonly<Record<string, string>>;
  readonly response: ProviderResponse;
  readonly captureRuleId: number | null;
  readonly ingest?: IngestModule;
  /**
   * True when the response size equals a known provider cap (P8). Finnhub's
   * bulk calendar truncates from the FRONT at 1,500, so a payload *at* the cap
   * is evidence of truncation — trusting one put an earnings date a quarter
   * late in the existing app and silently suppressed all three mechanisms that
   * would have corrected it.
   */
  readonly atProviderCap?: boolean;
}

export interface CaptureResult {
  readonly sourceResponseId: number;
  readonly parseStatus: 'ok' | 'partial' | 'failed';
  readonly rowsWritten: number;
  readonly archiveFile: string;
  readonly archiveOffset: number;
  /** Set when an identical response had already been ingested — see `dedup_hash`. */
  readonly deduplicated: boolean;
  readonly parseError?: string;
}

function dedupHash(
  provider: string,
  endpoint: string,
  paramsJson: string,
  body: string
): string {
  return createHash('sha256')
    .update(`${provider}\n${endpoint}\n${paramsJson}\n${body}`)
    .digest('hex');
}

function insertRow(
  db: SqliteLike,
  table: string,
  values: Readonly<Record<string, unknown>>
): number {
  const columns = Object.keys(values);
  const placeholders = columns.map(() => '?').join(', ');
  const quoted = columns.map((c) => `"${c}"`).join(', ');
  const info = db.prepare(`INSERT INTO "${table}" (${quoted}) VALUES (${placeholders})`).run(
    ...columns.map((c) => values[c] as unknown)
  );
  return Number(info.lastInsertRowid);
}

/**
 * Archive, index and ingest one response.
 *
 * The ordering that matters, and why:
 *
 * 1. **Archive first.** A crash between the archive write and the transaction
 *    leaves an orphan line, which QC-953 reconciles. The reverse — index first —
 *    would leave a row pointing at bytes that do not exist, and a dangling
 *    pointer is worse than an unreferenced fact.
 * 2. **Index and ingest in ONE transaction.** A `meta_response` row without its
 *    rows, or rows without their `meta_response`, would each break AC-1 in a way
 *    no check could distinguish from a genuine empty response.
 * 3. **An ingestion failure still commits the index row**, with
 *    `parse_status = 'failed'` and zero data rows. The body is in the archive,
 *    QC-001 fires, and a replay after the fix recovers the rows without
 *    refetching (P4). Rolling back would throw away the evidence needed to fix
 *    the parser.
 */
export function captureResponse(args: CaptureArgs): CaptureResult {
  const { host, db, response } = args;
  const paramsJson = JSON.stringify(args.params);
  const hash = dedupHash(args.provider, args.endpoint, paramsJson, response.body);

  // Idempotence for crash recovery and replay ONLY. Re-running a day is NOT
  // idempotent and is not meant to be: a fresh call returns a different body,
  // so it appends a new version with a later observed_at (P1).
  const existing = db
    .prepare('SELECT source_response_id, parse_status FROM meta_response WHERE dedup_hash = ?')
    .get(hash) as { source_response_id: number; parse_status: string } | undefined;
  if (existing) {
    return {
      sourceResponseId: existing.source_response_id,
      parseStatus: existing.parse_status as CaptureResult['parseStatus'],
      rowsWritten: 0,
      archiveFile: '',
      archiveOffset: -1,
      deduplicated: true
    };
  }

  const responseId = `${args.runId}-${args.provider}-${args.slug}-${Date.now()}`;
  const location = archiveResponse(host, {
    provider: args.provider,
    asOfDate: args.asOfDate,
    slug: args.slug,
    id: responseId,
    params: args.params,
    response
  });

  let parseStatus: CaptureResult['parseStatus'] = 'ok';
  let parseError: string | undefined;
  let rows: ReturnType<IngestModule> = [];

  // Parsing happens OUTSIDE the transaction so a throw cannot leave it open, and
  // so the index row can record the failure rather than vanish with it.
  if (args.ingest && response.status !== null && response.status >= 200 && response.status < 300) {
    try {
      rows = args.ingest(response.body, {
        runId: args.runId,
        asOfDate: args.asOfDate,
        observedAt: response.respondedAt ?? response.requestedAt,
        captureRuleId: args.captureRuleId,
        sourceResponseId: -1 // replaced below, once the row exists
      });
    } catch (err) {
      parseStatus = 'failed';
      parseError = err instanceof Error ? err.message : String(err);
      rows = [];
    }
  } else if (response.status === null || response.status < 200 || response.status >= 300) {
    // A non-2xx is archived and indexed like any other response — it is
    // evidence. It is simply not parsed.
    parseStatus = 'failed';
    parseError = response.error ?? `HTTP ${String(response.status)}`;
  }

  let sourceResponseId = 0;
  let rowsWritten = 0;
  // Counts children too, so AC-5's "stored equals parsed" holds for every table
  // a response writes rather than only the top-level one.
  const parsedRowCount = rows.reduce(
    (n, r) => n + 1 + (r.children ?? []).reduce((m, c) => m + c.rows.length, 0),
    0
  );

  const write = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO meta_response (
           run_id, provider, endpoint, params_json, requested_at, responded_at, http_status,
           byte_length, archive_file, archive_offset, sha256, dedup_hash, encrypted,
           at_provider_cap, parse_status, parsed_row_count
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        args.runId,
        args.provider,
        args.endpoint,
        paramsJson,
        response.requestedAt,
        response.respondedAt,
        response.status,
        location.byteLength,
        location.archiveFile,
        location.archiveOffset,
        location.sha256,
        hash,
        args.slug.startsWith('account-') ? 1 : 0,
        args.atProviderCap ? 1 : 0,
        parseStatus,
        parsedRowCount
      );
    sourceResponseId = Number(info.lastInsertRowid);

    for (const row of rows) {
      const parentId = insertRow(db, row.table, {
        ...row.values,
        source_response_id: sourceResponseId
      });
      rowsWritten++;
      for (const child of row.children ?? []) {
        for (const values of child.rows) {
          insertRow(db, child.table, {
            ...values,
            [child.parentColumn]: parentId,
            source_response_id: sourceResponseId
          });
          rowsWritten++;
        }
      }
    }
  });

  try {
    write();
  } catch (err) {
    // The rows were bad even though the parse succeeded — a constraint the
    // dictionary declares and the module violated. Record the index row alone so
    // the body stays reachable, then report.
    parseStatus = 'failed';
    parseError = err instanceof Error ? err.message : String(err);
    rowsWritten = 0;
    const info = db
      .prepare(
        `INSERT INTO meta_response (
           run_id, provider, endpoint, params_json, requested_at, responded_at, http_status,
           byte_length, archive_file, archive_offset, sha256, dedup_hash, encrypted,
           at_provider_cap, parse_status, parsed_row_count
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        args.runId, args.provider, args.endpoint, paramsJson, response.requestedAt,
        response.respondedAt, response.status, location.byteLength, location.archiveFile,
        location.archiveOffset, location.sha256, hash,
        args.slug.startsWith('account-') ? 1 : 0, args.atProviderCap ? 1 : 0, 'failed', 0
      );
    sourceResponseId = Number(info.lastInsertRowid);
  }

  return {
    sourceResponseId,
    parseStatus,
    rowsWritten,
    archiveFile: location.archiveFile,
    archiveOffset: location.archiveOffset,
    deduplicated: false,
    ...(parseError ? { parseError } : {})
  };
}
