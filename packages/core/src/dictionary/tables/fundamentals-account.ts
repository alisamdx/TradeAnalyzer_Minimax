import { col, nullable, withStatus, type TableEntry } from '../types.js';
import { defineTable } from '../standard-columns.js';

/**
 * Fundamentals, the operator's account, macro series and the sentiment domains —
 * 02 §9 through §12.
 *
 * Fundamentals are stored in the honest raw form the SEC publishes: **facts**,
 * not statements. Statements, TTM roll-forwards and ratios are derived in stage 2
 * and reproducible from these rows.
 *
 * The account tables are written through the existing masked-key transport and
 * their archive files are encrypted (P15, Q20). No derived P&L exists in stage 1
 * — the existing app reconstructed P&L by inference and got five positions wrong
 * in both directions, reading the book at -$2,902 when it was +$3,983.
 */

const OPTION_LEG_COLUMNS = (source: string) => [
  nullable(col.ident('osi_symbol', 'OCC contract symbol, built from the product fields.', { sourceProvider: 'etrade', sourceField: `${source}.Product`, converter: 'buildOsiSymbol' }), 'not an option — this is a stock line'),
  nullable(col.enumOf('right', ['call', 'put'], 'Call or put.', { sourceProvider: 'etrade', sourceField: `${source}.Product.callPut`, converter: 'etradeRightToEnum' }), 'not an option — this is a stock line'),
  nullable(col.perShare('strike', 'Strike price.', { sourceProvider: 'etrade', sourceField: `${source}.Product.strikePrice` }), 'not an option — this is a stock line'),
  nullable(col.date('expiration_date', 'Contract expiration.', { sourceProvider: 'etrade', sourceField: `${source}.Product.expiryYear/Month/Day`, converter: 'etradeExpiryToDate' }), 'not an option — this is a stock line')
];

