// Batch service — manages scheduled background jobs (startup + daily schedule).
// Jobs are pluggable via BatchJobHandler. Only one job runs at a time.
// Progress and completion events stream to the renderer via callbacks.
// v0.21.0

import type { DbHandle } from '../db/connection.js';
import type { BatchJob, BatchRun, AppNotification, BatchProgressEvent } from '@shared/types.js';

// ─── Job handler interface ────────────────────────────────────────────────────

export interface BatchJobResult {
  status: 'success' | 'failed' | 'skipped';
  notes?: string;
  errorMessage?: string;
  tickersAttempted: number;
  tickersUpdated: number;
  tickersSkipped: number;
  tickersFailed: number;
  /** Optional notification the job wants surfaced to the user (e.g. auth expiry CTA). */
  notification?: AppNotification;
}

export interface BatchJobHandler {
  name: string;
  description: string;
  run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal
  ): Promise<BatchJobResult>;
}

// ─── DB row types ─────────────────────────────────────────────────────────────

interface BatchJobRow {
  id: string;
  name: string;
  description: string | null;
  enabled: number;
  run_on_startup: number;
  startup_delay_seconds: number;
  daily_schedule_enabled: number;
  daily_schedule_time: string;
  last_run_at: string | null;
  last_run_status: string | null;
  last_success_date: string | null;
}

interface BatchRunRow {
  id: number;
  job_id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  tickers_attempted: number;
  tickers_updated: number;
  tickers_skipped: number;
  tickers_failed: number;
  notes: string | null;
  error_message: string | null;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class BatchService {
  private handlers = new Map<string, BatchJobHandler>();
  private abortControllers = new Map<string, AbortController>();
  private runningJobId: string | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DbHandle,
    private readonly onNotification: (n: AppNotification) => void,
    private readonly onProgress: (evt: BatchProgressEvent) => void
  ) {}

  // ── Job registration ──────────────────────────────────────────────────────

  /**
   * Register a job handler and seed its DB row (INSERT OR IGNORE — existing
   * user config is never overwritten on restart).
   *
   * @param options.dailyScheduleTime  Default 'HH:MM' in ET (only applied on first registration).
   * @param options.runOnStartup       Whether to auto-run on app launch (default true).
   * @param options.startupDelaySeconds  Seconds to wait before the startup run (default 30).
   */
  registerJob(
    id: string,
    handler: BatchJobHandler,
    options?: { dailyScheduleTime?: string; runOnStartup?: boolean; startupDelaySeconds?: number },
  ): void {
    this.handlers.set(id, handler);

    const scheduleTime        = options?.dailyScheduleTime   ?? '16:00';
    const runOnStartup        = options?.runOnStartup        ?? true ? 1 : 0;
    const startupDelaySecs    = options?.startupDelaySeconds ?? 30;

    // Seed the batch_jobs row with INSERT OR IGNORE so config persists across restarts.
    this.db.prepare(`
      INSERT OR IGNORE INTO batch_jobs
        (id, name, description, enabled, run_on_startup, startup_delay_seconds,
         daily_schedule_enabled, daily_schedule_time)
      VALUES (?, ?, ?, 1, ?, ?, 1, ?)
    `).run(id, handler.name, handler.description, runOnStartup, startupDelaySecs, scheduleTime);
  }

  // ── Startup jobs ─────────────────────────────────────────────────────────

  async runStartupJobs(): Promise<void> {
    const jobs = this._getJobRows().filter(j => j.enabled && j.run_on_startup);
    for (const job of jobs) {
      const today = this.todayET();
      if (job.last_success_date === today) continue; // already ran today

      const delayMs = job.startup_delay_seconds * 1000;
      const jobId = job.id;
      console.log(`[batch] scheduling startup job "${jobId}" in ${job.startup_delay_seconds}s`);
      setTimeout(() => {
        this.runJob(jobId, 'startup').catch(err =>
          console.error(`[batch] startup job "${jobId}" error:`, err)
        );
      }, delayMs);
    }
  }

  // ── Daily scheduler ───────────────────────────────────────────────────────

  startScheduler(): void {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    // Check every 5 minutes
    this.scheduleTimer = setInterval(() => {
      this.checkSchedule().catch(err =>
        console.error('[batch] scheduler check error:', err)
      );
    }, 5 * 60 * 1000);
  }

