import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import type { CollectorHost, ProviderName, ProviderResponse } from './host.js';

/**
 * The response archive — 04 §2.2, §6, and the whole of P2.
 *
 * Every provider response is written here **before** anything is parsed from it.
 * That ordering is the point: a parse that fails still leaves the bytes on disk,
 * so the fix is a replay rather than a refetch, and a value in a raw table can
 * always be traced back to the text it came from (AC-1).
 *
 * One gzipped JSON line per response, appended. Append-only files are safe to
 * copy while a run is in flight, which is what makes "back up a generation" mean
 * "copy a folder".
 */

/** The 16-byte header on an encrypted archive line, so a decrypt failure is diagnosable (Q20). */
export const ENC_HEADER = Buffer.from('TADATA-ENC-v1\0\0\0', 'utf8');

if (ENC_HEADER.length !== 16) {
  throw new Error(`ENC_HEADER must be exactly 16 bytes, got ${ENC_HEADER.length}`);
}

/** Domains whose archive files are encrypted at rest (P15, Q20). */
const ENCRYPTED_PROVIDERS_BY_SLUG = new Set([
  'account-portfolio',
  'account-balance',
  'account-orders',
  'account-transactions'
]);

export function isEncryptedSlug(slug: string): boolean {
  return ENCRYPTED_PROVIDERS_BY_SLUG.has(slug);
}

export interface ArchiveLocation {
  /** Relative to the generation directory, e.g. `archive/etrade/2026-09-05/optionchains.jsonl.gz`. */
  readonly archiveFile: string;
  /** Line number within that file, zero-based. */
  readonly archiveOffset: number;
  /** sha256 of the uncompressed body as received. */
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ArchiveLine {
  readonly id: string;
  readonly requestedAt: string;
  readonly respondedAt: string | null;
  readonly status: number | null;
  readonly params: Readonly<Record<string, string>>;
  readonly body: string;
  readonly error?: string;
}

function fileFor(provider: ProviderName, asOfDate: string, slug: string): string {
  const ext = isEncryptedSlug(slug) ? 'jsonl.enc' : 'jsonl.gz';
  return join('archive', provider, asOfDate, `${slug}.${ext}`);
}

/** Counts lines already in a file, so `archive_offset` survives a restart. */
const offsets = new Map<string, number>();

export function resetOffsetCache(): void {
  offsets.clear();
}

function nextOffset(absolutePath: string, encrypted: boolean): number {
  const cached = offsets.get(absolutePath);
  if (cached !== undefined) {
    offsets.set(absolutePath, cached + 1);
    return cached;
  }
  let count = 0;
  if (existsSync(absolutePath)) {
    const raw = readFileSync(absolutePath);
    count = countRecords(raw, encrypted);
  }
  offsets.set(absolutePath, count + 1);
  return count;
}

/**
 * Each record is length-prefixed rather than newline-delimited.
 *
 * Compressed and encrypted bytes contain 0x0A freely, so splitting on newlines
 * would corrupt records at random — a bug that only shows up on the responses
 * unlucky enough to compress to bytes containing a newline, which is most of
 * them and never reproducibly the same ones.
 */
function frame(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function countRecords(raw: Buffer, _encrypted: boolean): number {
  let n = 0;
  let at = 0;
  while (at + 4 <= raw.length) {
    const len = raw.readUInt32BE(at);
    at += 4 + len;
    if (at > raw.length) break; // truncated tail from a crash mid-write
    n++;
  }
  return n;
}

/**
 * Appends one response and returns where it landed.
 *
 * A crash between this and the database transaction leaves an orphan line, which
 * is tolerated by design and reconciled by QC-953 — the alternative, writing the
 * index first, would leave a row pointing at bytes that do not exist, and a
 * dangling pointer is worse than an unreferenced fact.
 */
export function archiveResponse(
  // Only what it uses, so an operator write in the new exe can archive its own
  // request without faking a collector host (B9c study pins).
  host: Pick<CollectorHost, 'archiveRoot' | 'encryptForArchive'>,
  args: {
    readonly provider: ProviderName;
    readonly asOfDate: string;
    readonly slug: string;
    readonly id: string;
    readonly params: Readonly<Record<string, string>>;
    readonly response: ProviderResponse;
  }
): ArchiveLocation {
  const relative = fileFor(args.provider, args.asOfDate, args.slug);
  const absolute = join(host.archiveRoot(), '..', relative);
  mkdirSync(dirname(absolute), { recursive: true });

  const line: ArchiveLine = {
    id: args.id,
    requestedAt: args.response.requestedAt,
    respondedAt: args.response.respondedAt,
    status: args.response.status,
    params: args.params,
    body: args.response.body,
    ...(args.response.error ? { error: args.response.error } : {})
  };

  const encrypted = isEncryptedSlug(args.slug);
  const json = Buffer.from(JSON.stringify(line), 'utf8');
  const compressed = gzipSync(json);
  const payload = encrypted
    ? Buffer.concat([ENC_HEADER, host.encryptForArchive(compressed)])
    : compressed;

  const offset = nextOffset(absolute, encrypted);
  appendFileSync(absolute, frame(payload));

  const bodyBytes = Buffer.from(args.response.body, 'utf8');
  return {
    archiveFile: relative.split('\\').join('/'),
    archiveOffset: offset,
    sha256: createHash('sha256').update(bodyBytes).digest('hex'),
    byteLength: bodyBytes.length
  };
}

/**
 * Reads one archived response back. This is what AC-1 resolves to: given a raw
 * row's `source_response_id`, the inspector reads its `meta_response` row and
 * calls this.
 */
export function readArchivedResponse(
  host: CollectorHost,
  archiveFile: string,
  archiveOffset: number
): ArchiveLine {
  const absolute = join(host.archiveRoot(), '..', archiveFile);
  if (!existsSync(absolute)) {
    throw new Error(`Archive file missing: ${archiveFile}`);
  }
  const raw = readFileSync(absolute);
  const encrypted = archiveFile.endsWith('.enc');

  let at = 0;
  for (let i = 0; at + 4 <= raw.length; i++) {
    const len = raw.readUInt32BE(at);
    const start = at + 4;
    const end = start + len;
    if (end > raw.length) break;
    if (i === archiveOffset) {
      let payload: Buffer = Buffer.from(raw.subarray(start, end));
      if (encrypted) {
        const header = payload.subarray(0, ENC_HEADER.length);
        if (!header.equals(ENC_HEADER)) {
          throw new Error(
            `Archive line ${archiveFile}:${archiveOffset} does not carry the expected ` +
              `encryption header — it was written by a different mechanism, or it is corrupt.`
          );
        }
        payload = Buffer.from(host.decryptFromArchive(Buffer.from(payload.subarray(ENC_HEADER.length))));
      }
      return JSON.parse(gunzipSync(payload).toString('utf8')) as ArchiveLine;
    }
    at = end;
  }
  throw new Error(`Archive line ${archiveOffset} not found in ${archiveFile}`);
}

/** Verifies a stored response still hashes to what `meta_response.sha256` recorded. */
export function verifyArchivedResponse(
  host: CollectorHost,
  archiveFile: string,
  archiveOffset: number,
  expectedSha256: string
): boolean {
  const line = readArchivedResponse(host, archiveFile, archiveOffset);
  return createHash('sha256').update(Buffer.from(line.body, 'utf8')).digest('hex') === expectedSha256;
}
