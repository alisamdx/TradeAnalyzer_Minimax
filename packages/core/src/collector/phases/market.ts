import type { SqliteLike } from '../../db/sqlite-like.js';
import type { CollectorHost } from '../host.js';
import { throwIfCancelled } from '../host.js';
import { captureResponse } from '../capture.js';
import { captureRuleId, type RunHandle } from '../run.js';
import {
  makeBarIngest,
  ingestSnapshot,
  ingestSplits,
  ingestDividends
} from '../../ingest/market.js';

/**
 * Phases 2, 3 and 4 — daily bars, the end-of-day snapshot, corporate actions
 * (04 §2).
 *
 * Ordering matters and is not arbitrary: bars run before the subset rule because
 * that rule reads dollar volume, and the cheap phases run before the long chain
 * phase so a chain failure never costs them.
 */

export const BARS_RULE = { scope: 'universe_active', adjusted: true, depthDays: 1 } as const;
export const QUOTES_RULE = { scope: 'universe_active', source: 'polygon_full_snapshot' } as const;
export const ACTIONS_RULE = { sweepDays: 7 } as const;

export interface PhaseCounts {
  readonly expected: number;
  readonly stored: number;
  readonly failed: number;
}

function activeMembers(db: SqliteLike): readonly string[] {
  return (
    db
      .prepare('SELECT DISTINCT ticker FROM ref_universe_membership WHERE valid_to IS NULL ORDER BY ticker')
      .all() as { ticker: string }[]
  ).map((r) => r.ticker);
}

/**
 * Phase 2 — daily bars, one call per active member.
 *
 * Every bar is stored with `adjusted_as_of` set to today, because Polygon
 * returns a series adjusted *as of this fetch*. Storing that fact is what makes
 * a later split visible as a discontinuity rather than as a silent rescale: the
 * existing app fetched with `adjusted=true` and still accumulated 153
 * discontinuities across 126 tickers, because freshness of the tail never
 * implies consistency of the history.
 */
export async function runBarsPhase(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly depthDays?: number; readonly tickers?: readonly string[] } = {}
): Promise<PhaseCounts> {
  const ruleId = captureRuleId(db, host, 'bars', BARS_RULE, 'Daily OHLCV for every active universe member.');
  const tickers = opts.tickers ?? activeMembers(db);
  const depth = opts.depthDays ?? 5;

  const from = new Date(Date.parse(`${run.tradingDate}T00:00:00Z`) - depth * 86_400_000)
    .toISOString()
    .slice(0, 10);

  let stored = 0;
  let failed = 0;

  for (const [i, ticker] of tickers.entries()) {
    throwIfCancelled(host, 'phase-2-bars');
    host.progress('bars', i, tickers.length, ticker);

    const path = `/v2/aggs/ticker/${ticker}/range/1/day/${from}/${run.tradingDate}`;
    const response = await host.polygonGet(path, { adjusted: 'true', sort: 'asc', limit: '50000' });

    const result = captureResponse({
      host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'polygon',
      endpoint: path, slug: 'aggs-day', params: { ticker, from, to: run.tradingDate },
      response, captureRuleId: ruleId,
      ingest: makeBarIngest({
        ticker,
        fetchKind: 'daily',
        adjustedAsOf: run.tradingDate,
        // Anything dated today may still be settling — Polygon keeps adjusting
        // past 16:00 ET, which is why the run is scheduled at 17:05 rather than
        // 16:30.
        provisionalDate: run.tradingDate
      })
    });

    if (result.parseStatus === 'ok') stored += result.rowsWritten;
    else failed++;
  }

  return { expected: tickers.length, stored, failed };
}

/**
 * Phase 3 — the end-of-day snapshot. **One call for the whole universe**, which
 * is why it is the cross-source check on the bar close rather than a second
 * per-ticker sweep.
 */
export async function runQuotesPhase(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle
): Promise<PhaseCounts> {
  const ruleId = captureRuleId(db, host, 'quotes', QUOTES_RULE, 'One full-market snapshot per run.');
  const expected = activeMembers(db).length;

  host.progress('quotes', 0, 1, 'full-market snapshot');
  const path = '/v2/snapshot/locale/us/markets/stocks/tickers';
  const response = await host.polygonGet(path, {});

  const result = captureResponse({
    host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'polygon',
    endpoint: path, slug: 'snapshot-all', params: {}, response, captureRuleId: ruleId,
    ingest: ingestSnapshot
  });

  return {
    expected,
    stored: result.rowsWritten,
    failed: result.parseStatus === 'ok' ? 0 : 1
  };
}

/**
 * Phase 4 — corporate actions, swept by execution-date window.
 *
 * Swept rather than fetched per ticker: an action is rare, and 1,089 daily calls
 * to learn that almost nothing happened is the shape of waste the insider sweep
 * avoids the same way. A discontinuity that needs explaining triggers a targeted
 * per-ticker re-fetch through R6 instead.
 */
export async function runActionsPhase(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly windowDays?: number } = {}
): Promise<{ splits: PhaseCounts; dividends: PhaseCounts }> {
  const ruleId = captureRuleId(db, host, 'actions', ACTIONS_RULE, 'Split and dividend sweeps by execution-date window.');
  const window = opts.windowDays ?? 7;
  const from = new Date(Date.parse(`${run.tradingDate}T00:00:00Z`) - window * 86_400_000)
    .toISOString()
    .slice(0, 10);

  host.progress('actions', 0, 2, 'splits');
  const splitResponse = await host.polygonGet('/v3/reference/splits', {
    'execution_date.gte': from, 'execution_date.lte': run.tradingDate, limit: '1000'
  });
  const splits = captureResponse({
    host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'polygon',
    endpoint: '/v3/reference/splits', slug: 'reference-splits',
    params: { from, to: run.tradingDate }, response: splitResponse, captureRuleId: ruleId,
    ingest: ingestSplits
  });

  host.progress('actions', 1, 2, 'dividends');
  const divResponse = await host.polygonGet('/v3/reference/dividends', {
    'ex_dividend_date.gte': from, 'ex_dividend_date.lte': run.tradingDate, limit: '1000'
  });
  const dividends = captureResponse({
    host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'polygon',
    endpoint: '/v3/reference/dividends', slug: 'reference-dividends',
    params: { from, to: run.tradingDate }, response: divResponse, captureRuleId: ruleId,
    ingest: ingestDividends
  });

  return {
    splits: { expected: 0, stored: splits.rowsWritten, failed: splits.parseStatus === 'ok' ? 0 : 1 },
    dividends: { expected: 0, stored: dividends.rowsWritten, failed: dividends.parseStatus === 'ok' ? 0 : 1 }
  };
}
