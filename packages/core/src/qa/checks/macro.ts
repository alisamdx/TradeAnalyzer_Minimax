import type { CheckDefinition, Evaluation } from '../check.js';
import { FUND_TYPES, fundFindingClosers, departedFindingClosers } from './earnings-fundamentals.js';
import { tradingDaysInRange } from '../../collector/trading-calendar.js';
import { EVENTS_RULE } from '../../collector/phases/events.js';

/**
 * Macro, rates and sentiment-side checks — 03 §3.8.
 *
 * QC-901 has a lineage worth keeping visible. The existing app's brief job
 * fetches VIX from E*Trade because Polygon's *stocks* snapshot cannot serve an
 * index, and its range guard existed to cover an **unverified symbol**. The
 * symbol was confirmed on 2026-09-07 (`VIX`, HTTP 200, 14.53), so the guard's
 * job has changed rather than ended: it now catches a *future* symbol change,
 * turning it into an `invalid` instead of a plausible wrong number that the
 * critic and the dashboard would both read as real.
 */

const VIX_MIN = 5;
const VIX_MAX = 150;

/** The 14 tenors the Treasury actually publishes, read from the live CSV. */
const PUBLISHED_TENORS = 14;

/**
 * QC-904's allowance, as its three parts. FINRA settles mid-month and at month end (each moved
 * back to a business day), so consecutive settlements are 13-18 days apart; it publishes after
 * the close on the 7th business day after settlement; the collector sweeps weekly.
 */
const MAX_SETTLEMENT_GAP_DAYS = 18;
const MAX_PUBLICATION_LAG_DAYS = 12;
export const SHORT_INTEREST_MAX_DAYS =
  MAX_SETTLEMENT_GAP_DAYS + MAX_PUBLICATION_LAG_DAYS + EVENTS_RULE.shortInterestCadenceDays + 1;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export const QC901_VIX_RANGE: CheckDefinition = {
  id: 'QC-901',
  domain: 'index',
  severity: 'blocking',
  description:
    'Every enabled macro series quoted this run has a last value inside its configured sane band. ' +
    'A missing quote fires as hard as an out-of-band one: the value feeds the market-regime read, ' +
    'and a silently absent VIX is how a regime gate comes to be evaluated against nothing.',
  readsTables: ['raw_index_quote', 'ref_macro_series'],
  testedQuantity: 'band_excursion',
  testedUnit: 'ratio',
  thresholds: { maxExcursion: 0 },
  thresholdBasis: 'measured',
  thresholdEvidence:
    'VIX has never closed outside [5, 150]. The band is per series in `ref_macro_series`; the ' +
    'symbol `VIX` itself was confirmed live 2026-09-07 (200, 14.53), so the check now guards ' +
    'against a future symbol change rather than an unverified one.',
  remediation: 'R1',
  run(ctx) {
    const series = ctx.db
      .prepare('SELECT symbol, sane_min, sane_max FROM ref_macro_series WHERE enabled = 1')
      .all() as { symbol: string; sane_min: number; sane_max: number }[];

    return series.map((s) => {
      const quote = ctx.db
        .prepare(
          `SELECT last, last_status FROM raw_index_quote
            WHERE symbol = ? AND as_of_date = ?
            ORDER BY observed_at DESC, row_id DESC LIMIT 1`
        )
        .get(s.symbol, ctx.tradingDate) as
        | { last: number | null; last_status: string }
        | undefined;

      const min = s.sane_min ?? VIX_MIN;
      const max = s.sane_max ?? VIX_MAX;

      if (!quote || quote.last === null) {
        return {
          key: s.symbol,
          // A missing quote has no magnitude of its own. It is reported at the
          // largest excursion rather than omitted, because an evaluation that
          // returns nothing leaves the distribution looking clean.
          value: 1,
          fired: true,
          detail: `${s.symbol}: no quote stored for ${ctx.tradingDate}`,
          evidence: { symbol: s.symbol, status: quote?.last_status ?? 'no row' }
        } satisfies Evaluation;
      }

      const excursion =
        quote.last < min ? (min - quote.last) / min
        : quote.last > max ? (quote.last - max) / max
        : 0;

      return {
        key: s.symbol,
        value: excursion,
        fired: excursion > 0,
        detail: `${s.symbol} last ${quote.last}, band [${min}, ${max}]`,
        evidence: { symbol: s.symbol, last: quote.last, min, max }
      } satisfies Evaluation;
    });
  }
};

