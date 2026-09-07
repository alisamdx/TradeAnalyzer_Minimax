import type { CheckDefinition, Evaluation } from '../check.js';
import { bsDelta } from '../black-scholes.js';

/**
 * Option-chain checks — 03 §3.5.
 *
 * These guard the domain that is 85 % of the run's calls and the one whose
 * failures the existing app could not see: a 34 % chain 4xx rate that read as
 * "options are illiquid" rather than "we asked for a date the ticker does not
 * list".
 */

export const QC401_SUBSET_COVERAGE: CheckDefinition = {
  id: 'QC-401',
  domain: 'chains',
  severity: 'blocking',
  description:
    'Every ticker in the chain subset has an expirations row for the trading date. A subset member ' +
    'with no expirations row means the ticker was asked and did not answer, which is a collection ' +
    'failure rather than a fact about the ticker.',
  readsTables: ['raw_option_expiration', 'ref_chain_subset_membership'],
  testedQuantity: 'missing_subset_ticker_fraction',
  testedUnit: 'fraction',
  thresholds: { maxMissingFraction: 0.02 },
  thresholdBasis: 'working',
  remediation: 'R2',
  run(ctx) {
    const expected = (
      ctx.db
        .prepare('SELECT ticker FROM ref_chain_subset_membership WHERE valid_to IS NULL')
        .all() as { ticker: string }[]
    ).map((r) => r.ticker);
    if (expected.length === 0) return [];

    const seen = new Set(
      (
        ctx.db
          .prepare('SELECT DISTINCT ticker FROM raw_option_expiration WHERE as_of_date = ?')
          .all(ctx.tradingDate) as { ticker: string }[]
      ).map((r) => r.ticker)
    );
    const missing = expected.filter((t) => !seen.has(t));
    const fraction = missing.length / expected.length;

    return [
      {
        key: ctx.tradingDate,
        value: fraction,
        fired: fraction > this.thresholds['maxMissingFraction']!,
        detail: `${missing.length} of ${expected.length} subset tickers returned no expirations (${(fraction * 100).toFixed(2)}%)`,
        evidence: { subsetSize: expected.length, missingSample: missing.slice(0, 20) }
      }
    ];
  }
};

export const QC402_EXPIRATION_COVERAGE: CheckDefinition = {
  id: 'QC-402',
  domain: 'chains',
  severity: 'blocking',
  description:
    'Every expiration the run selected has contracts stored. An expiration marked in the capture ' +
    'window with zero contracts means the chain call was made and produced nothing, which is the ' +
    'shape a dormant token used to produce silently.',
  readsTables: ['raw_option_expiration', 'raw_option_contract_snapshot'],
  testedQuantity: 'empty_selected_expiration_count',
  testedUnit: 'count',
  thresholds: { maxEmpty: 0 },
  thresholdBasis: 'structural',
  remediation: 'R1',
  run(ctx) {
    const selected = ctx.db
      .prepare(
        `SELECT e.ticker, e.expiration_date,
                (SELECT COUNT(*) FROM raw_option_contract_snapshot c
                  WHERE c.ticker = e.ticker AND c.expiration_date = e.expiration_date
                    AND c.as_of_date = e.as_of_date) AS contracts
           FROM raw_option_expiration e
          WHERE e.as_of_date = ? AND e.in_capture_window = 1`
      )
      .all(ctx.tradingDate) as { ticker: string; expiration_date: string; contracts: number }[];

    return selected.map((r) => ({
      key: `${r.ticker} ${r.expiration_date}`,
      value: r.contracts === 0 ? 1 : 0,
      fired: r.contracts === 0,
      detail: `${r.ticker} ${r.expiration_date} was selected for capture but stored no contracts`,
      evidence: { ticker: r.ticker, expiration: r.expiration_date }
    })) satisfies Evaluation[];
  }
};