  private async checkSchedule(): Promise<void> {
    const now = this.currentTimeET();
    const today = this.todayET();

    const jobs = this._getJobRows().filter(j =>
      j.enabled && j.daily_schedule_enabled
    );

    for (const job of jobs) {
      if (job.last_success_date === today) continue; // already ran today
      if (now < job.daily_schedule_time) continue;   // not yet time

      console.log(`[batch] schedule trigger for "${job.id}" (now=${now} >= ${job.daily_schedule_time})`);
      await this.runJob(job.id, 'schedule').catch(err =>
        console.error(`[batch] schedule job "${job.id}" error:`, err)
      );
    }
  }

  // ── Run a job ─────────────────────────────────────────────────────────────

  async runJob(jobId: string, trigger: 'startup' | 'schedule' | 'manual'): Promise<void> {
    if (this.runningJobId !== null) {
      this.onNotification({
        id: `batch-busy-${Date.now()}`,
        type: 'warning',
        message: `Batch job "${this.runningJobId}" is already running. "${jobId}" was not started.`,
      });
      return;
    }

    const handler = this.handlers.get(jobId);
    if (!handler) {
      console.error(`[batch] no handler registered for job "${jobId}"`);
      return;
    }

    const startedAt = new Date().toISOString();
    this.runningJobId = jobId;

    // Create run record
    const insertResult = this.db.prepare(`
      INSERT INTO batch_runs (job_id, started_at, status)
      VALUES (?, ?, 'running')
    `).run(jobId, startedAt);
    const runId = insertResult.lastInsertRowid as number;

    // Update job last_run_at + status = running
    this.db.prepare(`
      UPDATE batch_jobs SET last_run_at = ?, last_run_status = 'running' WHERE id = ?
    `).run(startedAt, jobId);

    // Create abort controller
    const ac = new AbortController();
    this.abortControllers.set(jobId, ac);

    console.log(`[batch] starting job "${jobId}" (trigger=${trigger}, runId=${runId})`);

    let result: BatchJobResult;
    try {
      result = await handler.run(
        (evt) => {
          // Enrich with runId and relay
          this.onProgress({ ...evt, runId });
        },
        ac.signal
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = {
        status: 'failed',
        errorMessage: msg,
        tickersAttempted: 0,
        tickersUpdated: 0,
        tickersSkipped: 0,
        tickersFailed: 0,
      };
    } finally {
      this.abortControllers.delete(jobId);
      this.runningJobId = null;
    }

    const completedAt = new Date().toISOString();

    // Update run record
    this.db.prepare(`
      UPDATE batch_runs
      SET completed_at = ?, status = ?,
          tickers_attempted = ?, tickers_updated = ?,
          tickers_skipped = ?, tickers_failed = ?,
          notes = ?, error_message = ?
      WHERE id = ?
    `).run(
      completedAt,
      result.status,
      result.tickersAttempted,
      result.tickersUpdated,
      result.tickersSkipped,
      result.tickersFailed,
      result.notes ?? null,
      result.errorMessage ?? null,
      runId
    );

    // Update job metadata
    const today = this.todayET();
    const lastSuccessDate = (result.status === 'success' || result.status === 'skipped') ? today : null;
    this.db.prepare(`
      UPDATE batch_jobs
      SET last_run_at = ?, last_run_status = ?, last_success_date = COALESCE(?, last_success_date)
      WHERE id = ?
    `).run(completedAt, result.status, lastSuccessDate, jobId);

    // Emit notification — job-supplied notification takes priority (e.g. auth CTA),
    // otherwise fall back to the standard success / failed / skipped messages.
    const jobRow = this._getJobRow(jobId);
    const jobName = jobRow?.name ?? jobId;
    if (result.notification) {
      this.onNotification(result.notification);
    } else if (result.status === 'success') {
      this.onNotification({
        id: `batch-done-${runId}`,
        type: 'success',
        message: `${jobName}: ${result.tickersUpdated} updated, ${result.tickersSkipped} skipped.`,
        cta: { label: 'View Batch', view: 'batch' },
      });
    } else if (result.status === 'failed') {
      this.onNotification({
        id: `batch-fail-${runId}`,
        type: 'error',
        message: `${jobName} failed: ${result.errorMessage ?? 'Unknown error'}`,
        cta: { label: 'View Batch', view: 'batch' },
      });
    } else if (result.status === 'skipped') {
      console.log(`[batch] job "${jobId}" skipped: ${result.notes ?? ''}`);
      this.onNotification({
        id: `batch-skip-${runId}`,
        type: 'info',
        message: `${jobName}: ${result.notes ?? 'Skipped'}`,
        cta: { label: 'View Batch', view: 'batch' },
      });
    }

    // Prune runs older than 30 days for this job
    this.db.prepare(`
      DELETE FROM batch_runs
      WHERE job_id = ? AND started_at < datetime('now', '-30 days')
    `).run(jobId);

    console.log(`[batch] job "${jobId}" finished: status=${result.status}`);
  }

  // ── Cancel a running job ──────────────────────────────────────────────────

  cancelJob(jobId: string): void {
    const ac = this.abortControllers.get(jobId);
    if (ac) {
      ac.abort();
      console.log(`[batch] cancel requested for "${jobId}"`);
    }
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  getJobs(): BatchJob[] {
    return this._getJobRows().map(row => this._mapJobRow(row));
  }

  getRuns(jobId: string): BatchRun[] {
    const rows = this.db.prepare(`
      SELECT * FROM batch_runs
      WHERE job_id = ? AND started_at >= datetime('now', '-30 days')
      ORDER BY started_at DESC
    `).all(jobId) as BatchRunRow[];
    return rows.map(r => this._mapRunRow(r));
  }

  updateJobConfig(
    jobId: string,
    patch: Partial<Pick<BatchJob, 'enabled' | 'runOnStartup' | 'startupDelaySeconds' | 'dailyScheduleEnabled' | 'dailyScheduleTime'>>
  ): void {
    if (patch.enabled !== undefined) {
      this.db.prepare(`UPDATE batch_jobs SET enabled = ? WHERE id = ?`).run(patch.enabled ? 1 : 0, jobId);
    }
    if (patch.runOnStartup !== undefined) {
      this.db.prepare(`UPDATE batch_jobs SET run_on_startup = ? WHERE id = ?`).run(patch.runOnStartup ? 1 : 0, jobId);
    }
    if (patch.startupDelaySeconds !== undefined) {
      this.db.prepare(`UPDATE batch_jobs SET startup_delay_seconds = ? WHERE id = ?`).run(patch.startupDelaySeconds, jobId);
    }
    if (patch.dailyScheduleEnabled !== undefined) {
      this.db.prepare(`UPDATE batch_jobs SET daily_schedule_enabled = ? WHERE id = ?`).run(patch.dailyScheduleEnabled ? 1 : 0, jobId);
    }
    if (patch.dailyScheduleTime !== undefined) {
      this.db.prepare(`UPDATE batch_jobs SET daily_schedule_time = ? WHERE id = ?`).run(patch.dailyScheduleTime, jobId);
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private _getJobRows(): BatchJobRow[] {
    return this.db.prepare(`SELECT * FROM batch_jobs ORDER BY id`).all() as BatchJobRow[];
  }

  private _getJobRow(jobId: string): BatchJobRow | undefined {
    return this.db.prepare(`SELECT * FROM batch_jobs WHERE id = ?`).get(jobId) as BatchJobRow | undefined;
  }

  private _mapJobRow(row: BatchJobRow): BatchJob {
    const status = row.last_run_status as BatchJob['lastRunStatus'];
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      enabled: row.enabled === 1,
      runOnStartup: row.run_on_startup === 1,
      startupDelaySeconds: row.startup_delay_seconds,
      dailyScheduleEnabled: row.daily_schedule_enabled === 1,
      dailyScheduleTime: row.daily_schedule_time,
      lastRunAt: row.last_run_at,
      lastRunStatus: (status === 'running' || status === 'success' || status === 'failed' || status === 'skipped') ? status : null,
      lastSuccessDate: row.last_success_date,
    };
  }

  private _mapRunRow(row: BatchRunRow): BatchRun {
    const status = row.status as BatchRun['status'];
    return {
      id: row.id,
      jobId: row.job_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      status: (['running', 'success', 'failed', 'skipped', 'cancelled'] as const).includes(status as BatchRun['status'])
        ? status
        : 'failed',
      tickersAttempted: row.tickers_attempted,
      tickersUpdated: row.tickers_updated,
      tickersSkipped: row.tickers_skipped,
      tickersFailed: row.tickers_failed,
      notes: row.notes,
      errorMessage: row.error_message,
    };
  }

  /** Returns today's date in ET timezone as YYYY-MM-DD. */
  todayET(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  }

  /** Returns the current time in ET as 'HH:MM'. */
  currentTimeET(): string {
    return new Date().toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).slice(0, 5);
  }
}
