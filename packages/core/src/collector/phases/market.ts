import type { SqliteLike } from '../../db/sqlite-like.js';
import type { CollectorHost } from '../host.js';
import { throwIfCancelled } from '../host.js';
import { captureResponse } from '../capture.js';
import { recipes } from '../../ingest/recipes.js';
import { captureRuleId, type RunHandle } from '../run.js';
import { sweepPolygonPages, POLYGON_LIST_PAGE_SIZE } from '../paged.js';
import { barSettled } from '../bar-settlement.js';
import { BACKFILL_RULE } from '../backfill.js';
export { barSettled, BAR_SETTLED_AT_ET } from '../bar-settlement.js';

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
  /** Bars phase only: members fetched five years back because they had no history (v1.1.351). */
  readonly backfilled?: number;
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

  // A member with no five-year history gets one now, in place of its tail call (v1.1.351). The
  // backfill job ran once, at the start of the generation, so a ticker that joins the universe later
  // never got history: VMRK (AVB + EQR, admitted by the 2026-10-12 seed) would have collected bars
  // from its first nightly run onward and nothing before. Still one call per ticker. Stored as
  // `fetch_kind = 'backfill'` under the backfill rule, exactly as the job would have stored it, so
  // QC-204/205/209/210 read it the same way and the next night sees history and asks for the tail.
  const historyFrom = fiveYearsBefore(run.tradingDate);
  const hasHistory = db.prepare(
    "SELECT 1 FROM raw_daily_bar WHERE ticker = ? AND fetch_kind = 'backfill' LIMIT 1"
  );
  let backfillRuleId: number | null = null;

  let stored = 0;
  let failed = 0;
  let backfilled = 0;

  for (const [i, ticker] of tickers.entries()) {
    throwIfCancelled(host, 'phase-2-bars');
    host.progress('bars', i, tickers.length, ticker);

    const needsHistory = hasHistory.get(ticker) === undefined;
    if (needsHistory && backfillRuleId === null) {
      backfillRuleId = captureRuleId(
        db, host, 'bars_backfill', BACKFILL_RULE,
        'One-time five-year bar history for every universe member, fetched in a single pass per ticker.'
      );
    }
    const start = needsHistory ? historyFrom : from;
    const path = `/v2/aggs/ticker/${ticker}/range/1/day/${start}/${run.tradingDate}`;
    const response = await host.polygonGet(path, { adjusted: 'true', sort: 'asc', limit: '50000' });

    const result = captureResponse({
      host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'polygon',
      endpoint: path, slug: needsHistory ? 'aggs-day-backfill' : 'aggs-day',
      params: { ticker, from: start, to: run.tradingDate },
      response, captureRuleId: needsHistory ? (backfillRuleId as number) : ruleId,
      recipe: recipes.bars({
        ticker,
        fetchKind: needsHistory ? 'backfill' : 'daily',
        adjustedAsOf: run.tradingDate,
        // Anything dated today may still be settling before 17:00 ET — Polygon keeps adjusting
        // past 16:00, which is why the run is scheduled at 17:05 rather than 16:30. Decided per
        // response from when it ARRIVED, and recorded in the recipe, so replay agrees.
        ...(barSettled(run.tradingDate, response.respondedAt) ? {} : { provisionalDate: run.tradingDate })
      })
    });

    if (result.parseStatus === 'ok') {
      stored += result.rowsWritten;
      if (needsHistory && result.rowsWritten > 0) backfilled++;
    } else {
      failed++;
    }
  }

  return { expected: tickers.length, stored, failed, backfilled };
}

function fiveYearsBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 5);
  return d.toISOString().slice(0, 10);
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
    recipe: recipes.snapshot()
  });

  return {
    expected,
    stored: result.rowsWritten,
    failed: result.parseStatus === 'ok' ? 0 : 1
  };
}

export const ETRADE_QUOTES_RULE = { scope: 'universe_active', source: 'etrade_quote', batchSize: 25 } as const;

/** E*Trade documents 25 symbols per quote call (50 only with `overrideSymbolCount`, deliberately not used). */
export const ETRADE_QUOTE_BATCH = 25;

export interface EtradeQuoteCounts extends PhaseCounts {
  readonly calls: number;
  /** Asked, answered 2xx, and absent from every response — a ticker E*Trade does not quote under that symbol. */
  readonly unanswered: readonly string[];
}