export const QC403_PARSE_COUNT_EQUALITY: CheckDefinition = {
  id: 'QC-403',
  domain: 'chains',
  severity: 'blocking',
  description:
    'Stored contracts for a chain response equal the contracts that response was parsed into (AC-5). ' +
    'The one check that catches a parser silently dropping rows — a row count that disagrees with ' +
    'itself is the only symptom, because the dropped rows leave nothing else behind.',
  readsTables: ['meta_response', 'raw_option_contract_snapshot'],
  testedQuantity: 'stored_minus_parsed',
  testedUnit: 'count',
  thresholds: { maxAbsDifference: 0 },
  thresholdBasis: 'structural',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT r.source_response_id, r.parsed_row_count,
                (SELECT COUNT(*) FROM raw_option_contract_snapshot c
                  WHERE c.source_response_id = r.source_response_id) AS stored
           FROM meta_response r
          WHERE r.run_id = ? AND r.endpoint = '/v1/market/optionchains' AND r.parse_status = 'ok'`
      )
      .all(ctx.runId) as { source_response_id: number; parsed_row_count: number; stored: number }[];

    return rows.map((r) => {
      const diff = r.stored - r.parsed_row_count;
      return {
        key: `response ${String(r.source_response_id)}`,
        value: Math.abs(diff),
        fired: diff !== 0,
        detail: `response ${String(r.source_response_id)}: ${r.stored} stored vs ${r.parsed_row_count} parsed`,
        evidence: { sourceResponseId: r.source_response_id, stored: r.stored, parsed: r.parsed_row_count }
      } satisfies Evaluation;
    });
  }
};

export const QC404_BID_ASK_SANITY: CheckDefinition = {
  id: 'QC-404',
  domain: 'chains',
  severity: 'warning',
  description:
    'A quoted contract has bid <= ask and an ask no larger than three times the underlying. The ' +
    'spread, not the last trade, is what a position actually costs, so a crossed or absurd quote is ' +
    'worth seeing before anything prices against it.',
  readsTables: ['raw_option_contract_snapshot'],
  testedQuantity: 'ask_over_underlying_ratio',
  testedUnit: 'ratio',
  thresholds: { maxAskOverUnderlying: 3 },
  thresholdBasis: 'structural',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT osi_symbol, bid, ask, underlying_price FROM raw_option_contract_snapshot
          WHERE as_of_date = ? AND price_status = 'ok' AND underlying_price > 0`
      )
      .all(ctx.tradingDate) as {
      osi_symbol: string;
      bid: number;
      ask: number;
      underlying_price: number;
    }[];

    return rows.map((r) => {
      const ratio = r.ask / r.underlying_price;
      const crossed = r.bid > r.ask;
      return {
        key: r.osi_symbol,
        value: ratio,
        fired: crossed || ratio > this.thresholds['maxAskOverUnderlying']!,
        detail: crossed
          ? `${r.osi_symbol}: bid ${r.bid} above ask ${r.ask}`
          : `${r.osi_symbol}: ask ${r.ask} is ${ratio.toFixed(2)}x the underlying ${r.underlying_price}`,
        evidence: { osiSymbol: r.osi_symbol, bid: r.bid, ask: r.ask, underlying: r.underlying_price, crossed }
      } satisfies Evaluation;
    });
  }
};