export const fundamentalsAccountTables: readonly TableEntry[] = [
  defineTable({
    table: 'raw_edgar_filing',
    layer: 'raw',
    domain: 'fundamentals',
    description: 'Filings index from EDGAR submissions. A new 10-K or 10-Q here is what triggers a facts pull.',
    naturalKey: ['accession_no'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('cik', 'SEC filer identifier, zero-padded to 10.', { sourceProvider: 'edgar' }),
      col.ident('ticker', 'The ticker this CIK maps to in our universe.', { sourceProvider: 'derived_at_ingestion' }),
      col.ident('accession_no', 'The filing\'s accession number.', { sourceProvider: 'edgar', unique: true }),
      col.text('form', 'Form type — `10-K`, `10-Q`, `8-K`, `20-F`, and so on.', { sourceProvider: 'edgar' }),
      col.date('filed_date', 'When it was filed.', { sourceProvider: 'edgar' }),
      nullable(col.date('report_date', 'The period the filing reports on.', { sourceProvider: 'edgar' }), 'omitted by the provider'),
      nullable(col.text('primary_doc', 'The primary document\'s filename.', { sourceProvider: 'edgar' }), 'omitted by the provider')
    ],
    indexes: [
      { columns: ['cik', 'filed_date'] },
      { columns: ['accession_no'], unique: true }
    ]
  }),

  defineTable({
    table: 'raw_edgar_fact',
    layer: 'raw',
    domain: 'fundamentals',
    description:
      'XBRL company facts from EDGAR — the honest raw form. A **restated value in a later filing is a ' +
      'new row**, not an edit, so a study can ask what was known at the time as easily as what is ' +
      'known now.',
    naturalKey: ['cik', 'taxonomy', 'concept', 'unit', 'period_end', 'fiscal_period', 'accession_no'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('cik', 'SEC filer identifier, zero-padded to 10.', { sourceProvider: 'edgar' }),
      col.enumOf('taxonomy', ['us-gaap', 'dei', 'ifrs-full', 'srt', 'invest'], 'Which taxonomy the concept belongs to.', { sourceProvider: 'edgar' }),
      col.ident('concept', 'The concept name verbatim — `Revenues`, `NetIncomeLoss`, `Assets`. Never mapped to our own vocabulary at capture; mapping is a stage-2 derivation with its own version.', { sourceProvider: 'edgar' }),
      col.text('unit', 'The unit verbatim — `USD`, `shares`, `USD/shares`, `pure`.', { sourceProvider: 'edgar' }),
      col.providerDefined('value', 'unit', 'The reported value, in whatever the `unit` column says. Stored unconverted precisely because the unit varies per concept — one table legitimately holds USD, shares, USD/shares and pure numbers, and declaring a single unit for all of them would be a lie the inspector then renders as a badge.', { sourceProvider: 'edgar' }),
      nullable(col.date('period_start', 'Start of the reporting period.', { sourceProvider: 'edgar' }), 'an instant (balance-sheet) fact — it has a point in time, not a period'),
      col.date('period_end', 'End of the reporting period, or the instant.', { sourceProvider: 'edgar' }),
      col.int('fiscal_year', 'Fiscal year.', { sourceProvider: 'edgar', sourceField: 'fy' }),
      col.text('fiscal_period', 'Fiscal period — `FY`, `Q1` and so on.', { sourceProvider: 'edgar', sourceField: 'fp' }),
      col.text('form', 'The form the fact was reported on.', { sourceProvider: 'edgar' }),
      col.date('filed_date', 'When that form was filed.', { sourceProvider: 'edgar' }),
      col.ident('accession_no', 'The filing this value came from — what makes a restatement traceable.', { sourceProvider: 'edgar' }),
      nullable(col.text('frame', 'The SEC\'s deduplicated calendar frame.', { sourceProvider: 'edgar' }), 'omitted by the provider')
    ],
    indexes: [
      { columns: ['cik', 'concept', 'period_end'] },
      { columns: ['accession_no'] }
    ]
  }),

  defineTable({
    table: 'raw_account_position_snapshot',
    layer: 'raw',
    domain: 'account',
    description:
      'One row per position per run. A position that vanishes is detected by **comparing snapshots**, ' +
      'never by deleting a row — which is what lets the history say when it went and what it was worth ' +
      'the last time it was seen.',
    naturalKey: ['account_key_hash', 'symbol', 'as_of_date', 'observed_at'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      { column: 'account_key_hash', type: 'TEXT', unit: 'sha256', nullable: false, description: 'SHA-256 of `accountIdKey`. The key itself is never stored (P15).', sourceProvider: 'derived_at_ingestion' },
      col.ident('symbol', 'The position\'s symbol.', { sourceProvider: 'etrade', sourceField: 'Product.symbol' }),
      col.text('security_type', 'E*Trade\'s `securityType` verbatim — `EQ`, `OPTN`.', { sourceProvider: 'etrade', sourceField: 'Product.securityType' }),
      ...OPTION_LEG_COLUMNS('Position'),
      col.int('quantity', 'Position size, **signed** — short is negative, signed from `positionType`.', { sourceProvider: 'etrade', sourceField: 'quantity', converter: 'signQuantityByPositionType' }),
      col.text('position_type', 'E*Trade\'s `positionType` verbatim — `LONG` or `SHORT`.', { sourceProvider: 'etrade', sourceField: 'positionType' }),
      ...withStatus(col.perShare('price_paid', 'Cost basis per share.', { sourceProvider: 'etrade', sourceField: 'pricePaid' })),
      ...withStatus(col.usd('total_cost', 'Total cost of the position.', { sourceProvider: 'etrade', sourceField: 'totalCost' })),
      ...withStatus(col.usd('market_value', 'Current market value.', { sourceProvider: 'etrade', sourceField: 'marketValue' })),
      ...withStatus(col.perShare('last_price', 'Last traded price of the instrument.', { sourceProvider: 'etrade', sourceField: 'Quick.lastTrade' })),
      ...withStatus(col.usd('days_gain', 'The provider\'s own day gain. **A provider estimate**, stored as such and never used as realised P&L.', { sourceProvider: 'etrade', sourceField: 'daysGain' })),
      ...withStatus(col.usd('total_gain', 'The provider\'s own total gain. **A provider estimate**, stored as such and never used as realised P&L — estimates of exactly this kind were wrong in both directions on five of the existing app\'s positions.', { sourceProvider: 'etrade', sourceField: 'totalGain' })),
      nullable(col.date('date_acquired', 'When the lot was acquired.', { sourceProvider: 'etrade', sourceField: 'dateAcquired' }), 'omitted by the provider'),
      nullable(col.ident('provider_position_id', 'E*Trade own position id. **Confirmed present, numeric**, measured 2026-09-07 on a live portfolio call.', { sourceProvider: 'etrade', sourceField: 'positionId', converter: 'numberToIdentifier' }), 'omitted by the provider'),
    ],
    indexes: [
      { columns: ['as_of_date'] },
      { columns: ['symbol', 'as_of_date'] }
    ]
  }),

  defineTable({
    table: 'raw_account_balance_snapshot',
    layer: 'raw',
    domain: 'account',
    description: 'One balance row per run.',
    naturalKey: ['account_key_hash', 'as_of_date', 'observed_at'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      { column: 'account_key_hash', type: 'TEXT', unit: 'sha256', nullable: false, description: 'SHA-256 of `accountIdKey`. The key itself is never stored (P15).', sourceProvider: 'derived_at_ingestion' },
      ...withStatus(col.usd('cash_available_for_investment', 'Cash available to invest.', { sourceProvider: 'etrade', sourceField: 'Computed.cashAvailableForInvestment' })),
      ...withStatus(col.usd('cash_buying_power', 'Cash buying power.', { sourceProvider: 'etrade', sourceField: 'Computed.cashBuyingPower' })),
      ...withStatus(col.usd('net_cash', 'Net cash in the account.', { sourceProvider: 'etrade', sourceField: 'Computed.netCash' })),
      ...withStatus(col.usd('margin_buying_power', 'Margin buying power.', { sourceProvider: 'etrade', sourceField: 'Computed.marginBuyingPower' })),
      ...withStatus(col.usd('total_account_value', 'Total account value, real-time NAV.', { sourceProvider: 'etrade', sourceField: 'Computed.RealTimeValues.totalAccountValue' })),
      nullable(col.text('account_type', 'The account type.', { sourceProvider: 'etrade', sourceField: 'accountType' }), 'omitted by the provider')
    ],
    indexes: [{ columns: ['as_of_date'] }]
  }),

  defineTable({
    table: 'raw_executed_order',
    layer: 'raw',
    domain: 'account',
    description:
      'Executed orders — **the primary source of fills**. `orderAction` states open versus close ' +
      'outright and `averageExecutionPrice` is the realised fill, which is why this replaced the ' +
      'transactions parser that inferred intent from "sold means opened" and paired legs by index. ' +
      'A re-pull that returns an order already stored **unchanged** writes nothing; one that returns ' +
      'it with different leg data appends a new observation, which is what QC-803 reads. `order_id` ' +
      'is deliberately **not unique**: an executed order is immutable, so a second version of one is ' +
      'a finding, and a unique index would turn that finding into an insert failure indistinguishable ' +
      'from a parse fault.',
    naturalKey: ['order_id', 'observed_at'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      { column: 'account_key_hash', type: 'TEXT', unit: 'sha256', nullable: false, description: 'SHA-256 of `accountIdKey`.', sourceProvider: 'derived_at_ingestion' },
      col.ident('order_id', 'E*Trade\'s order id.', { sourceProvider: 'etrade', sourceField: 'orderId', unique: true }),
      col.text('order_type', 'Order type verbatim — `EQ`, `OPTN`, `SPREADS`.', { sourceProvider: 'etrade', sourceField: 'orderType' }),
      col.ts('placed_time', 'When the order was placed.', { sourceProvider: 'etrade', sourceField: 'placedTime', converter: 'msEpochToEtTimestamp' }),
      ...withStatus(col.ts('executed_time', 'When it filled.', { sourceProvider: 'etrade', sourceField: 'executedTime', converter: 'msEpochToEtTimestamp' })),
      nullable(col.text('order_term', 'Order term.', { sourceProvider: 'etrade', sourceField: 'orderTerm' }), 'omitted by the provider'),
      nullable(col.text('price_type', 'Price type.', { sourceProvider: 'etrade', sourceField: 'priceType' }), 'omitted by the provider'),
      nullable(col.perShare('limit_price', 'Limit price.', { sourceProvider: 'etrade', sourceField: 'limitPrice' }), 'not applicable — this was not a limit order'),
      col.text('status', 'Order status; this table stores `EXECUTED` only.', { sourceProvider: 'etrade', sourceField: 'status' }),
      { column: 'order_fingerprint', type: 'TEXT', unit: 'sha256', nullable: false, description: 'Digest over the executed time, status and every leg tuple. An unchanged re-pull is recognised by this and writes nothing; a changed one appends a second observation, and QC-803 is exactly "two observations of one order id with different fingerprints".', sourceProvider: 'derived_at_ingestion' }
    ],
    indexes: [
      { columns: ['order_id'] },
      { columns: ['executed_time'] }
    ]
  }),

  defineTable({
    table: 'raw_executed_order_leg',
    layer: 'raw',
    domain: 'account',
    description:
      'One row per instrument in an executed order. A combo is one order with N legs, filled as a ' +
      'package — never N independent orders.',
    naturalKey: ['order_row_id', 'leg_index'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.int('order_row_id', 'The order this leg belongs to.', { references: { table: 'raw_executed_order', column: 'row_id' }, sourceProvider: 'collector' }),
      col.int('leg_index', 'Position within the order.', { sourceProvider: 'collector' }),
      col.ident('symbol', 'The leg\'s symbol.', { sourceProvider: 'etrade', sourceField: 'Instrument.Product.symbol' }),
      col.text('security_type', 'E*Trade\'s `securityType` verbatim.', { sourceProvider: 'etrade', sourceField: 'Instrument.Product.securityType' }),
      ...OPTION_LEG_COLUMNS('Instrument'),
      col.enumOf('order_action', ['BUY_OPEN', 'SELL_OPEN', 'BUY_CLOSE', 'SELL_CLOSE', 'BUY', 'SELL'], 'E*Trade\'s `orderAction` verbatim — **the** open/close signal, stated rather than inferred.', { sourceProvider: 'etrade', sourceField: 'Instrument.orderAction' }),
      col.int('quantity_ordered', 'Contracts or shares ordered.', { sourceProvider: 'etrade', sourceField: 'Instrument.quantityOrdered' }),
      col.int('filled_quantity', 'Contracts or shares filled.', { sourceProvider: 'etrade', sourceField: 'Instrument.filledQuantity' }),
      col.perShare('average_execution_price', 'The realised fill price. This is the number that supersedes every estimate.', { sourceProvider: 'etrade', sourceField: 'Instrument.averageExecutionPrice' }),
      ...withStatus(col.usd('estimated_commission', 'Commission as the provider estimated it.', { sourceProvider: 'etrade', sourceField: 'Instrument.estimatedCommission' })),
      ...withStatus(col.usd('estimated_fees', 'Fees as the provider estimated them.', { sourceProvider: 'etrade', sourceField: 'Instrument.estimatedFees' }))
    ],
    indexes: [
      { columns: ['order_row_id'] },
      { columns: ['osi_symbol'] },
      { columns: ['symbol'] }
    ]
  }),

  defineTable({
    table: 'raw_account_transaction',
    layer: 'raw',
    domain: 'account',
    description:
      'Account transactions — a **fallback source only** (Q13), kept for what executed orders miss: ' +
      'dividends, fees, interest, assignments and exercises. The endpoint is known to be ' +
      'intermittently unresponsive for ~120 s behind an `oauth_problem=nonce_used` mask that is a ' +
      'server-side timeout rather than an OAuth fault, so a failure here is a **warning, never ' +
      'blocking**.',
    naturalKey: ['transaction_id'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      { column: 'account_key_hash', type: 'TEXT', unit: 'sha256', nullable: false, description: 'SHA-256 of `accountIdKey`.', sourceProvider: 'derived_at_ingestion' },
      col.ident('transaction_id', 'E*Trade\'s transaction id.', { sourceProvider: 'etrade', sourceField: 'transactionId', unique: true }),
      col.date('transaction_date', 'When it happened.', { sourceProvider: 'etrade', sourceField: 'transactionDate' }),
      col.text('transaction_type', 'E*Trade\'s type verbatim.', { sourceProvider: 'etrade', sourceField: 'transactionType' }),
      nullable(col.text('description', 'The provider\'s description line.', { sourceProvider: 'etrade', sourceField: 'description' }), 'omitted by the provider'),
      nullable(col.ident('symbol', 'The instrument involved. Path confirmed 2026-09-07: populated on instrument transactions (`Sold Short`, `Bought To Cover`), and `brokerage.product` comes back as an **empty object** on cash transactions such as `Transfer` — so the declared null meaning is the observed behaviour, not an assumption.', { sourceProvider: 'etrade', sourceField: 'brokerage.product.symbol' }), 'not applicable — the transaction has no instrument (a transfer, interest, a fee)'),
      col.usd('amount', 'Cash amount, signed.', { sourceProvider: 'etrade', sourceField: 'amount' }),
      nullable(col.int('quantity', 'Quantity involved. Path confirmed live 2026-09-07, present on every sampled transaction.', { sourceProvider: 'etrade', sourceField: 'brokerage.quantity' }), 'not applicable — the transaction has no quantity'),
      nullable(col.perShare('price', 'Price involved. Path confirmed live 2026-09-07, present on every sampled transaction.', { sourceProvider: 'etrade', sourceField: 'brokerage.price' }), 'not applicable — the transaction has no price')
    ],
    indexes: [
      { columns: ['transaction_id'], unique: true },
      { columns: ['transaction_date'] }
    ]
  }),

  defineTable({
    table: 'raw_macro_event',
    layer: 'raw',
    domain: 'macro',
    description:
      'Scheduled macro events — FOMC, CPI, PPI, employment. A rescheduled event is a new row with the ' +
      'same `event_key` and a later `observed_at`, so the reschedule itself is visible.',
    naturalKey: ['event_key', 'observed_at'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('event_key', 'Stable across reschedules, e.g. `FOMC-2026-09`, `CPI-2026-08`.', { sourceProvider: 'derived_at_ingestion' }),
      col.enumOf('event_type', ['FOMC', 'CPI', 'PPI', 'NFP', 'GDP', 'PCE', 'OTHER'], 'What kind of event.', { sourceProvider: 'derived_at_ingestion' }),
      col.date('event_date', 'Scheduled date, ET.', { sourceProvider: 'derived_at_ingestion' }),
      nullable(col.text('event_time', 'Scheduled time, ET.'), 'the source publishes a date but no time'),
      col.text('description', 'What the event is.', { sourceProvider: 'derived_at_ingestion' }),
      nullable(col.text('source_url', 'Where the schedule was read from.'), 'entered manually, with no source page')
    ],
    indexes: [
      { columns: ['event_date'] },
      { columns: ['event_key', 'observed_at'] }
    ]
  }),

  defineTable({
    table: 'raw_treasury_yield',
    layer: 'raw',
    domain: 'macro',
    description:
      'The daily par yield curve. Verified 2026-09-05, no key required. **One fetch returns every ' +
      'trading day of the year**, so the daily pull is naturally idempotent and a backfill is the same ' +
      'call. Published as percent and converted to fraction at ingestion. Stage-1 consumer is QC-410, ' +
      'the Greek-reproduction check.',
    naturalKey: ['curve_date', 'tenor', 'source'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.date('curve_date', 'The curve\'s date.', { sourceProvider: 'treasury', sourceField: 'Date', converter: 'mmddyyyyToDate' }),
      col.enumOf('tenor', ['1M', '1.5M', '2M', '3M', '4M', '6M', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '20Y', '30Y'], 'The tenor. **14 as published**, measured 2026-09-05 — the nine first drafted were missing 1.5M, 4M, 3Y, 7Y and 20Y.', { sourceProvider: 'treasury' }),
      col.fraction('yield', 'The par yield as a **fraction** (0.0391). Treasury publishes percent (3.91); the converter divides by 100 at ingestion, once, per §0.1.', { sourceProvider: 'treasury', converter: 'percentToFraction' }),
      col.enumOf('source', ['treasury', 'fred'], 'Which feed. FRED `DGS3MO` is the fallback.', { sourceProvider: 'collector' })
    ],
    indexes: [{ columns: ['curve_date', 'tenor'] }]
  }),

  defineTable({
    table: 'raw_short_interest',
    layer: 'raw',
    domain: 'sentiment',
    description:
      'Short interest, published twice monthly by FINRA, read from Polygon\'s short-interest endpoint ' +
      '(verified live 2026-09-14: 67,386 rows). Finnhub\'s endpoint is premium (403, measured ' +
      '2026-09-06); a direct FINRA file is the fallback.',
    naturalKey: ['ticker', 'settlement_date', 'source'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('ticker', 'The ticker symbol.'),
      col.date('settlement_date', 'The settlement date the figure is as of.'),
      col.int('short_interest', 'Shares held short.'),
      nullable(col.int('avg_daily_volume', 'Average daily volume used for days-to-cover.'), 'the source did not publish it'),
      { column: 'days_to_cover', type: 'REAL', unit: 'ratio', nullable: true, nullMeaning: 'the source did not publish it, and it is deliberately not computed here — a derived value belongs in stage 2, where its derivation carries a version', description: 'Days to cover exactly as the source publishes it: short interest over average daily volume.' },
      col.enumOf('source', ['polygon', 'finra', 'finnhub'], 'Which feed supplied the figure.', { sourceProvider: 'collector' })
    ],
    indexes: [{ columns: ['ticker', 'settlement_date'] }]
  }),

  defineTable({
    table: 'raw_analyst_recommendation',
    layer: 'raw',
    domain: 'sentiment',
    description:
      'Analyst recommendation counts by month. **Confirmed free 2026-09-06** — Finnhub ' +
      '`/stock/recommendation` returns exactly these fields, four monthly periods per call.',
    naturalKey: ['ticker', 'period_month', 'observed_at'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('ticker', 'The ticker symbol.', { sourceProvider: 'finnhub', sourceField: 'symbol' }),
      col.date('period_month', 'The month the counts are for, as its first day.', { sourceProvider: 'finnhub', sourceField: 'period' }),
      col.int('strong_buy', 'Strong-buy ratings.', { sourceProvider: 'finnhub', sourceField: 'strongBuy' }),
      col.int('buy', 'Buy ratings.', { sourceProvider: 'finnhub', sourceField: 'buy' }),
      col.int('hold', 'Hold ratings.', { sourceProvider: 'finnhub', sourceField: 'hold' }),
      col.int('sell', 'Sell ratings.', { sourceProvider: 'finnhub', sourceField: 'sell' }),
      col.int('strong_sell', 'Strong-sell ratings.', { sourceProvider: 'finnhub', sourceField: 'strongSell' })
    ],
    indexes: [{ columns: ['ticker', 'period_month'] }]
  }),

  defineTable({
    table: 'raw_analyst_estimate',
    layer: 'raw',
    domain: 'sentiment',
    description:
      'Forward consensus estimates, taken from the **earnings calendar row** rather than from the ' +
      'dedicated estimate endpoints, which are premium (403, measured 2026-09-06). Coverage on our ' +
      'universe is 517 of 520 scheduled reports (99.4 %) at **no extra call**. What stays unavailable ' +
      'is dispersion — high, low and analyst count are premium-only and are deliberately not columns ' +
      'here rather than columns that would always be null.',
    naturalKey: ['ticker', 'fiscal_period', 'observed_at'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('ticker', 'The ticker symbol.', { sourceProvider: 'finnhub', sourceField: 'symbol' }),
      col.text('fiscal_period', 'The period estimated, e.g. `2027Q1`.', { sourceProvider: 'derived_at_ingestion' }),
      ...withStatus(col.perShare('eps_estimate_avg', 'Consensus EPS estimate.', { sourceProvider: 'finnhub', sourceField: 'epsEstimate' })),
      ...withStatus(col.usd('revenue_estimate_avg', 'Consensus revenue estimate.', { sourceProvider: 'finnhub', sourceField: 'revenueEstimate' })),
      col.enumOf('source', ['finnhub'], 'Which feed supplied the estimate.', { sourceProvider: 'collector' })
    ],
    indexes: [{ columns: ['ticker', 'fiscal_period'] }]
  }),

  defineTable({
    table: 'raw_insider_transaction',
    layer: 'raw',
    domain: 'sentiment',
    description:
      'Form 4 insider transactions from EDGAR. Captured by **one daily full-index sweep**, not per ' +
      'ticker: EDGAR publishes an index listing every filing of the day, so a single call yields every ' +
      'Form 4 and the universe filter is applied locally. Per-ticker polling would be ~300 calls a day ' +
      'to learn that almost nothing was filed.',
    naturalKey: ['accession_no', 'transaction_date', 'filer_name', 'transaction_code'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('cik', 'The issuer\'s CIK.', { sourceProvider: 'edgar' }),
      col.ident('ticker', 'The ticker this CIK maps to in our universe.', { sourceProvider: 'derived_at_ingestion' }),
      col.text('filer_name', 'The reporting insider.', { sourceProvider: 'edgar' }),
      nullable(col.text('filer_role', 'Their relationship to the issuer — officer, director, ten-percent owner.', { sourceProvider: 'edgar' }), 'the filing did not state a role'),
      col.date('transaction_date', 'When the transaction happened.', { sourceProvider: 'edgar' }),
      col.text('transaction_code', 'Form 4 transaction code verbatim — `P` purchase, `S` sale, `A` award, and so on. Stored raw because the codes carry distinctions a two-way buy/sell mapping would destroy.', { sourceProvider: 'edgar' }),
      col.int('shares', 'Shares transacted.', { sourceProvider: 'edgar' }),
      nullable(col.perShare('price', 'Price per share.', { sourceProvider: 'edgar' }), 'the filing reported no price — awards and gifts often have none'),
      nullable(col.int('shares_owned_after', 'Shares held after the transaction.', { sourceProvider: 'edgar' }), 'the filing did not state it'),
      col.ident('accession_no', 'The Form 4 filing this came from.', { sourceProvider: 'edgar' })
    ],
    indexes: [
      { columns: ['ticker', 'transaction_date'] },
      { columns: ['cik', 'transaction_date'] },
      { columns: ['accession_no'] }
    ]
  })
];