export const QC902_YIELD_CURVE: CheckDefinition = {
  id: 'QC-902',
  domain: 'macro',
  severity: 'warning',
  description:
    'The newest stored curve carries all 14 published tenors and every yield is inside ' +
    '[-1 %, 25 %]. Fourteen is measured, not assumed: the first draft named nine, and the live CSV ' +
    'has 1.5M, 4M, 3Y, 7Y and 20Y as well. The tenor count is the check that catches a renamed ' +
    'header, because the parser maps by name and a header it does not recognise becomes a missing ' +
    'tenor rather than a mislabelled curve.',
  readsTables: ['raw_treasury_yield'],
  testedQuantity: 'missing_tenor_count',
  testedUnit: 'count',
  thresholds: { minTenors: PUBLISHED_TENORS },
  thresholdBasis: 'measured',
  thresholdEvidence:
    'Read from the live Treasury CSV 2026-09-07: Date plus exactly 14 tenor columns, 3 Mo = 3.91 % ' +
    'on 09/04/2026.',
  remediation: 'R1',
  run(ctx) {
    const newest = ctx.db
      .prepare('SELECT MAX(curve_date) AS d FROM raw_treasury_yield WHERE curve_date <= ?')
      .get(ctx.tradingDate) as { d: string | null } | undefined;

    if (!newest?.d) {
      return [
        {
          key: ctx.tradingDate,
          value: PUBLISHED_TENORS,
          fired: true,
          detail: 'no yield curve stored on or before the trading date',
          evidence: {}
        }
      ];
    }

    const rows = ctx.db
      .prepare('SELECT tenor, "yield" AS y FROM raw_treasury_yield WHERE curve_date = ?')
      .all(newest.d) as { tenor: string; y: number }[];

    const tenors = new Set(rows.map((r) => r.tenor));
    const missing = PUBLISHED_TENORS - tenors.size;
    const outOfRange = rows.filter((r) => r.y < -0.01 || r.y > 0.25);

    return [
      {
        key: newest.d,
        value: Math.max(missing, 0),
        fired: missing > 0 || outOfRange.length > 0,
        detail:
          `curve ${newest.d}: ${tenors.size} of ${PUBLISHED_TENORS} tenors` +
          (outOfRange.length > 0 ? `, ${outOfRange.length} yields outside [-1%, 25%]` : ''),
        evidence: {
          curveDate: newest.d,
          tenors: [...tenors].sort(),
          outOfRange: outOfRange.map((r) => `${r.tenor}=${r.y}`)
        }
      }
    ];
  }
};

export const QC903_MACRO_CALENDAR_GAP: CheckDefinition = {
  id: 'QC-903',
  domain: 'macro',
  severity: 'warning',
  description:
    'An FOMC meeting is scheduled within 90 days and a CPI release within 45. Both bodies publish ' +
    'their calendars a year ahead, so an empty forward window means our copy has gone stale rather ' +
    'than that nothing is scheduled.',
  readsTables: ['raw_macro_event'],
  testedQuantity: 'days_to_next_event',
  testedUnit: 'days',
  thresholds: { maxDaysToFomc: 90 },
  thresholdBasis: 'structural',
  run(ctx) {
    const horizons: readonly { type: string; maxDays: number }[] = [
      { type: 'FOMC', maxDays: 90 },
      { type: 'CPI', maxDays: 45 }
    ];

    return horizons.map((h) => {
      const next = ctx.db
        .prepare(
          `SELECT MIN(event_date) AS d FROM raw_macro_event
            WHERE event_type = ? AND event_date >= ?`
        )
        .get(h.type, ctx.tradingDate) as { d: string | null } | undefined;

      // No scheduled event at all is the worst case, not a zero. Reporting it
      // as one horizon past the threshold keeps it in the same distribution as
      // a merely-stale calendar without pretending it is the same thing.
      const days = next?.d ? daysBetween(ctx.tradingDate, next.d) : h.maxDays * 2;

      return {
        key: h.type,
        value: days,
        fired: days > h.maxDays,
        detail: next?.d
          ? `next ${h.type} is ${next.d}, ${days} days out (limit ${h.maxDays})`
          : `no future ${h.type} event is scheduled`,
        evidence: { eventType: h.type, next: next?.d ?? null, limitDays: h.maxDays }
      } satisfies Evaluation;
    });
  }
};

