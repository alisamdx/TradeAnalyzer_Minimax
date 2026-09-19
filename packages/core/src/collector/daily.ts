import type { CollectorHost } from './host.js';
import { CollectorCancelled } from './host.js';
import { beginRun, finishRun, type RunHandle } from './run.js';
import { runPreflight } from './phases/preflight.js';
import { runBarsPhase, runQuotesPhase, runActionsPhase } from './phases/market.js';
import { runAccountPhase } from './phases/account.js';
import { runChainSubsetPhase, runChainsPhase } from './phases/chains.js';
import { runEventsPhase } from './phases/events.js';
import { runDerivePhase } from './phases/derive.js';
import { checksFor } from '../qa/registry.js';
import { runGate, type Verdict } from '../qa/gate.js';
import { runR6ActionRefetch, R6_MAX_TICKERS_PER_RUN, type R6Report } from './remediation.js';
import { buildStatusEmail } from '../qa/email.js';
import { COLLECTOR_VERSION } from '../version.js';

/**
 * The daily run — 04 §2.
 *
 * At B7b this is phases 0 through 9 plus the gate and the email — phase 9, the
 * IV derivation, landed here; the `bootstrap_iv` load beside it is a one-shot,
 * not part of the daily chain.
 *
 * Phase order is not arbitrary. Bars precede the chain subset because the subset
 * rule reads their dollar volume; the account precedes the subset and the chains
 * because a held option is a sticky contract and a sticky contract changes what
 * the chain phase asks for; and the cheap phases all precede the long chain
 * phase so that a chain failure never costs them.
 *
 * **The gate runs last and always.** Even when a phase throws, even when the run
 * is cancelled: a partial day is `unusable` by the gate's own reckoning, which
 * is the correct verdict and a far more useful one than no verdict at all.
 */

export interface DailyRunReport {
  readonly runId: number;
  readonly tradingDate: string;
  readonly verdict: Verdict | 'skipped';
  readonly skippedReason?: string;
  readonly domains: Readonly<Record<string, { expected: number; stored: number }>>;
  readonly blocking: number;
  readonly warnings: number;
  readonly checksRun: number;
  readonly checksVacuous: readonly string[];
  readonly emailSent: boolean;
  readonly emailError?: string;
  readonly phaseErrors: readonly string[];
  /** The R6 re-fetch this run attempted, if any (03 §6). */
  readonly remediation?: R6Report;
}

