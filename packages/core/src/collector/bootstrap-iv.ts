import type { SqliteLike } from '../db/sqlite-like.js';
import type { CollectorHost } from './host.js';
import { throwIfCancelled } from './host.js';
import { captureResponse } from './capture.js';
import { recipes } from '../ingest/recipes.js';
import { beginRun, finishRun, captureRuleId, type RunHandle } from './run.js';
import { outOfBandCount, IVX_METHOD_NOTE } from '../ingest/iv-bootstrap.js';

/**
 * `bootstrap_iv` — the one-time external IV history load (04 §7.3, Q17).
 *
 * One call per **chain-subset** ticker, not per universe member: IV rank is
 * computed for the subset, and buying a year of history for names we will never
 * price is spending on data nothing reads. Each call returns a whole date range
 * for one symbol, so ~500 calls cover the year.
 *
 * **Loading is not accepting.** Every row lands with `accepted = 0` and nothing
 * reads it: rank and percentile compute from `derived_iv30_daily` alone and
 * report their declared gap, exactly as they would if no bootstrap had been
 * bought. Acceptance is a separate operator act, gated on QC-907 having enough
 * paired days to mean anything.
 *
 * **The pull must reach past the day our own computation begins.** The
 * subscription has to cover `stitch_date + MIN_OVERLAP_DAYS`, and that is a
 * constraint on what is *bought*, not only on what is checked — it is the one
 * requirement in this step that cannot be added retroactively.
 */

export const BOOTSTRAP_IV_RULE = {
  scope: 'chain_subset_active',
  tenor: 'iv30',
  depthDays: 365,
  source: 'ivolatility'
} as const;

export const IVOLATILITY_BASE = 'https://restapi.ivolatility.com';
export const IVX_ENDPOINT = '/equities/eod/ivx';

export interface BootstrapIvReport {
  readonly runId: number;
  readonly tickersAttempted: number;
  readonly tickersStored: number;
  readonly tickersFailed: number;
  readonly rowsStored: number;
  /**
   * Values outside the fraction band `(0, 5)`, counted across every response.
   *
   * Reported **beside** `rowsStored` rather than folded into a failure count,
   * because the two numbers being equal means something specific and different:
   * not sparse data, but the wrong unit. The existing app's parser guesses the
   * unit from the magnitude and would have hidden exactly that.
   */
  readonly outOfBand: number;
  readonly from: string;
  readonly to: string;
}

function oneYearBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The subset as it stands now — the tickers IV rank will actually be computed
 * for (04 §7.3: "the chain subset at bootstrap time").
 */
export function bootstrapTickers(db: SqliteLike): readonly string[] {
  return (
    db
      .prepare(
        'SELECT DISTINCT ticker FROM ref_chain_subset_membership WHERE valid_to IS NULL ORDER BY ticker'
      )
      .all() as { ticker: string }[]
  ).map((r) => r.ticker);
}

export async function runBootstrapIv(
  host: CollectorHost,
  args: {
    readonly tradingDate: string;
    readonly tickers?: readonly string[];
    readonly from?: string;
    readonly source?: string;
  }
): Promise<BootstrapIvReport> {
  const db: SqliteLike = host.openGenerationDb();
  const run: RunHandle = beginRun(db, host, { kind: 'bootstrap_iv', tradingDate: args.tradingDate });

  try {
    const ruleId = captureRuleId(
      db,
      host,
      'iv_bootstrap',
      BOOTSTRAP_IV_RULE,
      'One-time external 30-day constant-maturity ATM IV history for the chain subset.'
    );

    const tickers = args.tickers ?? bootstrapTickers(db);
    const from = args.from ?? oneYearBefore(args.tradingDate);
    const to = args.tradingDate;
    const source = args.source ?? 'ivolatility';

    let stored = 0;
    let failed = 0;
    let rows = 0;
    let outOfBand = 0;

    for (const [i, ticker] of tickers.entries()) {
      throwIfCancelled(host, 'bootstrap_iv');
      host.progress('bootstrap_iv', i, tickers.length, ticker);

      // The API key and the pacing are both the host's business, not `core`'s —
      // the same division as every other transport here. `httpGet` appends the
      // key (IVolatility rejects a Bearer header, so it must be a query
      // parameter), strips it from the log line, and holds each call behind the
      // IVolatility limiter. This module never sees the key and so can never
      // log it.
      //
      // Until v1.1.231 that was only half true: the host had no IVolatility
      // branch at all, so this comment described an intention rather than the
      // code, and the first real run would have sent ~500 unauthenticated
      // requests as fast as the loop could issue them.
      const url = `${IVOLATILITY_BASE}${IVX_ENDPOINT}?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}`;
      const response = await host.httpGet(url);

      const result = captureResponse({
        host,
        db,
        runId: run.runId,
        asOfDate: args.tradingDate,
        provider: 'ivolatility',
        endpoint: IVX_ENDPOINT,
        slug: 'ivx-bootstrap',
        params: { symbol: ticker, from, to },
        response,
        captureRuleId: ruleId,
        recipe: recipes.ivBootstrap({ ticker, source, methodNote: IVX_METHOD_NOTE })
      });

      if (result.parseStatus === 'ok' && result.rowsWritten > 0) {
        stored += 1;
        rows += result.rowsWritten;
      } else {
        failed += 1;
      }

      // Counted from the body rather than from the stored rows: the point is to
      // notice a systematic unit error on the first load, and a check that read
      // back only what was stored would be reading the same assumption twice.
      if (response.body) {
        try {
          outOfBand += outOfBandCount(JSON.parse(response.body)).outOfBand;
        } catch {
          /* an unparseable body is already counted as a failure above */
        }
      }
    }

    finishRun(db, host, run, 'complete');

    return {
      runId: run.runId,
      tickersAttempted: tickers.length,
      tickersStored: stored,
      tickersFailed: failed,
      rowsStored: rows,
      outOfBand,
      from,
      to
    };
  } catch (err) {
    finishRun(db, host, run, 'failed');
    throw err;
  }
}