export const QC904_SHORT_INTEREST_FRESHNESS: CheckDefinition = {
  id: 'QC-904',
  domain: 'sentiment',
  severity: 'warning',
  description:
    'The newest short-interest settlement date is no older than the NEXT settlement could be before ' +
    'it reaches us: one settlement interval, plus FINRA\'s publication lag, plus the collector\'s ' +
    'weekly cadence. Older than that means a publication was missed. This is the domain with no ' +
    'confirmed free source, which makes its freshness check the thing most likely to be reporting ' +
    'a real gap rather than a fault.',
  readsTables: ['raw_short_interest'],
  testedQuantity: 'days_since_settlement',
  testedUnit: 'days',
  thresholds: { maxDays: SHORT_INTEREST_MAX_DAYS },
  thresholdBasis: 'measured',
  thresholdEvidence:
    `${MAX_SETTLEMENT_GAP_DAYS} (widest gap between FINRA settlement dates) + ${MAX_PUBLICATION_LAG_DAYS} ` +
    `(7 business days to publication, one holiday, available the next session) + ` +
    `${EVENTS_RULE.shortInterestCadenceDays + 1} (weekly fetch, one holiday-skipped Monday). The old 21 counted ` +
    'from settlement as if publication were instant: the 2026-08-31 settlement read 22-25 days old on ' +
    '2026-09-22..25 while the 2026-09-15 data was not yet published (FINRA: 2026-09-24) nor due to be ' +
    'fetched (2026-09-28), and escalated to blocking on a domain that was exactly on schedule.',
  remediation: 'R1',
  run(ctx) {
    const row = ctx.db
      .prepare('SELECT MAX(settlement_date) AS d FROM raw_short_interest')
      .get() as { d: string | null } | undefined;

    // Never loaded is reported, not skipped — an empty domain and a fresh one
    // must not look alike, which is the same rule QC-907 exists to enforce for
    // the IV bootstrap.
    const days = row?.d ? daysBetween(row.d, ctx.tradingDate) : 9999;
    return [
      {
        key: 'short_interest',
        value: days,
        fired: days > (this.thresholds['maxDays'] as number),
        detail: row?.d
          ? `newest settlement date ${row.d}, ${days} days ago`
          : 'no short-interest row has ever been stored',
        evidence: { newestSettlementDate: row?.d ?? null },
        // Freshness is a claim about now, so a clean reading settles an open finding. Past the old
        // 21 days it is clean only because the rule changed (v1.1.316), and must say so.
        closesAs:
          days <= (this.thresholds['maxDays'] as number)
            ? days > 21
              ? { kind: 'rule_changed', note: `${days} days is inside the publication-aware allowance of ${SHORT_INTEREST_MAX_DAYS} (v1.1.316)` }
              : { kind: 'data_corrected', note: `newest settlement ${row?.d} is ${days} days old` }
            : undefined
      }
    ];
  }
};

