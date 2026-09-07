import { col, nullable, type TableEntry } from '../types.js';
import { defineTable } from '../standard-columns.js';

/**
 * The quality gate's tables — 03 §4.
 *
 * The gate decides, after every run, whether what was just stored may be
 * trusted. It runs inside the collector, on the same run, before the run is
 * marked complete.
 *
 * The column that carries the most weight here is `qa_check_result
 * .distribution_json`. Evaluated and fired counts identify a check that never
 * fires, but they cannot say whether its threshold is in the right place — a
 * check that fires zero times looks identical whether the boundary sits in an
 * empty gap or a mile past every real value. Recording only fires would
 * reproduce the conviction-band failure at the level of the gate itself: a
 * boundary nobody can see the distance to.
 */

const SEVERITIES = ['info', 'warning', 'blocking'] as const;

export const qaTables: readonly TableEntry[] = [
  defineTable({
    table: 'qa_check_registry',
    layer: 'qa',
    domain: 'registry',
    description:
      'Every check as a registered object with a stable id, generated from code at startup. ' +
      'Checks are code with identity (03 §1.1): the registry is what lets the inspector list every ' +
      'check, its fire history and its last change, and it is why a threshold is stored data rather ' +
      'than a literal in a condition.',
    naturalKey: ['check_id', 'registry_version'],
    appendOnly: true,
    validRangeColumn: 'valid_to',
    // The definition is frozen; the instrumentation accumulates. Everything not
    // named here still refuses an edit, so a threshold change is a new version
    // and never a quiet overwrite of what a past result was measured against.
    mutableColumns: ['evaluated_total', 'fired_total', 'first_fired_at', 'last_fired_at'],
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.int('row_id', 'Surrogate key.', { primaryKey: true, sourceProvider: 'collector' }),
      col.ident('check_id', 'Stable identifier, `QC-nnn`.', { sourceProvider: 'collector' }),
      col.text('domain', 'Which domain the check belongs to.', { sourceProvider: 'collector' }),
      col.enumOf('default_severity', SEVERITIES, 'The severity a finding starts at, before any escalation.', { sourceProvider: 'collector' }),
      col.text('description', 'What the check looks for, in the operator\'s words.', { sourceProvider: 'collector' }),
      col.json('reads_tables_json', 'Which tables the check reads. A check may only read (03 §1.1); remediation is a separate enumerated step.', { sourceProvider: 'collector' }),
      nullable(
        col.text('tested_quantity', 'The name of the magnitude this check compares against its threshold — `abs_close_change_pct`, `volume_regime_ratio`, `missing_ticker_fraction`.'),
        'the check tests a predicate, not a magnitude — QC-001 through QC-005 are true or false, a row either has provenance or it does not'
      ),
      nullable(
        col.text('tested_unit', 'The unit of that magnitude, from the dictionary\'s vocabulary.'),
        'the check tests a predicate, so there is no magnitude to have a unit'
      ),
      col.json('thresholds_json', 'The thresholds in force. Changing one creates a new registry version rather than editing this row.', { sourceProvider: 'collector' }),
      col.int('registry_version', 'Version of this check\'s definition.', { sourceProvider: 'collector' }),
      col.ts('valid_from', 'When this version took effect.', { sourceProvider: 'collector' }),
      nullable(col.ts('valid_to', 'When it was superseded.'), 'this is the version currently in force'),
      col.int('evaluated_total', 'How many times this check has evaluated anything, ever. Half of the P10 instrumentation.', { sourceProvider: 'collector' }),
      col.int('fired_total', 'How many times it has fired, ever. A check with a large `evaluated_total` and zero here is either a clean system or a decorative check, and only the distribution can tell you which.', { sourceProvider: 'collector' }),
      nullable(col.ts('first_fired_at', 'When it first fired.'), 'it has never fired'),
      nullable(col.ts('last_fired_at', 'When it last fired.'), 'it has never fired')
    ],
    indexes: [
      { columns: ['check_id', 'registry_version'], unique: true },
      { columns: ['check_id'], where: 'valid_to IS NULL' }
    ]
  }),

  defineTable({
    table: 'qa_quality_report',
    layer: 'qa',
    domain: 'report',
    description: 'One row per run: the gate\'s verdict, the per-domain table the email shows, and whether the email got out.',
    naturalKey: ['run_id'],
    appendOnly: true,
    // The report's content is a fact about the run and is frozen. Whether the
    // email got out is learned a moment later, and is not knowable when the row
    // is written — so those three columns, and only those, may be filled in.
    mutableColumns: ['email_sent_at', 'email_status', 'email_error'],
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.int('report_id', 'Surrogate key.', { primaryKey: true, sourceProvider: 'collector' }),
      col.int('run_id', 'The run this report covers.', { references: { table: 'meta_run', column: 'run_id' }, sourceProvider: 'collector' }),
      col.ts('generated_at', 'When the gate finished.', { sourceProvider: 'collector' }),
      col.enumOf('overall', ['green', 'amber', 'red'], 'No findings, warnings only, or any blocking.', { sourceProvider: 'collector' }),
      col.json('domains_json', 'Per domain: expected, stored, status. The table the email prints.', { sourceProvider: 'collector' }),
      col.json('checks_json', 'Per check: evaluated, fired, duration. The queryable form is `qa_check_result`.', { sourceProvider: 'collector' }),
      nullable(col.ts('email_sent_at', 'When the status email went out.'), 'the email has not been sent'),
      col.enumOf('email_status', ['pending', 'sent', 'failed', 'suppressed'], 'How the send went. Never `suppressed` in stage 1 — an email after **every** run, including green ones, is what makes silence meaningful (P9).', { sourceProvider: 'collector' }),
      nullable(col.text('email_error', 'Why the send failed.'), 'the send did not fail')
    ],
    indexes: [{ columns: ['run_id'] }]
  }),

  defineTable({
    table: 'qa_check_result',
    layer: 'qa',
    domain: 'report',
    description:
      'One row per (run, check). This is where P10 is taken literally: a check that compares a ' +
      'magnitude records that magnitude\'s **distribution over every evaluation**, fired or not, and ' +
      'the keys carrying the largest values. The rows nearest the boundary are the evidence a ' +
      'threshold review needs, and they are exactly the ones a fired-only record throws away.',
    naturalKey: ['run_id', 'check_id'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.int('row_id', 'Surrogate key.', { primaryKey: true, sourceProvider: 'collector' }),
      col.int('run_id', 'The run this result belongs to.', { references: { table: 'meta_run', column: 'run_id' }, sourceProvider: 'collector' }),
      col.ident('check_id', 'Which check produced it.', { sourceProvider: 'collector' }),
      col.int('registry_version', 'Which version of the check definition ran.', { sourceProvider: 'collector' }),
      col.int('evaluated_count', 'How many things the check looked at this run.', { sourceProvider: 'collector' }),
      col.int('fired_count', 'How many of them fired.', { sourceProvider: 'collector' }),
      col.int('duration_ms', 'How long the check took.', { sourceProvider: 'collector' }),
      col.json('sample_keys_json', 'Up to 20 offending keys, for the inspector.', { sourceProvider: 'collector' }),
      nullable(
        col.json('distribution_json', 'Summary statistics of the tested quantity over every evaluation: `{ n, min, p50, p90, p99, max, threshold, nearBoundary }`, where `nearBoundary` counts evaluations within 25 % of the threshold. **This is what makes a threshold reviewable** — without it, a check that never fires is indistinguishable from a check that cannot fire.'),
        'the check tests a predicate rather than a magnitude, so there is no distribution — the registry declares `tested_quantity` null for exactly these'
      ),
      nullable(
        col.json('extreme_keys_json', 'Up to 20 keys with the **largest** tested values, whether or not any fired.'),
        'the check tests a predicate, so there is no magnitude to rank by'
      )
    ],
    indexes: [
      { columns: ['run_id', 'check_id'], unique: true },
      { columns: ['check_id'] }
    ]
  }),

  defineTable({
    table: 'qa_exception',
    layer: 'qa',
    domain: 'exception',
    description:
      'One row per distinct finding, **persistent across runs**. A finding is a fact about the data, ' +
      'not about the run: if the same condition is still true tomorrow it is the *same* exception, ' +
      'which is what lets it age, escalate, and be resolved deliberately rather than by going quiet.',
    naturalKey: ['fingerprint'],
    appendOnly: false,
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.int('exception_id', 'Surrogate key.', { primaryKey: true, sourceProvider: 'collector' }),
      { column: 'fingerprint', type: 'TEXT', unit: 'sha256', nullable: false, unique: true, description: 'sha1 of check id, domain and key — the identity that makes tomorrow\'s recurrence the same exception rather than a new one.', sourceProvider: 'collector' },
      col.ident('check_id', 'Which check found it.', { sourceProvider: 'collector' }),
      col.text('domain', 'Which domain it concerns.', { sourceProvider: 'collector' }),
      col.text('key', 'What it is about — ticker, osi_symbol, order id, or date (03 §5.3).', { sourceProvider: 'collector' }),
      col.enumOf('severity', SEVERITIES, 'Current severity, after any escalation. It never drops automatically.', { sourceProvider: 'collector' }),
      col.enumOf('base_severity', SEVERITIES, 'The check\'s default at creation, kept so an escalation is visible as one.', { sourceProvider: 'collector' }),
      col.enumOf('state', ['open', 'acknowledged', 'resolved', 'accepted', 'expired_review'], 'Where it stands in the lifecycle (03 §5.1).', { sourceProvider: 'collector' }),
      col.text('detail', 'One line, for a human.', { sourceProvider: 'collector' }),
      col.json('evidence_json', 'The offending values — expected against actual.', { sourceProvider: 'collector' }),
      col.int('first_seen_run_id', 'The run that first raised it.', { sourceProvider: 'collector' }),
      col.int('last_seen_run_id', 'The most recent run in which it fired.', { sourceProvider: 'collector' }),
      col.int('consecutive_runs', 'How many runs in a row it has fired while open. Three promotes it one severity level.', { sourceProvider: 'collector' }),
      col.json('remediations_json', 'Every automatic remediation attempted, with its outcome (03 §6).', { sourceProvider: 'collector' }),
      nullable(col.ts('resolved_at', 'When it was resolved.'), 'not resolved'),
      nullable(col.text('resolution_note', 'What was done.'), 'not resolved'),
      nullable(col.enumOf('resolution_kind', ['data_corrected', 'provider_fixed', 'rule_changed', 'false_positive'], 'How it was resolved.'), 'not resolved'),
      nullable(col.ts('accepted_at', 'When it was accepted.'), 'not accepted'),
      nullable(col.text('accepted_note', 'Why it was accepted. Required on acceptance.'), 'not accepted'),
      nullable(col.date('accepted_until', 'When the acceptance expires. **Required** — an acceptance without an expiry is a decision nobody revisits.'), 'not accepted'),
      col.json('affects_trading_dates_json', 'The domain-days this exception makes unusable.', { sourceProvider: 'collector' }),
      col.flag('still_firing', 'Whether the fingerprint fired in the most recent run. An exception that stops firing without a remediation stays **open** and is listed as "no longer observed, unresolved" — because "it went away" is exactly how the earnings-date bug hid.', { sourceProvider: 'collector' })
    ],
    indexes: [
      { columns: ['fingerprint'], unique: true },
      { columns: ['state', 'severity'] },
      { columns: ['check_id'] },
      { columns: ['last_seen_run_id'] }
    ]
  }),

  defineTable({
    table: 'qa_exception_event',
    layer: 'qa',
    domain: 'exception',
    description:
      'Append-only audit trail of every state or severity change. Who changed what, when, and why — ' +
      'the record that makes P9 checkable rather than aspirational.',
    naturalKey: ['exception_id', 'at'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.int('row_id', 'Surrogate key.', { primaryKey: true, sourceProvider: 'collector' }),
      col.int('exception_id', 'The exception.', { references: { table: 'qa_exception', column: 'exception_id' }, sourceProvider: 'collector' }),
      col.ts('at', 'When the change happened.', { sourceProvider: 'collector' }),
      col.enumOf('actor', ['gate', 'operator', 'escalation'], 'Who made the change. The gate may only resolve when a remediation succeeded and the fingerprint evaluates clean — never merely because it stopped firing.', { sourceProvider: 'collector' }),
      nullable(col.text('from_state', 'State before.'), 'the exception was created by this event'),
      col.text('to_state', 'State after.', { sourceProvider: 'collector' }),
      nullable(col.text('from_severity', 'Severity before.'), 'the exception was created by this event'),
      col.text('to_severity', 'Severity after.', { sourceProvider: 'collector' }),
      nullable(col.text('note', 'Why the change was made, in the words of whoever made it.'), 'no note was given — permitted on acknowledge, required on accept')
    ],
    indexes: [{ columns: ['exception_id', 'at'] }]
  }),

  defineTable({
    table: 'qa_domain_day_status',
    layer: 'qa',
    domain: 'status',
    description:
      '**The only table a downstream consumer may read to decide whether to use a day\'s data.** ' +
      'Recomputed whenever an exception changes state, which is why it is not stored on the run: ' +
      'a `meta_run.usable` column would be correct for exactly one day and then drift every time an ' +
      'exception was resolved — the same denormalisation trap that let a stale earnings date ' +
      'suppress its own corrections.',
    naturalKey: ['domain', 'trading_date'],
    appendOnly: false,
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.int('row_id', 'Surrogate key.', { primaryKey: true, sourceProvider: 'collector' }),
      col.text('domain', 'The domain.', { sourceProvider: 'collector' }),
      col.date('trading_date', 'The trading day.', { sourceProvider: 'collector' }),
      col.enumOf('status', ['usable', 'usable_with_warnings', 'unusable', 'not_run'], '`not_run` is set for every domain-day the calendar expected but no run covered — the watchdog writes it, so a dead scheduler shows as an explicit gap rather than as an absence of rows.', { sourceProvider: 'collector' }),
      col.int('blocking_open', 'Open or acknowledged blocking exceptions on this domain-day.', { sourceProvider: 'collector' }),
      col.int('warning_open', 'Open or acknowledged warnings on this domain-day.', { sourceProvider: 'collector' }),
      col.ts('computed_at', 'When this verdict was last recomputed.', { sourceProvider: 'collector' }),
      nullable(col.int('by_run_id', 'The run that last recomputed it.'), 'recomputed by an operator action rather than by a run')
    ],
    indexes: [
      { columns: ['domain', 'trading_date'], unique: true },
      { columns: ['trading_date'] }
    ]
  })
];
