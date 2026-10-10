import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';
import { runDaily, markNotRun, syncRegistry, ALL_CHECKS, buildNoRunEmail, sessionOnOrBefore } from '@tradeanalyzer/core';
import { generationExists, readSharedPointer } from '../../collector-host/electron-collector-host.js';
import type { HostFactory } from './collector-oneshot.js';

/**
 * `data-collector` — the daily run (NewApp 04 §2, 06 §5 change #4).
 *
 * At B4 this runs phases 0 through 4 — preflight, bars, the end-of-day
 * snapshot and corporate actions — then the gate, then the status email.
 * Phases 5 through 9 (account, chain subset, chains, event domains, derivation)
 * arrive at B6 and B7.
 *
 * Registered at 17:05, after-close only. That places it after this app's own
 * after-close chain has started; if that chain is still running the batch mutex
 * makes the collector wait its turn, and the 19:30 watchdog catches the case
 * where the wait swallowed the day.
 *
 * 17:00 rather than 16:30 because Polygon keeps settling the day's bar past
 * 16:00 ET — the existing app learned that by storing partial bars and scoring
 * breakouts off them.
 */
/** The regular session opens here; before it, the latest session is a previous day's. */
export const SESSION_OPEN_ET = '09:30';

/**
 * The session a daily collector run belongs to (v1.1.345).
 *
 * It used to be the ET calendar date at start. A manual chain started in the
 * evening reaches the collector late, and once that is past midnight the run
 * would be recorded against the NEW date, whose session has not happened. Its
 * bars and chains are the previous session's. That case nearly happened on
 * 2026-10-08, when run 66 started at 23:52.
 *
 * Before 09:30 ET the run belongs to the latest session strictly before today,
 * from core's rule-based calendar: a Saturday 00:30 or a Monday 08:00 run is
 * Friday's. From 09:30 onward it stays today. A daytime run sees today's
 * market, and labelling it yesterday would file live quotes under a closed
 * session. This is why the cutoff is not the watchdog's 17:05.
 */
export function collectorTradingDate(today: string, timeEt: string): string {
  if (timeEt >= SESSION_OPEN_ET) return today;
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return sessionOnOrBefore(d.toISOString().slice(0, 10));
}

export function createCollectorDailyJob(deps: {
  readonly makeHost: HostFactory;
  readonly todayET: () => string;
  /** Current ET wall-clock time as 'HH:MM'. */
  readonly nowTimeET: () => string;
}): BatchJobHandler {
  return {
    name: 'Data collector (new application)',
    description:
      'The daily collection run for the rebuild: preflight and the run record. Writes only into ' +
      'the new generation, never into this application\'s own database.',

    async run(
      onProgress: (evt: BatchProgressEvent) => void,
      signal: AbortSignal
    ): Promise<BatchJobResult> {
      const base: BatchJobResult = {
        status: 'skipped',
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0
      };

      const pointer = readSharedPointer();
      if (!pointer) {
        return { ...base, notes: 'No generation pointer yet — the new application has not been run.' };
      }
      if (!generationExists(pointer)) {
        // Not an error, and above all not something to fix by creating one:
        // generation creation belongs to the new exe (06 §3).
        return { ...base, notes: 'No generation yet — TradeAnalyzer 2 has not created one.' };
      }

      const host = deps.makeHost({
        signal,
        onProgress: (phase, done, total, note) =>
          onProgress({
            jobId: 'data-collector', runId: 0, ticker: note ?? phase, status: 'updated',
            attempted: done, updated: done, skipped: 0, failed: 0, total,
            message: `${phase}${note ? `: ${note}` : ''}`
          })
      });

      try {
        const tradingDate = collectorTradingDate(deps.todayET(), deps.nowTimeET());
        const report = await runDaily(host, { tradingDate });

        if (report.verdict === 'skipped') {
          return { ...base, notes: `Preflight stopped the run: ${report.skippedReason ?? ''}` };
        }

        const stored = Object.values(report.domains).reduce((n, d) => n + d.stored, 0);
        const expected = Object.values(report.domains).reduce((n, d) => n + d.expected, 0);

        return {
          ...base,
          // A red verdict is a successful RUN that found problems, not a failed
          // job — the gate did exactly its work. A failed job here would mean
          // the collector could not complete, and conflating the two would make
          // the batch history unable to answer either question.
          status: report.phaseErrors.length > 0 ? 'failed' : 'success',
          notes:
            `${report.verdict.toUpperCase()} — ${report.blocking} blocking, ${report.warnings} warning(s); ` +
            `email ${report.emailSent ? 'sent' : `NOT sent (${report.emailError ?? 'unknown'})`}` +
            (report.phaseErrors.length > 0 ? `; phase errors: ${report.phaseErrors.join(' | ')}` : ''),
          tickersAttempted: expected,
          tickersUpdated: stored,
          tickersFailed: report.phaseErrors.length,
          ...(report.phaseErrors.length > 0 ? { errorMessage: report.phaseErrors.join(' | ') } : {})
        };
      } catch (err) {
        return {
          ...base,
          status: 'failed',
          tickersFailed: 1,
          errorMessage: err instanceof Error ? err.message : String(err)
        };
      } finally {
        host.close();
      }
    }
  };
}

