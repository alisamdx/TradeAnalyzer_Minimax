import type { SqliteLike } from '../db/sqlite-like.js';
import type { CollectorHost } from './host.js';
import { captureResponse } from './capture.js';
import { recipes } from '../ingest/recipes.js';
import { captureRuleId } from './run.js';
import { sweepPolygonPages, POLYGON_LIST_PAGE_SIZE } from './paged.js';

/**
 * Automatic remediations — 03 §6.
 *
 * **R6 is the first one that has ever run.** The spec has listed seven since B5
 * and described them as current behaviour: *"Every attempt is appended to
 * `remediations_json` with its outcome."* Measured 2026-09-17 on gen-002: all
 * **12,970** exceptions carried `remediations_json = '[]'`, and nothing in the
 * repo wrote one. Every check's `remediation:` field was a declaration of
 * intent.
 *
 * That left a dead branch one level up, which is the reason this matters more
 * than the re-fetch itself: `reconcileStoppedFiring` may auto-resolve a finding
 * only when *"a remediation in `remediations_json` succeeded and the fingerprint
 * now evaluates clean"*. It reads a field nothing writes, so it could never
 * fire — the same shape as a threshold whose tested quantity can never reach it.
 *
 * ## Why targeted rather than a bulk sweep
 *
 * QC-204 explains a discontinuity with a split or a **special** dividend on the
 * boundary. `raw_split` covers five years; `raw_dividend` covered **ten days**,
 * because only the daily seven-day sweep fetched dividends and the backfill
 * never did — so for 138 of the 151 findings open on 2026-09-17 the dividend
 * branch could not match at all.
 *
 * The obvious fix, a five-year market-wide dividend sweep in the backfill, costs
 * about **845 pages and 845,000 rows**: of 4,696 dividends in the last eight
 * trading days, **130** were for universe members. R6 fetches the same evidence
 * for the tickers that actually have an unexplained step — roughly 63 tickers,
 * two calls each — which is what §6 specified in the first place.
 *
 * ## What "success" means here
 *
 * That the re-fetch completed, **not** that the step is now explained. Whether
 * it is explained is the gate's question, asked on the next run when QC-204
 * re-evaluates; a step that is still unexplained keeps firing and stays open,
 * and one that is now explained stops firing and the gate resolves it against
 * this recorded attempt. Deciding "explained" here would put the verdict in the
 * remediation, which is precisely the separation §6 draws.
 */

/** One R6 attempt as it is stored on the exception. */
export interface RemediationAttempt {
  readonly code: 'R6';
  readonly at: string;
  readonly outcome: 'success' | 'failed';
  readonly detail: string;
}

export interface R6Report {
  readonly tickersAttempted: number;
  readonly tickersSucceeded: number;
  readonly tickersFailed: number;
  readonly exceptionsMarked: number;
  readonly splitRowsStored: number;
  readonly dividendRowsStored: number;
  /** Tickers left for a later run because the per-run cap was reached. */
  readonly deferred: number;
}

/**
 * At most this many tickers per run. A bounded amount of work per run is the
 * half the collector's removed claim loop never had: that one re-ran the same
 * failing job 70 times in a night because nothing capped the attempts.
 */
export const R6_MAX_TICKERS_PER_RUN = 60;

/** A window either side of the step, so a boundary action is inside the range asked for. */
const R6_WINDOW_DAYS = 7;

function shiftDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

interface Candidate {
  readonly ticker: string;
  readonly from: string;
  readonly to: string;
  readonly exceptionIds: readonly number[];
}

/**
 * Tickers with an unexplained discontinuity that has not been remediated yet, oldest finding first.
 *
 * One entry per TICKER, not per finding: SOLS carried 21 QC-204 findings and a
 * ticker's splits and dividends are one fetch whatever the number of steps. The
 * already-attempted filter is the attempt cap — an exception is remediated once,
 * and a step that is still unexplained afterwards is an operator's question, not
 * something to re-fetch nightly for ever.
 */
