import { createHash } from 'node:crypto';
import type { SqliteLike } from '../db/sqlite-like.js';
import type { CollectorHost, OperatorHost } from './host.js';
import { archiveResponse } from './archive.js';
import { indexAndIngest } from './capture.js';
import { OperatorActionRefused } from '../qa/operator.js';
import { COLLECTOR_VERSION } from '../version.js';
import { DICTIONARY_VERSION } from '../dictionary/index.js';

/**
 * Pin a contract for study — 05 §4.2 (B9c).
 *
 * A pinned contract is captured every day to its expiry even if its underlying
 * leaves the chain subset (Q2.3), which is what a study of one contract's life
 * needs. The chain phase already reads every open `ref_sticky_contract` row;
 * this only adds the operator's way in.
 *
 * **Provenance is recorded, not waived.** `ref_sticky_contract` carries the
 * standard columns, so every row names a run and a response. A pin has no
 * provider response — but it does have a cause: the operator's request. So the
 * request itself is archived as a `host_app` response under an operator run,
 * and the sticky row points at it — the same resolution the legacy import used
 * (the rows it read ARE the source). Making the columns nullable for this one
 * reason would have been a constraint change a populated generation cannot
 * take, and would have written "no provenance" into a table where every other
 * row has it.
 *
 * The request is archived with **no recipe**: it was not parsed from anything,
 * so a replay counts it as having no parser to re-run, which is true.
 */

export type ArchivingOperatorHost = OperatorHost & Pick<CollectorHost, 'archiveRoot' | 'encryptForArchive'>;

export interface StudyPin {
  readonly osiSymbol: string;
  readonly ticker: string;
  readonly expirationDate: string;
  readonly reason: string;
  readonly validFrom: string;
  readonly originRef: string | null;
}

