import type { SqliteLike } from '../db/sqlite-like.js';
import type { CollectorHost } from '../collector/host.js';
import { recomputeDomainDayStatus } from './gate.js';

/**
 * Operator actions on exceptions — 03 §5.1, §6.
 *
 * These are the functions the Exceptions workbench calls at B9. They exist now,
 * with tests, because B5's gate requires the operator to rule on ticker-reuse
 * candidates and the UI is four steps away — building the operations first means
 * the workbench later wires buttons to behaviour that is already proven, rather
 * than being the first place any of it runs.
 *
 * Every one records an actor and a note in `qa_exception_event`. There is no
 * path that changes an exception without leaving that trail (P9).
 */

export type ResolutionKind = 'data_corrected' | 'provider_fixed' | 'rule_changed' | 'false_positive';

/** Default life of an acceptance. An acceptance without an expiry is a decision nobody revisits. */
export const DEFAULT_ACCEPTANCE_DAYS = 30;

export class OperatorActionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorActionRefused';
  }
}

function load(db: SqliteLike, exceptionId: number): {
  exception_id: number; state: string; severity: string; check_id: string; key: string; still_firing: number;
} {
  const row = db
    .prepare('SELECT exception_id, state, severity, check_id, key, still_firing FROM qa_exception WHERE exception_id = ?')
    .get(exceptionId) as
    | { exception_id: number; state: string; severity: string; check_id: string; key: string; still_firing: number }
    | undefined;
  if (!row) throw new OperatorActionRefused(`No exception ${exceptionId}.`);
  return row;
}