export const QC405_IV_RANGE: CheckDefinition = {
  id: 'QC-405',
  domain: 'chains',
  severity: 'warning',
  description:
    'The fraction of contracts whose IV the ingestion rejected as out of range. A handful is normal ' +
    'on illiquid strikes; a large fraction means the feed changed scale, which is the failure this ' +
    'looks for. The individual rejection is already recorded as `iv_status = invalid`.',
  readsTables: ['raw_option_contract_snapshot'],
  testedQuantity: 'invalid_iv_fraction',
  testedUnit: 'fraction',
  thresholds: { maxInvalidFraction: 0.1 },
  thresholdBasis: 'structural',
  // Any rejection at all is worth seeing; a tenth of the chain means the feed
  // changed scale, which is a different and blocking kind of problem.
  promoteToBlockingAtValue: 0.1,
  run(ctx) {
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN iv_status = 'invalid' THEN 1 ELSE 0 END) AS invalid
           FROM raw_option_contract_snapshot WHERE as_of_date = ?`
      )
      .get(ctx.tradingDate) as { total: number; invalid: number | null };
    if (!row || row.total === 0) return [];

    const fraction = (row.invalid ?? 0) / row.total;
    return [
      {
        key: ctx.tradingDate,
        value: fraction,
        fired: (row.invalid ?? 0) > 0,
        detail: `${String(row.invalid ?? 0)} of ${row.total} contracts have an out-of-range IV (${(fraction * 100).toFixed(2)}%)`,
        evidence: { total: row.total, invalid: row.invalid ?? 0 }
      }
    ];
  }
};

export const QC406_LADDER_INTEGRITY: CheckDefinition = {
  id: 'QC-406',
  domain: 'chains',
  severity: 'warning',
  description:
    'Every strike in an expiration appears as both a call and a put. A one-sided strike means half a ' +
    'pair was dropped somewhere between the response and the table, and a pair is how the chain is ' +
    'actually shaped.',
  readsTables: ['raw_option_contract_snapshot'],
  testedQuantity: 'unpaired_strike_count',
  testedUnit: 'count',
  thresholds: { maxUnpaired: 0 },
  thresholdBasis: 'structural',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT ticker, expiration_date, strike,
                SUM(CASE WHEN "right" = 'call' THEN 1 ELSE 0 END) AS calls,
                SUM(CASE WHEN "right" = 'put' THEN 1 ELSE 0 END) AS puts
           FROM raw_option_contract_snapshot
          WHERE as_of_date = ?
          GROUP BY ticker, expiration_date, strike`
      )
      .all(ctx.tradingDate) as {
      ticker: string;
      expiration_date: string;
      strike: number;
      calls: number;
      puts: number;
    }[];

    return rows.map((r) => {
      const unpaired = r.calls === 0 || r.puts === 0;
      return {
        key: `${r.ticker} ${r.expiration_date} ${String(r.strike)}`,
        value: unpaired ? 1 : 0,
        fired: unpaired,
        detail: `${r.ticker} ${r.expiration_date} strike ${r.strike}: ${r.calls} calls, ${r.puts} puts`,
        evidence: { ticker: r.ticker, expiration: r.expiration_date, strike: r.strike, calls: r.calls, puts: r.puts }
      } satisfies Evaluation;
    });
  }
};

export const QC407_UNDERLYING_DISAGREEMENT: CheckDefinition = {
  id: 'QC-407',
  domain: 'chains',
  severity: 'warning',
  description:
    'The underlying price E*Trade returns with a chain agrees with the Polygon snapshot for the same ' +
    'ticker and day. Two independent readings of one number, from two providers, on the same run — ' +
    'the cheapest cross-source check the chain domain has.',
  readsTables: ['raw_option_contract_snapshot', 'raw_eod_quote'],
  testedQuantity: 'abs_underlying_disagreement_fraction',
  testedUnit: 'fraction',
  thresholds: { maxAbsDisagreement: 0.01 },
  thresholdBasis: 'measured',
  thresholdEvidence:
    'Unblocked by the 2026-09-07 re-auth: E*Trade nearPrice read 770.19 for SPY on a live chain. The ' +
    'per-run comparison itself first exists at B6, so 1 % stands as the working bound until the ' +
    "pilot's own distribution replaces it.",
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT c.ticker, AVG(c.underlying_price) AS chain_price, q.last AS quote_price
           FROM raw_option_contract_snapshot c
           JOIN raw_eod_quote q ON q.ticker = c.ticker AND q.as_of_date = c.as_of_date
          WHERE c.as_of_date = ? AND q.last > 0
          GROUP BY c.ticker`
      )
      .all(ctx.tradingDate) as { ticker: string; chain_price: number; quote_price: number }[];

    return rows.map((r) => {
      const disagreement = Math.abs(r.chain_price - r.quote_price) / r.quote_price;
      return {
        key: r.ticker,
        value: disagreement,
        fired: disagreement > this.thresholds['maxAbsDisagreement']!,
        detail: `${r.ticker}: chain underlying ${r.chain_price.toFixed(2)} vs snapshot ${r.quote_price.toFixed(2)} (${(disagreement * 100).toFixed(2)}%)`,
        evidence: { ticker: r.ticker, chainPrice: r.chain_price, quotePrice: r.quote_price }
      } satisfies Evaluation;
    });
  }
};

export const QC408_ZERO_VOLUME_DEFAULT: CheckDefinition = {
  id: 'QC-408',
  domain: 'chains',
  severity: 'warning',
  description:
    'Contracts stored with volume 0, open interest 0 and no quote at all. This *may* be a defaulted ' +
    'field written where the provider sent nothing, but a genuinely untraded far-OTM strike on a ' +
    'fresh expiration has exactly the same shape, so it can never be blocking. It is kept because a ' +
    'sudden jump in its count is a good smoke signal that an ingestion change went wrong — which the ' +
    'unit test asserting absent-means-null cannot give.',
  readsTables: ['raw_option_contract_snapshot'],
  testedQuantity: 'suspect_zero_default_fraction',
  testedUnit: 'fraction',
  thresholds: { maxSuspectFraction: 0.5 },
  thresholdBasis: 'working',
  run(ctx) {
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN volume = 0 AND volume_status = 'ok'
                          AND open_interest = 0 AND open_interest_status = 'ok'
                          AND COALESCE(bid, 0) = 0 AND COALESCE(ask, 0) = 0
                     THEN 1 ELSE 0 END) AS suspect
           FROM raw_option_contract_snapshot WHERE as_of_date = ?`
      )
      .get(ctx.tradingDate) as { total: number; suspect: number | null };
    if (!row || row.total === 0) return [];

    const fraction = (row.suspect ?? 0) / row.total;
    return [
      {
        key: ctx.tradingDate,
        value: fraction,
        fired: fraction > this.thresholds['maxSuspectFraction']!,
        detail: `${String(row.suspect ?? 0)} of ${row.total} contracts are zero on volume, open interest and both quotes (${(fraction * 100).toFixed(2)}%)`,
        evidence: { total: row.total, suspect: row.suspect ?? 0 }
      }
    ];
  }
};

