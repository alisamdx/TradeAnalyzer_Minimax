// Exit policy (Requirements/v2-execution 03-lifecycle §3.3).
//
// Pure rule evaluation for a managed position: stop / defensive-expiry (protective,
// automatic) and profit-target / planned-exit (discretionary, approve-each by default).
// Rules are evaluated in priority order; the first that triggers wins. No I/O — the
// management loop (position-manager.ts) supplies the view and acts on the decision.

import type { ExecCloseReason, ExecConfig } from '../../shared/types.js';
import { etDateString } from './market-hours.js';

export type ExitClass = 'protective' | 'discretionary';

export interface ExitDecision {
  reason: ExecCloseReason;
  cls: ExitClass;
}

/** The fields the exit rules need from a managed position. */
export interface ManagedPositionView {
  id: number;
  entryNetCredit: number | null; // per-share credit received
  currentMark: number | null; // per-share cost to close now
  openedAt: string; // ISO
  expiry: string; // YYYY-MM-DD (the spread's expiration)
}

/** Calendar days from ET date `a` to date `b` (both YYYY-MM-DD). */
export function daysBetweenDates(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export class ExitPolicy {
  /** First triggered rule wins, protective before discretionary (§3.3). */
  evaluate(pos: ManagedPositionView, config: ExecConfig, now: Date): ExitDecision | null {
    const { entryNetCredit: credit, currentMark: mark } = pos;
    const dte = daysBetweenDates(etDateString(now), pos.expiry);
    const daysHeld = (now.getTime() - Date.parse(pos.openedAt)) / 86_400_000;
    const priced = credit != null && mark != null && credit > 0;

    // 1) Stop — loss reaches stop_multiple × credit (protective).
    if (priced && mark! - credit! >= config.stopMultiple * credit!) {
      return { reason: 'stop', cls: 'protective' };
    }
    // 2) Defensive expiry — close a defined-risk spread near expiry (protective).
    if (dte <= config.defensiveDte) {
      return { reason: 'defensive', cls: 'protective' };
    }
    // 3) Profit target — close at profit_target_pct of the credit (discretionary).
    if (priced && mark! <= credit! * (1 - config.profitTargetPct / 100)) {
      return { reason: 'profit_target', cls: 'discretionary' };
    }
    // 4) Planned/time exit — held long enough, or near a configured DTE (discretionary).
    if (daysHeld >= config.holdDays || (config.timeExitDte > 0 && dte <= config.timeExitDte)) {
      return { reason: 'time_stop', cls: 'discretionary' };
    }
    return null;
  }
}
