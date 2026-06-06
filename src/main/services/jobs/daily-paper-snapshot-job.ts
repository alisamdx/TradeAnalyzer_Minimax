// DailyPaperSnapshotJob — snapshots EOD prices for all open paper trades.
//
// For every paper trade (any status) whose entry_date is before today, inserts one
// paper_trade_snapshots row per available historical-price date not yet recorded.
// Fully idempotent: ON CONFLICT DO NOTHING means multiple runs per day are safe.
//
// Runs at 17:00 ET (after price-gap-fill at 16:00 + buffer, and after the brief at 16:30).
// This ensures today's closing prices are already in historical_prices before we snapshot.
//
// see Requirements/paper-trading.md §Retrospect

import type { Database } from 'better-sqlite3';
import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';
import { PaperTradingService } from '../paper-trading-service.js';

export class DailyPaperSnapshotJob implements BatchJobHandler {
  readonly name = 'Daily Paper Trade Snapshot';
  readonly description =
    'Snapshots EOD closing prices for all paper trades so Retrospect can measure ' +
    'scoring-engine accuracy at fixed horizons (Day+1, Day+5, etc.). ' +
    'Safe to run multiple times per day — idempotent.';

  private readonly paperService: PaperTradingService;

  constructor(private readonly db: Database) {
    this.paperService = new PaperTradingService(db);
  }

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    _signal: AbortSignal,
  ): Promise<BatchJobResult> {
    const emit = (msg: string) =>
      onProgress({
        jobId: 'daily-paper-snapshot',
        runId: 0,
        ticker: '',
        status: 'updated',
        attempted: 0, updated: 0, skipped: 0, failed: 0, total: 0,
        message: msg,
      });

    emit('Snapshotting EOD prices for open paper trades…');

    const written = this.paperService.snapshotTrades();

    emit(`Done — ${written} new snapshot rows written.`);

    return {
      status:            'success',
      notes:             `${written} new snapshot${written !== 1 ? 's' : ''} written`,
      tickersAttempted:  0,
      tickersUpdated:    written,
      tickersSkipped:    0,
      tickersFailed:     0,
    };
  }
}