/** A completed run of kind `manual` for one operator act — never resumed, never shared. */
function operatorRun(db: SqliteLike, host: OperatorHost, tradingDate: string, now: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO meta_run (
           run_kind, slot, trading_date, started_at, finished_at, status,
           host_app, host_version, collector_version, dictionary_version
         ) VALUES ('manual', 'after_close', ?, ?, ?, 'complete', ?, ?, ?, ?)`
      )
      .run(tradingDate, now, now, host.hostApp.name, host.hostApp.version, COLLECTOR_VERSION, DICTIONARY_VERSION)
      .lastInsertRowid
  );
}

/** Archives an operator's request and indexes it, returning its response id. Archive first, as always. */
function archiveRequest(
  db: SqliteLike,
  host: ArchivingOperatorHost,
  args: { readonly runId: number; readonly tradingDate: string; readonly now: string; readonly action: string; readonly body: Readonly<Record<string, unknown>> }
): number {
  const endpoint = `operator/${args.action}`;
  const params = { action: args.action };
  const body = JSON.stringify({ ...args.body, requestedAt: args.now, requestedBy: `${host.hostApp.name} ${host.hostApp.version}` });
  const response = { status: 200, body, requestedAt: args.now, respondedAt: args.now };
  const location = archiveResponse(host, {
    provider: 'host_app',
    asOfDate: args.tradingDate,
    slug: `operator-${args.action}`,
    id: `${args.runId}-operator-${args.action}`,
    params,
    response
  });
  const paramsJson = JSON.stringify(params);
  const result = indexAndIngest({
    db,
    now: args.now,
    runId: args.runId,
    asOfDate: args.tradingDate,
    provider: 'host_app',
    endpoint,
    paramsJson,
    response,
    location,
    dedupHash: createHash('sha256').update(`host_app\n${endpoint}\n${paramsJson}\n${body}`).digest('hex'),
    encrypted: false,
    atProviderCap: false,
    captureRuleId: null
  });
  return result.sourceResponseId;
}

function openStudyPin(db: SqliteLike, osiSymbol: string): { row_id: number; valid_from: string } | undefined {
  return db
    .prepare(
      `SELECT row_id, valid_from FROM ref_sticky_contract
        WHERE osi_symbol = ? AND reason = 'study_flag' AND valid_to IS NULL
        ORDER BY row_id DESC LIMIT 1`
    )
    .get(osiSymbol) as { row_id: number; valid_from: string } | undefined;
}

export function pinForStudy(
  db: SqliteLike,
  host: ArchivingOperatorHost,
  args: { readonly osiSymbol: string; readonly note: string }
): StudyPin {
  const note = args.note.trim();
  if (note === '') throw new OperatorActionRefused('A study pin needs a note saying what the study is.');

  const contract = db
    .prepare(
      `SELECT ticker, expiration_date FROM raw_option_contract_snapshot
        WHERE osi_symbol = ? ORDER BY observed_at DESC LIMIT 1`
    )
    .get(args.osiSymbol) as { ticker: string; expiration_date: string } | undefined;
  if (!contract) {
    // Pinned from what was captured, so ticker and expiry come from a stored
    // row rather than from parsing the symbol — a wrong OSI string does not
    // throw, it pins a contract the chain phase never matches.
    throw new OperatorActionRefused(`${args.osiSymbol} has never been captured, so there is nothing to pin.`);
  }

  const now = host.nowET();
  const today = now.slice(0, 10);
  if (contract.expiration_date < today) {
    throw new OperatorActionRefused(`${args.osiSymbol} expired on ${contract.expiration_date}; there is nothing left to capture.`);
  }
  const existing = openStudyPin(db, args.osiSymbol);
  if (existing) throw new OperatorActionRefused(`${args.osiSymbol} is already pinned for study since ${existing.valid_from}.`);

  const runId = operatorRun(db, host, today, now);
  let sourceResponseId = 0;
  const write = db.transaction(() => {
    sourceResponseId = archiveRequest(db, host, {
      runId, tradingDate: today, now, action: 'study-pin', body: { osiSymbol: args.osiSymbol, note }
    });
    db.prepare(
      `INSERT INTO ref_sticky_contract
         (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
          osi_symbol, ticker, expiration_date, reason, valid_from, origin_ref)
       VALUES (?,?,?,NULL,?,?,?,?, 'study_flag', ?, ?)`
    ).run(
      runId, today, now, sourceResponseId, args.osiSymbol, contract.ticker, contract.expiration_date, today,
      `meta_response.source_response_id=${sourceResponseId}`
    );
  });
  write();

  return {
    osiSymbol: args.osiSymbol,
    ticker: contract.ticker,
    expirationDate: contract.expiration_date,
    reason: 'study_flag',
    validFrom: today,
    originRef: `meta_response.source_response_id=${sourceResponseId}`
  };
}

/**
 * Ends a study pin today. The request is archived too — the row can record only
 * WHEN the range closed, so the archive is where WHY lives.
 */
export function unpinStudy(
  db: SqliteLike,
  host: ArchivingOperatorHost,
  args: { readonly osiSymbol: string; readonly note: string }
): void {
  const note = args.note.trim();
  if (note === '') throw new OperatorActionRefused('Ending a study pin needs a note saying why.');
  const open = openStudyPin(db, args.osiSymbol);
  if (!open) throw new OperatorActionRefused(`${args.osiSymbol} is not pinned for study.`);

  const now = host.nowET();
  const today = now.slice(0, 10);
  const runId = operatorRun(db, host, today, now);
  const write = db.transaction(() => {
    archiveRequest(db, host, { runId, tradingDate: today, now, action: 'study-unpin', body: { osiSymbol: args.osiSymbol, note } });
    // Closing the validity range is the one edit the table's trigger permits.
    db.prepare('UPDATE ref_sticky_contract SET valid_to = ? WHERE row_id = ?').run(today, open.row_id);
  });
  write();
}

/** Every open pin on a contract, whatever its reason — held, recommended, or studied. */
export function openPins(db: SqliteLike, osiSymbol: string): readonly StudyPin[] {
  const rows = db
    .prepare(
      `SELECT osi_symbol, ticker, expiration_date, reason, valid_from, origin_ref FROM ref_sticky_contract
        WHERE osi_symbol = ? AND valid_to IS NULL ORDER BY valid_from`
    )
    .all(osiSymbol) as {
    osi_symbol: string; ticker: string; expiration_date: string; reason: string; valid_from: string; origin_ref: string | null;
  }[];
  return rows.map((r) => ({
    osiSymbol: r.osi_symbol, ticker: r.ticker, expirationDate: r.expiration_date, reason: r.reason,
    validFrom: r.valid_from, originRef: r.origin_ref
  }));
}
