// Daily IV Capture job — fetches today's ATM IV from E*Trade for all universe
// tickers and stores it in iv_history. Used to compute IV Rank across the app
// without a paid IV data subscription.
// v0.21.0

import type { DbHandle } from '../../db/connection.js';
import type { ETradeDataProvider } from '../etrade-data-provider.js';
import type { IvHistoryService } from '../iv-history-service.js';
import { isTradingDay } from '../iv-history-service.js';
import type { ConstituentsService } from '../constituents-service.js';
import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';

const DEFAULT_CALL_DELAY_MS = 1_100; // safe default — stays under E*Trade rate limit
const MIN_CALL_DELAY_MS     =   200; // hard floor — never go below 200ms
const MAX_CALL_DELAY_MS     = 2_000; // hard ceiling

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Read callDelayMs from the job's config_json row, clamped to [200, 2000]. */
function readCallDelay(db: import('../../db/connection.js').DbHandle): number {
  type Row = { config_json: string | null };
  const row = db.prepare(`SELECT config_json FROM batch_jobs WHERE id = 'daily-iv-update'`).get() as Row | undefined;
  if (!row?.config_json) return DEFAULT_CALL_DELAY_MS;
  try {
    const cfg = JSON.parse(row.config_json) as Record<string, unknown>;
    const v = cfg['callDelayMs'];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return Math.max(MIN_CALL_DELAY_MS, Math.min(MAX_CALL_DELAY_MS, Math.round(v)));
    }
  } catch { /* ignore */ }
  return DEFAULT_CALL_DELAY_MS;
}

export class DailyIvCaptureJob implements BatchJobHandler {
  readonly name = 'Daily IV Update';
  readonly description =
    "Fetches today's ATM IV from E*Trade for all universe tickers and stores it in iv_history. " +
    'Used to compute IV Rank across the app without a paid IV data subscription.';

