import type { SqliteLike } from '../db/sqlite-like.js';
import type { CollectorHost } from './host.js';
import { captureResponse } from './capture.js';
import { recipes } from '../ingest/recipes.js';
import { beginRun, finishRun, captureRuleId } from './run.js';
import {
  stickyRowsFor,
  legacyRunId,
  type LegacyBriefHandoff
} from '../ingest/legacy-brief.js';

/**
 * The legacy brief hand-off — 04 §8, Q6.
 *
 * The existing app's brief job calls this at the end of a run with what it
 * already holds in memory. **It must not change what the brief decides or
 * emails** (D1), so every failure here is a collector problem and never a brief
 * problem — the caller wraps it and swallows.
 *
 * The payload is archived as a `meta_response` from provider `host_app`, which
 * buys three things at once: `legacy_*` rows get the same provenance column
 * every raw row has (AC-1), the hand-off replays like any other capture (AC-4),
 * and the original payload survives even if the parse is later found wrong.
 */

export const LEGACY_HANDOFF_RULE = {
  scope: 'every_scored_candidate',
  includesLosers: true,
  ivUnit: 'fraction'
} as const;

export interface LegacyHandoffResult {
  readonly runId: number;
  readonly legacyRunId: string;
  readonly candidates: number;
  readonly rowsWritten: number;
  readonly stickyPinned: number;
  readonly parseStatus: string;
}

/**
 * Writes one brief's record into the generation.
 *
 * Everything lands in a single transaction — the archive index, the
 * `legacy_*` rows and the sticky pins together — so a recommended contract is
 * pinned whether the brief ran before or after that day's collection.
 */
export function writeLegacyHandoff(
  host: CollectorHost,
  payload: LegacyBriefHandoff
): LegacyHandoffResult {
  const db: SqliteLike = host.openGenerationDb();
  const run = beginRun(db, host, { kind: 'manual', tradingDate: payload.tradingDate });

  try {
    const ruleId = captureRuleId(
      db,
      host,
      'legacy_handoff',
      LEGACY_HANDOFF_RULE,
      'Every candidate the existing app scored, including the ones it rejected.'
    );

    const body = JSON.stringify(payload);
    const observedAt = host.nowET();

    let stickyPinned = 0;

    const write = db.transaction(() => {
      const result = captureResponse({
        host,
        db,
        runId: run.runId,
        asOfDate: payload.tradingDate,
        provider: 'host_app',
        endpoint: 'legacy/brief-handoff',
        slug: 'legacy-brief-handoff',
        params: { slot: payload.slot, briefId: String(payload.briefId ?? '') },
        response: {
          status: 200,
          body,
          requestedAt: observedAt,
          respondedAt: observedAt
        },
        captureRuleId: ruleId,
        recipe: recipes.legacyBrief()
      });

      stickyPinned = pinSticky(db, payload, {
        runId: run.runId,
        asOfDate: payload.tradingDate,
        observedAt,
        captureRuleId: ruleId,
        sourceResponseId: result.sourceResponseId
      });

      return result;
    });

    const result = write();
    finishRun(db, host, run, 'complete');

    return {
      runId: run.runId,
      legacyRunId: legacyRunId(payload),
      candidates: payload.candidates.length,
      rowsWritten: result.rowsWritten,
      stickyPinned,
      parseStatus: result.parseStatus
    };
  } catch (err) {
    finishRun(db, host, run, 'failed');
    throw err;
  }
}

/**
 * Pins each recommended contract, **skipping the ones already pinned**.
 *
 * This lives in the writer rather than in the ingest module because it depends
 * on what is already in the table, and an ingestion module gets no database
 * handle by design (P11). The split is deliberate: the `legacy_*` facts must
 * replay byte-identically from a fixture, while a sticky pin is current state
 * and re-pinning an open one would leave two open ranges for one contract —
 * which is precisely the ambiguity the validity range exists to prevent.
 */
function pinSticky(
  db: SqliteLike,
  payload: LegacyBriefHandoff,
  ctx: {
    runId: number;
    asOfDate: string;
    observedAt: string;
    captureRuleId: number | null;
    sourceResponseId: number;
  }
): number {
  const already = db.prepare(
    'SELECT 1 AS present FROM ref_sticky_contract WHERE osi_symbol = ? AND valid_to IS NULL LIMIT 1'
  );
  const insert = db.prepare(
    `INSERT INTO ref_sticky_contract
       (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
        osi_symbol, ticker, expiration_date, reason, valid_from, valid_to, origin_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  );

  let pinned = 0;
  for (const row of stickyRowsFor(payload, ctx)) {
    if (already.get(row['osi_symbol']) !== undefined) continue;
    insert.run(
      ctx.runId,
      ctx.asOfDate,
      ctx.observedAt,
      ctx.captureRuleId,
      ctx.sourceResponseId,
      row['osi_symbol'],
      row['ticker'],
      row['expiration_date'],
      row['reason'],
      row['valid_from'],
      row['origin_ref']
    );
    pinned += 1;
  }
  return pinned;
}
