// BatchOrchestratorJob — runs all configured batch jobs in sequence.
// Responsibilities: non-trading day guard, E*Trade token renewal, start email,
// per-job resume (skips already-succeeded jobs), stop-on-failure.
// Only one job is ever running at a time — the orchestrator holds the BatchService mutex.

import type { BatchJobHandler, BatchJobResult, BatchService, RunTrigger } from '../batch-service.js';
import type { BatchProgressEvent, OrchestratorJobConfig } from '@shared/types.js';
import type { EmailService } from '../email-service.js';
import type { OAuthCredentials } from '../etrade-auth.js';
import { renewAccessToken } from '../etrade-auth.js';
import { isTradingDay } from '../iv-history-service.js';

type TokenStatus = 'valid' | 'invalid';
type EtradeCredsWithDate = OAuthCredentials & { tokenDate: string | null };

/**
 * Whether a schedule slot runs LEAN (skips after_close_only jobs) — pure + unit-tested.
 * Explicit `leanSlots` wins; otherwise the default is every slot except the latest (the after-close
 * slot runs everything). Manual / startup runs (no slotTime) are never lean — they do the full batch.
 */
export function isLeanSlot(slotTime: string | null, scheduleSlots: string[], leanSlots?: string[]): boolean {
  if (!slotTime) return false;
  if (Array.isArray(leanSlots)) return leanSlots.includes(slotTime);
  const slots = [...(scheduleSlots ?? [])].sort();
  return slots.length > 1 && slotTime !== slots[slots.length - 1];
}

export class BatchOrchestratorJob implements BatchJobHandler {
  readonly name = 'Batch Orchestrator';
  readonly description =
    'Runs all enabled batch jobs in sequence. Validates E*Trade token, sends a start email, ' +
    'skips already-succeeded jobs (natural resume), and stops on first failure.';

