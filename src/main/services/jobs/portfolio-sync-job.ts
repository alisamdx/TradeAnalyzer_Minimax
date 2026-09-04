// PortfolioSyncJob — nightly refresh of the real position book from E*Trade.
//
// Runs last in the after-close chain so the Portfolio and Performance views are current every
// morning without anyone remembering to press a button.
//
// TWO THINGS ABOUT THIS JOB ARE UNUSUAL AND DELIBERATE.
//
// 1. It NEVER returns `failed`. The orchestrator is stop-on-failure, so a failed sub-job halts
//    everything after it. E*Trade's transactions endpoint is demonstrably flaky (it answered
//    `oauth_problem=nonce_used` after ~120 s for weeks), and a broker API hiccup must not stop
//    the daily brief from generating. Errors surface as a `success` result carrying a warning
//    note — the same contract `constituents-refresh` uses for a broken holdings feed.
//
// 2. Portfolio sync runs BEFORE the closed-position import, and the order matters. When a
//    position vanishes from the broker, `syncPortfolio` writes an estimate marked "realized P&L
//    estimated from last mark" — and those are systematically wrong: an assigned CSP reads as a
//    large loss when it was a conversion into stock (TSLA $350: estimate −$3,735.53, actual
//    +$499.48). Importing immediately afterwards supersedes that estimate with the real fill in
//    the same run, so the wrong figure never reaches the Performance tab.
//
// This is also the first batch job that writes to the user's real financial record rather than
// market data, which is why every write it makes is audited (`position_audit`, migration 073).

import type { DbHandle } from '../../db/connection.js';
import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';
import type { OAuthCredentials } from '../etrade-auth.js';
import { EtradePortfolioService } from '../etrade-portfolio-service.js';

const JOB_ID = 'portfolio-sync';

export class PortfolioSyncJob implements BatchJobHandler {
  readonly name = 'Portfolio Sync';
  readonly description =
    'Refreshes open positions from E*Trade and imports closed positions with real broker fills, '
    + 'so the Portfolio and Performance views are current without a manual sync. Open positions '
    + 'are synced first so any estimate written for a position that just closed is immediately '
    + 'superseded by its actual fill. Never fails the batch chain — E*Trade problems surface as '
    + 'a warning note.';

  private readonly portfolio = new EtradePortfolioService();

  constructor(
    private readonly db: DbHandle,
    private readonly getCreds: () => OAuthCredentials | null,
  ) {}

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal,
  ): Promise<BatchJobResult> {
    const emit = (message: string, status: BatchProgressEvent['status'] = 'updated'): void =>
      onProgress({
        jobId: JOB_ID, runId: 0, ticker: '', status,
        attempted: 0, updated: 0, skipped: 0, failed: 0, total: 2, message,
      });

    const creds = this.getCreds();
    if (!creds?.accessToken) {
      return {
        status: 'skipped',
        notes: 'E*Trade not connected — reconnect in Settings to sync the portfolio.',
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
      };
    }

    const notes: string[] = [];
    const warnings: string[] = [];
    let updated = 0;

    // ── 1. Open positions ────────────────────────────────────────────────────
    emit('Syncing open positions from E*Trade…');
    try {
      const r = await this.portfolio.syncPortfolio(this.db, creds);
      updated += r.positionsUpserted;
      notes.push(`Positions: ${r.positionsUpserted} updated, ${r.positionsSkipped} unchanged`);
      if (r.errors.length > 0) warnings.push(`position sync: ${r.errors.slice(0, 2).join('; ')}`);
    } catch (err) {
      warnings.push(`position sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // The cash balance snapshot happens INSIDE syncPortfolio (v1.1.180), so it covers this job
    // and the manual Sync button alike. It used to be a separate step here, which meant a manual
    // sync snapshotted nothing at all.

    if (signal.aborted) {
      return {
        status: 'failed', notes: notes.join(' · '), errorMessage: 'Job was cancelled.',
        tickersAttempted: 2, tickersUpdated: updated, tickersSkipped: 0, tickersFailed: 0,
      };
    }

    // ── 2. Closed positions, with real fills ─────────────────────────────────
    // Second on purpose — see the header note on estimate-then-supersede.
    emit('Importing closed positions (real fills)…');
    try {
      const r = await this.portfolio.syncClosedPositions(this.db, creds);
      updated += r.positionsUpserted;
      notes.push(`Closed: ${r.positionsUpserted} imported, ${r.positionsSkipped} already present`);
      if (r.errors.length > 0) warnings.push(`closed import: ${r.errors[0]?.slice(0, 120)}`);
    } catch (err) {
      warnings.push(`closed import failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Anything written to the financial record this run, for the run note.
    let audited = 0;
    try {
      audited = (this.db.prepare(
        `SELECT COUNT(*) AS n FROM position_audit WHERE occurred_at >= datetime('now','-1 hour')`,
      ).get() as { n: number }).n;
    } catch { /* audit table is a nicety, never a blocker */ }
    if (audited > 0) notes.push(`${audited} audited write${audited === 1 ? '' : 's'}`);

    // Deliberately `success` even when E*Trade misbehaved: this job must not halt the chain.
    return {
      status: 'success',
      notes: notes.join(' · ') + (warnings.length ? ` · WARNING: ${warnings.join(' | ')}` : ''),
      tickersAttempted: 2,
      tickersUpdated: updated,
      tickersSkipped: 0,
      tickersFailed: 0,
    };
  }
}
