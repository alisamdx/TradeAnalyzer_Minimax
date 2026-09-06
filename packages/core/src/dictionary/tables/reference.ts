import { col, nullable, withStatus, type TableEntry } from '../types.js';
import { defineTable } from '../standard-columns.js';

/**
 * Reference and membership — 02 §2.
 *
 * Slowly-changing facts stored as **validity ranges**, never overwritten: a
 * departure closes `valid_to` and a new row opens. That is what lets a study
 * ask "who was in the universe on 2026-03-14" a year later and get the answer
 * that was true then, not the answer that is true now.
 */

const STICKY_REASONS = ['held_in_book', 'recommended_by_legacy', 'study_flag'] as const;

export const referenceTables: readonly TableEntry[] = [
  defineTable({
    table: 'ref_universe_membership',
    layer: 'ref',
    domain: 'universe',
    description:
      'Which tickers are in the universe and why, as validity ranges. Expected current members ' +
      '~1,089 — measured 2026-09-05 as the *union* of sp500 (503), russell1000 (1,024) and etf (60). ' +
      'The lists overlap almost entirely; their sum is 1,587, which is the figure discovery recorded ' +
      'and every section inherited until it was measured.',
    naturalKey: ['ticker', 'list_source', 'valid_from'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('ticker', 'The ticker symbol.'),
      col.enumOf('list_source', ['sp500', 'russell1000', 'etf_list', 'manual'], 'Which list put this ticker in the universe. A ticker in two lists has two rows.'),
      col.date('valid_from', 'First day of membership.'),
      nullable(col.date('valid_to', 'Last day of membership.'), 'currently a member'),
      col.enumOf('change_reason', ['initial', 'index_add', 'index_drop', 'ticker_change', 'delisted', 'manual'], 'Why membership started or ended.'),
      nullable(col.ident('predecessor_ticker', 'The symbol this ticker was renamed from.'), 'no rename involved')
    ],
    indexes: [
      { columns: ['ticker', 'valid_from'] },
      { columns: ['valid_to'] },
      { columns: ['ticker'], where: 'valid_to IS NULL' }
    ]
  }),

  defineTable({
    table: 'raw_ticker_reference',
    layer: 'raw',
    domain: 'universe',
    description:
      'Point-in-time reference facts. A row is appended when any field differs from the latest ' +
      'stored row for the ticker, or every 30 days as a heartbeat, so "as known on day X" is always ' +
      'well defined.',
    naturalKey: ['ticker', 'observed_at'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('ticker', 'The ticker symbol.', { sourceProvider: 'polygon', sourceField: 'ticker' }),
      col.text('name', 'Company or fund name.', { sourceProvider: 'polygon', sourceField: 'name' }),
      col.text('security_type', 'Polygon\'s `type` stored verbatim — `CS`, `ETF`, `ADRC`, and so on. Not mapped to our own vocabulary, so a new provider value shows up as itself rather than as a silent miscategorisation.', { sourceProvider: 'polygon', sourceField: 'type' }),
      nullable(col.text('primary_exchange', 'Listing exchange.', { sourceProvider: 'polygon', sourceField: 'primary_exchange' }), 'omitted by the provider'),
      nullable(col.ident('sic_code', 'SEC Standard Industrial Classification code.', { sourceProvider: 'polygon', sourceField: 'sic_code' }), 'omitted by the provider — ETFs have none'),
      nullable(col.text('sic_description', 'The SIC code in words.', { sourceProvider: 'polygon', sourceField: 'sic_description' }), 'omitted by the provider — ETFs have none'),
      nullable(col.text('sector', 'Sector, derived at ingestion from `sic_code` through the versioned `ref_sic_sector` mapping — the mapping is data, not code, so a re-classification is a new mapping version rather than a code change.', { sourceProvider: 'derived_at_ingestion' }), 'no mapping exists for this SIC code'),
      ...withStatus(col.usd('market_cap', 'Market capitalisation.', { sourceProvider: 'polygon', sourceField: 'market_cap' })),
      ...withStatus({
        column: 'shares_outstanding', type: 'INTEGER', unit: 'count', nullable: false,
        description: 'Shares outstanding. `weighted_shares_outstanding` where available, else `share_class_shares_outstanding`; which one was used is in `shares_source`. The fallback is proven live on our plan (>= 95.8 % of the universe, measured 2026-09-06), so this column populates regardless of how the primary resolves.',
        sourceProvider: 'polygon', sourceField: 'weighted_shares_outstanding'
      }),
      nullable(col.enumOf('shares_source', ['weighted', 'share_class'], 'Which Polygon field `shares_outstanding` came from. Two different quantities wearing one column name is exactly how a share count goes quietly wrong, so the choice is recorded per row.', { sourceProvider: 'derived_at_ingestion' }), 'no share count was available'),
      nullable(col.ident('cik', 'SEC filer identifier, zero-padded to 10.', { sourceProvider: 'polygon', sourceField: 'cik', converter: 'zeroPadCik' }), 'not an SEC filer'),
      nullable(col.ident('composite_figi', 'Composite FIGI.', { sourceProvider: 'polygon', sourceField: 'composite_figi' }), 'omitted by the provider'),
      nullable(col.date('list_date', 'When the security was first listed.', { sourceProvider: 'polygon', sourceField: 'list_date' }), 'omitted by the provider'),
      col.flag('active', 'Whether the provider considers the ticker active.', { sourceProvider: 'polygon', sourceField: 'active' }),
      ...withStatus(col.flag('optionable', 'Whether the ticker lists options, derived at ingestion from the E*Trade expirations call returning at least one expiration.', { sourceProvider: 'derived_at_ingestion' }), { statuses: ['ok', 'omitted', 'outside_window'] })
    ],
    indexes: [{ columns: ['ticker', 'observed_at'] }]
  }),

  defineTable({
    table: 'ref_sic_sector',
    layer: 'ref',
    domain: 'universe',
    description:
      'SIC code to sector mapping, versioned. The mapping is **data, not code**: a re-classification ' +
      'is a new version with its own validity range, so a sector assigned last year stays explicable ' +
      'even after the mapping changes.',
    naturalKey: ['sic_code', 'mapping_version'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.int('row_id', 'Surrogate key.', { primaryKey: true, sourceProvider: 'collector' }),
      col.ident('sic_code', 'The SIC code.', { sourceProvider: 'operator' }),
      col.text('sector', 'The sector it maps to.', { sourceProvider: 'operator' }),
      col.int('mapping_version', 'Version of the mapping table this row belongs to.', { sourceProvider: 'operator' }),
      col.ts('valid_from', 'When this version took effect.', { sourceProvider: 'collector' }),
      nullable(col.ts('valid_to', 'When it was superseded.'), 'this is the version currently in force')
    ],
    indexes: [{ columns: ['sic_code', 'mapping_version'], unique: true }]
  }),

  defineTable({
    table: 'ref_chain_subset_membership',
    layer: 'ref',
    domain: 'chain_subset',
    description:
      'Which tickers get option chains pulled, and why (Q15). Membership is **sticky**: a ticker that ' +
      'falls below the admission threshold is not removed, because a series that stops mid-study is ' +
      'worse than one that costs a few extra calls. `removal_reason` therefore has no ' +
      '`fell_below_threshold` value at all.',
    naturalKey: ['ticker', 'valid_from'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('ticker', 'The ticker symbol.'),
      col.date('valid_from', 'First day in the subset.'),
      nullable(col.date('valid_to', 'Last day in the subset.'), 'currently in the subset'),
      col.enumOf('membership_reason', ['rule_pass', 'sticky_ticker', 'held_in_book', 'recommended_by_legacy', 'study_flag', 'manual'], 'Why this ticker is in the subset.'),
      col.int('rule_capture_rule_id', 'The subset rule version that admitted it.', { references: { table: 'meta_capture_rule', column: 'capture_rule_id' } }),
      col.json('rule_inputs_json', 'The measured values at admission — close, 20-day average dollar volume — so the decision stays auditable after the rule changes. The admitting rule is `close >= $10` and `20d average dollar volume >= $233M`, measured 2026-09-05; the originally drafted $20M sat at the **1st percentile** and admitted 97.2 % of tickers, i.e. it could not select.'),
      nullable(col.enumOf('removal_reason', ['delisted', 'not_optionable', 'manual'], 'Why the ticker left the subset. Never "fell below the threshold" — membership is sticky.'), 'still in the subset')
    ],
    indexes: [
      { columns: ['ticker', 'valid_from'] },
      { columns: ['ticker'], where: 'valid_to IS NULL' }
    ]
  }),

  defineTable({
    table: 'ref_sticky_contract',
    layer: 'ref',
    domain: 'chain_subset',
    description:
      'Individual contracts pinned into capture regardless of the rule (Q2.3) — a contract held in the ' +
      'book, recommended by the legacy app, or flagged for a study keeps being captured to expiry even ' +
      'if its underlying leaves the subset.',
    naturalKey: ['osi_symbol', 'valid_from'],
    appendOnly: true,
    ruleDriven: false,
    standardColumns: true,
    columns: [
      col.ident('osi_symbol', 'The OCC contract symbol — the contract\'s identity across days.'),
      col.ident('ticker', 'Underlying ticker.'),
      col.date('expiration_date', 'Contract expiration.'),
      col.enumOf('reason', [...STICKY_REASONS, 'manual'], 'Why the contract is pinned.'),
      col.date('valid_from', 'First day pinned.'),
      nullable(col.date('valid_to', 'Last day pinned — the expiration date at the latest.'), 'still pinned'),
      nullable(col.text('origin_ref', 'What caused the pin, e.g. `legacy_brief_leg.row_id` or `raw_account_position_snapshot.row_id`.'), 'pinned manually, with no originating row')
    ],
    indexes: [
      { columns: ['osi_symbol'] },
      { columns: ['osi_symbol'], where: 'valid_to IS NULL' }
    ]
  }),

  defineTable({
    table: 'ref_trading_day',
    layer: 'ref',
    domain: 'calendar',
    description:
      'Every calendar day from five years back to two years forward, marked trading or not. The ' +
      'expected-count model in 03 reads this: no bars are expected on a non-trading day, so without ' +
      'it every holiday would look like a collection failure.',
    naturalKey: ['date'],
    appendOnly: false,
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.date('date', 'The calendar day.', { primaryKey: true, sourceProvider: 'nyse_rules' }),
      col.flag('is_trading_day', 'Whether the US equity market opened.', { sourceProvider: 'nyse_rules' }),
      nullable(col.text('early_close_time', 'Early close in ET, e.g. `13:00`.'), 'a normal session, or not a trading day'),
      nullable(col.text('holiday_name', 'The holiday\'s name.'), 'not a holiday'),
      col.flag('is_monthly_expiration', 'Third Friday, or the preceding Thursday when that Friday is a holiday.', { sourceProvider: 'nyse_rules' }),
      col.enumOf('source', ['nyse_rules', 'polygon_marketstatus', 'manual'], 'Where this day\'s status came from. Seeded from exchange rules, refreshed yearly from Polygon for unscheduled closures.', { sourceProvider: 'collector' }),
      col.ts('observed_at', 'When this row was written or last confirmed.', { sourceProvider: 'collector' })
    ],
    indexes: [{ columns: ['is_trading_day'] }]
  }),

  defineTable({
    table: 'ref_macro_series',
    layer: 'ref',
    domain: 'calendar',
    description:
      'The index symbols quoted daily into `raw_index_quote` — VIX first, VIX3M and VVIX as later ' +
      'additions. A configured list rather than a constant, so adding a series is data, not a release.',
    naturalKey: ['symbol'],
    appendOnly: false,
    ruleDriven: false,
    standardColumns: false,
    columns: [
      col.ident('symbol', 'The provider symbol to quote.', { primaryKey: true, sourceProvider: 'operator' }),
      col.text('description', 'What the series is.', { sourceProvider: 'operator' }),
      col.fraction('sane_min', 'Lower bound of the ingestion sanity check; a value outside the range is stored as `invalid`, never silently.', { sourceProvider: 'operator' }),
      col.fraction('sane_max', 'Upper bound of the ingestion sanity check.', { sourceProvider: 'operator' }),
      col.flag('enabled', 'Whether the series is quoted on each run.', { sourceProvider: 'operator' }),
      col.ts('added_at', 'When the series was added.', { sourceProvider: 'collector' })
    ],
    indexes: []
  })
];
