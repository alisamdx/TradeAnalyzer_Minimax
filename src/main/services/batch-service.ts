// Batch service — manages scheduled background jobs (startup + daily schedule).
// Jobs are pluggable via BatchJobHandler. Only one job runs at a time (mutex).
// Progress and completion events stream to the renderer via callbacks.
// v0.33.0 — Orchestrator support: runJobDirect, multi-slot scheduler, trigger context.

import type { DbHandle } from '../db/connection.js';
import type { BatchJob, BatchRun, AppNotification, BatchProgressEvent, OrchestratorJobConfig, OrchestratorJobEntry } from '@shared/types.js';

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

export type RunTrigger = 'startup' | 'schedule' | 'manual';

export interface BatchJobHandler {
  name: string;
  description: string;
  /**
   * @param force   When true, bypass "non-trading day" guards so the job always runs.
   * @param trigger How the job was started — passed through for handler-level branching.
   * @param slotTime Which scheduler slot fired this run (null for manual/startup/API).
   */
  run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal,
    force?: boolean,
    trigger?: RunTrigger,
    slotTime?: string | null,
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
  sequence_order: number;
  after_close_only: number;
  config_json: string | null;
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
  trigger: string;
  slot_time: string | null;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class BatchService {
  private handlers = new Map<string, BatchJobHandler>();
  private abortControllers = new Map<string, AbortController>();
  private runningJobId: string | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private batchJobsEnabled = true;

  setEnabled(enabled: boolean): void {
    this.batchJobsEnabled = enabled;
    console.log(`[batch] global toggle: ${enabled ? 'enabled' : 'disabled'}`);
  }

  isEnabled(): boolean {
    return this.batchJobsEnabled;
  }

  getRunningJobId(): string | null {
    return this.runningJobId;
  }

  constructor(
    private readonly db: DbHandle,
    private readonly onNotification: (n: AppNotification) => void,
    private readonly onProgress: (evt: BatchProgressEvent) => void
  ) {
    // Clean up any jobs left in 'running' state from a previous crashed/killed session.
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE batch_runs
      SET status = 'failed', completed_at = ?, error_message = 'Interrupted by app restart'
      WHERE status = 'running'
    `).run(now);
    this.db.prepare(`
      UPDATE batch_jobs SET last_run_status = 'failed'
      WHERE last_run_status = 'running'
    `).run();
  }

  // ── Job registration ──────────────────────────────────────────────────────

  /**
   * Register a job handler and seed its DB row (INSERT OR IGNORE).
   *
   * @param options.sequenceOrder       Explicit position; overrides MAX+1 when provided.
   * @param options.dailyScheduleTime   Default 'HH:MM' ET (only applied on first registration).
   * @param options.runOnStartup        Whether to auto-run on app launch (default true).
   * @param options.startupDelaySeconds Seconds to wait before the startup run (default 30).
   * @param options.defaultConfig       Initial config_json values. Only written on first registration.
   */
  registerJob(
    id: string,
    handler: BatchJobHandler,
    options?: {
      sequenceOrder?: number;
      dailyScheduleTime?: string;
      dailyScheduleEnabled?: boolean;
      /**
       * Seeds `batch_jobs.enabled` on a FRESH install only. Defaults to true.
       *
       * `false` means "registered, runnable by hand, never triggered on its
       * own" — which is what a job wants while the thing it writes into is
       * still being stabilised. An existing install keeps whatever the row
       * already says (`INSERT OR IGNORE`), so changing this needs a migration.
       */
      enabled?: boolean;
      runOnStartup?: boolean;
      startupDelaySeconds?: number;
      afterCloseOnly?: boolean;
      defaultConfig?: Record<string, unknown>;
    },
  ): void {
    this.handlers.set(id, handler);

    const enabled             = (options?.enabled ?? true) ? 1 : 0;
    const scheduleTime        = options?.dailyScheduleTime    ?? '16:00';
    const scheduleEnabled     = (options?.dailyScheduleEnabled ?? true) ? 1 : 0;
    const runOnStartup        = options?.runOnStartup         ?? true ? 1 : 0;
    const startupDelaySecs    = options?.startupDelaySeconds  ?? 30;
    const afterCloseOnly      = options?.afterCloseOnly ? 1 : 0;
    const configJson          = options?.defaultConfig ? JSON.stringify(options.defaultConfig) : null;

    // Determine sequence_order: explicit > MAX+1
    const seqOrderExpr = options?.sequenceOrder != null
      ? String(options.sequenceOrder)
      : `(SELECT COALESCE(MAX(sequence_order), 0) + 1 FROM batch_jobs)`;

    // INSERT OR IGNORE = first install seeds these defaults; later startups preserve user edits.
    this.db.prepare(`
      INSERT OR IGNORE INTO batch_jobs
        (id, name, description, enabled, run_on_startup, startup_delay_seconds,
         daily_schedule_enabled, daily_schedule_time, sequence_order, after_close_only, config_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${seqOrderExpr}, ?, ?)
    `).run(id, handler.name, handler.description, enabled, runOnStartup, startupDelaySecs, scheduleEnabled, scheduleTime, afterCloseOnly, configJson);

    // Backfill config_json if it is still NULL (handles upgrades).
    if (configJson !== null) {
      this.db.prepare(`
        UPDATE batch_jobs SET config_json = ? WHERE id = ? AND config_json IS NULL
      `).run(configJson, id);
    }
  }

  // ── Startup jobs ─────────────────────────────────────────────────────────

  async runStartupJobs(): Promise<void> {
    if (!this.batchJobsEnabled) {
      console.log('[batch] global toggle is OFF — skipping startup jobs');
      return;
    }
    const jobs = this._getJobRows().filter(j => j.enabled && j.run_on_startup);
    for (const job of jobs) {
      const today = this.todayET();
      if (job.last_success_date === today) continue;

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
    this.scheduleTimer = setInterval(() => {
      this.checkSchedule().catch(err =>
        console.error('[batch] scheduler check error:', err)
      );
    }, 5 * 60 * 1000);
  }

  private async checkSchedule(): Promise<void> {
    if (!this.batchJobsEnabled) return;
    const now = this.currentTimeET();
    const today = this.todayET();

    const jobs = this._getJobRows().filter(j =>
      j.enabled && j.daily_schedule_enabled
    );

    for (const job of jobs) {
      // Multi-slot jobs (orchestrator) store their schedule in config_json.scheduleSlots.
      const config = job.config_json ? (JSON.parse(job.config_json) as Record<string, unknown>) : null;
      const slots = Array.isArray(config?.['scheduleSlots'])
        ? (config['scheduleSlots'] as unknown[]).filter((s): s is string => typeof s === 'string')
        : null;

      if (slots && slots.length > 0) {
        for (const slotTime of slots) {
          if (now < slotTime) continue;
          if (this._hasSlotFiredToday(job.id, slotTime, today)) continue;
          console.log(`[batch] schedule slot trigger for "${job.id}" slot=${slotTime}`);
          await this.runJob(job.id, 'schedule', false, slotTime).catch(err =>
            console.error(`[batch] schedule job "${job.id}" slot "${slotTime}" error:`, err)
          );
        }
      } else {
        // Original single-slot logic
        if (job.last_success_date === today) continue;
        if (now < job.daily_schedule_time) continue;
        console.log(`[batch] schedule trigger for "${job.id}" (now=${now} >= ${job.daily_schedule_time})`);
        await this.runJob(job.id, 'schedule').catch(err =>
          console.error(`[batch] schedule job "${job.id}" error:`, err)
        );
      }
    }
  }

  /** Returns true if any batch_run for this job+slot exists on today's date (any status). */
  private _hasSlotFiredToday(jobId: string, slotTime: string, today: string): boolean {
    const row = this.db.prepare(`
      SELECT id FROM batch_runs
      WHERE job_id = ? AND slot_time = ? AND date(started_at, 'localtime') = ?
      LIMIT 1
    `).get(jobId, slotTime, today);
    return !!row;
  }

  // ── Run a job (public, holds the mutex) ───────────────────────────────────

  async runJob(
    jobId: string,
    trigger: RunTrigger,
    force = false,
    slotTime?: string,
  ): Promise<void> {
    if (this.runningJobId !== null) {
      // A SCHEDULED trigger finding the mutex held is normal and self-correcting:
      // `checkSchedule` retries every 5 minutes, and the job is usually also a
      // member of the chain currently holding the lock (`getSubJobs` returns every
      // enabled job), so it runs either way. Notifying per tick turned a routine
      // wait into ~30 identical warnings across one evening — on 2026-09-10 the
      // 17:05 collector waited behind the orchestrator until 19:33. An alarm that
      // repeats while nothing is wrong is the shape that got 70 gate emails
      // ignored; it belongs in the log, not in front of the operator.
      //
      // Manual and startup triggers still notify: there somebody is waiting for
      // the job, and silence would be the bug.
      if (trigger === 'schedule') {
        console.log(
          `[batch] "${jobId}" deferred — "${this.runningJobId}" holds the mutex; retrying on the next tick`
        );
        return;
      }
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

    const insertResult = this.db.prepare(`
      INSERT INTO batch_runs (job_id, started_at, status, trigger, slot_time)
      VALUES (?, ?, 'running', ?, ?)
    `).run(jobId, startedAt, trigger, slotTime ?? null);
    const runId = insertResult.lastInsertRowid as number;

    this.db.prepare(`
      UPDATE batch_jobs SET last_run_at = ?, last_run_status = 'running' WHERE id = ?
    `).run(startedAt, jobId);

    const ac = new AbortController();
    this.abortControllers.set(jobId, ac);

    console.log(`[batch] starting job "${jobId}" (trigger=${trigger}, slot=${slotTime ?? 'none'}, runId=${runId})`);

    let result: BatchJobResult;
    try {
      result = await handler.run(
        (evt) => { this.onProgress({ ...evt, runId }); },
        ac.signal,
        force,
        trigger,
        slotTime ?? null,
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

    if (ac.signal.aborted) return;

    const completedAt = new Date().toISOString();
    this._writeRunResult(runId, jobId, completedAt, result);

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

    this.db.prepare(`
      DELETE FROM batch_runs
      WHERE job_id = ? AND started_at < datetime('now', '-30 days')
    `).run(jobId);

    console.log(`[batch] job "${jobId}" finished: status=${result.status}`);
  }

  // ── Run a job directly (called by orchestrator — no mutex, no notification) ─

  /**
   * Run a job handler directly without acquiring the outer mutex.
   * Intended for use by the BatchOrchestratorJob, which already holds the slot.
   * Records the run in batch_runs (with trigger + slot_time) and updates
   * batch_jobs metadata so per-job history is preserved exactly as if the
   * job had been called via runJob().
   *
   * Does NOT emit AppNotifications — the orchestrator owns messaging.
   */
  async runJobDirect(
    jobId: string,
    trigger: RunTrigger,
    slotTime: string | null,
    signal: AbortSignal,
    force = false,
  ): Promise<BatchJobResult> {
    const handler = this.handlers.get(jobId);
    if (!handler) {
      return {
        status: 'failed',
        errorMessage: `No handler registered for job "${jobId}"`,
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
      };
    }

    const startedAt = new Date().toISOString();

    const insertResult = this.db.prepare(`
      INSERT INTO batch_runs (job_id, started_at, status, trigger, slot_time)
      VALUES (?, ?, 'running', ?, ?)
    `).run(jobId, startedAt, trigger, slotTime);
    const runId = insertResult.lastInsertRowid as number;

    this.db.prepare(`
      UPDATE batch_jobs SET last_run_at = ?, last_run_status = 'running' WHERE id = ?
    `).run(startedAt, jobId);

    console.log(`[batch] runJobDirect "${jobId}" (trigger=${trigger}, slot=${slotTime ?? 'none'}, runId=${runId})`);

    let result: BatchJobResult;
    try {
      result = await handler.run(
        (evt) => { this.onProgress({ ...evt, runId }); },
        signal,
        force,
        trigger,
        slotTime,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = {
        status: 'failed',
        errorMessage: msg,
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
      };
    }

    if (!signal.aborted) {
      this._writeRunResult(runId, jobId, new Date().toISOString(), result);
    }

    return result;
  }

  // ── Cancel a running job ──────────────────────────────────────────────────

  cancelJob(jobId: string): void {
    const ac = this.abortControllers.get(jobId);
    if (ac) {
      ac.abort();
      console.log(`[batch] cancel requested for "${jobId}"`);

      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE batch_runs SET status = 'cancelled', completed_at = ?
        WHERE job_id = ? AND status = 'running'
      `).run(now, jobId);
      this.db.prepare(`
        UPDATE batch_jobs SET last_run_status = 'cancelled' WHERE id = ?
      `).run(jobId);

      this.runningJobId = null;
    }
  }

  // ── Orchestrator helpers ──────────────────────────────────────────────────

  /**
   * Returns all non-orchestrator jobs in sequence_order, filtered to those
   * enabled in the orchestrator config. Jobs not present in configJobs default
   * to enabled (handles new jobs added after config was last saved).
   *
   * **`batch_jobs.enabled` is honoured here too, and was not until v1.1.206.**
   * Every other trigger already respected it — `runStartupJobs` filters
   * `enabled && run_on_startup`, the daily tick filters
   * `enabled && daily_schedule_enabled` — but the orchestrator chain is what
   * actually runs jobs twice a trading day, so a job switched off in the UI kept
   * running and there was no single control that stopped it. The two defaults
   * compounded: a job absent from `config_json.jobs` defaults to *enabled*, so a
   * newly registered job joins the chain without anyone opting it in.
   *
   * Manual runs are deliberately unaffected — `runJob` never consulted this
   * column — so "off" means "does not run on its own", not "cannot be run".
   */
  getSubJobs(configJobs: OrchestratorJobEntry[]): BatchJob[] {
    const all = this._getJobRows()
      .filter(j => j.id !== 'batch-orchestrator' && j.enabled)
      .sort((a, b) => a.sequence_order - b.sequence_order)
      .map(j => this._mapJobRow(j));

    if (configJobs.length === 0) return all;

    const enabledById = new Map(configJobs.map(c => [c.id, c.enabled]));
    return all.filter(j => enabledById.get(j.id) !== false);
  }

  getOrchestratorConfig(): OrchestratorJobConfig {
    const row = this._getJobRow('batch-orchestrator');
    if (!row?.config_json) {
      return { scheduleSlots: [], validateEtradeToken: true, emailOnStart: true, jobs: [] };
    }
    return JSON.parse(row.config_json) as OrchestratorJobConfig;
  }

  getLastRun(jobId: string): BatchRun | null {
    const row = this.db.prepare(`
      SELECT * FROM batch_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1
    `).get(jobId) as BatchRunRow | undefined;
    return row ? this._mapRunRow(row) : null;
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
    patch: Partial<Pick<BatchJob, 'enabled' | 'runOnStartup' | 'startupDelaySeconds' | 'dailyScheduleEnabled' | 'dailyScheduleTime' | 'sequenceOrder' | 'afterCloseOnly' | 'config'>>
  ): void {
    if (patch.afterCloseOnly !== undefined) {
      this.db.prepare(`UPDATE batch_jobs SET after_close_only = ? WHERE id = ?`).run(patch.afterCloseOnly ? 1 : 0, jobId);
    }
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
    if (patch.sequenceOrder !== undefined) {
      this.db.prepare(`UPDATE batch_jobs SET sequence_order = ? WHERE id = ?`).run(patch.sequenceOrder, jobId);
    }
    if (patch.config !== undefined) {
      const existing = this._getJobRow(jobId);
      const current = existing?.config_json ? (JSON.parse(existing.config_json) as Record<string, unknown>) : {};
      const merged = { ...current, ...patch.config };
      this.db.prepare(`UPDATE batch_jobs SET config_json = ? WHERE id = ?`).run(JSON.stringify(merged), jobId);
    }
  }

  reorderJobs(jobIds: string[]): void {
    const stmt = this.db.prepare(`UPDATE batch_jobs SET sequence_order = ? WHERE id = ?`);
    jobIds.forEach((id, idx) => stmt.run(idx + 1, id));
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private _writeRunResult(runId: number, jobId: string, completedAt: string, result: BatchJobResult): void {
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

    const today = this.todayET();
    const lastSuccessDate = (result.status === 'success' || result.status === 'skipped') ? today : null;
    this.db.prepare(`
      UPDATE batch_jobs
      SET last_run_at = ?, last_run_status = ?, last_success_date = COALESCE(?, last_success_date)
      WHERE id = ?
    `).run(completedAt, result.status, lastSuccessDate, jobId);
  }

  private _getJobRows(): BatchJobRow[] {
    return this.db.prepare(`SELECT * FROM batch_jobs ORDER BY sequence_order ASC, id`).all() as BatchJobRow[];
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
      sequenceOrder: row.sequence_order,
      afterCloseOnly: row.after_close_only === 1,
      config: row.config_json ? (JSON.parse(row.config_json) as Record<string, unknown>) : {},
    };
  }

  private _mapRunRow(row: BatchRunRow): BatchRun {
    const status = row.status as BatchRun['status'];
    const trigger = (['manual', 'schedule', 'startup'] as const).includes(row.trigger as BatchRun['trigger'])
      ? (row.trigger as BatchRun['trigger'])
      : 'manual';
    return {
      id: row.id,
      jobId: row.job_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      status: (['running', 'success', 'failed', 'skipped', 'cancelled'] as const).includes(status)
        ? status
        : 'failed',
      tickersAttempted: row.tickers_attempted,
      tickersUpdated: row.tickers_updated,
      tickersSkipped: row.tickers_skipped,
      tickersFailed: row.tickers_failed,
      notes: row.notes,
      errorMessage: row.error_message,
      trigger,
      slotTime: row.slot_time,
    };
  }

  /** Returns today's date in ET timezone as YYYY-MM-DD. */
  todayET(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  }

  /** Freshness of the latest daily brief (spec 08 §5.4): is the most recent brief from today (ET)?
   *  The execution engine acts only on a same-day brief, so this tells the operator at a glance
   *  whether a fresh brief is available to trade. */
  getBriefFreshness(): { generatedAt: string | null; etDate: string | null; isToday: boolean } {
    const row = this.db
      .prepare('SELECT generated_at FROM daily_briefs ORDER BY generated_at DESC LIMIT 1')
      .get() as { generated_at: string } | undefined;
    if (!row) return { generatedAt: null, etDate: null, isToday: false };
    const etDate = new Date(row.generated_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return { generatedAt: row.generated_at, etDate, isToday: etDate === this.todayET() };
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