/**
 * Phase 3b — equity bid/ask from E*Trade, the only bid/ask this plan set has for
 * stocks (Polygon Starter sends no `lastQuote`), and what QC-303 reads.
 *
 * Batched 25 to a call — about 44 calls for the universe. **A batched path had
 * never been sent by either app before this phase** (the single-symbol shape was
 * read live 2026-10-14), so a batch that comes back non-2xx is retried one
 * symbol at a time: if the comma path is ever refused, the night still gets its
 * quotes and the per-symbol calls in the API log say why.
 */
export async function runEtradeQuotesPhase(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle
): Promise<EtradeQuoteCounts> {
  const ruleId = captureRuleId(db, host, 'quotes_etrade', ETRADE_QUOTES_RULE, 'Equity bid/ask from E*Trade, 25 symbols per call.');
  const tickers = activeMembers(db);
  const batches: string[][] = [];
  for (let i = 0; i < tickers.length; i += ETRADE_QUOTE_BATCH) batches.push(tickers.slice(i, i + ETRADE_QUOTE_BATCH));

  let stored = 0;
  let failed = 0;
  let calls = 0;

  const fetchOne = async (symbols: readonly string[]): Promise<boolean> => {
    const path = `/v1/market/quote/${symbols.join(',')}`;
    const response = await host.etradeGet(path, {});
    calls++;
    const ok = response.status !== null && response.status >= 200 && response.status < 300;
    const result = captureResponse({
      host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'etrade',
      endpoint: '/v1/market/quote/{symbols}', slug: 'quote-equity',
      params: { symbols: symbols.join(',') }, response, captureRuleId: ruleId,
      recipe: recipes.etradeQuotes({ symbols })
    });
    if (result.parseStatus === 'ok') stored += result.rowsWritten;
    else failed++;
    return ok;
  };

  for (const [i, batch] of batches.entries()) {
    throwIfCancelled(host, 'phase-3b-quotes-etrade');
    host.progress('quotes-etrade', i, batches.length, batch[0] ?? '');
    if (await fetchOne(batch)) continue;
    if (batch.length === 1) continue;
    for (const symbol of batch) {
      throwIfCancelled(host, 'phase-3b-quotes-etrade');
      await fetchOne([symbol]);
    }
  }

  const answered = new Set(
    (
      db
        .prepare('SELECT DISTINCT ticker FROM raw_etrade_quote WHERE run_id = ?')
        .all(run.runId) as { ticker: string }[]
    ).map((r) => r.ticker)
  );
  const unanswered = tickers.filter((t) => !answered.has(t));
  return { expected: tickers.length, stored, failed, calls, unanswered };
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

  // Both sweeps page. A seven-day window is nowhere near 1,000 rows today, which
  // is exactly why it would have gone unnoticed here — the backfill's five-year
  // window is what made the truncation visible, and this window only has to grow
  // (or a busy ex-dividend week only has to arrive) for the same silent loss to
  // land in the daily run. A cap that is harmless today is still a cap.
  host.progress('actions', 0, 2, 'splits');
  let splitRows = 0;
  let splitFailed = 0;
  await sweepPolygonPages(host, {
    path: '/v3/reference/splits',
    params: {
      'execution_date.gte': from,
      'execution_date.lte': run.tradingDate,
      limit: String(POLYGON_LIST_PAGE_SIZE)
    },
    onPage: (page) => {
      const captured = captureResponse({
        host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'polygon',
        endpoint: '/v3/reference/splits', slug: 'reference-splits',
        params: { from, to: run.tradingDate, page: String(page.index + 1) },
        response: page.response, captureRuleId: ruleId,
        atProviderCap: page.atProviderCap,
        recipe: recipes.splits()
      });
      splitRows += captured.rowsWritten;
      if (captured.parseStatus !== 'ok') splitFailed++;
    }
  });

  host.progress('actions', 1, 2, 'dividends');
  let divRows = 0;
  let divFailed = 0;
  await sweepPolygonPages(host, {
    path: '/v3/reference/dividends',
    params: {
      'ex_dividend_date.gte': from,
      'ex_dividend_date.lte': run.tradingDate,
      limit: String(POLYGON_LIST_PAGE_SIZE)
    },
    onPage: (page) => {
      const captured = captureResponse({
        host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'polygon',
        endpoint: '/v3/reference/dividends', slug: 'reference-dividends',
        params: { from, to: run.tradingDate, page: String(page.index + 1) },
        response: page.response, captureRuleId: ruleId,
        atProviderCap: page.atProviderCap,
        recipe: recipes.dividends()
      });
      divRows += captured.rowsWritten;
      if (captured.parseStatus !== 'ok') divFailed++;
    }
  });

  return {
    splits: { expected: 0, stored: splitRows, failed: splitFailed },
    dividends: { expected: 0, stored: divRows, failed: divFailed }
  };
}