export const QC905_RECOMMENDATION_FRESHNESS: CheckDefinition = {
  id: 'QC-905',
  domain: 'sentiment',
  severity: 'warning',
  description:
    'Every chain-subset ticker has a recommendation observation within 45 days. Finnhub returns ' +
    'four monthly periods per call, so a ticker falling out of the weekly sweep shows up here well ' +
    'before its data is actually stale.',
  readsTables: ['raw_analyst_recommendation', 'ref_chain_subset_membership', 'raw_ticker_reference', 'meta_response', 'qa_exception', 'ref_universe_membership'],
  testedQuantity: 'days_since_observed',
  testedUnit: 'days',
  thresholds: { maxDays: 45 },
  thresholdBasis: 'working',
  remediation: 'R2',
  run(ctx) {
    // What this check guards is the SWEEP: a ticker falling out of it. So a ticker counts as
    // current when it was last stored, last ASKED (Finnhub answering an empty list for a ticker it
    // does not cover is not a collection failure), or admitted to the subset — whichever is latest.
    // Funds are excluded: they have no analyst coverage. On 2026-09-16, 47 of 82 findings were ETFs
    // and most of the rest were tickers admitted after the last weekly sweep or asked and empty.
    const asked = new Map(
      (
        ctx.db
          .prepare(
            `SELECT json_extract(params_json, '$.symbol') AS ticker, MAX(substr(requested_at, 1, 10)) AS last_asked
               FROM meta_response
              WHERE endpoint = '/stock/recommendation' AND parse_status = 'ok'
              GROUP BY ticker`
          )
          .all() as { ticker: string | null; last_asked: string }[]
      ).map((r) => [r.ticker, r.last_asked])
    );
    const rows = ctx.db
      .prepare(
        `SELECT m.ticker, MAX(m.valid_from) AS admitted,
                (SELECT MAX(substr(a.observed_at, 1, 10))
                   FROM raw_analyst_recommendation a WHERE a.ticker = m.ticker) AS last_seen
           FROM ref_chain_subset_membership m
          WHERE m.valid_to IS NULL
            AND m.ticker NOT IN (
              SELECT ticker FROM raw_ticker_reference
               WHERE security_type IN ${FUND_TYPES}
                 AND row_id IN (SELECT MAX(row_id) FROM raw_ticker_reference GROUP BY ticker))
          GROUP BY m.ticker`
      )
      .all() as { ticker: string; admitted: string; last_seen: string | null }[];

    const maxDays = this.thresholds['maxDays'] as number;
    const within = (d: string | null): d is string => d !== null && daysBetween(d, ctx.tradingDate) <= maxDays;
    return rows.map((r): Evaluation => {
      const lastAsked = asked.get(r.ticker) ?? null;
      const reference = [r.last_seen, lastAsked, r.admitted].filter((d): d is string => d !== null).sort().pop()!;
      const days = daysBetween(reference, ctx.tradingDate);
      const fired = days > maxDays;
      return {
        key: r.ticker,
        value: days,
        fired,
        detail:
          lastAsked === null
            ? `${r.ticker}: never asked since admission on ${r.admitted} (${days} days)`
            : `${r.ticker}: last asked ${lastAsked}, last stored ${r.last_seen ?? 'never'} (${days} days)`,
        evidence: { ticker: r.ticker, lastObserved: r.last_seen, lastAsked, admitted: r.admitted },
        // A clean reading settles an open finding, and says why (v1.1.282): a stored row is data;
        // an asked-and-empty answer or a recent admission is a rule the finding predates.
        closesAs: fired
          ? undefined
          : within(r.last_seen)
            ? { kind: 'data_corrected', note: `${r.ticker}: a recommendation row was stored ${r.last_seen}` }
            : within(lastAsked)
              ? { kind: 'rule_changed', note: `${r.ticker}: asked ${lastAsked} and Finnhub returned no rows — an asked ticker counts as current` }
              : { kind: 'rule_changed', note: `${r.ticker}: admitted to the subset ${r.admitted}, inside the ${maxDays}-day window before its first weekly sweep` }
      };
    }).concat(
      fundFindingClosers(ctx, 'QC-905', 'funds have no analyst coverage and are excluded from QC-905 since v1.1.257'),
      departedFindingClosers(ctx, 'QC-905')
    );
  }
};