export function r6Candidates(db: SqliteLike, runId: number): readonly Candidate[] {
  const rows = db
    .prepare(
      `SELECT exception_id, key, remediations_json, first_seen_run_id FROM qa_exception
        WHERE check_id = 'QC-204'
          AND state IN ('open', 'acknowledged')
          AND still_firing = 1
          AND last_seen_run_id = ?`
    )
    .all(runId) as { exception_id: number; key: string; remediations_json: string; first_seen_run_id: number }[];

  const byTicker = new Map<string, { ids: number[]; dates: string[]; oldestRun: number; oldestId: number }>();
  for (const r of rows) {
    let attempts: { code?: string }[] = [];
    try {
      attempts = JSON.parse(r.remediations_json) as { code?: string }[];
    } catch {
      attempts = [];
    }
    if (attempts.some((a) => a.code === 'R6')) continue;

    const [ticker, date] = r.key.split(' ');
    if (!ticker || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const entry = byTicker.get(ticker) ?? { ids: [], dates: [], oldestRun: r.first_seen_run_id, oldestId: r.exception_id };
    entry.ids.push(r.exception_id);
    entry.dates.push(date);
    entry.oldestRun = Math.min(entry.oldestRun, r.first_seen_run_id);
    entry.oldestId = Math.min(entry.oldestId, r.exception_id);
    byTicker.set(ticker, entry);
  }

  // Oldest finding first, so the per-run cap drains the queue in the order the findings arrived
  // (v1.1.286). It was alphabetical: on R6's first run (2026-09-18) the 60-ticker cap stopped at
  // the letters before W, and WULF — whose findings dated from run 5, among the oldest open —
  // waited another run. The ticker is only the tie-break, so the order is still deterministic.
  const ordered = [...byTicker.entries()].sort(([ta, a], [tb, b]) =>
    a.oldestRun - b.oldestRun || a.oldestId - b.oldestId || (ta < tb ? -1 : ta > tb ? 1 : 0)
  );
  return ordered.map(([ticker, e]) => {
    const sorted = [...e.dates].sort();
    return {
      ticker,
      from: shiftDays(sorted[0]!, -R6_WINDOW_DAYS),
      to: shiftDays(sorted[sorted.length - 1]!, R6_WINDOW_DAYS),
      exceptionIds: e.ids
    };
  });
}

function appendAttempt(db: SqliteLike, exceptionId: number, attempt: RemediationAttempt): void {
  const row = db
    .prepare('SELECT remediations_json FROM qa_exception WHERE exception_id = ?')
    .get(exceptionId) as { remediations_json: string } | undefined;
  if (!row) return;
  let attempts: unknown[] = [];
  try {
    const parsed = JSON.parse(row.remediations_json) as unknown;
    attempts = Array.isArray(parsed) ? parsed : [];
  } catch {
    attempts = [];
  }
  attempts.push(attempt);
  db.prepare('UPDATE qa_exception SET remediations_json = ? WHERE exception_id = ?')
    .run(JSON.stringify(attempts), exceptionId);
}

/**
 * Re-fetches splits and dividends for every ticker with an unexplained
 * discontinuity raised by this run, and records the attempt on each finding.
 *
 * Additive and idempotent, as §6 requires: the raw tables are append-only and a
 * re-fetch writes a new observation rather than editing one, so running this
 * twice costs two calls and changes no interpretation.
 */
export async function runR6ActionRefetch(
  host: CollectorHost,
  db: SqliteLike,
  args: { readonly runId: number; readonly tradingDate: string; readonly maxTickers?: number }
): Promise<R6Report> {
  const all = r6Candidates(db, args.runId);
  const cap = args.maxTickers ?? R6_MAX_TICKERS_PER_RUN;
  const candidates = all.slice(0, cap);

  if (candidates.length === 0) {
    return {
      tickersAttempted: 0, tickersSucceeded: 0, tickersFailed: 0, exceptionsMarked: 0,
      splitRowsStored: 0, dividendRowsStored: 0, deferred: all.length
    };
  }

  const ruleId = captureRuleId(
    db, host, 'actions_r6', { scope: 'per_ticker', windowDays: R6_WINDOW_DAYS },
    'R6: a ticker\'s splits and dividends re-fetched around an unexplained discontinuity (03 §6).'
  );

  let succeeded = 0;
  let failed = 0;
  let marked = 0;
  let splitRows = 0;
  let dividendRows = 0;

  for (const c of candidates) {
    host.progress('remediation:R6', candidates.indexOf(c), candidates.length, c.ticker);
    let detail: string;
    let outcome: RemediationAttempt['outcome'];
    try {
      const splits = await sweepPolygonPages(host, {
        path: '/v3/reference/splits',
        params: {
          ticker: c.ticker,
          'execution_date.gte': c.from,
          'execution_date.lte': c.to,
          limit: String(POLYGON_LIST_PAGE_SIZE)
        },
        onPage: (page) => {
          splitRows += captureResponse({
            host, db, runId: args.runId, asOfDate: args.tradingDate, provider: 'polygon',
            endpoint: '/v3/reference/splits', slug: 'reference-splits-r6',
            params: { ticker: c.ticker, from: c.from, to: c.to, page: String(page.index + 1) },
            response: page.response, captureRuleId: ruleId, atProviderCap: page.atProviderCap,
            recipe: recipes.splits()
          }).rowsWritten;
        }
      });

      const dividends = await sweepPolygonPages(host, {
        path: '/v3/reference/dividends',
        params: {
          ticker: c.ticker,
          'ex_dividend_date.gte': c.from,
          'ex_dividend_date.lte': c.to,
          limit: String(POLYGON_LIST_PAGE_SIZE)
        },
        onPage: (page) => {
          dividendRows += captureResponse({
            host, db, runId: args.runId, asOfDate: args.tradingDate, provider: 'polygon',
            endpoint: '/v3/reference/dividends', slug: 'reference-dividends-r6',
            params: { ticker: c.ticker, from: c.from, to: c.to, page: String(page.index + 1) },
            response: page.response, captureRuleId: ruleId, atProviderCap: page.atProviderCap,
            recipe: recipes.dividends()
          }).rowsWritten;
        }
      });

      outcome = 'success';
      detail =
        `re-fetched ${c.ticker} splits and dividends ${c.from}..${c.to} ` +
        `(${splits.pages} + ${dividends.pages} page(s))` +
        // A truncated re-fetch is not a clean one: the action that would explain
        // the step may be in the part that was never returned.
        (splits.truncated || dividends.truncated ? ' — TRUNCATED, the window was not fully covered' : '');
      if (splits.truncated || dividends.truncated) outcome = 'failed';
      if (outcome === 'success') succeeded++;
      else failed++;
    } catch (err) {
      outcome = 'failed';
      detail = `re-fetch of ${c.ticker} failed: ${err instanceof Error ? err.message : String(err)}`;
      failed++;
    }

    const at = host.nowET();
    for (const id of c.exceptionIds) {
      appendAttempt(db, id, { code: 'R6', at, outcome, detail });
      marked++;
    }
  }

  return {
    tickersAttempted: candidates.length,
    tickersSucceeded: succeeded,
    tickersFailed: failed,
    exceptionsMarked: marked,
    splitRowsStored: splitRows,
    dividendRowsStored: dividendRows,
    deferred: all.length - candidates.length
  };
}