  constructor(
    private readonly batchService: BatchService,
    private readonly getEtradeCreds: () => EtradeCredsWithDate | null,
    private readonly emailService: EmailService,
  ) {}

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal,
    force = false,
    trigger: RunTrigger = 'manual',
    slotTime: string | null = null,
  ): Promise<BatchJobResult> {
    const today = this.batchService.todayET();

    // ── 1. Non-trading day guard (scheduled runs only) ──────────────────────
    if (trigger === 'schedule' && !force && !isTradingDay(today)) {
      return {
        status: 'skipped',
        notes: 'Non-trading day — no jobs scheduled.',
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
      };
    }

    const config = this.batchService.getOrchestratorConfig();
    // Lean intraday slot (spec 08 §4): the ~10:15 morning slot skips after_close_only jobs (the
    // post-brief tail) — the brief and its upstream closure still run, so the brief is identical.
    // Manual/startup runs (no slotTime) and the after-close slot run the full set.
    const lean = this._isLeanSlot(slotTime, config);
    const enabledJobs = this.batchService.getSubJobs(config.jobs).filter(j => !lean || !j.afterCloseOnly);
    const total = enabledJobs.length;

    // ── 2. E*Trade token check ──────────────────────────────────────────────
    let tokenStatus: TokenStatus = 'valid';
    if (config.validateEtradeToken) {
      tokenStatus = await this._checkEtradeToken();
    }

    // ── 3. Resume/skip state ────────────────────────────────────────────────
    // A job is skipped when its last successful run completed within the past
    // SKIP_WINDOW_MS. This handles two distinct cases:
    //   • Resume: orchestrator stopped mid-run; re-trigger skips jobs that
    //     already succeeded moments ago and picks up from the failure point.
    //   • Multi-slot: 16:30 slot re-runs everything that succeeded at 10:15
    //     (well outside the window) rather than skipping it all.
    const nowMs = Date.now();
    const alreadyDone = enabledJobs.filter(j => this._isRecentSuccess(j, nowMs));
    const resumeStep  = alreadyDone.length + 1;
    const isFreshStart = alreadyDone.length === 0;
    const canStart = tokenStatus === 'valid';

    // ── 4. Start email ──────────────────────────────────────────────────────
    if (config.emailOnStart && this.emailService.isConfigured()) {
      const triggerLabel = trigger === 'schedule'
        ? `Scheduled ${slotTime ?? ''}`.trim()
        : trigger === 'manual' ? 'Manual' : 'Startup';
      this._sendStartEmail({
        triggerLabel,
        today,
        tokenStatus,
        isFreshStart,
        resumeStep,
        total,
        alreadyDoneNames: alreadyDone.map(j => j.name),
        pendingCount: enabledJobs.filter(j => !this._isRecentSuccess(j, nowMs)).length,
        canStart,
      }).catch(err => console.error('[orchestrator] start email error:', err));
    }

    // ── 5. Abort if token invalid ───────────────────────────────────────────
    if (!canStart) {
      return {
        status: 'failed',
        errorMessage: 'E*Trade token invalid — renewal failed. Batch did not start.',
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
      };
    }

    // ── 6. Job loop ─────────────────────────────────────────────────────────
    let succeeded = 0;
    let skipped   = 0;
    let warnings  = 0;

    for (let i = 0; i < enabledJobs.length; i++) {
      if (signal.aborted) break;

      const job       = enabledJobs[i]!;
      const stepLabel = `[${i + 1}/${total}]`;

      if (this._isRecentSuccess(job, nowMs)) {
        skipped++;
        const minsAgo = Math.round((nowMs - new Date(job.lastRunAt!).getTime()) / 60_000);
        onProgress(this._evt(job.id, 'skipped', i + 1, succeeded, skipped, 0, total,
          `${stepLabel} ${job.name} — skipped (succeeded ${minsAgo}m ago)`));
        continue;
      }

      onProgress(this._evt(job.id, 'skipped', i + 1, succeeded, skipped, 0, total,
        `${stepLabel} ${job.name} — starting…`));

      const result = await this.batchService.runJobDirect(job.id, trigger, slotTime, signal, force);

      // A warning continues the chain like a success (the job completed with a usable
      // fallback) but is counted separately so the orchestrator's own note shows it.
      if (result.status === 'success' || result.status === 'skipped' || result.status === 'warning') {
        succeeded++;
        if (result.status === 'warning') warnings++;
        onProgress(this._evt(job.id, 'updated', i + 1, succeeded, skipped, 0, total,
          `${stepLabel} ${job.name} — ${result.status}${result.notes ? ` (${result.notes})` : ''}`));
      } else {
        onProgress(this._evt(job.id, 'failed', i + 1, succeeded, skipped, 1, total,
          `${stepLabel} ${job.name} — FAILED: ${result.errorMessage ?? 'unknown error'}`));
        return {
          status: 'failed',
          errorMessage: `Stopped at ${job.name}: ${result.errorMessage ?? 'unknown error'}`,
          tickersAttempted: i + 1,
          tickersUpdated: succeeded,
          tickersSkipped: skipped,
          tickersFailed: 1,
        };
      }
    }

    return {
      status: 'success',
      notes: `${succeeded} succeeded${warnings > 0 ? ` (${warnings} with warnings)` : ''} · ${skipped} skipped`,
      tickersAttempted: total,
      tickersUpdated: succeeded,
      tickersSkipped: skipped,
      tickersFailed: 0,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  // Jobs that succeeded within this window are skipped; older successes are re-run.
  private static readonly SKIP_WINDOW_MS = 90 * 60 * 1000;

  private _isLeanSlot(slotTime: string | null, config: OrchestratorJobConfig): boolean {
    return isLeanSlot(slotTime, config.scheduleSlots, config.leanSlots);
  }

  private _isRecentSuccess(job: import('@shared/types.js').BatchJob, nowMs: number): boolean {
    return (
      job.lastRunStatus === 'success' &&
      job.lastRunAt !== null &&
      nowMs - new Date(job.lastRunAt).getTime() < BatchOrchestratorJob.SKIP_WINDOW_MS
    );
  }

  private async _checkEtradeToken(): Promise<TokenStatus> {
    const creds = this.getEtradeCreds();
    if (!creds?.accessToken) return 'invalid';

    // E*Trade tokens expire at midnight ET — the issue date is the authoritative gate.
    // This mirrors the checkConnection IPC handler (ipc-etrade.ts) which uses the same
    // date-stamp approach and intentionally avoids calling renewAccessToken() on startup
    // because calling it on an ACTIVE token causes E*Trade to return an error.
    const today = this.batchService.todayET();
    if (!creds.tokenDate || creds.tokenDate !== today) return 'invalid';

    // Token is date-valid. Attempt renewal to pre-wake a dormant token (inactive >2h).
    // Active tokens will fail this call — that is expected and does NOT mean the token
    // is invalid. Individual jobs surface real 401s if the token somehow isn't working.
    try {
      await renewAccessToken(creds);
    } catch (e) {
      // Expected for recently-used (active) tokens — but log it: a silent failure here
      // hid the dormant-token terminated-stream failures that halted the evening chain
      // for two weeks (Jun 2026). Jobs downstream now renew-and-retry themselves.
      console.warn('[orchestrator] token pre-wake renew failed (continuing):', e instanceof Error ? e.message : String(e));
    }
    return 'valid';
  }

  private _evt(
    jobId: string,
    status: BatchProgressEvent['status'],
    attempted: number,
    updated: number,
    skipped: number,
    failed: number,
    total: number,
    message: string,
  ): BatchProgressEvent {
    return {
      jobId: 'batch-orchestrator',
      runId: 0, // enriched with real runId by BatchService.runJob wrapper
      ticker: jobId,
      status,
      attempted,
      updated,
      skipped,
      failed,
      total,
      message,
    };
  }

  private async _sendStartEmail(params: {
    triggerLabel: string;
    today: string;
    tokenStatus: TokenStatus;
    isFreshStart: boolean;
    resumeStep: number;
    total: number;
    alreadyDoneNames: string[];
    pendingCount: number;
    canStart: boolean;
  }): Promise<void> {
    const {
      triggerLabel, today, tokenStatus, isFreshStart,
      resumeStep, total, alreadyDoneNames, pendingCount, canStart,
    } = params;

    const outcome = canStart
      ? `✅ Batch started — ${pendingCount} job${pendingCount !== 1 ? 's' : ''} will run`
      : '❌ Batch did not start — E*Trade token invalid';

    const tokenLine = tokenStatus === 'valid'
      ? '✅ Valid (renewed)'
      : '❌ Invalid — renewal failed';

    const stateLine = isFreshStart
      ? `Fresh start — all ${total} jobs pending`
      : `Resuming at step ${resumeStep} of ${total}`;

    const alreadyDoneHtml = alreadyDoneNames.length > 0
      ? `<p style="margin:4px 0 0; color:#666; font-size:13px;">Already succeeded today: ${alreadyDoneNames.join(', ')}</p>`
      : '';

    const html = `
<div style="font-family:monospace; padding:20px; max-width:580px; color:#222;">
  <h2 style="margin:0 0 16px; font-size:18px; color:#1a1a2e;">⚙ TradeAnalyzer Batch Orchestrator</h2>

  <table style="width:100%; border-collapse:collapse; font-size:14px; margin-bottom:16px;">
    <tr>
      <td style="padding:5px 0; color:#666; width:140px;">Date</td>
      <td>${today}</td>
    </tr>
    <tr>
      <td style="padding:5px 0; color:#666;">Trigger</td>
      <td>${triggerLabel}</td>
    </tr>
  </table>

  <hr style="border:none; border-top:1px solid #ddd; margin:12px 0;" />

  <h3 style="margin:12px 0 4px; font-size:14px;">E*Trade Token</h3>
  <p style="margin:0;">${tokenLine}</p>

  <h3 style="margin:16px 0 4px; font-size:14px;">Batch State</h3>
  <p style="margin:0;">${stateLine}</p>
  ${alreadyDoneHtml}

  <h3 style="margin:16px 0 4px; font-size:14px;">Outcome</h3>
  <p style="margin:0; font-weight:600;">${outcome}</p>
</div>`;

    const subject = `TradeAnalyzer Batch — ${triggerLabel} — ${canStart ? 'Started' : 'Failed to Start'} — ${today}`;
    await this.emailService.send(subject, html);
  }
}