function event(
  db: SqliteLike,
  exceptionId: number,
  at: string,
  actor: 'gate' | 'operator' | 'escalation',
  fromState: string,
  toState: string,
  severity: string,
  note: string
): void {
  db.prepare(
    `INSERT INTO qa_exception_event (exception_id, at, actor, from_state, to_state, from_severity, to_severity, note)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(exceptionId, at, actor, fromState, toState, severity, severity, note);
}

/** Stops the ageing clock without claiming anything was fixed. A note is optional. */
export function acknowledge(
  db: SqliteLike,
  host: CollectorHost,
  exceptionId: number,
  note?: string
): void {
  const e = load(db, exceptionId);
  if (e.state !== 'open') {
    throw new OperatorActionRefused(`Only an open exception can be acknowledged; ${exceptionId} is ${e.state}.`);
  }
  const now = host.nowET();
  db.prepare("UPDATE qa_exception SET state = 'acknowledged' WHERE exception_id = ?").run(exceptionId);
  event(db, exceptionId, now, 'operator', e.state, 'acknowledged', e.severity, note ?? 'acknowledged');
}

/**
 * Marks the finding dealt with.
 *
 * **Refused while the check is still firing.** Resolving something the data
 * still says is wrong would put the domain-day back to usable on the strength of
 * an opinion — and the next run would reopen it anyway, so the only lasting
 * effect would be a misleading clean day in between. If the finding is real but
 * tolerable, that is what `accept` is for, and it carries an expiry.
 */
export function resolve(
  db: SqliteLike,
  host: CollectorHost,
  exceptionId: number,
  kind: ResolutionKind,
  note: string,
  opts: { readonly force?: boolean } = {}
): void {
  const e = load(db, exceptionId);
  if (!note.trim()) throw new OperatorActionRefused('A resolution needs a note saying what was done.');
  if (e.state === 'resolved') throw new OperatorActionRefused(`${exceptionId} is already resolved.`);

  if (e.still_firing === 1 && kind !== 'false_positive' && !opts.force) {
    throw new OperatorActionRefused(
      `${e.check_id} on ${e.key} is still firing. Resolving it now would mark the domain-day usable on ` +
        'the strength of an opinion, and the next run would reopen it. Use `accept` (which carries an ' +
        'expiry) if the finding is real but tolerable, or resolve it as `false_positive` if the check ' +
        'is wrong.'
    );
  }

  const now = host.nowET();
  db.prepare(
    `UPDATE qa_exception SET state = 'resolved', resolved_at = ?, resolution_kind = ?, resolution_note = ?
      WHERE exception_id = ?`
  ).run(now, kind, note, exceptionId);
  event(db, exceptionId, now, 'operator', e.state, 'resolved', e.severity, note);
  recomputeAffected(db, host, exceptionId);
}

/**
 * Tolerates a real finding for a bounded time.
 *
 * The note and the expiry are both **required**. The 30-day default is doing
 * real work: it forces periodic re-examination of everything accepted, which is
 * the only thing standing between "we looked at this and decided" and "nobody
 * has looked at this in a year".
 */
export function accept(
  db: SqliteLike,
  host: CollectorHost,
  exceptionId: number,
  note: string,
  until?: string
): string {
  const e = load(db, exceptionId);
  if (!note.trim()) throw new OperatorActionRefused('An acceptance needs a note saying why.');
  if (e.state === 'accepted') throw new OperatorActionRefused(`${exceptionId} is already accepted.`);

  const now = host.nowET();
  const expiry =
    until ??
    new Date(Date.parse(now) + DEFAULT_ACCEPTANCE_DAYS * 86_400_000).toISOString().slice(0, 10);

  db.prepare(
    `UPDATE qa_exception SET state = 'accepted', accepted_at = ?, accepted_note = ?, accepted_until = ?
      WHERE exception_id = ?`
  ).run(now, note, expiry, exceptionId);
  event(db, exceptionId, now, 'operator', e.state, 'accepted', e.severity, `${note} (until ${expiry})`);
  recomputeAffected(db, host, exceptionId);
  return expiry;
}

/**
 * Moves acceptances whose expiry has passed into `expired_review`.
 *
 * **This does not make a domain-day unusable and does not break the clean-day
 * streak** (03 §5.2). An acceptance expiring is a prompt to re-examine a known
 * fact, not the discovery of a new one — the data has not changed. Letting
 * expiry flip a day back would mean an acceptance taken on pilot day 1 resets
 * the streak around day 21 every time, so the 20-day criterion would be defeated
 * by its own escape valve. It blocks promotion instead, and gets its own section
 * in every email until the operator rules.
 */
export function expireAcceptances(db: SqliteLike, host: CollectorHost, today: string): number {
  const due = db
    .prepare(
      `SELECT exception_id, severity, still_firing FROM qa_exception
        WHERE state = 'accepted' AND accepted_until IS NOT NULL AND accepted_until < ?`
    )
    .all(today) as { exception_id: number; severity: string; still_firing: number }[];

  const now = host.nowET();
  for (const e of due) {
    db.prepare("UPDATE qa_exception SET state = 'expired_review' WHERE exception_id = ?").run(e.exception_id);
    event(db, e.exception_id, now, 'gate', 'accepted', 'expired_review', e.severity,
      'acceptance expired — needs a ruling');
  }
  return due.length;
}

/**
 * The operator's ruling on a confirmed ticker reuse — 03 §6, "truncate before
 * splice".
 *
 * **Nothing is truncated.** The bars stay exactly where they are: raw tables are
 * append-only, and deleting the earlier entity's history would destroy evidence
 * to fix an interpretation problem. Instead the membership range is closed at
 * the splice and a new one opened, so a reader asking for this ticker's series
 * intersects with membership validity and gets one entity at a time.
 *
 * That is the difference between the two facts the symbol is carrying: "these
 * bars are wrong" (they are not) and "these bars belong to a different company"
 * (they do). No re-fetch can ever fix the second — the provider keys by ticker
 * too.
 */
export function recordTickerReuse(
  db: SqliteLike,
  host: CollectorHost,
  args: {
    readonly exceptionId: number;
    readonly ticker: string;
    /**
     * First trading date belonging to the NEW entity. **Omit it** and the date
     * is taken from the QC-204 discontinuity for the same ticker, which is where
     * the boundary was actually observed.
     */
    readonly spliceDate?: string;
    readonly note: string;
  }
): { readonly closed: number; readonly opened: number; readonly spliceDate: string } {
  const e = load(db, args.exceptionId);
  if (!args.note.trim()) throw new OperatorActionRefused('Recording a ticker reuse needs a note.');

  // Getting the splice date wrong by one day is easy and its consequence is
  // silent: one bar of the new company stays in the old entity's range, and
  // nothing complains. The date is already known — QC-204 keys its finding by
  // `TICKER YYYY-MM-DD` at the exact boundary — so the default is that observed
  // date rather than the operator's recollection of it.
  const spliceDate = args.spliceDate ?? inferSpliceDate(db, args.ticker);
  if (!spliceDate) {
    throw new OperatorActionRefused(
      `No splice date given and no QC-204 discontinuity for ${args.ticker} to take one from. ` +
        'Pass the first trading date belonging to the new entity explicitly.'
    );
  }

  const now = host.nowET();
  const open = db
    .prepare(
      `SELECT row_id, list_source, valid_from FROM ref_universe_membership
        WHERE ticker = ? AND valid_to IS NULL`
    )
    .all(args.ticker) as { row_id: number; list_source: string; valid_from: string }[];

  if (open.length === 0) {
    throw new OperatorActionRefused(
      `${args.ticker} has no open membership row to close; nothing to splice.`
    );
  }

  const dayBefore = new Date(Date.parse(`${spliceDate}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);

  let opened = 0;
  const write = db.transaction(() => {
    for (const row of open) {
      // Closing the range is the one edit a membership row permits. Everything
      // else about it stays frozen.
      db.prepare(
        `UPDATE ref_universe_membership SET valid_to = ?, change_reason = 'ticker_change' WHERE row_id = ?`
      ).run(dayBefore, row.row_id);

      const template = db
        .prepare('SELECT run_id, as_of_date, capture_rule_id, source_response_id FROM ref_universe_membership WHERE row_id = ?')
        .get(row.row_id) as { run_id: number; as_of_date: string; capture_rule_id: number | null; source_response_id: number };

      db.prepare(
        `INSERT INTO ref_universe_membership (
           run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
           ticker, list_source, valid_from, valid_to, change_reason, predecessor_ticker
         ) VALUES (?,?,?,?,?,?,?,?,NULL,'ticker_change',?)`
      ).run(
        template.run_id, template.as_of_date, now, template.capture_rule_id, template.source_response_id,
        args.ticker, row.list_source, spliceDate, args.ticker
      );
      opened++;
    }

    db.prepare(
      `UPDATE qa_exception SET state = 'resolved', resolved_at = ?, resolution_kind = 'data_corrected',
              resolution_note = ? WHERE exception_id = ?`
    ).run(now, `ticker reuse confirmed, series split at ${spliceDate}: ${args.note}`, args.exceptionId);
  });
  write();

  event(db, args.exceptionId, now, 'operator', e.state, 'resolved', e.severity,
    `ticker reuse confirmed; membership closed ${dayBefore} and reopened ${spliceDate}. ${args.note}`);
  recomputeAffected(db, host, args.exceptionId);

  return { closed: open.length, opened, spliceDate };
}