export async function runDaily(
  host: CollectorHost,
  args: { readonly tradingDate: string; readonly barDepthDays?: number }
): Promise<DailyRunReport> {
  const db = host.openGenerationDb();
  const run: RunHandle = beginRun(db, host, {
    kind: 'daily', tradingDate: args.tradingDate, slot: 'after_close'
  });

  const domains: Record<string, { expected: number; stored: number }> = {};
  const phaseErrors: string[] = [];
  let cancelled = false;

  const preflight = await runPreflight(host, db, run);
  if (!preflight.proceed) {
    finishRun(db, host, run, 'complete');
    return {
      runId: run.runId, tradingDate: args.tradingDate, verdict: 'skipped',
      skippedReason: preflight.detail, domains: {}, blocking: 0, warnings: 0,
      checksRun: 0, checksVacuous: [], emailSent: false, phaseErrors: []
    };
  }

  // Each phase is attempted independently. A failure is recorded and the run
  // continues: the gate reports which domains suffered, which beats losing the
  // cheap domains because an expensive one failed.
  const attempt = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof CollectorCancelled) { cancelled = true; throw err; }
      phaseErrors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  try {
    await attempt('bars', async () => {
      const c = await runBarsPhase(host, db, run, args.barDepthDays !== undefined ? { depthDays: args.barDepthDays } : {});
      domains['bars'] = { expected: c.expected, stored: c.stored };
    });
    await attempt('quotes', async () => {
      const c = await runQuotesPhase(host, db, run);
      domains['quotes'] = { expected: c.expected, stored: c.stored };
    });
    await attempt('corporate_actions', async () => {
      const c = await runActionsPhase(host, db, run);
      domains['corporate_actions'] = {
        expected: 0, stored: c.splits.stored + c.dividends.stored
      };
    });
    await attempt('account', async () => {
      const c = await runAccountPhase(host, db, run);
      domains['account'] = {
        expected: 0,
        stored: c.positions + c.balanceRows + c.ordersStored + c.transactionsStored
      };
    });
    await attempt('chain_subset', () => {
      const c = runChainSubsetPhase(db, host, run);
      domains['chain_subset'] = { expected: c.evaluated, stored: c.admitted + c.alreadyMembers };
      return Promise.resolve();
    });
    await attempt('chains', async () => {
      const c = await runChainsPhase(host, db, run);
      domains['chains'] = { expected: c.chainCalls, stored: c.contractsStored };
    });
    await attempt('events', async () => {
      // Phase 8's sub-phases already isolate their own failures, so a single
      // dead domain arrives here as a count of zero rather than as a throw.
      // What reaches this handler is a failure of the phase itself.
      const c = await runEventsPhase(host, db, run, {
        onError: (name, err) => {
          phaseErrors.push(`events/${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      for (const [name, sub] of Object.entries(c)) {
        domains[`events_${name}`] = { expected: sub.calls, stored: sub.stored };
      }
    });
    await attempt('derive', () => {
      // Phase 9 — the only phase that calls no provider, so it runs last and
      // reads what phase 7 just stored. It is deliberately inside the same
      // `attempt` wrapper as the rest: a derivation that throws must cost the
      // gate nothing that phase 7's own counts have not already reported.
      const c = runDerivePhase(db, host, run);
      domains['derive_iv30'] = { expected: c.tickers, stored: c.ok };
      return Promise.resolve();
    });
  } catch {
    // Cancellation only. The current response was already archived and ingested
    // before the signal was honoured, so what exists is consistent.
  }

  // The gate runs on whatever exists, including after a cancellation.
  // `checksFor` rather than `ALL_CHECKS`: the bootstrap's overlap checks are
  // registered only once a load exists to compare against (03 §3.8a), and the
  // set is therefore a property of the generation rather than of the build.
  const gate = runGate(db, host, {
    runId: run.runId, tradingDate: args.tradingDate, checks: checksFor(db), domainsExpected: domains
  });

  // R6 runs AFTER the gate, because which discontinuities are unexplained is
  // the gate's answer, and BEFORE the email so the attempt is on the record the
  // operator reads. It does not resolve anything: whether the re-fetched action
  // explains the step is decided on the NEXT run, when QC-204 re-evaluates and
  // `reconcileStoppedFiring` weighs this attempt against a fingerprint that has
  // gone quiet (03 §6). A failure here never fails the run — a remediation that
  // could halt collection would be worse than the finding it chases.
  let remediation: R6Report | undefined;
  let r6Error: string | undefined;
  try {
    remediation = await runR6ActionRefetch(host, db, {
      runId: run.runId, tradingDate: args.tradingDate
    });
  } catch (err) {
    r6Error = err instanceof Error ? err.message : String(err);
    phaseErrors.push(`remediation R6: ${r6Error}`);
  }

  const finishedAt = host.nowET();
  finishRun(db, host, run, cancelled ? 'cancelled' : 'complete', gate.verdict);

  const email = buildStatusEmail(db, {
    runId: run.runId,
    tradingDate: args.tradingDate,
    slot: 'after_close',
    verdict: gate.verdict,
    generationNo: preflight.generationNo,
    generationStatus: preflight.generationStatus,
    collectorVersion: COLLECTOR_VERSION,
    startedAt: run.startedAt,
    finishedAt,
    domains,
    ...(remediation
      ? {
          r6: {
            attempted: remediation.tickersAttempted, succeeded: remediation.tickersSucceeded,
            failed: remediation.tickersFailed, findingsMarked: remediation.exceptionsMarked,
            deferred: remediation.deferred, cap: R6_MAX_TICKERS_PER_RUN
          }
        }
      : r6Error !== undefined ? { r6: { error: r6Error } } : {})
  });

  let emailSent = false;
  let emailError: string | undefined;
  try {
    await host.sendEmail(email);
    emailSent = true;
    db.prepare("UPDATE qa_quality_report SET email_sent_at = ?, email_status = 'sent' WHERE report_id = ?")
      .run(finishedAt, gate.reportId);
  } catch (err) {
    emailError = err instanceof Error ? err.message : String(err);
    // A failed send is recorded, never swallowed. The email IS the interface;
    // an unreported send failure means the operator's silence-means-fine
    // assumption is quietly wrong.
    db.prepare("UPDATE qa_quality_report SET email_status = 'failed', email_error = ? WHERE report_id = ?")
      .run(emailError, gate.reportId);
  }

  return {
    runId: run.runId,
    tradingDate: args.tradingDate,
    verdict: gate.verdict,
    domains,
    blocking: gate.blocking,
    warnings: gate.warnings,
    checksRun: gate.checksRun,
    checksVacuous: gate.checksVacuous,
    emailSent,
    ...(emailError ? { emailError } : {}),
    phaseErrors,
    ...(remediation ? { remediation } : {})
  };
}