export const QC409_STICKY_SET_HONOURED: CheckDefinition = {
  id: 'QC-409',
  domain: 'chains',
  severity: 'blocking',
  description:
    'Every currently pinned contract has a snapshot row this run. A pin exists so a held or ' +
    'recommended contract keeps being priced to expiry even when its underlying leaves the subset; a ' +
    'pin that stops producing rows silently is the pin failing to do the one thing it is for.',
  readsTables: ['ref_sticky_contract', 'raw_option_contract_snapshot'],
  testedQuantity: 'unhonoured_pin_count',
  testedUnit: 'count',
  thresholds: { maxUnhonoured: 0 },
  thresholdBasis: 'structural',
  remediation: 'R1',
  run(ctx) {
    const pins = ctx.db
      .prepare(
        `SELECT osi_symbol, ticker, reason FROM ref_sticky_contract
          WHERE valid_to IS NULL AND expiration_date >= ?`
      )
      .all(ctx.tradingDate) as { osi_symbol: string; ticker: string; reason: string }[];

    const captured = ctx.db.prepare(
      'SELECT 1 FROM raw_option_contract_snapshot WHERE osi_symbol = ? AND as_of_date = ? LIMIT 1'
    );

    return pins.map((p) => {
      const has = captured.get(p.osi_symbol, ctx.tradingDate) !== undefined;
      return {
        key: p.osi_symbol,
        value: has ? 0 : 1,
        fired: !has,
        detail: `${p.osi_symbol} is pinned (${p.reason}) but has no snapshot for ${ctx.tradingDate}`,
        evidence: { osiSymbol: p.osi_symbol, ticker: p.ticker, reason: p.reason }
      } satisfies Evaluation;
    });
  }
};

/** Roughly at the money — where a delta difference is largest and easiest to read. */
const ATM_BAND = 0.05;

/** A breach on one strike is noise; on more than this share of them it is the feed. */
const BREACH_FRACTION_TO_FIRE = 0.05;

