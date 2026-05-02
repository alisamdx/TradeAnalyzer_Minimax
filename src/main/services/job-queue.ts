// Job queue — manages the producer/consumer pipeline state in SQLite.
// Tracks job_runs + job_progress so that jobs are resumable across app restarts.
// see SPEC: §4.4.4
// see docs/formulas.md#job-queue

import type { DbHandle } from '../db/connection.js';
import { withTransaction } from '../db/connection.js';

export type JobType = 'validate_all' | 'screen_run' | 'analysis_run';
export type JobStatus = 'pending' | 'running' | 'paused' | 'stopped' | 'completed' | 'failed';
export type TickerStatus = 'pending' | 'fetched' | 'persisted' | 'failed';

export interface JobRunRecord {
  id: number;
  type: JobType;
  watchlistId: number | null;
  status: JobStatus;
  startedAt: string;
  endedAt: string | null;
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  configJson: string | null;
}

export interface JobProgressRecord {
  id: number;
  jobRunId: number;
  ticker: string;
  status: TickerStatus;
  errorMsg: string | null;
  processedAt: string;
}

export interface JobQueueStats {
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
}

/** Wraps a DB handle with job-run + progress tracking methods. */
export class JobQueue {
  constructor(private readonly db: DbHandle) {}

  // ─── Job run CRUD ────────────────────────────────────────────────────────────

  /** Create a new job run, seeding it with all tickers as pending. */
  enqueue(
    type: JobType,
    tickers: string[],
    watchlistId: number | null = null,
    config: Record<string, unknown> = {}
  ): JobRunRecord {
    return withTransaction(this.db, () => {
      const result = this.db.prepare(
        `INSERT INTO job_runs (type, watchlist_id, status, config_json, total_count)
         VALUES (?, ?, 'pending', ?, ?)`
      ).run(type, watchlistId, JSON.stringify(config), tickers.length);

      const runId = Number(result.lastInsertRowid);
      const insertTicker = this.db.prepare(
        `INSERT INTO job_progress (job_run_id, ticker, status) VALUES (?, ?, 'pending')`
      );
      for (const ticker of tickers) {
        insertTicker.run(runId, ticker);
      }
      return this.getRun(runId)!;
    });
  }

  /** Get a run by id. */
  getRun(id: number): JobRunRecord | null {
    const r = this.db.prepare(
      `SELECT id, type, watchlist_id, status, started_at, ended_at,
              total_count, succeeded_count, failed_count, config_json
         FROM job_runs WHERE id = ?`
    ).get(id) as {
      id: number; type: JobType; watchlist_id: number | null;
      status: JobStatus; started_at: string; ended_at: string | null;
      total_count: number; succeeded_count: number; failed_count: number;
      config_json: string | null;
    } | undefined;
    if (!r) return null;
    return {
      id: r.id, type: r.type, watchlistId: r.watchlist_id, status: r.status,
      startedAt: r.started_at, endedAt: r.ended_at,
      totalCount: r.total_count, succeededCount: r.succeeded_count,
      failedCount: r.failed_count, configJson: r.config_json
    };
  }

  /** Mark a run as running (transition from pending). */
  markRunning(id: number): void {
    this.db.prepare(
      `UPDATE job_runs SET status = 'running' WHERE id = ? AND status = 'pending'`
    ).run(id);
  }

  /** Mark a run as paused. */
  pauseRun(id: number): void {
    this.db.prepare(
      `UPDATE job_runs SET status = 'paused' WHERE id = ? AND status = 'running'`
    ).run(id);
  }

  /** Resume a paused run back to running. */
  resumeRun(id: number): void {
    this.db.prepare(
      `UPDATE job_runs SET status = 'running' WHERE id = ? AND status = 'paused'`
    ).run(id);
  }

  /** Mark a run as stopped — signals Fetcher to drain gracefully. */
  stopRun(id: number): void {
    this.db.prepare(
      `UPDATE job_runs SET status = 'stopped' WHERE id = ?`
    ).run(id);
  }

  /** Finalize a run — mark completed, failed, or stopped, with final counts. */
  finalizeRun(id: number, status: 'completed' | 'failed' | 'stopped'): void {
    const stats = this.getRunStats(id);
    this.db.prepare(
      `UPDATE job_runs SET status = ?, ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                      succeeded_count = ?, failed_count = ?
       WHERE id = ?`
    ).run(status, stats.succeeded, stats.failed, id);
  }

  /** Get the next pending ticker for a run, or null if all are done/failed. */
  getNextPending(jobRunId: number): string | null {
    const row = this.db.prepare(
      `SELECT ticker FROM job_progress
        WHERE job_run_id = ? AND status = 'pending'
        ORDER BY id ASC LIMIT 1`
    ).get(jobRunId) as { ticker: string } | undefined;
    return row?.ticker ?? null;
  }

