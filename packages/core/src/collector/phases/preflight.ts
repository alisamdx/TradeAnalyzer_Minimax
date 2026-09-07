import type { SqliteLike } from '../../db/sqlite-like.js';
import type { CollectorHost } from '../host.js';
import { captureResponse } from '../capture.js';
import type { RunHandle } from '../run.js';
import { ensureTradingCalendar } from '../trading-calendar.js';

/**
 * Phase 0 — preflight (04 §2.1).
 *
 * Four cheap checks before anything expensive. The important design choice is
 * what preflight is **allowed to stop**: only a non-trading day and a closed
 * generation. A failing provider probe does *not* abort the run — the phases
 * that need it will fail individually and the gate will say which, which is a
 * far more useful answer than "the whole run refused to start".
 */

export type PreflightOutcome =
  | { readonly proceed: false; readonly reason: 'non_trading_day' | 'generation_closed'; readonly detail: string }
  | {
      readonly proceed: true;
      readonly etrade: 'ok' | 'unavailable';
      readonly etradeDetail: string | null;
      readonly generationNo: number;
      readonly generationStatus: string;
    };

export function isTradingDay(db: SqliteLike, date: string): boolean | undefined {
  const row = db.prepare('SELECT is_trading_day FROM ref_trading_day WHERE date = ?').get(date) as
    | { is_trading_day: number }
    | undefined;
  return row ? row.is_trading_day === 1 : undefined;
}

export async function runPreflight(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly requireCalendar?: boolean } = {}
): Promise<PreflightOutcome> {
  host.progress('preflight', 0, 3);

  // 0. The calendar seeds itself, before it is read.
  //
  //    It lives here rather than in a one-shot because the fail-open rule below
  //    is load-bearing and dangerous in exactly one direction: an unseeded
  //    calendar does not stop the run, it makes every Saturday and every
  //    holiday look like a trading day. The collector would then write
  //    weekend-dated snapshots of Friday's data, and the watchdog would email
  //    "no daily run" every weekend until nobody read it. A calendar that
  //    exists only if somebody remembered to seed it is one that will be
  //    missing on the day it matters.
  ensureTradingCalendar(db, host, run.tradingDate);

  // 1. Trading day. An unknown date is treated as a trading day rather than a
  //    holiday: refusing to collect because the calendar has not been seeded
  //    would turn a missing reference table into silent data loss, and a
  //    needless run costs calls while a skipped one costs a day that cannot be
  //    recovered. With the seed above this is now a fallback for dates outside
  //    the generated range rather than the normal path.
  const trading = isTradingDay(db, run.tradingDate);
  if (trading === false) {
    return {
      proceed: false,
      reason: 'non_trading_day',
      detail: `${run.tradingDate} is not a trading day.`
    };
  }
  if (trading === undefined && opts.requireCalendar) {
    return {
      proceed: false,
      reason: 'non_trading_day',
      detail: `${run.tradingDate} is not in ref_trading_day and the calendar was required.`
    };
  }

  // 2. The generation must be writable.
  const generation = db
    .prepare('SELECT generation_no, status FROM meta_generation ORDER BY generation_no DESC LIMIT 1')
    .get() as { generation_no: number; status: string } | undefined;
  if (!generation) {
    return { proceed: false, reason: 'generation_closed', detail: 'No generation row exists.' };
  }
  if (generation.status === 'closed') {
    return {
      proceed: false,
      reason: 'generation_closed',
      detail: `Generation ${generation.generation_no} is closed; open a new one before collecting.`
    };
  }

  host.progress('preflight', 1, 3, 'probing E*Trade');

  // 3. One SPY quote through the host's renew-and-retry transport. Archived like
  //    any other response, because "we could not reach the provider" is a fact
  //    about the day worth keeping — the existing app was blind to exactly this
  //    for 23 versions.
  let etrade: 'ok' | 'unavailable' = 'unavailable';
  let etradeDetail: string | null = null;
  try {
    const probe = await host.etradeGet('/v1/market/quote/SPY', {});
    captureResponse({
      host,
      db,
      runId: run.runId,
      asOfDate: run.tradingDate,
      provider: 'etrade',
      endpoint: '/v1/market/quote/SPY',
      slug: 'preflight-probe',
      params: {},
      response: probe,
      captureRuleId: null
    });
    if (probe.status !== null && probe.status >= 200 && probe.status < 300) etrade = 'ok';
    else {
      etradeDetail =
        probe.error ??
        `HTTP ${String(probe.status)} — ${probe.body.slice(0, 200)}`;
    }
  } catch (err) {
    etradeDetail = err instanceof Error ? err.message : String(err);
  }

  host.progress('preflight', 3, 3);

  return {
    proceed: true,
    etrade,
    etradeDetail,
    generationNo: generation.generation_no,
    generationStatus: generation.status
  };
}
