import type { CollectorHost, ProviderResponse } from './host.js';

/**
 * Following Polygon's `next_url`, because a `limit` is a PAGE SIZE and not a total.
 *
 * The three sweeps that fetch a *list* — the backfill's five-year splits, and the
 * daily run's splits and dividends — each asked for `limit: '1000'`, read only the
 * first page, and discarded the cursor. Measured 2026-09-11 on the first real
 * backfill: **exactly 1,000 splits**, which is the parameter, not a count of
 * corporate actions. The number a truncated list returns is the number you asked
 * for, and that is the whole tell.
 *
 * What made it worse than a merely short list: QC-204 marks a price discontinuity
 * `explained` only when a matching `raw_split`/`raw_dividend` row sits inside the
 * gap, so every split past the cap turns a real corporate action into an
 * unexplained step for the operator to rule on. That backfill opened **512
 * findings** against a split list missing an unknown number of rows.
 *
 * Nothing flagged it either: `captureResponse` was passed no `atProviderCap`, so
 * QC-008 — the blocking check written for exactly this shape, after Finnhub's
 * 1,500-row calendar put an earnings date a quarter late — could not fire. **A cap
 * detector only ever works on the call sites that tell it a cap was hit**, so the
 * detector and the paging have to ship together.
 *
 * Same family as that Finnhub calendar and as the universe seed that captured
 * 2,000 alphabetical tickers with MSFT absent. Every one of them was HTTP 200.
 */

/**
 * One page, 1,000 rows. Polygon documents a 5,000 maximum on splits, but not every
 * list endpoint shares it, and a page size that is wrong for one of them fails the
 * same silent way this module exists to fix. Paging correctly turns the page size
 * into a cost question rather than a correctness one, so it stays at the
 * conservative value all three call sites already used.
 */
export const POLYGON_LIST_PAGE_SIZE = 1000;

/**
 * A ceiling on pages, so a provider that keeps handing back a cursor cannot make a
 * sweep unbounded. 50 pages is 50,000 rows — far beyond any real five-year split
 * list — and reaching it is *reported* (`atProviderCap`) rather than passed over,
 * which is the difference between this cap and the one it replaces.
 */
export const POLYGON_MAX_PAGES = 50;

export type NextPage =
  | { readonly kind: 'none' }
  | { readonly kind: 'refused'; readonly reason: string }
  | {
      readonly kind: 'follow';
      readonly path: string;
      readonly params: Record<string, string>;
      readonly key: string;
    };

/**
 * Decomposes a `next_url` into the `(path, params)` pair the host transport takes.
 *
 * **Only the path and query survive; the origin is discarded.** `polygonGet` builds
 * `https://api.polygon.io${path}` itself, so a `next_url` cannot redirect a request
 * off Polygon however the body is written — a response body is data, never a
 * destination. The host is nonetheless checked and a foreign one refused, because a
 * `next_url` pointing elsewhere means its *path* was meant for a different service,
 * and issuing that path against Polygon is a request nobody intended.
 *
 * An `apiKey` echoed back inside the cursor URL is dropped: the host attaches the
 * real one, and carrying a credential through here would put it in `params_json`,
 * which is stored in `meta_response` and printed by the Runs view.
 */
export function nextPolygonPage(response: ProviderResponse): NextPage {
  let parsed: { next_url?: unknown };
  try {
    parsed = JSON.parse(response.body) as { next_url?: unknown };
  } catch {
    // A body that will not parse has no next page to offer, and the capture that
    // follows records the parse failure with far better detail than this could.
    return { kind: 'none' };
  }

  const raw = parsed.next_url;
  if (typeof raw !== 'string' || raw.length === 0) return { kind: 'none' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'refused', reason: 'next_url is not a URL' };
  }
  if (url.hostname !== 'api.polygon.io') {
    return { kind: 'refused', reason: `next_url points at ${url.hostname}` };
  }

  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    if (k.toLowerCase() === 'apikey') continue;
    params[k] = v;
  }
  return {
    kind: 'follow',
    path: url.pathname,
    params,
    key: `${url.pathname}?${new URLSearchParams(params).toString()}`
  };
}

export interface PolygonPage {
  readonly response: ProviderResponse;
  /** 0-based. */
  readonly index: number;
  /** The params this page was actually requested with. */
  readonly params: Readonly<Record<string, string>>;
  /**
   * True only on the final page fetched, and only when more pages existed that
   * this sweep did not take — the page budget was spent, the cursor stopped
   * advancing, or the cursor pointed off Polygon. It is false on every page of a
   * sweep that ran to the end of the list, which is what keeps QC-008 (blocking)
   * quiet on the normal case.
   */
  readonly atProviderCap: boolean;
  /** Set when `atProviderCap` is true, for the capture's own record. */
  readonly capReason?: string;
}

export interface PagedSweep {
  readonly pages: number;
  /** Whether the list was left incomplete. Mirrors the last page's `atProviderCap`. */
  readonly truncated: boolean;
  readonly capReason?: string;
}

/**
 * Walks a Polygon list endpoint to the end, handing each page to `onPage`.
 *
 * Each page is captured **separately and in full**, rather than being stitched into
 * one synthetic body: `meta_response` then holds exactly what Polygon sent, the
 * archive stays byte-faithful, and a replay re-ingests each page through the same
 * recipe. `ingestSplits`/`ingestDividends` read only `results`, so they need no
 * knowledge of paging at all.
 */
export async function sweepPolygonPages(
  host: CollectorHost,
  args: {
    readonly path: string;
    readonly params: Readonly<Record<string, string>>;
    readonly maxPages?: number;
    readonly onPage: (page: PolygonPage) => void;
  }
): Promise<PagedSweep> {
  const maxPages = args.maxPages ?? POLYGON_MAX_PAGES;
  const seen = new Set<string>();

  let path = args.path;
  let params: Record<string, string> = { ...args.params };
  let index = 0;

  for (;;) {
    const response = await host.polygonGet(path, params);
    const next = nextPolygonPage(response);

    // Resolved BEFORE the page is handed over, because whether this page is the
    // truncation point is part of what the capture has to record about it.
    let capReason: string | undefined;
    if (next.kind === 'refused') capReason = next.reason;
    else if (next.kind === 'follow') {
      if (seen.has(next.key)) capReason = 'next_url repeated — the cursor stopped advancing';
      else if (index + 1 >= maxPages) capReason = `page budget of ${maxPages} spent with more pages available`;
    }

    const atProviderCap = capReason !== undefined;
    args.onPage({
      response,
      index,
      params,
      atProviderCap,
      ...(capReason !== undefined ? { capReason } : {})
    });

    if (next.kind !== 'follow' || atProviderCap) {
      return {
        pages: index + 1,
        truncated: atProviderCap,
        ...(capReason !== undefined ? { capReason } : {})
      };
    }

    seen.add(next.key);
    path = next.path;
    params = next.params;
    index++;
  }
}