  /** Get all pending tickers for a run (for resume). */
  getPendingTickers(jobRunId: number): string[] {
    const rows = this.db.prepare(
      `SELECT ticker FROM job_progress
        WHERE job_run_id = ? AND status = 'pending' ORDER BY id ASC`
    ).all(jobRunId) as Array<{ ticker: string }>;
    return rows.map((r) => r.ticker);
  }

  // ─── Ticker progress ─────────────────────────────────────────────────────────

  /** Mark a ticker as fetched. */
  markFetched(jobRunId: number, ticker: string): void {
    this.db.prepare(
      `UPDATE job_progress SET status = 'fetched',
          processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE job_run_id = ? AND ticker = ?`
    ).run(jobRunId, ticker);
  }

  /** Mark a ticker as persisted. */
  markPersisted(jobRunId: number, ticker: string): void {
    this.db.prepare(
      `UPDATE job_progress SET status = 'persisted',
          processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE job_run_id = ? AND ticker = ?`
    ).run(jobRunId, ticker);
  }

  /** Mark a ticker as failed. */
  markFailed(jobRunId: number, ticker: string, errorMsg: string): void {
    this.db.prepare(
      `UPDATE job_progress SET status = 'failed', error_msg = ?,
          processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE job_run_id = ? AND ticker = ?`
    ).run(errorMsg, jobRunId, ticker);
  }

  /** Get all progress records for a run. */
  getProgress(jobRunId: number): JobProgressRecord[] {
    const rows = this.db.prepare(
      `SELECT id, job_run_id, ticker, status, error_msg, processed_at
         FROM job_progress WHERE job_run_id = ? ORDER BY id ASC`
    ).all(jobRunId) as Array<{
      id: number; job_run_id: number; ticker: string;
      status: TickerStatus; error_msg: string | null; processed_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id, jobRunId: r.job_run_id, ticker: r.ticker,
      status: r.status, errorMsg: r.error_msg, processedAt: r.processed_at
    }));
  }

  /** Get aggregated stats for a run. */
  getRunStats(jobRunId: number): JobQueueStats {
    const rows = this.db.prepare(
      `SELECT status, COUNT(*) AS count FROM job_progress
        WHERE job_run_id = ? GROUP BY status`
    ).all(jobRunId) as Array<{ status: TickerStatus; count: number }>;
    let total = 0, succeeded = 0, failed = 0, pending = 0;
    for (const row of rows) {
      total += row.count;
      if (row.status === 'persisted') succeeded += row.count;
      else if (row.status === 'failed') failed += row.count;
      else if (row.status === 'pending') pending += row.count;
    }
    return { total, succeeded, failed, pending };
  }

  // ─── Resume helpers ──────────────────────────────────────────────────────────

  /** Find incomplete runs from a previous session. */
  getIncompleteRuns(): JobRunRecord[] {
    const rows = this.db.prepare(
      `SELECT id, type, watchlist_id, status, started_at, ended_at,
              total_count, succeeded_count, failed_count, config_json
         FROM job_runs
         WHERE status IN ('pending', 'running', 'paused')
         ORDER BY started_at DESC LIMIT 10`
    ).all() as Array<{
      id: number; type: JobType; watchlist_id: number | null;
      status: JobStatus; started_at: string; ended_at: string | null;
      total_count: number; succeeded_count: number; failed_count: number;
      config_json: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id, type: r.type, watchlistId: r.watchlist_id, status: r.status,
      startedAt: r.started_at, endedAt: r.ended_at,
      totalCount: r.total_count, succeededCount: r.succeeded_count,
      failedCount: r.failed_count, configJson: r.config_json
    }));
  }

  /** List all runs, newest first. */
  listRuns(type?: JobType, limit = 50): JobRunRecord[] {
    const sql = `SELECT id, type, watchlist_id, status, started_at, ended_at,
                       total_count, succeeded_count, failed_count, config_json
                 FROM job_runs${type ? ' WHERE type = ?' : ''}
                 ORDER BY started_at DESC LIMIT ?`;
    const params = type ? [type, limit] : [limit];
    const rows = (type
      ? this.db.prepare(sql).all(...params)
      : this.db.prepare(sql).all(...params)
    ) as Array<{
      id: number; type: JobType; watchlist_id: number | null;
      status: JobStatus; started_at: string; ended_at: string | null;
      total_count: number; succeeded_count: number; failed_count: number;
      config_json: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id, type: r.type, watchlistId: r.watchlist_id, status: r.status,
      startedAt: r.started_at, endedAt: r.ended_at,
      totalCount: r.total_count, succeededCount: r.succeeded_count,
      failedCount: r.failed_count, configJson: r.config_json
    }));
  }
}