export const QC906_INSIDER_PARSE: CheckDefinition = {
  id: 'QC-906',
  domain: 'sentiment',
  severity: 'warning',
  description:
    'A Form 4 that was fetched yielded at least one transaction row. A filing that parses to nothing ' +
    'is the signature of a schema change, and it is invisible from row counts alone: the domain ' +
    'simply gets quieter. Comparing responses against rows is what makes the silence audible. ' +
    'v1.1.305: until dictionary v20 the parser dropped derivative transactions, so an ordinary ' +
    'option-grant filing parsed to nothing and the benign case dominated the measurement — it fired ' +
    'on 2 of the 2 runs that ever had data (19.1% and 11.7%) and had never once passed. All 11 ' +
    'filings it named on 2026-09-21 were correct Form 4s with only derivative transactions. Both ' +
    'classes are now stored, so zero rows again means what the check says it means: a readable ' +
    'filing that yielded nothing. A Form 4 reporting only HOLDINGS still parses to no rows, which ' +
    'is rare and worth the finding.',
  readsTables: ['raw_insider_transaction', 'meta_response'],
  testedQuantity: 'unparsed_filing_fraction',
  testedUnit: 'fraction',
  thresholds: { maxFraction: 0.1 },
  thresholdBasis: 'working',
  run(ctx) {
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS fetched,
                SUM(CASE WHEN COALESCE(parsed_row_count, 0) = 0 THEN 1 ELSE 0 END) AS empty
           FROM meta_response
          WHERE run_id = ? AND archive_file LIKE '%edgar-form4%' AND http_status = 200`
      )
      .get(ctx.runId) as { fetched: number; empty: number } | undefined;

    const fetched = row?.fetched ?? 0;
    // No Form 4 fetched is not a finding — most days the universe filter leaves
    // few or none, and firing on that would train the operator to ignore this
    // check on exactly the days it has nothing to say.
    if (fetched === 0) return [];

    const fraction = (row?.empty ?? 0) / fetched;
    return [
      {
        key: ctx.tradingDate,
        value: fraction,
        fired: fraction > (this.thresholds['maxFraction'] as number),
        detail: `${row?.empty ?? 0} of ${fetched} fetched Form 4 filings parsed to no rows`,
        evidence: { fetched, empty: row?.empty ?? 0 }
      }
    ];
  }
};

export const QC910_INSIDER_INDEX_COVERAGE: CheckDefinition = {
  id: 'QC-910',
  domain: 'sentiment',
  severity: 'warning',
  description:
    'The insider sweep has read the EDGAR daily form index of every session before today. Without it ' +
    'a day on which the index could not be read is indistinguishable from a day nobody filed a Form 4: ' +
    'on 2026-09-18 the index answered HTTP 503, `events_insider` stored 0 against 299 the night before, ' +
    'and QC-906 — which only looks at Form 4s that WERE fetched — had nothing to say. The sweep catches ' +
    'up from the last parsed index (v1.1.268), so one session behind recovers on the next run and is ' +
    'not a finding; two means the catch-up itself is failing. Today is excluded: its index is not ' +
    'published until late evening.',
  readsTables: ['meta_response', 'ref_trading_day'],
  testedQuantity: 'sessions_without_insider_index',
  testedUnit: 'sessions',
  thresholds: { maxSessions: 1 },
  thresholdBasis: 'working',
  run(ctx) {
    const last = (ctx.db
      .prepare(
        `SELECT MAX(json_extract(params_json, '$.date')) AS d FROM meta_response
          WHERE endpoint = '/Archives/edgar/daily-index/form.idx' AND parse_status = 'ok'`
      )
      .get() as { d: string | null } | undefined)?.d ?? null;
    const failures = ctx.db
      .prepare(
        `SELECT json_extract(params_json, '$.date') AS date, http_status FROM meta_response
          WHERE run_id = ? AND endpoint = '/Archives/edgar/daily-index/form.idx' AND parse_status <> 'ok'`
      )
      .all(ctx.runId) as { date: string; http_status: number | null }[];

    // Nothing ever parsed and nothing attempted: there is no sweep to measure.
    if (last === null && failures.length === 0) return [];

    const behind = last === null
      ? null
      : tradingDaysInRange(ctx.db, last, ctx.tradingDate).filter((d) => d > last && d < ctx.tradingDate);
    const failedText = failures.length > 0
      ? `; this run could not read ${failures.map((f) => `${f.date} (HTTP ${f.http_status ?? 'none'})`).join(', ')}`
      : '';
    const max = this.thresholds['maxSessions'] as number;
    return [
      {
        key: ctx.tradingDate,
        ...(behind === null ? {} : { value: behind.length }),
        fired: behind === null || behind.length > max,
        detail: behind === null
          ? `no EDGAR daily form index has ever parsed${failedText}`
          : `${behind.length} session(s) before today with no parsed insider index (last parsed ${last})${failedText}`,
        evidence: { lastParsed: last, sessionsBehind: behind ?? null, failures }
      }
    ];
  }
};

export const QC909_RECOMMENDATION_SYMBOL_MISMATCH: CheckDefinition = {
  id: 'QC-909',
  domain: 'sentiment',
  severity: 'warning',
  description:
    'Finnhub answered a recommendation request for the symbol we asked, not another listing. Measured ' +
    '2026-09-14: GOOG came back as GOOGL, BRK.B as BRK.A, GFL as GFL.TO and LLYVA as FWONA. The first ' +
    'three are the same issuer; FWONA is a different company. Which it is cannot be decided from the ' +
    'symbols, so every mismatch is reported for a ruling rather than silently kept or dropped. Reads the ' +
    'latest observation per ticker, so it evaluates on the days between weekly sweeps too. ' +
    'v1.1.306: a mismatch the operator has RULED in `ref_provider_symbol_ruling` no longer fires — a ' +
    'standing answer is not an open question, and leaving the ruled ones in made the unruled ones ' +
    'harder to see, which is the whole point of the check. A `different_issuer` ruling also stops the ' +
    'ingest storing the answer, so that pairing stops appearing on its own once the next sweep runs; ' +
    'rows written before the ruling stay as evidence of what the provider answered, carrying their ' +
    '`provider_symbol`.',
  readsTables: ['raw_analyst_recommendation', 'ref_provider_symbol_ruling'],
  testedQuantity: null,
  testedUnit: null,
  thresholds: {},
  thresholdBasis: 'not_applicable',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT a.ticker, a.provider_symbol, a.observed_at
           FROM raw_analyst_recommendation a
           JOIN (SELECT ticker, MAX(observed_at) AS latest FROM raw_analyst_recommendation GROUP BY ticker) m
             ON m.ticker = a.ticker AND m.latest = a.observed_at
          WHERE a.provider_symbol IS NOT NULL
          GROUP BY a.ticker`
      )
      .all() as { ticker: string; provider_symbol: string; observed_at: string }[];

    const ruled = new Set(
      (
        ctx.db
          .prepare(
            `SELECT asked_ticker, answered_symbol, decision FROM ref_provider_symbol_ruling
              WHERE provider = 'finnhub'`
          )
          .all() as { asked_ticker: string; answered_symbol: string; decision: string }[]
      ).map((r) => `${r.asked_ticker}|${r.answered_symbol}`)
    );

    return rows.map((r) => {
      const isRuled = ruled.has(`${r.ticker}|${r.provider_symbol}`);
      return {
        key: r.ticker,
        fired: r.provider_symbol !== r.ticker && !isRuled,
        detail: isRuled
          ? `asked Finnhub for ${r.ticker}, it answered for ${r.provider_symbol} — ruled in ref_provider_symbol_ruling`
          : `asked Finnhub for ${r.ticker}, it answered for ${r.provider_symbol} (${r.observed_at.slice(0, 10)})`,
        evidence: { asked: r.ticker, answered: r.provider_symbol, ruled: isRuled },
        // A ruling is a decision the finding predates, not new data — so an open
        // finding closes as `rule_changed` and says which ruling settled it.
        ...(isRuled
          ? { closesAs: { kind: 'rule_changed' as const, note: `${r.ticker} → ${r.provider_symbol} is ruled in ref_provider_symbol_ruling` } }
          : {})
      };
    });
  }
};

export const MACRO_CHECKS: readonly CheckDefinition[] = [
  QC901_VIX_RANGE,
  QC902_YIELD_CURVE,
  QC903_MACRO_CALENDAR_GAP,
  QC904_SHORT_INTEREST_FRESHNESS,
  QC905_RECOMMENDATION_FRESHNESS,
  QC906_INSIDER_PARSE,
  QC910_INSIDER_INDEX_COVERAGE,
  QC909_RECOMMENDATION_SYMBOL_MISMATCH
];