/**
 * The date QC-204 observed the step, from its exception key (`TICKER YYYY-MM-DD`).
 *
 * The discontinuity check keys its finding at the first bar of the new regime,
 * which is exactly the first trading date belonging to the new entity.
 */
function inferSpliceDate(db: SqliteLike, ticker: string): string | undefined {
  const row = db
    .prepare(
      `SELECT key FROM qa_exception
        WHERE check_id = 'QC-204' AND key LIKE ? || ' %'
        ORDER BY last_seen_run_id DESC LIMIT 1`
    )
    .get(ticker) as { key: string } | undefined;
  const date = row?.key.split(' ')[1];
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

function recomputeAffected(db: SqliteLike, host: CollectorHost, exceptionId: number): void {
  const row = db
    .prepare('SELECT affects_trading_dates_json FROM qa_exception WHERE exception_id = ?')
    .get(exceptionId) as { affects_trading_dates_json: string } | undefined;
  if (!row) return;
  for (const date of JSON.parse(row.affects_trading_dates_json) as string[]) {
    recomputeDomainDayStatus(db, host, null, date);
  }
}

/** The blocking findings still awaiting a ruling — B5's gate reads this. */
export function reviewQueue(
  db: SqliteLike
): readonly { readonly exceptionId: number; readonly checkId: string; readonly key: string; readonly detail: string; readonly state: string }[] {
  return (
    db
      .prepare(
        `SELECT exception_id, check_id, key, detail, state FROM qa_exception
          WHERE severity = 'blocking' AND state IN ('open', 'acknowledged')
          ORDER BY check_id, key`
      )
      .all() as { exception_id: number; check_id: string; key: string; detail: string; state: string }[]
  ).map((r) => ({
    exceptionId: r.exception_id, checkId: r.check_id, key: r.key, detail: r.detail, state: r.state
  }));
}
