import { col, nullable, withStatus, withSharedStatus, type TableEntry } from '../types.js';
import { defineTable } from '../standard-columns.js';

/**
 * Market data — 02 §3 through §8: bars, end-of-day quotes, option chains,
 * corporate actions, earnings dates, index quotes.
 */

export const marketTables: readonly TableEntry[] = [
  defineTable({
    table: 'raw_daily_bar',
    layer: 'raw',
    domain: 'bars',
    description:
      'Daily OHLCV from Polygon aggregates. One-time backfill at full plan depth, then daily. ' +
      'Re-fetches **append** (P1) rather than overwrite, which is what makes the split check ' +
      'possible: the existing app stored bars incrementally and so accumulated 153 unadjusted-split ' +
      'discontinuities across 126 tickers, silently corrupting every indicator that spanned them. ' +
      'Freshness of the tail never implies consistency of the history.',
    naturalKey: ['ticker', 'trade_date', 'observed_at'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('ticker', 'The ticker symbol.', { sourceProvider: 'polygon' }),
      col.date('trade_date', 'The session this bar covers.', { sourceProvider: 'polygon', sourceField: 't', converter: 'msEpochToEtDate' }),
      col.perShare('open', 'Session open.', { sourceProvider: 'polygon', sourceField: 'o' }),
      col.perShare('high', 'Session high.', { sourceProvider: 'polygon', sourceField: 'h' }),
      col.perShare('low', 'Session low.', { sourceProvider: 'polygon', sourceField: 'l' }),
      col.perShare('close', 'Session close.', { sourceProvider: 'polygon', sourceField: 'c' }),
      col.int('volume', 'Shares traded. Polygon returns a float; the converter asserts integrality and marks the row `invalid` rather than rounding, because a fractional share volume means the field is not what we think it is.', { sourceProvider: 'polygon', sourceField: 'v', converter: 'floatToIntegerStrict' }),
      nullable(col.perShare('vwap', 'Volume-weighted average price.', { sourceProvider: 'polygon', sourceField: 'vw' }), 'omitted by the provider'),
      nullable(col.int('transactions', 'Number of trades.', { sourceProvider: 'polygon', sourceField: 'n' }), 'omitted by the provider'),
      col.date('adjusted_as_of', 'The date the fetch was made. The whole series is split- and dividend-adjusted *as of this date* — which is the fact that makes a later split visible as a discontinuity instead of invisible as a silent rescale.', { sourceProvider: 'collector' }),
      col.enumOf('fetch_kind', ['backfill', 'daily', 'refetch_discontinuity', 'refetch_manual'], 'Why this fetch happened.', { sourceProvider: 'collector' }),
      col.flag('is_final', '`0` when fetched before Polygon\'s settlement window closed for that date (before roughly 17:00 ET). The evening run re-fetches non-final bars; the existing app\'s morning slot stored a partial same-day bar and scored breakouts off it.', { sourceProvider: 'collector' })
    ],
    indexes: [
      { columns: ['ticker', 'trade_date'] },
      { columns: ['trade_date'] },
      { columns: ['ticker', 'observed_at'] }
    ]
  }),

  defineTable({
    table: 'raw_eod_quote',
    layer: 'raw',
    domain: 'quotes',
    description:
      'End-of-day quotes from Polygon\'s full-market snapshot — one call for the whole universe. It ' +
      'is the cross-source check on the bar close and the only place bid/ask is captured for equities.',
    naturalKey: ['ticker', 'as_of_date', 'observed_at'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('ticker', 'The ticker symbol.', { sourceProvider: 'polygon', sourceField: 'ticker' }),
      ...withStatus(col.perShare('last', 'Last trade price.', { sourceProvider: 'polygon', sourceField: 'lastTrade.p' })),
      ...withStatus(col.int('last_size', 'Last trade size.', { sourceProvider: 'polygon', sourceField: 'lastTrade.s' })),
      ...withSharedStatus(
        [
          col.perShare('bid', 'Best bid at the snapshot. After hours this can be stale — `quote_time` says when it was struck.', { sourceProvider: 'polygon', sourceField: 'lastQuote.p' }),
          col.int('bid_size', 'Best bid size.', { sourceProvider: 'polygon', sourceField: 'lastQuote.s' }),
          col.perShare('ask', 'Best ask at the snapshot. After hours this can be stale — `quote_time` says when it was struck.', { sourceProvider: 'polygon', sourceField: 'lastQuote.P' }),
          col.int('ask_size', 'Best ask size.', { sourceProvider: 'polygon', sourceField: 'lastQuote.S' })
        ],
        'quote_status'
      ),
      ...withSharedStatus(
        [
          col.perShare('day_open', 'Session open.', { sourceProvider: 'polygon', sourceField: 'day.o' }),
          col.perShare('day_high', 'Session high.', { sourceProvider: 'polygon', sourceField: 'day.h' }),
          col.perShare('day_low', 'Session low.', { sourceProvider: 'polygon', sourceField: 'day.l' }),
          col.perShare('day_close', 'Session close, cross-checked against `raw_daily_bar.close`.', { sourceProvider: 'polygon', sourceField: 'day.c' }),
          col.int('day_volume', 'Session volume.', { sourceProvider: 'polygon', sourceField: 'day.v' }),
          col.perShare('day_vwap', 'Session VWAP.', { sourceProvider: 'polygon', sourceField: 'day.vw' })
        ],
        'day_status'
      ),
      ...withStatus(col.perShare('prev_close', 'Previous session close.', { sourceProvider: 'polygon', sourceField: 'prevDay.c' })),
      nullable(col.ts('quote_time', 'When the quote was struck. After hours the bid/ask can be stale; this is how you tell.', { sourceProvider: 'polygon', sourceField: 'lastQuote.t', converter: 'nsEpochToEtTimestamp' }), 'omitted by the provider'),
      nullable(col.ts('trade_time', 'When the last trade printed.', { sourceProvider: 'polygon', sourceField: 'lastTrade.t', converter: 'nsEpochToEtTimestamp' }), 'omitted by the provider'),
      col.ts('snapshot_updated', 'The snapshot\'s own update stamp.', { sourceProvider: 'polygon', sourceField: 'updated', converter: 'nsEpochToEtTimestamp' })
    ],
    indexes: [
      { columns: ['ticker', 'as_of_date'] },
      { columns: ['as_of_date'] }
    ]
  }),

  defineTable({
    table: 'raw_option_expiration',
    layer: 'raw',
    domain: 'chains',
    description:
      'The expirations E*Trade lists for a ticker, one call per chain-subset ticker per run. Asking ' +
      'per ticker rather than guessing a global weekly date is what removes the existing app\'s 34 % ' +
      'chain 4xx rate: 97 % of those were code 10031 on a globally-guessed date the ticker does not ' +
      'list.',
    naturalKey: ['ticker', 'expiration_date', 'as_of_date'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('ticker', 'The underlying ticker.', { sourceProvider: 'etrade' }),
      col.date('expiration_date', 'The expiration.', { sourceProvider: 'etrade', sourceField: 'year/month/day', converter: 'etradeExpiryToDate' }),
      col.text('expiry_type', 'E*Trade expiryType verbatim. Observed 2026-09-07 across SPY 34 expirations: `WEEKLY`, `MONTHLY`, `QUARTERLY` and **`MONTHEND`** — a fourth value the draft did not list, which is exactly why this is stored verbatim rather than mapped to an enum of our own.', { sourceProvider: 'etrade', sourceField: 'expiryType' }),
      col.flag('in_capture_window', '`1` if the run\'s rule selected this expiration for a chain call.', { sourceProvider: 'derived_at_ingestion' }),
      col.enumOf('window_reason', ['within_max_dte', 'extra_monthly', 'sticky_contract', 'outside'], 'Why the expiration was or was not captured. The expirations we *declined* are recorded too — a pipeline that keeps only what it captured cannot answer why something is missing.', { sourceProvider: 'derived_at_ingestion' })
    ],
    indexes: [
      { columns: ['ticker', 'as_of_date'] },
      { columns: ['ticker', 'expiration_date'] }
    ]
  }),

  defineTable({
    table: 'raw_option_contract_snapshot',
    layer: 'raw',
    domain: 'chains',
    description:
      'One row per option contract per run — the large table. **Every strike returned is stored** ' +
      '(Q2), not just the ones a strategy would pick: the losers are the data a study needs, and ' +
      'pipelines habitually discard exactly those.',
    naturalKey: ['osi_symbol', 'as_of_date', 'observed_at'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('ticker', 'The underlying ticker.', { sourceProvider: 'etrade' }),
      col.ident('osi_symbol', 'OCC contract symbol — the contract\'s identity across days.', { sourceProvider: 'etrade', sourceField: 'osiKey' }),
      col.date('expiration_date', 'Contract expiration, from the request.', { sourceProvider: 'collector' }),
      col.perShare('strike', 'Strike price.', { sourceProvider: 'etrade', sourceField: 'strikePrice' }),
      col.enumOf('right', ['call', 'put'], 'Call or put.', { sourceProvider: 'etrade', converter: 'etradeRightToEnum' }),
      nullable(col.ident('display_symbol', 'E*Trade\'s human-readable symbol.', { sourceProvider: 'etrade', sourceField: 'displaySymbol' }), 'omitted by the provider'),
      ...withSharedStatus(
        [
          col.perShare('bid', 'Best bid for the contract. With `ask` it is the only honest input to a fill estimate — the spread, not the last trade, is what a position actually costs.', { sourceProvider: 'etrade', sourceField: 'bid' }),
          col.perShare('ask', 'Best ask for the contract.', { sourceProvider: 'etrade', sourceField: 'ask' })
        ],
        'price_status'
      ),
      ...withStatus(col.perShare('last', 'Last traded price. E*Trade sends `0` when the contract has not traded; the converter stores null with `omitted`, **never 0** — a zero here would read as "it traded at zero".', { sourceProvider: 'etrade', sourceField: 'lastPrice', converter: 'zeroToOmitted' })),
      ...withSharedStatus(
        [
          col.int('bid_size', 'Contracts quoted at the bid.', { sourceProvider: 'etrade', sourceField: 'bidSize' }),
          col.int('ask_size', 'Contracts quoted at the ask.', { sourceProvider: 'etrade', sourceField: 'askSize' })
        ],
        'size_status'
      ),
      ...withStatus(col.int('volume', 'Contracts traded today. Absent means `omitted`, **never 0** (D7) — the existing app\'s `leg.volume ?? 0` turned "not reported" into "did not trade" on 23 of 250 stored legs, and a liquidity gate then rejected them.', { sourceProvider: 'etrade', sourceField: 'volume' })),
      ...withStatus(col.int('open_interest', 'Open interest.', { sourceProvider: 'etrade', sourceField: 'openInterest' })),
      ...withStatus(col.fraction('iv', 'Implied volatility, **fraction as E*Trade sends it** (0.3882, not 38.82). The converter asserts 0 < iv < 5 and marks `invalid` otherwise.', { sourceProvider: 'etrade', sourceField: 'OptionGreeks.iv', converter: 'assertIvRange' })),
      ...withSharedStatus(
        [
          col.fraction('delta', 'Delta as sent.', { sourceProvider: 'etrade', sourceField: 'OptionGreeks.delta' }),
          col.fraction('gamma', 'Gamma as sent.', { sourceProvider: 'etrade', sourceField: 'OptionGreeks.gamma' }),
          col.fraction('theta', 'Theta **per day**, as E*Trade sends it. Measured 2026-09-07 on a live SPY chain: E*Trade -0.18651 against a Black-Scholes -0.2285 per day and -83.39 per year. Three orders of magnitude separate the candidates, so the unit is not in doubt.', { sourceProvider: 'etrade', sourceField: 'OptionGreeks.theta' }),
          col.fraction('vega', 'Vega as sent.', { sourceProvider: 'etrade', sourceField: 'OptionGreeks.vega' }),
          col.fraction('rho', 'Rho as sent.', { sourceProvider: 'etrade', sourceField: 'OptionGreeks.rho' })
        ],
        'greeks_status'
      ),
      nullable(col.flag('in_the_money', 'Provider moneyness flag. **E*Trade sends the STRING `y` or `n`, not a boolean** (measured 2026-09-07), so the converter maps them explicitly. A plain cast would be silently wrong in the worst possible way: `Boolean("n")` is `true`, so every contract would read as in-the-money.', { sourceProvider: 'etrade', sourceField: 'inTheMoney', converter: 'etradeYesNoToFlag' }), 'omitted by the provider'),
      col.perShare('underlying_price', 'The underlying price at the time of the call, cross-checked against `raw_eod_quote.last` within 1 %.', { sourceProvider: 'etrade', sourceField: 'OptionChainResponse.nearPrice' }),
      nullable(col.ts('provider_timestamp', 'E*Trade own timestamp for the quote. **Epoch seconds**, measured 2026-09-07: 1788552898 reads as 2026-09-04T20:14:58Z (the prior session close) as seconds, and as 1970 as milliseconds.', { sourceProvider: 'etrade', sourceField: 'timeStamp', converter: 'secondsEpochToEtTimestamp' }), 'omitted by the provider'),
      nullable(col.enumOf('sticky_reason', ['held_in_book', 'recommended_by_legacy', 'study_flag'], 'Why this contract was captured despite the rule.'), 'captured by the rule, not sticky')
    ],
    indexes: [
      { columns: ['as_of_date'] },
      { columns: ['ticker', 'as_of_date'] },
      { columns: ['osi_symbol', 'as_of_date'] },
      { columns: ['ticker', 'expiration_date', 'as_of_date'] }
    ]
  }),

  defineTable({
    table: 'raw_split',
    layer: 'raw',
    domain: 'corporate_actions',
    description:
      'Stock splits from Polygon, swept daily by execution-date window and per-ticker whenever a bar ' +
      'discontinuity needs explaining. Every discontinuity must have a matching action row or it ' +
      'becomes an exception.',
    naturalKey: ['ticker', 'execution_date', 'provider_id'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('ticker', 'The ticker symbol.', { sourceProvider: 'polygon' }),
      col.date('execution_date', 'The date the split took effect.', { sourceProvider: 'polygon', sourceField: 'execution_date' }),
      col.ratio('split_from', 'Shares before the split — 1 in a 1-for-4. A ratio rather than a count: the pair is only meaningful together, and providers do send fractional values.', { sourceProvider: 'polygon', sourceField: 'split_from' }),
      col.ratio('split_to', 'Shares after the split — 4 in a 1-for-4.', { sourceProvider: 'polygon', sourceField: 'split_to' }),
      col.ident('provider_id', 'Polygon\'s own id, so a re-pull is idempotent.', { sourceProvider: 'polygon', sourceField: 'id' })
    ],
    indexes: [{ columns: ['ticker', 'execution_date'] }]
  }),

  defineTable({
    table: 'raw_dividend',
    layer: 'raw',
    domain: 'corporate_actions',
    description: 'Cash dividends from Polygon. Event data — not count-modelled, checked by consistency against bar discontinuities.',
    naturalKey: ['ticker', 'ex_dividend_date', 'provider_id'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('ticker', 'The ticker symbol.', { sourceProvider: 'polygon' }),
      col.date('ex_dividend_date', 'Ex-dividend date.', { sourceProvider: 'polygon', sourceField: 'ex_dividend_date' }),
      nullable(col.date('record_date', 'Record date.', { sourceProvider: 'polygon', sourceField: 'record_date' }), 'omitted by the provider'),
      nullable(col.date('pay_date', 'Payment date.', { sourceProvider: 'polygon', sourceField: 'pay_date' }), 'omitted by the provider'),
      nullable(col.date('declaration_date', 'Declaration date.', { sourceProvider: 'polygon', sourceField: 'declaration_date' }), 'omitted by the provider'),
      col.perShare('cash_amount', 'Cash paid per share.', { sourceProvider: 'polygon', sourceField: 'cash_amount' }),
      col.text('currency', 'Currency of `cash_amount`.', { sourceProvider: 'polygon', sourceField: 'currency' }),
      nullable(col.int('frequency', 'Payments per year — 0 one-time, 1, 2, 4, 12.', { sourceProvider: 'polygon', sourceField: 'frequency' }), 'omitted by the provider'),
      col.text('dividend_type', 'Polygon\'s type verbatim — `CD`, `SC`, `LT`, `ST`.', { sourceProvider: 'polygon', sourceField: 'dividend_type' }),
      col.ident('provider_id', 'Polygon\'s own id, so a re-pull is idempotent.', { sourceProvider: 'polygon', sourceField: 'id' })
    ],
    indexes: [{ columns: ['ticker', 'ex_dividend_date'] }]
  }),

  defineTable({
    table: 'raw_earnings_event',
    layer: 'raw',
    domain: 'earnings',
    description:
      'Every *observation* of an earnings date is a row (P1); "the current best date" is a reader-side ' +
      'resolution, never an update. Two sources are captured for cross-checking. An observed date ' +
      'moving **later** by more than 14 days is the truncation signature that put NVDA\'s report a ' +
      'quarter late in the existing app and suppressed the three mechanisms that would have corrected it.',
    naturalKey: ['ticker', 'source', 'observed_at'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('ticker', 'The ticker symbol.', { sourceProvider: 'finnhub', sourceField: 'symbol' }),
      col.date('report_date', 'The reporting date as observed.', { sourceProvider: 'finnhub', sourceField: 'date' }),
      ...withStatus(col.enumOf('report_time', ['bmo', 'amc', 'dmh'], 'Before market open, after market close, or during market hours. Measured 2026-09-06 over 520 universe reports: `bmo` 132, `amc` 144, and **empty string on 244 (47 %)**; `dmh` was never observed. The converter maps `\'\'` to null with status `omitted` — treating the empty string as a value would put a fourth member in the enum and silently defeat every `report_time IS NULL` filter.', { sourceProvider: 'finnhub', sourceField: 'hour', converter: 'emptyStringToOmitted' })),
      nullable(col.int('fiscal_year', 'Fiscal year reported.', { sourceProvider: 'finnhub', sourceField: 'year' }), 'omitted by the provider'),
      nullable(col.int('fiscal_quarter', 'Fiscal quarter reported.', { sourceProvider: 'finnhub', sourceField: 'quarter' }), 'omitted by the provider'),
      ...withStatus(col.perShare('eps_estimate', 'Consensus EPS estimate. Free-tier availability confirmed 2026-09-06 — the dedicated estimate endpoints are premium, but the calendar carries this for 99.4 % of universe reports at no extra call.', { sourceProvider: 'finnhub', sourceField: 'epsEstimate' })),
      ...withStatus(col.perShare('eps_actual', 'Reported EPS.', { sourceProvider: 'finnhub', sourceField: 'epsActual' })),
      ...withStatus(col.usd('revenue_estimate', 'Consensus revenue estimate.', { sourceProvider: 'finnhub', sourceField: 'revenueEstimate' })),
      ...withStatus(col.usd('revenue_actual', 'Reported revenue.', { sourceProvider: 'finnhub', sourceField: 'revenueActual' })),
      col.enumOf('source', ['finnhub', 'etrade'], 'Which provider observed this date. Disagreement of more than a day between the two is a warning.', { sourceProvider: 'collector' }),
      nullable(col.date('sweep_from', 'Start of the sweep window that returned this row.'), 'not from a sweep — fetched for this ticker directly'),
      nullable(col.date('sweep_to', 'End of the sweep window that returned this row.'), 'not from a sweep — fetched for this ticker directly'),
      nullable(col.flag('is_confirmed', 'The provider\'s own confirmation flag.'), 'the provider does not offer a confirmation flag')
    ],
    indexes: [
      { columns: ['ticker', 'report_date'] },
      { columns: ['report_date'] },
      { columns: ['ticker', 'observed_at'] }
    ]
  }),

  defineTable({
    table: 'raw_index_quote',
    layer: 'raw',
    domain: 'index',
    description:
      'Index quotes from E*Trade — Polygon\'s stock snapshot cannot serve an index. Symbols come from ' +
      '`ref_macro_series`, VIX first.',
    naturalKey: ['symbol', 'as_of_date', 'observed_at'],
    appendOnly: true,
    ruleDriven: true,
    standardColumns: true,
    columns: [
      col.ident('symbol', 'The index symbol. **`VIX` confirmed 2026-09-07** — HTTP 200 returning 14.53, inside the sane band; `VIX.X` is rejected as invalid. The range check stays: it turns a future symbol change into an `invalid` rather than a plausible wrong number.', { sourceProvider: 'etrade' }),
      // `last` carries its OWN status, and the other four share one. They were
      // drafted under a single shared status, which the CHECK constraint then
      // reads as all-or-nothing: a response missing only `open` would have to
      // null `last` as well, and QC-901 treats an absent last as a blocking
      // finding. So one missing context field would have taken out the market
      // regime read entirely. `last` is what QC-901, the critic and the
      // dashboard all consume; open/high/low/prev_close are context, and
      // losing them together is a real fact worth one status column.
      ...withStatus(col.perShare('last', 'Last level. The value every consumer reads, which is why it does not share a status with the session context below — a missing `open` must not be able to blank it.', { sourceProvider: 'etrade', sourceField: 'All.lastTrade' })),
      ...withSharedStatus(
        [
          col.perShare('open', 'Session open. Field name confirmed live 2026-09-07.', { sourceProvider: 'etrade', sourceField: 'All.open' }),
          col.perShare('high', 'Session high. Field name confirmed live 2026-09-07.', { sourceProvider: 'etrade', sourceField: 'All.high' }),
          col.perShare('low', 'Session low. Field name confirmed live 2026-09-07.', { sourceProvider: 'etrade', sourceField: 'All.low' }),
          col.perShare('prev_close', 'Previous close. Field name confirmed live 2026-09-07.', { sourceProvider: 'etrade', sourceField: 'All.previousClose' }),
        ],
        'session_status'
      ),
      nullable(col.ts('provider_timestamp', 'E*Trade\'s own timestamp.', { sourceProvider: 'etrade' }), 'omitted by the provider')
    ],
    indexes: [{ columns: ['symbol', 'as_of_date'] }]
  })
];
