import type { CollectorHost, ProviderName, ProviderResponse } from './host.js';
import { captureResponse } from './capture.js';
import { beginRun, finishRun } from './run.js';
import { runUniversePhase, type UniverseMember } from './phases/universe.js';

/**
 * `universe_seed` — 04 §7.1.
 *
 * Fetches the three lists, writes the initial `ref_universe_membership` and a
 * `raw_ticker_reference` row for every member. **Must run before the first daily
 * run**, and it is the first job to exercise the claim-and-execute path the Jobs
 * UI will use later (06 §9) — deliberately, so that path is proven by use rather
 * than by a temporary direct call that would then be deleted untested.
 */

/**
 * One of the lists that define the universe.
 *
 * **A source supplies its own response rather than naming a Polygon path**, and
 * that is a deliberate correction made 2026-09-07. The first version called
 * `host.polygonGet(endpoint, params)`, which quietly constrained the universe to
 * whatever a Polygon query could express — and Polygon has no index-membership
 * endpoint on this plan. What shipped was `market=stocks&type=CS`, i.e. *every*
 * US common stock, with `limit=1000` and no paging: **2,000 tickers in
 * alphabetical order, ending at DBND, with MSFT, NVDA, SPY and TSLA absent.**
 * The same capped-response trap already recorded for Finnhub, in a second place.
 *
 * The correct lists were never remote. The host application maintains them —
 * 503 S&P 500, 1,024 Russell 1000, 60 ETFs, **1,089 distinct**, exactly the
 * figure 04 §4.1 records — and "which endpoint answers for each list" was always
 * meant to be host-side configuration.
 *
 * **Provenance is unchanged.** The returned response is archived and digested
 * like any other (P2, AC-1): the archive records *what we were given*, and "the
 * host's constituent lists as of this date" is a legitimate answer to that. It
 * also keeps `core` ignorant of the other application's schema, which is the
 * whole point of the seam.
 */
export interface UniverseListSource {
  readonly listSource: UniverseMember['listSource'];
  /** Where the list came from, recorded on the archive row. */
  readonly endpoint: string;
  readonly params: Readonly<Record<string, string>>;
  /** Which provider the archive row is attributed to. */
  readonly provider: ProviderName;
  /**
   * Produces the list response.
   *
   * A remote source calls the host's transport; a local one serialises what the
   * host already holds. Either way the result goes through the same capture
   * contract, so a membership row always points at real archived bytes.
   */
  readonly fetch: () => Promise<ProviderResponse>;
  /** Parses the response body into ticker symbols. */
  readonly parse: (body: string) => readonly string[];
}

export interface UniverseSeedReport {
  readonly runId: number;
  readonly listsFetched: number;
  readonly listsFailed: readonly string[];
  readonly distinctTickers: number;
  readonly membershipsOpened: number;
  readonly membershipsClosed: number;
  readonly referenceFetched: number;
  readonly referenceFailed: number;
}

export async function runUniverseSeed(
  host: CollectorHost,
  args: {
    readonly tradingDate: string;
    readonly sources: readonly UniverseListSource[];
    readonly maxReferenceFetches?: number;
  }
): Promise<UniverseSeedReport> {
  const db = host.openGenerationDb();
  const run = beginRun(db, host, { kind: 'manual', tradingDate: args.tradingDate });

  try {
    const members: UniverseMember[] = [];
    const listsFailed: string[] = [];
    let listsFetched = 0;
    let membershipSourceResponseId = 0;

    for (const [i, source] of args.sources.entries()) {
      host.progress('universe:lists', i, args.sources.length, source.listSource);
      const response = await source.fetch();

      // The list responses go through the same contract as everything else, with
      // no ingestion module: their rows are written by the membership
      // reconciliation, which needs all three lists together. The archive row
      // still exists, so each membership row can point at a real response.
      const captured = captureResponse({
        host,
        db,
        runId: run.runId,
        asOfDate: args.tradingDate,
        provider: source.provider,
        endpoint: source.endpoint,
        slug: `universe-${source.listSource}`,
        params: source.params,
        response,
        captureRuleId: null
      });
      if (membershipSourceResponseId === 0) membershipSourceResponseId = captured.sourceResponseId;

      if (response.status !== null && response.status >= 200 && response.status < 300) {
        try {
          for (const ticker of source.parse(response.body)) {
            members.push({ ticker, listSource: source.listSource });
          }
          listsFetched++;
        } catch (err) {
          listsFailed.push(`${source.listSource}: ${(err as Error).message}`);
        }
      } else {
        listsFailed.push(`${source.listSource}: HTTP ${String(response.status)}`);
      }
    }

    // A seed that got none of its lists must not close the membership of a
    // universe it simply failed to read — reconciliation would see an empty
    // incoming set and drop every ticker. Refusing is the only safe answer.
    if (listsFetched === 0) {
      finishRun(db, host, run, 'failed');
      throw new Error(
        `universe_seed fetched none of its ${args.sources.length} lists ` +
          `(${listsFailed.join('; ')}). Refusing to reconcile membership against an empty set, ` +
          'which would close every existing member.'
      );
    }

    const phase = await runUniversePhase(host, db, run, {
      members,
      membershipSourceResponseId,
      changeReason: 'initial',
      ...(args.maxReferenceFetches !== undefined
        ? { maxReferenceFetches: args.maxReferenceFetches }
        : {})
    });

    finishRun(db, host, run, 'complete');

    return {
      runId: run.runId,
      listsFetched,
      listsFailed,
      distinctTickers: phase.distinctTickers,
      membershipsOpened: phase.membershipsOpened,
      membershipsClosed: phase.membershipsClosed,
      referenceFetched: phase.referenceFetched,
      referenceFailed: phase.referenceFailed
    };
  } catch (err) {
    const status = host.signal.aborted ? 'cancelled' : 'failed';
    finishRun(db, host, run, status);
    throw err;
  }
}