export const QC410_GREEK_REPRODUCTION: CheckDefinition = {
  id: 'QC-410',
  domain: 'chains',
  severity: 'warning',
  description:
    "Black-Scholes delta from the stored inputs is within tolerance of the provider's delta on ATM " +
    'contracts. This verifies the Greeks are on the scale the dictionary claims, not that they match ' +
    'our model: E*Trade prices American options with an unpublished pricer, and the measured gap has ' +
    'the shape of a model difference rather than an error. It is the stage-1 consumer of ' +
    '`raw_treasury_yield`; a missing rate skips the check rather than failing it, because a missing ' +
    "rate is QC-902's finding.",
  readsTables: ['raw_option_contract_snapshot', 'raw_treasury_yield'],
  testedQuantity: 'abs_delta_difference',
  testedUnit: 'fraction',
  thresholds: { maxAbsDeltaDifference: 0.05 },
  thresholdBasis: 'measured',
  thresholdEvidence:
    "One live SPY chain, 2026-09-07, 12 strikes within $40 of spot: E*Trade's delta sits 0.018–0.029 " +
    'below a European Black-Scholes, monotonically in moneyness. SPY\'s ~1.15 % dividend yield halves ' +
    'the worst gap (0.0287 to 0.0179) without closing it. 0.05 is far above a model difference and ' +
    'far below anything a unit or scale fault could produce, since those are off by 100x or sign ' +
    'flipped.',
  run(ctx) {
    const rate = ctx.db
      .prepare(
        `SELECT yield FROM raw_treasury_yield
          WHERE tenor = '3M' AND curve_date <= ?
          ORDER BY curve_date DESC LIMIT 1`
      )
      .get(ctx.tradingDate) as { yield: number } | undefined;
    // Skipped, not failed: without a rate there is no comparison to make, and
    // claiming one from a default would be exactly the fabrication P4 forbids.
    if (!rate) return [];

    const rows = ctx.db
      .prepare(
        `SELECT osi_symbol, strike, "right", iv, delta, underlying_price, expiration_date
           FROM raw_option_contract_snapshot
          WHERE as_of_date = ? AND iv_status = 'ok' AND greeks_status = 'ok'
            AND delta IS NOT NULL AND underlying_price > 0
            AND ABS(strike - underlying_price) <= underlying_price * ?`
      )
      .all(ctx.tradingDate, ATM_BAND) as {
      osi_symbol: string;
      strike: number;
      right: 'call' | 'put';
      iv: number;
      delta: number;
      underlying_price: number;
      expiration_date: string;
    }[];

    // Every ATM contract is measured, but a single breach is not the finding —
    // the spec's condition is a breach on more than 5 % of them. Measuring all
    // and firing on the fraction keeps the distribution (P10) while leaving one
    // odd strike out of the exception log.
    const measured: { key: string; diff: number; detail: string; evidence: Record<string, unknown> }[] = [];
    for (const r of rows) {
      const dteDays = Math.round(
        (Date.parse(`${r.expiration_date}T00:00:00Z`) - Date.parse(`${ctx.tradingDate}T00:00:00Z`)) /
          86_400_000
      );
      const modelled = bsDelta({
        spot: r.underlying_price,
        strike: r.strike,
        dteDays,
        iv: r.iv,
        rate: rate.yield,
        right: r.right
      });
      if (modelled === null) continue;

      measured.push({
        key: r.osi_symbol,
        diff: Math.abs(modelled - r.delta),
        detail: `${r.osi_symbol}: provider delta ${r.delta.toFixed(4)} vs model ${modelled.toFixed(4)}`,
        evidence: { osiSymbol: r.osi_symbol, providerDelta: r.delta, modelDelta: modelled, dteDays, iv: r.iv }
      });
    }
    if (measured.length === 0) return [];

    const tolerance = this.thresholds['maxAbsDeltaDifference']!;
    const breaching = measured.filter((m) => m.diff > tolerance).length;
    const breachFraction = breaching / measured.length;
    const fires = breachFraction > BREACH_FRACTION_TO_FIRE;

    return measured.map((m) => ({
      key: m.key,
      value: m.diff,
      fired: fires && m.diff > tolerance,
      detail: `${m.detail} — ${breaching} of ${measured.length} ATM contracts breach ${String(tolerance)}`,
      evidence: { ...m.evidence, breaching, atmContracts: measured.length, breachFraction }
    })) satisfies Evaluation[];
  }
};

