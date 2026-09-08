#!/usr/bin/env node
/**
 * Rules on an exception from the command line — NewApp 03 §5, 06 §9.
 *
 *   node packages/core/scripts/exception.mjs list
 *   node packages/core/scripts/exception.mjs show <id>
 *   node packages/core/scripts/exception.mjs ack <id> [note]
 *   node packages/core/scripts/exception.mjs accept <id> <note> [yyyy-mm-dd]
 *   node packages/core/scripts/exception.mjs resolve <id> <kind> <note>
 *   node packages/core/scripts/exception.mjs reuse <id> <ticker> [spliceDate] <note>
 *
 * DEV ONLY, and temporary. The Exceptions workbench (05 §5) is B9; B5's gate
 * needs the operator to rule on ticker-reuse candidates now. It calls the same
 * `core` functions the workbench will, so the UI later wires buttons to
 * behaviour that is already proven rather than being the first place it runs.
 *
 * `reuse` deletes nothing. It closes the membership range at the splice and
 * opens a new one, so a reader intersecting bars with membership sees one
 * entity at a time. The earlier company's bars stay — they are evidence, and no
 * re-fetch could ever separate them anyway, because the provider keys by ticker
 * too.
 */
import {
  checkpointAndClose,
  openGenerationExclusively,
  resolveGenerationPointer
} from './lib/generation-access.mjs';

const core = await import('../dist/index.js');

// Until 2026-09-08 this script resolved the pointer itself — from `homedir()`,
// a third spelling of a path the other two scripts each spelled differently —
// and then called `new Database(dbPath)` directly. So it opened the live
// generation from any shell including a containerised one, while both
// applications had it open, creating the file if it was missing, and ran
// `applyDictionary` against it. Four refusals the other scripts had, and it had
// none of them; they now live in `openGenerationExclusively` so a fourth script
// cannot miss them either.
const { dbPath } = await resolveGenerationPointer();
const db = await openGenerationExclusively(dbPath, 'exception.mjs');

// Apply the dictionary, exactly as both applications do on open. It is additive
// and idempotent, and without it this script cannot work on a generation created
// by an earlier dictionary version — which is the normal case, since the
// generation is opened long before any given table is added.
core.applyDictionary(db);

// The minimum host these operations need: a clock and an identity.
const host = {
  nowET: () => {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(new Date());
    const g = (t) => p.find((x) => x.type === t)?.value ?? '00';
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}-04:00`;
  },
  hostApp: { name: 'exception.mjs', version: 'dev' }
};

const [cmd, ...rest] = process.argv.slice(2);

try {
  switch (cmd) {
    case 'list': {
      const rows = db
        .prepare(
          `SELECT exception_id, check_id, domain, key, severity, state, still_firing, consecutive_runs, detail
             FROM qa_exception
            WHERE state IN ('open','acknowledged','expired_review')
            ORDER BY CASE severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, check_id`
        )
        .all();
      if (rows.length === 0) { console.log('Nothing open.'); break; }
      for (const r of rows) {
        console.log(
          `#${String(r.exception_id).padEnd(4)} ${r.severity.padEnd(8)} ${r.state.padEnd(14)} ` +
            `${r.check_id} ${r.domain}/${r.key}` +
            `${r.still_firing ? '' : '  [no longer observed]'}\n      ${r.detail}`
        );
      }
      break;
    }
    case 'show': {
      const row = db.prepare('SELECT * FROM qa_exception WHERE exception_id = ?').get(Number(rest[0]));
      if (!row) { console.error('No such exception.'); process.exit(1); }
      console.log(JSON.stringify(row, null, 2));
      console.log('\nEvents:');
      for (const e of db.prepare('SELECT at, actor, from_state, to_state, note FROM qa_exception_event WHERE exception_id = ? ORDER BY row_id').all(Number(rest[0]))) {
        console.log(`  ${e.at}  ${e.actor.padEnd(10)} ${e.from_state ?? '-'} -> ${e.to_state}  ${e.note ?? ''}`);
      }
      break;
    }
    case 'ack':
      core.acknowledge(db, host, Number(rest[0]), rest.slice(1).join(' ') || undefined);
      console.log('Acknowledged.');
      break;
    case 'accept': {
      const [id, ...tail] = rest;
      const maybeDate = tail[tail.length - 1];
      const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(maybeDate ?? '');
      const note = (hasDate ? tail.slice(0, -1) : tail).join(' ');
      const until = core.accept(db, host, Number(id), note, hasDate ? maybeDate : undefined);
      console.log(`Accepted until ${until}. It will move to expired_review after that and appear in every email until you rule again.`);
      break;
    }
    case 'resolve':
      core.resolve(db, host, Number(rest[0]), rest[1], rest.slice(2).join(' '));
      console.log('Resolved.');
      break;
    case 'reuse': {
      const [id, ticker, spliceDate, ...note] = rest;
      const r = core.recordTickerReuse(db, host, {
        exceptionId: Number(id), ticker, spliceDate, note: note.join(' ')
      });
      console.log(
        `Recorded. Closed ${r.closed} membership range(s) the day before ${spliceDate} and opened ${r.opened}.\n` +
          'No bars were deleted — a reader intersecting bars with membership now sees one entity at a time.'
      );
      break;
    }
    default:
      console.error(
        'Usage: exception.mjs list | show <id> | ack <id> [note] | accept <id> <note> [until] |\n' +
          '       resolve <id> <data_corrected|provider_fixed|rule_changed|false_positive> <note> |\n' +
          '       reuse <id> <ticker> <spliceDate> <note>'
      );
      process.exit(2);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
} finally {
  // Not `db.close()`. A close is not a checkpoint: measured 2026-09-07, a
  // 918,792-byte WAL was discarded on close with `data.sqlite` byte-for-byte
  // unchanged — the whole write silently lost. `checkpointAndClose` says so when
  // it does not fully apply.
  checkpointAndClose(db);
}
