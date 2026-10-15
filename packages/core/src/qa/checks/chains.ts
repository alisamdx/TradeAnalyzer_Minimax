import type { CheckContext, CheckDefinition, Evaluation } from '../check.js';
import { bsDelta, impliedSpotFromDelta, paritySpot } from '../black-scholes.js';

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
    'A quoted contract has bid <= ask and an ask no larger than three times the most the contract ' +
    'can be worth: the underlying for a call, the strike for a put. The spread, not the last trade, ' +
    'is what a position actually costs, so a crossed or absurd quote is worth seeing before anything ' +
    'prices against it. The bound depends on the right — a deep in-the-money put is worth nearly its ' +
    'strike, so on a collapsed underlying its ask is legitimately many times the share price (BMNR ' +
    '$95 put at $73.45 on a $22.81 stock, 2026-09-16), and an underlying-only bound fired on 476 correct quotes. ' +
    'Open findings are re-judged on their own recorded quote under the current rule, and closed as ' +
    'rule_changed when it would not have fired.',
  readsTables: ['raw_option_contract_snapshot', 'qa_exception'],
  testedQuantity: 'ask_over_max_value_ratio',
  testedUnit: 'ratio',
  thresholds: { maxAskOverMaxValue: 3 },
  thresholdBasis: 'structural',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT osi_symbol, "right", strike, bid, ask, underlying_price FROM raw_option_contract_snapshot
          WHERE as_of_date = ? AND price_status = 'ok' AND underlying_price > 0 AND strike > 0`
      )
      .all(ctx.tradingDate) as {
      osi_symbol: string;
      right: 'call' | 'put';
      strike: number;
      bid: number;
      ask: number;
      underlying_price: number;
    }[];

    const maxRatio = this.thresholds['maxAskOverMaxValue']!;
    const out = rows.map((r): Evaluation => {
      // A call can never be worth more than the share; a put never more than its strike.
      const isPut = r.right === 'put';
      const maxValue = isPut ? r.strike : r.underlying_price;
      const ratio = r.ask / maxValue;
      const crossed = r.bid > r.ask;
      return {
        key: r.osi_symbol,
        value: ratio,
        fired: crossed || ratio > maxRatio,
        detail: crossed
          ? `${r.osi_symbol}: bid ${r.bid} above ask ${r.ask}`
          : `${r.osi_symbol}: ask ${r.ask} is ${ratio.toFixed(2)}x the ${isPut ? `strike ${r.strike}` : `underlying ${r.underlying_price}`}`,
        evidence: {
          osiSymbol: r.osi_symbol, right: r.right, strike: r.strike, bid: r.bid, ask: r.ask,
          underlying: r.underlying_price, maxValue, crossed
        }
      };
    });
    return rejudgeOpenFindings(ctx, out, maxRatio);
  }
};

/**
 * QC-404's open findings, judged again on their OWN stored quote under the current rule (v1.1.281).
 *
 * Until v1.1.251 the bound was the underlying for both rights, and it fired on 519 deep
 * in-the-money puts whose ask was correct — BMNR's $95 put at $73.45 on a $22.81 stock. The rule
 * was fixed, and every one of those findings stayed open for ever: the contract's quote today is a
 * different quote, so "clean today" says nothing about the day it fired, and there is no
 * remediation for a finding the check should never have raised.
 *
 * What does settle it is the finding's own evidence: the ask, bid and underlying it recorded, with
 * the right and strike read from the symbol (older evidence did not store them). If the CURRENT
 * rule would not fire on that exact quote, the verdict came from the old rule, and the gate closes
 * it `rule_changed`. A finding the current rule would still fire on stays open, whatever today's
 * quote says — that is a stopped-firing finding, and those are the operator's (P9).
 */
function rejudgeOpenFindings(ctx: CheckContext, today: Evaluation[], maxRatio: number): Evaluation[] {
  const open = ctx.db
    .prepare(`SELECT key, evidence_json FROM qa_exception WHERE check_id = 'QC-404' AND state IN ('open', 'acknowledged')`)
    .all() as { key: string; evidence_json: string }[];
  if (open.length === 0) return today;

  const byKey = new Map(today.map((e, i) => [e.key, i]));
  const out = [...today];
  for (const f of open) {
    const tail = /(\d{6})([CP])(\d{8})$/.exec(f.key);
    let e: { bid?: unknown; ask?: unknown; underlying?: unknown };
    try {
      e = JSON.parse(f.evidence_json) as typeof e;
    } catch {
      continue;
    }
    if (!tail || typeof e.ask !== 'number' || typeof e.bid !== 'number' || typeof e.underlying !== 'number') continue;
    const isPut = tail[2] === 'P';
    const strike = Number(tail[3]) / 1000;
    const maxValue = isPut ? strike : e.underlying;
    if (!(maxValue > 0)) continue;
    const ratio = e.ask / maxValue;
    if (e.bid > e.ask || ratio > maxRatio) continue; // the current rule fires on it too

    const closesAs = {
      kind: 'rule_changed' as const,
      note:
        `re-judged on its own quote under the current rule: ask ${e.ask} is ${ratio.toFixed(2)}x the ` +
        `${isPut ? `strike ${strike}` : `underlying ${e.underlying}`}, within ${maxRatio}x — raised under the ` +
        'underlying-only bound, which a deep in-the-money put exceeds legitimately'
    };
    const i = byKey.get(f.key);
    if (i === undefined) {
      // Not quoted today. No value: the distribution is today's quotes, not re-judged history.
      out.push({ key: f.key, fired: false, closesAs });
    } else if (!out[i]!.fired) {
      out[i] = { ...out[i]!, closesAs };
    }
    // Firing today on today's quote: a live finding, left to fire.
  }
  return out;
}

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
    'The underlying price E*Trade returns with a chain agrees with the Polygon snapshot session close ' +
    'for the same ticker and day. Two independent readings of one number, from two providers, on the ' +
    'same run: the cheapest cross-source check the chain domain has. Until v1.1.252 it compared against ' +
    '`raw_eod_quote.last`, which Polygon never sends on this plan (`lastTrade` needs a trades ' +
    'entitlement): every row of 2026-09-14 to 2026-09-16 had last null, the join matched nothing, and ' +
    'the check evaluated zero tickers on every run while reporting no finding. `nearPrice` is the ' +
    'session close (qc410-study H7: equal to the bar close on all 547 tickers of 2026-09-16), so ' +
    '`day_close` is the like-for-like reading. When quotes exist but none carries a usable close, the ' +
    'check now says so instead of evaluating nothing.',
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
    // Latest quote observation per ticker: a re-run stores the snapshot again, and
    // joining every copy let an arbitrary one stand in for the day.
    const rows = ctx.db
      .prepare(
        `SELECT c.ticker, AVG(c.underlying_price) AS chain_price, q.day_close AS quote_price
           FROM raw_option_contract_snapshot c
           JOIN (SELECT ticker, day_close, MAX(observed_at) AS latest FROM raw_eod_quote
                  WHERE as_of_date = ? AND day_status = 'ok' AND day_close > 0
                  GROUP BY ticker) q
             ON q.ticker = c.ticker
          WHERE c.as_of_date = ? AND c.underlying_price > 0
          GROUP BY c.ticker`
      )
      .all(ctx.tradingDate, ctx.tradingDate) as { ticker: string; chain_price: number; quote_price: number }[];

    if (rows.length === 0) {
      const quotes = ctx.db
        .prepare('SELECT COUNT(*) AS n FROM raw_eod_quote WHERE as_of_date = ?')
        .get(ctx.tradingDate) as { n: number };
      const chains = ctx.db
        .prepare('SELECT COUNT(*) AS n FROM raw_option_contract_snapshot WHERE as_of_date = ? AND underlying_price > 0')
        .get(ctx.tradingDate) as { n: number };
      // Both sides captured and nothing comparable: that is the finding, not a pass.
      if (quotes.n > 0 && chains.n > 0) {
        return [
          {
            key: `coverage:${ctx.tradingDate}`,
            value: 1,
            fired: true,
            detail:
              `${quotes.n} Polygon quote rows and ${chains.n} chain rows for ${ctx.tradingDate}, but no ticker ` +
              'has a usable session close to compare against: the cross-check evaluated nothing',
            evidence: { quoteRows: quotes.n, chainRows: chains.n }
          }
        ];
      }
      return [];
    }

    return rows.map((r) => {
      const disagreement = Math.abs(r.chain_price - r.quote_price) / r.quote_price;
      return {
        key: r.ticker,
        value: disagreement,
        fired: disagreement > this.thresholds['maxAbsDisagreement']!,
        detail: `${r.ticker}: chain underlying ${r.chain_price.toFixed(2)} vs Polygon close ${r.quote_price.toFixed(2)} (${(disagreement * 100).toFixed(2)}%)`,
        evidence: { ticker: r.ticker, chainPrice: r.chain_price, quoteClose: r.quote_price }
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
  readsTables: ['ref_sticky_contract', 'raw_option_contract_snapshot', 'qa_exception', 'meta_run', 'meta_response'],
  testedQuantity: 'unhonoured_pin_count',
  testedUnit: 'count',
  thresholds: { maxUnhonoured: 0 },
  thresholdBasis: 'structural',
  remediation: 'R1',
  // Keyed on the pin's symbol, which since v1.1.248 (space padding) and v1.1.269 (the class-share
  // dot) is built exactly as E*Trade sends it: a dotless root dash-padded to six, 21 characters.
  // 415 findings keyed `AIZ   261016C…` and two keyed `BRK.B-261016P…` belong to pins the repair
  // closed, so the check can never produce those keys again; the gate retires them (v1.1.281).
  keyShape: {
    pattern: /^(?=.{21}$)[A-Z0-9]{1,6}-{0,5}\d{6}[CP]\d{8}$/,
    note: "keyed on E*Trade's dash-padded OSI since v1.1.248/v1.1.269; the pin behind this key was re-rooted"
  },
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
    const has = (osi: string, date: string): boolean => captured.get(osi, date) !== undefined;

    // The dates each open finding missed: the trading dates of its first and last firing run.
    // A finding closes itself only when the pin is captured tonight AND those dates now hold a
    // snapshot, i.e. the day was re-collected (v1.1.329). On 2026-09-22 run 28 collected nothing from
    // E*Trade and raised 1,004 of these; run 30 re-collected the date and captured every pin. But
    // the only way to close was remediation R1, which never ran, so all 1,004 stayed open and
    // blocking. A pin that works again after a day nobody re-collected has left a real hole in a
    // held contract's price history. The gate cannot repair that, so it stays open for the operator.
    const missed = new Map<string, { first: string; last: string }>();
    for (const r of ctx.db
      .prepare(
        `SELECT e.key, f.trading_date AS first, l.trading_date AS last FROM qa_exception e
           JOIN meta_run f ON f.run_id = e.first_seen_run_id
           JOIN meta_run l ON l.run_id = e.last_seen_run_id
          WHERE e.check_id = 'QC-409' AND e.state IN ('open', 'acknowledged')`
      )
      .all() as { key: string; first: string; last: string }[]) {
      missed.set(r.key, { first: r.first, last: r.last });
    }

    // A pin on an underlying E*Trade no longer lists is QC-415's finding, once per ticker (v1.1.347).
    // Re-collecting cannot honour it, so firing here put one permanent blocking row per contract on the
    // gate: 60 of 2026-10-09's 61, on MDT (204 since 10-06), PSKY and WBD (400 "symbol is invalid").
    // Its open finding closes `rule_changed` only when the ticker was ALSO unlisted on the finding's
    // last missed date, so a gap with another cause (a dead token, a skipped run) stays open.
    const unlisted = unlistedCache(ctx.db);
    const tonight = unlisted(ctx.tradingDate);

    return pins.map((p) => {
      const gap = missed.get(p.osi_symbol);
      const gone = tonight.get(p.ticker);
      if (gone) {
        const explained = gap !== undefined && unlisted(gap.last).has(p.ticker);
        return {
          key: p.osi_symbol,
          fired: false,
          closesAs: explained
            ? {
                kind: 'rule_changed' as const,
                note: `${p.osi_symbol}: E*Trade lists no options for ${p.ticker} (${gone.answer}` +
                  `${gone.lastListed ? `, last listed ${gone.lastListed}` : ''}); reported per ticker by QC-415`
              }
            : undefined
        } satisfies Evaluation;
      }
      const ok = has(p.osi_symbol, ctx.tradingDate);
      const refilled = ok && gap !== undefined && has(p.osi_symbol, gap.first) && has(p.osi_symbol, gap.last);
      return {
        key: p.osi_symbol,
        value: ok ? 0 : 1,
        fired: !ok,
        detail: `${p.osi_symbol} is pinned (${p.reason}) but has no snapshot for ${ctx.tradingDate}`,
        evidence: { osiSymbol: p.osi_symbol, ticker: p.ticker, reason: p.reason },
        closesAs: refilled
          ? {
              kind: 'data_corrected' as const,
              note: `${p.osi_symbol}: the missed ${gap.first === gap.last ? gap.first : `${gap.first}…${gap.last}`} ` +
                `was re-collected and the pin is captured on ${ctx.tradingDate}`
            }
          : undefined
      } satisfies Evaluation;
    });
  }
};

/** E*Trade's answer for a symbol with nothing to list: 204 (no expirations) or 400 (symbol invalid). */
const UNLISTED_EXPIRATION_STATUSES = new Set([204, 400]);

export interface UnlistedUnderlying {
  /** What E*Trade answered, for the detail line: `HTTP 204, no expirations` or `HTTP 400`. */
  readonly answer: string;
  /** The latest trading date on which its expirations call returned 200, or null. */
  readonly lastListed: string | null;
}

/**
 * The tickers E*Trade listed no options for on one trading date (v1.1.347).
 *
 * Read from that date's LAST `optionexpiredate` response per symbol, across every run filed under the
 * date, and only when no contract for the ticker was stored that date — a symbol that answered 204 once
 * and was then collected is listed. A call never sent (a latched token, `http_status` null) or a 401 is
 * a collection failure, never evidence of a delisting, so neither counts.
 */
export function unlistedUnderlyings(db: CheckContext['db'], tradingDate: string): Map<string, UnlistedUnderlying> {
  const rows = db
    .prepare(
      `SELECT json_extract(r.params_json, '$.symbol') AS symbol, r.http_status
         FROM meta_response r
        WHERE r.provider = 'etrade' AND r.endpoint = '/v1/market/optionexpiredate'
          AND r.run_id IN (SELECT run_id FROM meta_run WHERE trading_date = ?)
        ORDER BY r.source_response_id`
    )
    .all(tradingDate) as { symbol: string | null; http_status: number | null }[];
  const latest = new Map<string, number | null>();
  for (const r of rows) if (r.symbol) latest.set(r.symbol, r.http_status);

  const out = new Map<string, UnlistedUnderlying>();
  const stored = db.prepare(
    'SELECT 1 FROM raw_option_contract_snapshot WHERE ticker = ? AND as_of_date = ? LIMIT 1'
  );
  const lastListed = db.prepare(
    `SELECT MAX(n.trading_date) AS d
       FROM meta_response r JOIN meta_run n ON n.run_id = r.run_id
      WHERE r.provider = 'etrade' AND r.endpoint = '/v1/market/optionexpiredate'
        AND json_extract(r.params_json, '$.symbol') = ? AND r.http_status = 200 AND n.trading_date < ?`
  );
  for (const [symbol, status] of latest) {
    if (status === null || !UNLISTED_EXPIRATION_STATUSES.has(status)) continue;
    if (stored.get(symbol, tradingDate) !== undefined) continue;
    const last = lastListed.get(symbol, tradingDate) as { d: string | null } | undefined;
    out.set(symbol, {
      answer: status === 204 ? 'HTTP 204, no expirations' : `HTTP ${String(status)}`,
      lastListed: last?.d ?? null
    });
  }
  return out;
}

/** Memoised per date for one check run: QC-409 asks once for tonight and once per open finding's date. */
function unlistedCache(db: CheckContext['db']): (date: string) => Map<string, UnlistedUnderlying> {
  const byDate = new Map<string, Map<string, UnlistedUnderlying>>();
  return (date) => {
    let m = byDate.get(date);
    if (!m) byDate.set(date, (m = unlistedUnderlyings(db, date)));
    return m;
  };
}

export const QC415_PINNED_UNDERLYING_UNLISTED: CheckDefinition = {
  id: 'QC-415',
  domain: 'chains',
  severity: 'warning',
  description:
    'A ticker with live pins whose options E*Trade no longer lists (expirations answered 204 or 400, ' +
    'no contract stored). One finding per ticker, where QC-409 would raise one per pinned contract that ' +
    're-collection can never honour. A warning for recommended pins; blocking when any pin is a ' +
    'held position, since that contract still needs a price and the operator must get one elsewhere.',
  readsTables: ['ref_sticky_contract', 'meta_response', 'meta_run', 'raw_option_contract_snapshot'],
  testedQuantity: 'held_pin_count',
  testedUnit: 'count',
  thresholds: { maxHeldPins: 0 },
  thresholdBasis: 'structural',
  promoteToBlockingAtValue: 0,
  // A provider property: "still unlisted tonight" is the expected state, not new evidence (§5.4).
  escalatesOnRepeat: false,
  run(ctx) {
    const pins = ctx.db
      .prepare(
        `SELECT ticker, reason, COUNT(*) AS n, MIN(expiration_date) AS first_expiry, MAX(expiration_date) AS last_expiry
           FROM ref_sticky_contract
          WHERE valid_to IS NULL AND expiration_date >= ?
          GROUP BY ticker, reason`
      )
      .all(ctx.tradingDate) as { ticker: string; reason: string; n: number; first_expiry: string; last_expiry: string }[];
    if (pins.length === 0) return [];

    const byTicker = new Map<string, { reasons: Record<string, number>; held: number; last: string }>();
    for (const p of pins) {
      const t = byTicker.get(p.ticker) ?? { reasons: {}, held: 0, last: p.last_expiry };
      t.reasons[p.reason] = p.n;
      if (p.reason === 'held_in_book') t.held += p.n;
      if (p.last_expiry > t.last) t.last = p.last_expiry;
      byTicker.set(p.ticker, t);
    }

    const unlisted = unlistedUnderlyings(ctx.db, ctx.tradingDate);
    return [...byTicker].map(([ticker, t]) => {
      const gone = unlisted.get(ticker);
      const total = Object.values(t.reasons).reduce((a, b) => a + b, 0);
      if (!gone) {
        return {
          key: ticker,
          value: t.held,
          fired: false,
          closesAs: { kind: 'provider_fixed' as const, note: `${ticker}: E*Trade lists options again on ${ctx.tradingDate}` }
        } satisfies Evaluation;
      }
      const reasons = Object.entries(t.reasons).map(([r, n]) => `${n} ${r}`).join(', ');
      return {
        key: ticker,
        value: t.held,
        fired: true,
        detail:
          `${ticker}: E*Trade lists no options (${gone.answer}${gone.lastListed ? `, last listed ${gone.lastListed}` : ''}); ` +
          `${total} pinned contract(s) (${reasons}) cannot be priced, the last expiring ${t.last}`,
        evidence: { ticker, answer: gone.answer, lastListed: gone.lastListed, pins: t.reasons, heldPins: t.held, lastExpiry: t.last }
      } satisfies Evaluation;
    });
  }
};

/** Roughly at the money — where a delta responds to spot and is easiest to invert. */
const ATM_BAND = 0.05;

/** Enough contracts that a per-ticker median is a reading and not one strike. */
const MIN_IMPLIED_CONTRACTS = 5;
const MIN_PARITY_PAIRS = 3;

/** A pair's quote is usable for parity only when its spread says it is a market. */
const MAX_PARITY_SPREAD = 0.5;

/** Below this many invertible contracts the scale verdict is not a reading. */
const MIN_CONTRACTS_FOR_SCALE_VERDICT = 100;

interface GreekRow {
  osi_symbol: string;
  ticker: string;
  strike: number;
  right: 'call' | 'put';
  iv: number;
  delta: number;
  bid: number | null;
  ask: number | null;
  underlying_price: number;
  expiration_date: string;
}

/**
 * The 3M rate and the latest observation of each ATM contract for the day,
 * shared by QC-410 and QC-414. A re-run on one date stores every contract again,
 * and measuring both copies counted each twice (126,396 observations of 63,198
 * contracts on 2026-09-15). Null when no rate is stored.
 */
function loadAtmGreeks(ctx: CheckContext, ticker?: string): { rate: number; rows: GreekRow[] } | null {
  const rate = ctx.db
    .prepare(
      `SELECT yield FROM raw_treasury_yield
        WHERE tenor = '3M' AND curve_date <= ?
        ORDER BY curve_date DESC LIMIT 1`
    )
    .get(ctx.tradingDate) as { yield: number } | undefined;
  // Skipped, not failed: without a rate there is no comparison to make, and
  // claiming one from a default would be exactly the fabrication P4 forbids.
  if (!rate) return null;
  // One ticker for a reader (`greekConsistencyFor`), every ticker for the check.
  const only = ticker === undefined ? '' : 'AND ticker = ?';
  const rows = ctx.db
    .prepare(
      `SELECT s.osi_symbol, s.ticker, s.strike, s."right", s.iv, s.delta, s.bid, s.ask,
              s.underlying_price, s.expiration_date
         FROM raw_option_contract_snapshot s
         JOIN (SELECT osi_symbol, MAX(observed_at) AS latest FROM raw_option_contract_snapshot
                WHERE as_of_date = ? ${only} GROUP BY osi_symbol) m
           ON m.osi_symbol = s.osi_symbol AND m.latest = s.observed_at
        WHERE s.as_of_date = ? AND s.iv_status = 'ok' AND s.greeks_status = 'ok'
          AND s.delta IS NOT NULL AND s.underlying_price > 0
          AND ABS(s.strike - s.underlying_price) <= s.underlying_price * ?`
    )
    .all(...(ticker === undefined
      ? [ctx.tradingDate, ctx.tradingDate, ATM_BAND]
      : [ctx.tradingDate, ticker, ctx.tradingDate, ATM_BAND])) as GreekRow[];
  return { rate: rate.yield, rows };
}

function dteOn(tradingDate: string, expiration: string): number {
  return Math.round((Date.parse(`${expiration}T00:00:00Z`) - Date.parse(`${tradingDate}T00:00:00Z`)) / 86_400_000);
}

/** Saturated deltas are flat in spot: they cannot be inverted and say nothing about scale. */
function invertible(delta: number, dteDays: number): boolean {
  return dteDays >= 1 && Math.abs(delta) >= 0.05 && Math.abs(delta) <= 0.95;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

export const QC410_GREEK_REPRODUCTION: CheckDefinition = {
  id: 'QC-410',
  domain: 'chains',
  severity: 'warning',
  description:
    "A ticker's Greeks were computed off the price its chain reports. Per ticker, the spot at which " +
    "our Black-Scholes delta equals the provider's (median over ATM contracts) is compared with the " +
    "chain's `underlying_price`, which QC-407 cross-checks against Polygon's session close (549 of 549 " +
    'agreeing on 2026-09-16), AND with the put-call-parity spot of the quoted mids; it fires only when ' +
    'the Greeks are more than 1 % from BOTH. A dividend before expiry separates the two readings, and ' +
    "which one a provider's Greeks follow depends on whether its model prices the dividend: parity alone " +
    'flagged EIX, CMCSA and CLX (Greeks 54.72 on a 54.81 chain, parity 53.00), the chain alone flagged ' +
    'BBY, AJG, DY, EXPE, FPS and IQV (BBY Greeks 90.97, parity 91.17, chain 92.45). Measured 2026-09-15/16 over ' +
    '~500 tickers: parity reproduced the session close to a median of -0.03 %, while 50-70 tickers a ' +
    'day carried deltas implying a different price: PCTY 113.6 on a 147.3 close on BOTH days, JAZZ ' +
    '249.65 then 249.67 while the stock moved. Any consumer selecting strikes by provider delta picks ' +
    'the wrong contract on a flagged ticker. Until v1.1.252 this fired on the share of ALL ATM ' +
    'contracts breaching a 0.05 delta tolerance, so a handful of broken tickers turned the whole ' +
    'domain RED without naming them. QC-414 carries the scale question it used to answer. A missing ' +
    "3M rate skips the check, because a missing rate is QC-902's finding.",
  readsTables: ['raw_option_contract_snapshot', 'raw_treasury_yield'],
  // Per ticker since v1.1.252; it was per contract before (`ADP---260918C00275000`), and
  // those findings can never fire again. Tickers here are letters, digits and a class dot.
  keyShape: { pattern: /^[A-Z][A-Z0-9.]{0,9}$/, note: 'keyed per ticker since v1.1.252, per contract before' },
  // A persistent E*Trade property on 60–80 tickers a night, already handled per ticker where it is
  // consumed (TA1 STALE_GREEK_GUARD withholds the deltas; TA2 `greekConsistencyFor`). Escalating each
  // ticker on repeat held the chains domain `unusable` for good over something no action here can
  // repair (v1.1.328).
  escalatesOnRepeat: false,
  testedQuantity: 'abs_delta_spot_vs_nearest_price_reading_fraction',
  testedUnit: 'fraction',
  thresholds: { maxSpotDisagreement: 0.01 },
  thresholdBasis: 'measured',
  thresholdEvidence:
    'qc410-study.mjs on 2026-09-15 and 2026-09-16. Per ticker, the share of contracts breaching a 0.05 ' +
    'delta tolerance, by |delta-implied spot - close|: <0.1 % 0.9-1.5 %, 0.1-0.25 % 1.3-2.8 %, ' +
    '0.25-0.5 % 3.5-4.9 %, 0.5-1 % 11.7-19.7 %, 1-3 % 39-48 %, >3 % 86-94 %. Past 1 % the provider ' +
    "delta disagrees with our model on nearly half the ticker's contracts. Parity vs close: median " +
    '-0.03 % / -0.07 %, p5-p95 about -0.9 % to +0.35 %.',
  run(ctx) {
    const loaded = loadAtmGreeks(ctx);
    if (!loaded) return [];
    const { rate, rows } = loaded;

    const byTicker = new Map<string, GreekRow[]>();
    for (const r of rows) {
      const list = byTicker.get(r.ticker) ?? [];
      list.push(r);
      byTicker.set(r.ticker, list);
    }

    const maxGap = this.thresholds['maxSpotDisagreement']!;
    const evaluations: Evaluation[] = [];
    for (const [ticker, list] of [...byTicker].sort((a, b) => a[0].localeCompare(b[0]))) {
      const e = assessTickerGreeks(ticker, list, ctx.tradingDate, rate, maxGap);
      if (e) evaluations.push(e);
    }
    return evaluations;
  }
};

/**
 * Whether one ticker's provider Greeks are usable on one date — QC-410's verdict, for a
 * reader (v1.1.272). TradeAnalyzer 2's chain view showed E*Trade's deltas with no sign that
 * the gate had flagged them, on the 50-70 tickers a day whose Greeks imply a different price
 * than the chain's own quotes. Same code path as the check, so the two cannot disagree.
 *
 * Null when there is nothing to judge: no 3M rate stored, or too few near-the-money contracts.
 */
export function greekConsistencyFor(
  db: CheckContext['db'],
  tradingDate: string,
  ticker: string
): { readonly usable: boolean; readonly detail: string } | null {
  const loaded = loadAtmGreeks({ db, runId: 0, tradingDate, observedAt: '' }, ticker);
  if (!loaded || loaded.rows.length === 0) return null;
  const e = assessTickerGreeks(
    ticker, loaded.rows, tradingDate, loaded.rate,
    QC410_GREEK_REPRODUCTION.thresholds['maxSpotDisagreement']!
  );
  return e ? { usable: !e.fired, detail: e.detail ?? '' } : null;
}

function assessTickerGreeks(
  ticker: string,
  list: readonly GreekRow[],
  tradingDate: string,
  rate: number,
  maxGap: number
): Evaluation | null {
  const mid = (r: GreekRow | undefined): number | null =>
    r && r.bid !== null && r.ask !== null && r.bid > 0 && r.ask > r.bid &&
    (r.ask - r.bid) / ((r.ask + r.bid) / 2) <= MAX_PARITY_SPREAD
      ? (r.bid + r.ask) / 2
      : null;

  const implied: number[] = [];
  for (const r of list) {
    const dteDays = dteOn(tradingDate, r.expiration_date);
    if (!invertible(r.delta, dteDays)) continue;
    const spot = impliedSpotFromDelta({
      delta: r.delta, nearSpot: r.underlying_price, strike: r.strike, dteDays, iv: r.iv, rate, right: r.right
    });
    if (spot !== null) implied.push(spot);
  }

  const pairs = new Map<string, { call?: GreekRow; put?: GreekRow }>();
  for (const r of list) {
    const k = `${r.expiration_date}|${r.strike}`;
    const pair = pairs.get(k) ?? {};
    pair[r.right] = r;
    pairs.set(k, pair);
  }
  const parity: number[] = [];
  for (const { call, put } of pairs.values()) {
    const callMid = mid(call);
    const putMid = mid(put);
    if (!call || callMid === null || putMid === null) continue;
    const spot = paritySpot({
      callMid, putMid, strike: call.strike, dteDays: dteOn(tradingDate, call.expiration_date), rate
    });
    if (spot !== null) parity.push(spot);
  }

  const chainSpot = list[0]!.underlying_price;
  const quoteSpot = parity.length >= MIN_PARITY_PAIRS ? median(parity) : null;

  // The worst case cannot be inverted. Greeks computed off a price far enough
  // away pin every near-the-money delta at 0 or 1 (PCTY's $140 put read -1.000
  // on a 147.32 close), so a ticker judged only on invertible contracts would
  // drop out of the check at exactly the moment it is most wrong. A provider
  // delta that is pinned where our model at the chain's spot is plainly not
  // (0.2-0.8) is the same finding, read directly.
  let pinned = 0;
  for (const r of list) {
    const dteDays = dteOn(tradingDate, r.expiration_date);
    // Out of [-1, 1] is not pinned, it is a unit fault: QC-414's finding, feed-wide.
    if (dteDays < 1 || Math.abs(r.delta) > 1 || (Math.abs(r.delta) >= 0.05 && Math.abs(r.delta) <= 0.95)) continue;
    const model = bsDelta({ spot: chainSpot, strike: r.strike, dteDays, iv: r.iv, rate, right: r.right });
    if (model !== null && Math.abs(model) >= 0.2 && Math.abs(model) <= 0.8) pinned++;
  }

  const measurable = implied.length >= MIN_IMPLIED_CONTRACTS;
  if (!measurable && pinned < MIN_IMPLIED_CONTRACTS) return null;
  const deltaSpot = measurable ? median(implied) : null;
  // The Greeks are consistent if they agree with EITHER reading of the price.
  // A dividend before expiry separates the two, and which one a provider's
  // Greeks follow depends on whether its model prices the dividend: EIX's
  // matched the chain and not parity, BBY's matched parity (90.97 vs 91.17)
  // and not the chain (92.45). A broken Greek engine is far from both (AIZ
  // 12.2 % and 12.0 %). Measured on 2026-09-16: 7 of 33 flagged tickers were
  // within 1 % of one reading, and every one of them was a dividend-shaped gap.
  // With no invertible contracts the disagreement has no size, only a
  // direction; 1 stands for "beyond anything the spot comparison can measure".
  const gapChain = deltaSpot === null ? 1 : Math.abs(deltaSpot / chainSpot - 1);
  const gapParity = deltaSpot === null || quoteSpot === null ? null : Math.abs(deltaSpot / quoteSpot - 1);
  const gap = gapParity === null ? gapChain : Math.min(gapChain, gapParity);
  const fired = gap > maxGap || pinned >= MIN_IMPLIED_CONTRACTS;
  return {
    key: ticker,
    value: gap,
    fired,
    detail:
      (deltaSpot === null
        ? `${ticker}: ${pinned} near-the-money deltas pinned at 0 or 1 on a chain at ${chainSpot}`
        : `${ticker}: Greeks imply spot ${deltaSpot.toFixed(2)} on a chain at ${chainSpot} ` +
          `(${(gapChain * 100).toFixed(1)}% apart${pinned > 0 ? `, ${pinned} deltas pinned` : ''})`) +
      (quoteSpot === null
        ? ''
        : `; option quotes imply ${quoteSpot.toFixed(2)}${gapParity === null ? '' : ` (${(gapParity * 100).toFixed(1)}% apart)`}`) +
      '; provider delta is not usable for strike selection on this ticker today',
    evidence: {
      ticker,
      deltaImpliedSpot: deltaSpot,
      paritySpot: quoteSpot,
      chainUnderlying: chainSpot,
      impliedContracts: implied.length,
      pinnedContracts: pinned,
      parityPairs: parity.length
    },
    // Consistency is a claim about TODAY's chain, re-fetched every run, so a clean reading settles
    // an open finding (v1.1.318). Before this a ticker that drifted back under 1 % left its finding
    // open for ever: 132 open against 69 firing on 2026-09-23, 89 of them warnings nobody could act on.
    closesAs: fired
      ? undefined
      : {
          kind: 'provider_fixed',
          note: `${ticker}: Greeks now within ${(maxGap * 100).toFixed(0)}% of the chain or parity price ` +
            `(${(gap * 100).toFixed(2)}%) on ${tradingDate}`
        }
  };
}

export const QC414_GREEK_SCALE: CheckDefinition = {
  id: 'QC-414',
  domain: 'chains',
  severity: 'blocking',
  description:
    "The provider's Greeks are on the scale the dictionary claims. Split out of QC-410 when that check " +
    'became per ticker (v1.1.252): a unit fault (a sign flip, delta per contract instead of per share) ' +
    'makes the provider delta unreachable by Black-Scholes at any plausible spot, so no ticker would ' +
    "reach QC-410's minimum and it would evaluate nothing. The signature is a low share of ATM contracts " +
    'whose delta is reachable: outside [-1, 0] for a put or [0, 1] for a call is never reachable, a ' +
    'pinned in-range delta cannot be told apart and counts as reachable, and anything else must invert ' +
    'to a spot within half to one-and-a-half times the chain underlying. IV stored as a percentage never ' +
    "gets this far: the chain converter's 0 < iv < 5 assertion marks it invalid at ingestion.",
  readsTables: ['raw_option_contract_snapshot', 'raw_treasury_yield'],
  testedQuantity: 'solvable_contract_fraction',
  testedUnit: 'fraction',
  thresholds: { minSolvableFraction: 0.5 },
  thresholdBasis: 'working',
  thresholdEvidence:
    'Every one of 5,135 contracts breaching the old contract-level tolerance on 2026-09-16 was solvable, ' +
    'including those on tickers whose Greeks were computed off a price 20 % away; a scale fault moves ' +
    'nearly every contract out of reach at once. To be set from the pilot distribution.',
  run(ctx) {
    const loaded = loadAtmGreeks(ctx);
    if (!loaded) return [];
    let attempted = 0;
    let solvable = 0;
    for (const r of loaded.rows) {
      const dteDays = dteOn(ctx.tradingDate, r.expiration_date);
      if (dteDays < 1) continue;
      attempted++;
      // Filtering to invertible deltas first would hide the faults this exists for:
      // a delta of 52 or a put delta of +0.4 is simply not invertible.
      const inRange = r.right === 'call' ? r.delta >= 0 && r.delta <= 1 : r.delta >= -1 && r.delta <= 0;
      if (!inRange) continue;
      if (!invertible(r.delta, dteDays)) {
        solvable++;
        continue;
      }
      const spot = impliedSpotFromDelta({
        delta: r.delta, nearSpot: r.underlying_price, strike: r.strike, dteDays, iv: r.iv, rate: loaded.rate, right: r.right
      });
      if (spot !== null) solvable++;
    }
    if (attempted < MIN_CONTRACTS_FOR_SCALE_VERDICT) return [];
    const fraction = solvable / attempted;
    return [
      {
        key: ctx.tradingDate,
        value: fraction,
        fired: fraction < this.thresholds['minSolvableFraction']!,
        detail:
          `${solvable} of ${attempted} ATM contracts have a delta reachable at a plausible spot ` +
          `(${(fraction * 100).toFixed(1)}%); the Greeks may not be on the scale the dictionary claims`,
        evidence: { attempted, solvable, fraction }
      }
    ];
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
  // Until v1.1.362 this counted `meta_response` rows matching `renew_access_token`. The host
  // renews inside its own transport, so no such row was ever written and the check could
  // not fire (gen-002, 2026-10-14: zero renew rows across every run). It now reads the
  // count the daily run records from the host.
  readsTables: ['meta_run'],
  testedQuantity: 'renew_call_count',
  testedUnit: 'count',
  thresholds: { maxRenewsPerRun: 20 },
  thresholdBasis: 'working',
  run(ctx) {
    const row = ctx.db
      .prepare('SELECT etrade_renew_count AS renews FROM meta_run WHERE run_id = ?')
      .get(ctx.runId) as { renews: number | null } | undefined;
    // NULL means nobody counted (a host that does not report, or a run before v1.1.362).
    // Evaluating nothing keeps that apart from a measured zero.
    if (row?.renews === null || row?.renews === undefined) return [];

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
  QC413_RENEW_STORM,
  QC414_GREEK_SCALE,
  QC415_PINNED_UNDERLYING_UNLISTED
];
