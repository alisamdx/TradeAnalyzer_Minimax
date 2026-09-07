import type { SqliteLike } from '../db/sqlite-like.js';

/**
 * `CollectorHost` — 04 §1.
 *
 * The collector is a library with **no Electron, no scheduler and no network
 * client of its own**. Everything environment-specific arrives through this one
 * interface, so the same code runs inside the existing app today (Q4), inside
 * the new exe later, and under Vitest with fakes.
 *
 * The seam is not decoration. The existing app's provider transports carry years
 * of accumulated hardening — rate limiting, renew-and-retry on *any* E*Trade
 * failure, masked-key API logging — and reimplementing any of it here would
 * mean maintaining two versions of lessons that were expensive to learn once.
 */

/**
 * One provider call's outcome, before anything has been parsed.
 *
 * `body` is the response **as received**: the archive stores these bytes and
 * `sha256` is taken over them, so provenance means the text the parser actually
 * saw rather than a re-serialisation of what it produced (P2, AC-1).
 *
 * A network fault is `status: null` with `error` set, and is archived like any
 * other response — a call that never answered is evidence too, and the existing
 * app spent 23 versions unable to see exactly this because its OAuth calls sat
 * outside the instrumented transport.
 */
export interface ProviderResponse {
  readonly status: number | null;
  readonly body: string;
  readonly requestedAt: string;
  readonly respondedAt: string | null;
  readonly error?: string;
}

export type ProviderName =
  | 'polygon'
  | 'etrade'
  | 'edgar'
  | 'finnhub'
  | 'treasury'
  | 'fred'
  | 'ivolatility'
  | 'marketdata'
  | 'finra'
  /** The host application itself, for lists it already holds (04 §4.1). */
  | 'host_app';

export interface CollectorHost {
  // ── storage ──────────────────────────────────────────────────────────────
  /** The CURRENT generation's database, open and write-capable. */
  openGenerationDb(): SqliteLike;
  /** Absolute path to `gen-NNN/archive`. */
  archiveRoot(): string;
  /**
   * Encrypts an account-domain archive line (P15, Q20). The host chooses the
   * mechanism — safeStorage/DPAPI in Electron — because a key that `core` could
   * reach is a key that a test fixture could leak.
   */
  encryptForArchive(buf: Buffer): Buffer;
  decryptFromArchive(buf: Buffer): Buffer;

  // ── providers ────────────────────────────────────────────────────────────
  // The host's instrumented, rate-limited transports. Never a raw fetch: the
  // rate limiter, the renew-and-retry and the API log all live behind these.
  polygonGet(path: string, params: Record<string, string>): Promise<ProviderResponse>;
  /** Renew-and-retry on ANY failure happens inside this, not here. */
  etradeGet(path: string, params: Record<string, string>): Promise<ProviderResponse>;
  /** EDGAR, Treasury, Finnhub, FOMC/BLS. */
  httpGet(url: string, headers?: Record<string, string>): Promise<ProviderResponse>;

  // ── environment ──────────────────────────────────────────────────────────
  /** ISO-8601 with offset, America/New_York. */
  nowET(): string;
  sendEmail(msg: { subject: string; text: string; html: string }): Promise<void>;
  progress(phase: string, done: number, total: number, note?: string): void;
  readonly signal: AbortSignal;
  readonly hostApp: { readonly name: string; readonly version: string };
}

/** Thrown when the host's abort signal fires. Distinguished so a cancelled run is recorded as `cancelled`, not `failed`. */
export class CollectorCancelled extends Error {
  constructor(phase: string) {
    super(`Collector cancelled during ${phase}`);
    this.name = 'CollectorCancelled';
  }
}

export function throwIfCancelled(host: CollectorHost, phase: string): void {
  if (host.signal.aborted) throw new CollectorCancelled(phase);
}