  constructor(
    private readonly db: DbHandle,
    private readonly optionsProvider: ETradeDataProvider,
    private readonly ivHistoryService: IvHistoryService,
    private readonly constituentsService: ConstituentsService
  ) {}

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal
  ): Promise<BatchJobResult> {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // 1. Skip non-trading days
    if (!isTradingDay(today)) {
      return {
        status: 'skipped',
        notes: 'Non-trading day — nothing to do',
        tickersAttempted: 0,
        tickersUpdated: 0,
        tickersSkipped: 0,
        tickersFailed: 0,
      };
    }

    // 2. Validate E*Trade connectivity — renew-and-retry ONCE on ANY failure.
    //    A dormant token (inactive >2h) does not reliably surface as a clean 401:
    //    observed 2026-06-18→07-01, the probe died with a terminated/hung stream
    //    every evening slot (token idle since the ~10:40 morning run), the old
    //    auth-message heuristic didn't match, renewal was never attempted, and the
    //    orchestrator chain halted 8 of 10 trading days. Renewing an ACTIVE token
    //    errors harmlessly (caught), so the unconditional renew-and-retry is safe.
    const isAuthError = (e: unknown): boolean => {
      const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
      return msg.includes('401') || msg.includes('token') || msg.includes('auth') || msg.includes('oauth');
    };

    try {
      await this.optionsProvider.getOptionsExpirations('SPY');
    } catch (firstErr) {
      try {
        await this.optionsProvider.renewToken();
      } catch { /* expected error on a recently-used (active) token — the retry decides */ }

      try {
        await this.optionsProvider.getOptionsExpirations('SPY');
      } catch (retryErr) {
        // Renew + retry both failed. Auth-shaped ⇒ token rolled past midnight and
        // needs a manual re-auth; anything else ⇒ genuine connectivity failure.
        if (isAuthError(retryErr) || isAuthError(firstErr)) {
          return {
            status: 'failed',
            errorMessage: 'E*Trade token expired. Open the app and go to Settings → E*Trade Connection to reconnect.',
            tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
            notification: {
              id: `etrade-expired-${Date.now()}`,
              type: 'error',
              message: 'E*Trade token expired — Daily IV update skipped.',
              cta: { label: 'Reconnect', view: 'settings' },
            },
          };
        }
        return {
          status: 'failed',
          errorMessage: `E*Trade connectivity check failed (after token renew + retry): ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
          tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
        };
      }
    }

    // 4. Gather all unique tickers across universes
    const callDelayMs = readCallDelay(this.db);
    const sp500 = this.constituentsService.getConstituents('sp500').map(r => r.ticker.toUpperCase());
    const russell = this.constituentsService.getConstituents('russell1000').map(r => r.ticker.toUpperCase());
    const etf = this.constituentsService.getConstituents('etf').map(r => r.ticker.toUpperCase());
    const allTickers = [...new Set([...sp500, ...russell, ...etf])];

    // 5. Process all tickers every run — always re-capture so intraday runs reflect
    //    current IV movement. iv_history uses ON CONFLICT DO UPDATE so re-running
    //    safely overwrites today's row with the latest ATM IV value.
    const missing = allTickers;
    const total = missing.length;
    const estMins = Math.round((total * callDelayMs) / 60_000);
    console.log(`[daily-iv-update] callDelayMs=${callDelayMs} total=${total} est=${estMins}min`);

    let attempted = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    // ── Helper: detect errors that mean "no listed options" or "unknown symbol" ──
    // These are expected for some universe tickers (no listed options, class shares
    // with dot notation E*Trade rejects, OTC-only names). Count as skipped, not failed.
    const isNoOptionsError = (e: unknown): boolean => {
      const msg = (e instanceof Error ? e.message : String(e));
      return (
        msg.includes('non-JSON') ||           // E*Trade returned XML (no options)
        msg.includes('10033') ||              // "The symbol entered is invalid"
        msg.includes('Invalid symbol') ||
        msg.includes('invalid symbol')
      );
    };

    // 6. Process each missing ticker
    for (const ticker of missing) {
      if (signal.aborted) break;

      // Pre-filter: tickers with dots (e.g. LEN.B, CWE.A) are class shares that
      // E*Trade does not support for options — skip immediately rather than burning
      // an API call and getting a 400.
      if (ticker.includes('.')) {
        skipped++;
        onProgress({
          jobId: 'daily-iv-update', runId: 0, ticker, status: 'skipped',
          attempted: ++attempted, updated, skipped, failed, total,
          message: 'Class share — no listed options',
        });
        continue;
      }

      attempted++;

      try {
        // 4a. Get expirations, pick closest to 30 DTE (between 20–45 DTE preferred)
        const expirations = await this.optionsProvider.getOptionsExpirations(ticker);

        if (expirations.length === 0) {
          skipped++;
          onProgress({
            jobId: 'daily-iv-update',
            runId: 0, // will be overwritten by BatchService
            ticker,
            status: 'skipped',
            attempted,
            updated,
            skipped,
            failed,
            total,
            message: 'No expirations available',
          });
          await sleep(callDelayMs);
          continue;
        }

        // Pick expiration closest to 30 DTE, preferring 20–45 DTE range
        const nowMs = Date.now();
        const withDte = expirations.map(exp => {
          const expMs = new Date(exp + 'T00:00:00Z').getTime();
          const dte = Math.max(0, Math.round((expMs - nowMs) / 86_400_000));
          return { exp, dte };
        });

        // Prefer range 20-45 DTE, else pick nearest 30 DTE overall
        const inRange = withDte.filter(x => x.dte >= 20 && x.dte <= 45);
        const candidates = inRange.length > 0 ? inRange : withDte;
        const best = candidates.reduce((a, b) =>
          Math.abs(a.dte - 30) <= Math.abs(b.dte - 30) ? a : b
        );
        const expiration = best.exp;

        // 4b. Fetch options chain
        const chain = await this.optionsProvider.getOptionsChain(ticker, expiration);
        const underlyingPx = chain.underlyingPrice;

        // 4c. Capture IV
        this.ivHistoryService.captureFromEtradeChain(ticker, chain.contracts, underlyingPx);

        // 4d. Check if row was actually written
        type IvRow = { atm_iv: number } | undefined;
        const written = this.db.prepare(
          `SELECT atm_iv FROM iv_history WHERE ticker = ? AND date = ?`
        ).get(ticker, today) as IvRow;

        if (written) {
          updated++;
          onProgress({
            jobId: 'daily-iv-update',
            runId: 0,
            ticker,
            status: 'updated',
            attempted,
            updated,
            skipped,
            failed,
            total,
          });
        } else {
          // captureFromEtradeChain returned nothing (insufficient data or existing ivolatility row)
          onProgress({
            jobId: 'daily-iv-update',
            runId: 0,
            ticker,
            status: 'no-data',
            attempted,
            updated,
            skipped,
            failed,
            total,
            message: 'Could not compute ATM IV from chain',
          });
          skipped++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isNoOptionsError(err)) {
          // No listed options or symbol not supported — expected for some universe
          // tickers. Count as skipped, not failed, to keep job success metrics clean.
          skipped++;
          onProgress({
            jobId: 'daily-iv-update', runId: 0, ticker, status: 'skipped',
            attempted, updated, skipped, failed, total,
            message: 'No listed options',
          });
        } else {
          failed++;
          onProgress({
            jobId: 'daily-iv-update', runId: 0, ticker, status: 'failed',
            attempted, updated, skipped, failed, total,
            message,
          });
        }
      }

      // 4g. Rate limit
      if (!signal.aborted) await sleep(callDelayMs);
    }

    const finalStatus = signal.aborted ? 'failed' : 'success';

    return {
      status: finalStatus,
      notes: `${updated} updated, ${skipped} skipped, ${failed} failed out of ${attempted} attempted.`,
      errorMessage: signal.aborted ? 'Job was cancelled.' : undefined,
      tickersAttempted: attempted,
      tickersUpdated: updated,
      tickersSkipped: skipped,
      tickersFailed: failed,
    };
  }
}