/**
 * `collector-watchdog` — 03 §7.3.
 *
 * Runs at 19:30 and asks one question: did today produce a completed run? It
 * exists because the failure it catches is **silence**. A collector that never
 * started, or that was still waiting on the batch mutex when the evening ended,
 * looks exactly like a quiet day — and a green inbox that means "nothing ran" is
 * worse than a red one.
 */
/**
 * ET wall clock as 'HH:MM', 00-23. `hourCycle: 'h23'` because some ICU builds
 * render midnight as '24:xx' under `hour12: false`, which sorts after the cutoff.
 */
export function etClockHHMM(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}

/** When the daily collector is scheduled; before this, today's run cannot exist yet. */
export const COLLECTOR_SESSION_CUTOFF_ET = '17:05';

/**
 * The trading date the watchdog should ask about (v1.1.344).
 *
 * At 19:30 that is today. It is not today when the watchdog runs before
 * the collector's 17:05 slot. The case that hit: a manual orchestrator chain
 * started at 22:47 on 2026-10-08 reached the watchdog at 00:14, after midnight,
 * asked about 2026-10-09, found no run and halted the chain. It also marked
 * 2026-10-09's domains `not_run` and emailed NO RUN for a day that had not
 * started. Before the cutoff the question is about the previous trading day.
 */
export function watchdogTargetDate(
  today: string,
  timeEt: string,
  previousTradingDay: (date: string) => string | undefined
): string {
  if (timeEt >= COLLECTOR_SESSION_CUTOFF_ET) return today;
  return previousTradingDay(today) ?? today;
}

export function createCollectorWatchdogJob(deps: {
  readonly makeHost: HostFactory;
  readonly todayET: () => string;
  /** Current ET wall-clock time as 'HH:MM'. */
  readonly nowTimeET: () => string;
}): BatchJobHandler {
  return {
    name: 'Collector watchdog',
    description: 'Verifies the daily collection actually ran, and reports if it did not.',

    async run(
      _onProgress: (evt: BatchProgressEvent) => void,
      signal: AbortSignal
    ): Promise<BatchJobResult> {
      const base: BatchJobResult = {
        status: 'skipped',
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0
      };

      const pointer = readSharedPointer();
      if (!pointer) return { ...base, notes: 'No generation pointer yet.' };
      if (!generationExists(pointer)) {
        return { ...base, notes: 'No generation yet — TradeAnalyzer 2 has not created one.' };
      }

      const host = deps.makeHost({ signal, onProgress: () => undefined });
      try {
        const db = host.openGenerationDb();
        const today = watchdogTargetDate(deps.todayET(), deps.nowTimeET(), (d) =>
          (db
            .prepare('SELECT MAX(date) AS d FROM ref_trading_day WHERE date < ? AND is_trading_day = 1')
            .get(d) as { d: string | null } | undefined)?.d ?? undefined
        );

        const trading = db
          .prepare('SELECT is_trading_day FROM ref_trading_day WHERE date = ?')
          .get(today) as { is_trading_day: number } | undefined;
        if (trading?.is_trading_day === 0) {
          return { ...base, notes: `${today} is not a trading day.` };
        }

        const runs = db
          .prepare("SELECT status FROM meta_run WHERE trading_date = ? AND run_kind = 'daily'")
          .all(today) as { status: string }[];

        if (runs.some((r) => r.status === 'complete')) {
          return { ...base, status: 'success', notes: `Daily collection completed for ${today}.` };
        }

        // Reported, not retried. A watchdog that quietly re-ran the job would
        // turn "the collector did not run" into "the collector ran late", and
        // the second is much harder to notice going wrong repeatedly.
        const detail = runs.length === 0
          ? 'No daily run exists for this trading day.'
          : `Runs exist but none completed (${runs.map((r) => r.status).join(', ')}).`;

        // The registry must exist before `not_run` can be written per domain —
        // on a day the collector never ran, nothing else would have created it.
        syncRegistry(db, host, ALL_CHECKS);
        const domains = markNotRun(db, host, today);

        // The email that reports the absence of an email. A dead scheduler
        // produces no run, therefore no gate, therefore no status email — so
        // silence is the failure this sends.
        let emailSent = false;
        let emailError: string | undefined;
        try {
          await host.sendEmail(buildNoRunEmail(today, detail));
          emailSent = true;
        } catch (err) {
          emailError = err instanceof Error ? err.message : String(err);
        }

        return {
          ...base,
          status: 'failed',
          tickersFailed: 1,
          notes: `${domains} domain(s) marked not_run; NO RUN email ${emailSent ? 'sent' : `failed (${emailError ?? '?'})`}.`,
          errorMessage: `Collector watchdog: ${detail} for ${today}.`
        };
      } finally {
        host.close();
      }
    }
  };
}
