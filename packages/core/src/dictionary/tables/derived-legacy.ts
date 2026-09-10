import { col, nullable, withStatus, type TableEntry } from '../types.js';
import { defineTable } from '../standard-columns.js';

/**
 * External series, the one stage-1 derived table, and the legacy record —
 * 02 §13 and §14.
 *
 * The `legacy_` tables are **segregated by design**: no foreign key reaches from
 * them into a `raw_` table, and joins happen only inside an explicit study. They
 * record what the existing application decided, including everything it
 * rejected — because a pipeline that stores only survivors cannot answer whether
 * its ranking was any good, which is precisely the question the existing app's
 * `daily_briefs` could not be made to answer.
 */

const LEGACY_MODES = ['wheel', 'buy', 'options', 'bullish', 'bearish'] as const;

export const derivedLegacyTables: readonly TableEntry[] = [
  defineTable({
    table: 'ext_iv_history',
    layer: 'ext',
    domain: 'iv',
    description:
      'One-time external IV history (Q17), loaded so IV rank has a usable window before our own ' +
      'computed series is long enough. Readers use these rows only **before** the stitch date on ' +
      '`meta_generation`; from that date `derived_iv30_daily` takes over.',
    naturalKey: ['ticker', 'date'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: true,
    columns: [
      col.ident('ticker', 'The ticker symbol.'),
      col.date('date', 'The day the value is for.'),
      col.fraction('iv30', 'The source\'s 30-day constant-maturity at-the-money IV, as a fraction.'),
      col.text('source', 'Which vendor supplied the series. One value for the whole table — a mixed-provenance history would make the stitch meaningless.'),
      col.text('method_note', 'The source\'s published method, **verbatim**. Two vendors\' "30-day ATM IV" are not the same number, and the difference is only recoverable if the method travels with the data.'),
      col.int('load_run_id', 'The one-shot run that loaded this row.', { references: { table: 'meta_run', column: 'run_id' } }),
      col.flag(
        'accepted',
        '`0` until the overlap has been checked and the operator has accepted the series (04 §7.3). ' +
          '**Loading is not accepting**: nothing reads an unaccepted row, and rank computes from ' +
          '`derived_iv30_daily` alone reporting its declared gap, exactly as if no bootstrap had been ' +
          'bought. Written `0` explicitly by the loader rather than defaulted, so the distinction is ' +
          'visible at the one place that could blur it.',
        { sourceProvider: 'collector' }
      ),
      nullable(
        col.ts('accepted_at', 'When the series was accepted.'),
        'not accepted — the overlap is not yet sufficient, or the operator has not ruled'
      ),
      nullable(
        col.text(
          'accepted_note',
          'Why it was accepted. **Required on acceptance**, because acceptance over a disagreement ' +
            'QC-908 flagged is a judgement, and a judgement with no recorded reason is indistinguishable ' +
            'from nobody having looked.'
        ),
        'not accepted'
      )
    ],
    // The narrow exception the append-only guard exists to allow: the IV value
    // is a fact and stays frozen; whether we have decided to *read* it is
    // learned later. Everything else about the row still refuses an edit.
    mutableColumns: ['accepted', 'accepted_at', 'accepted_note'],
    indexes: [{ columns: ['ticker', 'date'] }]
  }),

  defineTable({
    table: 'derived_iv30_daily',
    layer: 'derived',
    domain: 'iv',
    description:
      'The **only** derived table in stage 1, so IV rank has a clean own-computed history from day ' +
      'one. A pure function of `raw_option_contract_snapshot` (P4): variance-time interpolation ' +
      'between the two expirations bracketing 30 calendar days, at-the-money taken as the strikes ' +
      'bracketing `underlying_price`, mid-IV of call and put. Its inputs are stored alongside the ' +
      'output so the number can be recomputed and checked rather than trusted.',
    naturalKey: ['ticker', 'as_of_date'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: true,
    columns: [
      col.ident('ticker', 'The ticker symbol.', { sourceProvider: 'derived_at_ingestion' }),
      ...withStatus(col.fraction('iv30', 'Own-computed 30-day constant-maturity ATM IV, as a fraction.', { sourceProvider: 'derived_at_ingestion' }), { statuses: ['ok', 'omitted', 'invalid'] }),
      nullable(col.date('near_expiration', 'The nearer bracketing expiration.'), 'not computed — see `iv30_status`'),
      nullable(col.date('far_expiration', 'The further bracketing expiration.'), 'not computed — see `iv30_status`'),
      nullable(col.fraction('near_iv', 'ATM IV at the nearer expiration.'), 'not computed — see `iv30_status`'),
      nullable(col.fraction('far_iv', 'ATM IV at the further expiration.'), 'not computed — see `iv30_status`'),
      col.int('derivation_version', 'Which version of the derivation produced this row (P4). A change in method is a new version, never a silent recompute.', { sourceProvider: 'derived_at_ingestion' }),
      col.enumOf('status', ['ok', 'insufficient_expirations', 'no_atm_quotes'], 'Why the value is what it is. A declared gap, never a guess — `insufficient_expirations` is an answer, an interpolated number would not be.', { sourceProvider: 'derived_at_ingestion' })
    ],
    indexes: [{ columns: ['ticker', 'as_of_date'] }]
  }),

  defineTable({
    table: 'legacy_brief_run',
    layer: 'legacy',
    domain: 'legacy_brief',
    description: 'One row per daily brief the existing application produced.',
    naturalKey: ['legacy_run_id'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: true,
    columns: [
      col.ident('legacy_run_id', 'The existing app\'s own identifier for the run.', { sourceProvider: 'legacy_app' }),
      col.date('trading_date', 'The day the brief was for.', { sourceProvider: 'legacy_app' }),
      col.enumOf('slot', ['morning', 'after_close'], 'Which of the existing app\'s two daily slots produced it. **Both are recorded**: the existing app emailed a pick from each but stored only the evening one, so the morning pick the operator actually read was produced from data destroyed hours later.', { sourceProvider: 'legacy_app' }),
      col.text('legacy_app_version', 'The existing app\'s version at the time.', { sourceProvider: 'legacy_app' }),
      nullable(col.ident('brief_id', 'The existing app\'s brief row id.'), 'the hand-off carried no brief id'),
      nullable(col.ts('emailed_at', 'When the brief was emailed.'), 'not emailed'),
      col.flag('pre_collector', '`1` for rows brought in by the one-time backward import, `0` for rows handed over live. The two have different reliability and must never be pooled silently.', { sourceProvider: 'collector' })
    ],
    indexes: [{ columns: ['trading_date', 'slot'] }]
  }),

  defineTable({
    table: 'legacy_brief_candidate',
    layer: 'legacy',
    domain: 'legacy_brief',
    description:
      '**Every ticker considered**, not just those that survived. This is the table that exists ' +
      'because the existing app persisted only survivors, so no study could ever ask whether its ' +
      'ranking separated winners from losers — the losers are the data that question needs.',
    naturalKey: ['legacy_run_id', 'ticker', 'mode'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: true,
    columns: [
      col.ident('legacy_run_id', 'The brief run.', { sourceProvider: 'legacy_app' }),
      col.ident('ticker', 'The ticker considered.', { sourceProvider: 'legacy_app' }),
      col.enumOf('mode', LEGACY_MODES, 'Which analysis mode considered it.', { sourceProvider: 'legacy_app' }),
      col.int('considered_rank', 'Where it placed in the mode\'s ranking.', { sourceProvider: 'legacy_app' }),
      col.flag('survived', 'Whether it survived to the brief.', { sourceProvider: 'legacy_app' }),
      ...withStatus(col.fraction('composite_score', 'The scoring engine\'s composite, normalised 0-100 and stored as a fraction.', { sourceProvider: 'legacy_app', converter: 'scoreToFraction' })),
      nullable(col.text('final_disposition', 'What ultimately happened to the candidate.'), 'no disposition was recorded by the existing app')
    ],
    indexes: [
      { columns: ['legacy_run_id', 'mode'] },
      { columns: ['ticker', 'as_of_date'] }
    ]
  }),

  defineTable({
    table: 'legacy_brief_candidate_gate',
    layer: 'legacy',
    domain: 'legacy_brief',
    description:
      'Each gate a candidate was tested against, with the value tested and the threshold applied. ' +
      'Recording both is what makes a gate auditable: the existing app shipped a conviction gate ' +
      'whose tested quantity could never approach its threshold, and it rejected 0 of 39 eligible ' +
      'picks over 62 briefs without anyone noticing — a gate that never fires is indistinguishable ' +
      'from a gate nothing violates unless the distribution is stored.',
    naturalKey: ['candidate_row_id', 'gate_name'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: true,
    columns: [
      col.int('candidate_row_id', 'The candidate this gate was applied to.', { references: { table: 'legacy_brief_candidate', column: 'row_id' }, sourceProvider: 'collector' }),
      col.text('gate_name', 'The gate\'s name in the existing app.', { sourceProvider: 'legacy_app' }),
      col.flag('passed', 'Whether the candidate passed.', { sourceProvider: 'legacy_app' }),
      ...withStatus(col.providerDefined('tested_value', 'gate_name', 'The value the gate measured. Stored unconverted: the unit varies per gate, and `gate_name` is what says which.', { sourceProvider: 'legacy_app' })),
      ...withStatus(col.providerDefined('threshold', 'gate_name', 'The threshold in force at the time, in the same unit as `tested_value`. Storing both is what makes a gate auditable: the *ratio* of the two over real data is how you learn whether a check can fire at all.', { sourceProvider: 'legacy_app' })),
      nullable(col.text('reason', 'The gate\'s own explanation.'), 'the gate recorded no explanation')
    ],
    indexes: [{ columns: ['candidate_row_id'] }, { columns: ['gate_name'] }]
  }),

  defineTable({
    table: 'legacy_brief_candidate_signal',
    layer: 'legacy',
    domain: 'legacy_brief',
    description:
      'Each scoring signal\'s raw and normalised value with its weight. Storing the **normalised** ' +
      'value beside the raw one is what makes a normalisation artefact visible: in the existing app ' +
      'one signal\'s curve pinned its median at 9.6/100, so "the pick\'s weakest reading" was a ' +
      'property of the curves rather than of the pick, on 60 % of picks.',
    naturalKey: ['candidate_row_id', 'signal_key'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: true,
    columns: [
      col.int('candidate_row_id', 'The candidate this signal was computed for.', { references: { table: 'legacy_brief_candidate', column: 'row_id' }, sourceProvider: 'collector' }),
      col.text('signal_key', 'The signal\'s name in the existing app.', { sourceProvider: 'legacy_app' }),
      ...withStatus(col.providerDefined('raw_value', 'signal_key', 'The signal value before normalisation. The unit varies per signal, and `signal_key` is what says which.', { sourceProvider: 'legacy_app' })),
      ...withStatus(col.fraction('normalized_value', 'The value after the signal\'s normalisation curve, as a fraction of full scale.', { sourceProvider: 'legacy_app', converter: 'scoreToFraction' })),
      col.fraction('weight', 'The signal\'s weight in the composite, as a fraction.', { sourceProvider: 'legacy_app', converter: 'scoreToFraction' }),
      col.flag('enabled', 'Whether the signal was enabled in the configuration at the time.', { sourceProvider: 'legacy_app' })
    ],
    indexes: [{ columns: ['candidate_row_id'] }, { columns: ['signal_key'] }]
  }),

  defineTable({
    table: 'legacy_brief_leg',
    layer: 'legacy',
    domain: 'legacy_brief',
    description:
      'The option legs as priced **at decision time**. These are frozen quotes, and a later split ' +
      'repair on `raw_daily_bar` makes them *more* wrong rather than less: the two then sit on ' +
      'different price scales, and settling a stored strike against a repaired close manufactured ' +
      '-$168,516 of fiction from four rows in the existing app. Any harness reading these must carry ' +
      'a scale guard comparing the strike to the underlying close on the pick date.',
    naturalKey: ['candidate_row_id', 'leg_index'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: true,
    columns: [
      col.int('candidate_row_id', 'The candidate this leg belongs to.', { references: { table: 'legacy_brief_candidate', column: 'row_id' }, sourceProvider: 'collector' }),
      col.int('leg_index', 'Position within the structure.', { sourceProvider: 'legacy_app' }),
      col.ident('osi_symbol', 'OCC contract symbol.', { sourceProvider: 'legacy_app' }),
      col.enumOf('right', ['call', 'put'], 'Call or put.', { sourceProvider: 'legacy_app' }),
      col.perShare('strike', 'Strike price as recommended.', { sourceProvider: 'legacy_app' }),
      col.date('expiration_date', 'Contract expiration.', { sourceProvider: 'legacy_app' }),
      ...withStatus(col.perShare('bid', 'Bid at decision time.', { sourceProvider: 'legacy_app' })),
      ...withStatus(col.perShare('ask', 'Ask at decision time.', { sourceProvider: 'legacy_app' })),
      ...withStatus(col.perShare('mid', 'Mid at decision time.', { sourceProvider: 'legacy_app' })),
      ...withStatus(col.fraction('iv', 'Implied volatility at decision time, as a fraction.', { sourceProvider: 'legacy_app', converter: 'percentToFractionIfNeeded' })),
      ...withStatus(col.fraction('delta', 'Delta at decision time.', { sourceProvider: 'legacy_app' })),
      ...withStatus(col.int('open_interest', 'Open interest at decision time.', { sourceProvider: 'legacy_app' })),
      ...withStatus(col.int('volume', 'Contracts traded at decision time. The existing app coerced "not reported" to 0 on 23 of 250 legs; the hand-off must distinguish them, which is what the status column is for.', { sourceProvider: 'legacy_app' })),
      ...withStatus(col.int('liquidity_score', 'The existing app\'s 0-15 liquidity score. Not comparable between the day\'s two slots — its volume component is a same-day counter, so the morning run sees an hour of tape and the evening run sees all of it.', { sourceProvider: 'legacy_app' }))
    ],
    indexes: [{ columns: ['candidate_row_id'] }, { columns: ['osi_symbol'] }]
  }),

  defineTable({
    table: 'legacy_dice_selection',
    layer: 'legacy',
    domain: 'legacy_brief',
    description:
      'The Roll-the-Dice selection, with the size of the eligible set it chose from. The count matters ' +
      'more than it looks: measured on the existing app, 27 of 34 pick-days (79 %) had exactly one ' +
      'candidate survive the gates, so the selection rule faced no choice at all on most days. A ' +
      'selection rule can only matter as often as it has something to choose between.',
    naturalKey: ['legacy_run_id'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: true,
    columns: [
      col.ident('legacy_run_id', 'The brief run.', { sourceProvider: 'legacy_app' }),
      col.int('eligible_count', 'How many candidates survived the gates and were available to choose from.', { sourceProvider: 'legacy_app' }),
      nullable(col.int('selected_candidate_row_id', 'The candidate selected.', { references: { table: 'legacy_brief_candidate', column: 'row_id' } }), 'nothing was eligible, so nothing was selected'),
      col.text('selection_rule', 'Which rule made the choice.', { sourceProvider: 'legacy_app' }),
      col.json('eligibility_trace_json', 'Why each candidate was or was not eligible.', { sourceProvider: 'legacy_app' })
    ],
    indexes: [{ columns: ['legacy_run_id'] }]
  }),

  defineTable({
    table: 'legacy_critic_verdict',
    layer: 'legacy',
    domain: 'legacy_brief',
    description:
      'The LLM critic\'s verdict on a candidate, **with the exact context object it was given**. ' +
      'Storing the context is not optional here: the critic has no live feed, so its output is a ' +
      'function of that object alone — and a context change measured after the fact turned 8 passes ' +
      'into 0. Without the stored context that is unattributable.',
    naturalKey: ['candidate_row_id'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: true,
    columns: [
      col.int('candidate_row_id', 'The candidate judged.', { references: { table: 'legacy_brief_candidate', column: 'row_id' }, sourceProvider: 'collector' }),
      col.text('verdict', 'The verdict as returned.', { sourceProvider: 'legacy_app' }),
      col.text('rationale', 'The model\'s stated reasoning.', { sourceProvider: 'legacy_app' }),
      col.json('context_json', 'The exact context object the model was given.', { sourceProvider: 'legacy_app' }),
      col.text('model', 'Which model produced the verdict.', { sourceProvider: 'legacy_app' })
    ],
    indexes: [{ columns: ['candidate_row_id'] }]
  }),

  defineTable({
    table: 'legacy_import_log',
    layer: 'legacy',
    domain: 'legacy_import',
    description:
      'What the one-time backward import read, wrote and **rejected** (Q19). The rejection report is ' +
      'the point: an import that silently drops rows is indistinguishable from one that had nothing to ' +
      'import.',
    naturalKey: ['import_run_id', 'source_table'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: true,
    columns: [
      col.int('import_run_id', 'The import run.', { references: { table: 'meta_run', column: 'run_id' }, sourceProvider: 'collector' }),
      col.text('source_table', 'Which table in the existing app was read.', { sourceProvider: 'collector' }),
      col.int('rows_read', 'Rows read from the source.', { sourceProvider: 'collector' }),
      col.int('rows_written', 'Rows written here.', { sourceProvider: 'collector' }),
      col.int('rows_rejected', 'Rows the dictionary validation refused.', { sourceProvider: 'collector' }),
      col.json('rejection_report_json', 'Why each rejected row was refused — listed, never summarised away.', { sourceProvider: 'collector' })
    ],
    indexes: [{ columns: ['import_run_id'] }]
  }),

  defineTable({
    table: 'legacy_config_import',
    layer: 'legacy',
    domain: 'legacy_import',
    description:
      'The existing app\'s configuration brought across as data (Q19 category 1): watchlists, ' +
      'conviction stocks and their bands, the ETF list, scoring configurations, screen presets, payoff ' +
      'strategies. One row per imported item, each validated against this dictionary before it lands.',
    naturalKey: ['config_kind', 'config_key', 'import_run_id'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: true,
    columns: [
      col.int('import_run_id', 'The import run.', { references: { table: 'meta_run', column: 'run_id' }, sourceProvider: 'collector' }),
      col.enumOf('config_kind', ['watchlist', 'conviction_stock', 'conviction_band', 'etf_list', 'scoring_config', 'screen_preset', 'payoff_strategy'], 'Which category of configuration.', { sourceProvider: 'collector' }),
      col.text('config_key', 'The item\'s identity within its category.', { sourceProvider: 'legacy_app' }),
      col.json('payload_json', 'The item itself.', { sourceProvider: 'legacy_app' }),
      col.text('origin', 'Always `legacy_import` — stamped so an imported item can never be mistaken for one created here.', { sourceProvider: 'collector' })
    ],
    indexes: [{ columns: ['config_kind', 'config_key'] }]
  })
];