export const QC411_WEEKEND_EXPIRATION: CheckDefinition = {
  id: 'QC-411',
  domain: 'chains',
  severity: 'blocking',
  description:
    'Every stored expiration is a trading day. This catches the UTC/local weekday bug whose signature ' +
    'is a Saturday date: the existing app computed the weekday locally and serialised through ' +
    '`toISOString()`, which shifted every guessed Friday to Saturday on evening runs, and E*Trade ' +
    'lists Fridays only — so the chain lookup returned an empty array and the agent went ten days ' +
    'without contracts.',
  readsTables: ['raw_option_expiration', 'ref_trading_day'],
  testedQuantity: 'non_trading_day_expiration_count',
  testedUnit: 'count',
  thresholds: { maxNonTradingDay: 0 },
  thresholdBasis: 'structural',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT DISTINCT e.expiration_date,
                (SELECT is_trading_day FROM ref_trading_day d WHERE d.date = e.expiration_date) AS is_trading
           FROM raw_option_expiration e
          WHERE e.as_of_date = ?`
      )
      .all(ctx.tradingDate) as { expiration_date: string; is_trading: number | null }[];

    return rows
      // A date the calendar does not cover is QC-905's problem, not this one —
      // an unknown day is not evidence that the day is a Saturday.
      .filter((r) => r.is_trading !== null)
      .map((r) => ({
        key: r.expiration_date,
        value: r.is_trading === 0 ? 1 : 0,
        fired: r.is_trading === 0,
        detail: `expiration ${r.expiration_date} is not a trading day`,
        evidence: { expiration: r.expiration_date }
      })) satisfies Evaluation[];
  }
};

export const QC412_CHAIN_ERROR_RATE: CheckDefinition = {
  id: 'QC-412',
  domain: 'chains',
  severity: 'warning',
  description:
    'The fraction of chain calls this run that came back non-2xx. The existing app ran at 34 %, of ' +
    'which 97 % were error 10031 against a globally guessed date the ticker does not list — which is ' +
    'the bug asking each ticker for its own expirations removes. Any non-zero rate here is worth ' +
    'seeing; above half a percent it is blocking, because at that point the per-ticker approach is ' +
    'not working as designed.',
  readsTables: ['meta_response'],
  testedQuantity: 'chain_4xx_fraction',
  testedUnit: 'fraction',
  thresholds: { maxErrorFraction: 0.005 },
  thresholdBasis: 'measured',
  thresholdEvidence:
    "Diagnosed 2026-09-06 against the existing app's API log: 34 % of its chain calls failed, 97 % of " +
    'them code 10031 on a date the ticker does not list. Asking per ticker removes that class ' +
    'entirely, so the expected steady state is zero and anything above 0.5 % means it has come back.',
  run(ctx) {
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN http_status IS NULL OR http_status < 200 OR http_status >= 300 THEN 1 ELSE 0 END) AS failed
           FROM meta_response
          WHERE run_id = ? AND endpoint = '/v1/market/optionchains'`
      )
      .get(ctx.runId) as { total: number; failed: number | null };
    if (!row || row.total === 0) return [];

    const fraction = (row.failed ?? 0) / row.total;
    return [
      {
        key: ctx.tradingDate,
        value: fraction,
        fired: fraction > 0,
        detail: `${String(row.failed ?? 0)} of ${row.total} chain calls failed (${(fraction * 100).toFixed(2)}%)`,
        evidence: { total: row.total, failed: row.failed ?? 0, blockingAbove: 0.005 }
      }
    ];
  },
  // Warning on any failure at all, blocking once the rate passes half a percent
  // — at that point the per-ticker expirations call is no longer doing its job.
  promoteToBlockingAtValue: 0.005
};

export const QC413_RENEW_STORM: CheckDefinition = {
  id: 'QC-413',
  domain: 'chains',
  severity: 'warning',
  description:
    'How many E*Trade OAuth renew calls this run made. Renew-and-retry on any failure is correct ' +
    'hardening, but a run that renews dozens of times is not recovering from dormancy — it is ' +
    'failing at something else and renewing at it, which the retry loop would otherwise hide ' +
    'completely.',
  readsTables: ['meta_response'],
  testedQuantity: 'renew_call_count',
  testedUnit: 'count',
  thresholds: { maxRenewsPerRun: 20 },
  thresholdBasis: 'working',
  run(ctx) {
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS renews FROM meta_response
          WHERE run_id = ? AND endpoint LIKE '%renew_access_token%'`
      )
      .get(ctx.runId) as { renews: number };

    return [
      {
        key: ctx.tradingDate,
        value: row.renews,
        fired: row.renews > this.thresholds['maxRenewsPerRun']!,
        detail: `${row.renews} token renewals this run`,
        evidence: { renews: row.renews }
      }
    ];
  }
};

export const CHAIN_CHECKS: readonly CheckDefinition[] = [
  QC401_SUBSET_COVERAGE,
  QC402_EXPIRATION_COVERAGE,
  QC403_PARSE_COUNT_EQUALITY,
  QC404_BID_ASK_SANITY,
  QC405_IV_RANGE,
  QC406_LADDER_INTEGRITY,
  QC407_UNDERLYING_DISAGREEMENT,
  QC408_ZERO_VOLUME_DEFAULT,
  QC409_STICKY_SET_HONOURED,
  QC410_GREEK_REPRODUCTION,
  QC411_WEEKEND_EXPIRATION,
  QC412_CHAIN_ERROR_RATE,
  QC413_RENEW_STORM
];
