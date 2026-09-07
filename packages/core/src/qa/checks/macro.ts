import type { CheckDefinition, Evaluation } from '../check.js';

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
    'The newest short-interest settlement date is within 21 days. FINRA publishes twice monthly, so ' +
    'three weeks is one missed publication. This is the domain with no confirmed free source, which ' +
    'makes its freshness check the thing most likely to be reporting a real gap rather than a fault.',
  readsTables: ['raw_short_interest'],
  testedQuantity: 'days_since_settlement',
  testedUnit: 'days',
  thresholds: { maxDays: 21 },
  thresholdBasis: 'measured',
  thresholdEvidence: 'FINRA publishes twice monthly; 21 days is one missed publication plus slack.',
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
        evidence: { newestSettlementDate: row?.d ?? null }
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
  readsTables: ['raw_analyst_recommendation', 'ref_chain_subset_membership'],
  testedQuantity: 'days_since_observed',
  testedUnit: 'days',
  thresholds: { maxDays: 45 },
  thresholdBasis: 'working',
  remediation: 'R2',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT m.ticker,
                (SELECT MAX(substr(a.observed_at, 1, 10))
                   FROM raw_analyst_recommendation a WHERE a.ticker = m.ticker) AS last_seen
           FROM ref_chain_subset_membership m
          WHERE m.valid_to IS NULL`
      )
      .all() as { ticker: string; last_seen: string | null }[];

    return rows.map((r) => {
      const days = r.last_seen === null ? 9999 : daysBetween(r.last_seen, ctx.tradingDate);
      return {
        key: r.ticker,
        value: days,
        fired: days > (this.thresholds['maxDays'] as number),
        detail: r.last_seen
          ? `${r.ticker}: last observed ${r.last_seen} (${days} days ago)`
          : `${r.ticker}: no recommendation row has ever been stored`,
        evidence: { ticker: r.ticker, lastObserved: r.last_seen }
      } satisfies Evaluation;
    });
  }
};

export const QC906_INSIDER_PARSE: CheckDefinition = {
  id: 'QC-906',
  domain: 'sentiment',
  severity: 'warning',
  description:
    'A Form 4 that was fetched yielded at least one transaction row. A filing that parses to nothing ' +
    'is the signature of a schema change, and it is invisible from row counts alone: the domain ' +
    'simply gets quieter. Comparing responses against rows is what makes the silence audible.',
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

export const MACRO_CHECKS: readonly CheckDefinition[] = [
  QC901_VIX_RANGE,
  QC902_YIELD_CURVE,
  QC903_MACRO_CALENDAR_GAP,
  QC904_SHORT_INTEREST_FRESHNESS,
  QC905_RECOMMENDATION_FRESHNESS,
  QC906_INSIDER_PARSE
];
