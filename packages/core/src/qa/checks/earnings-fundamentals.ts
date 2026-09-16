import type { CheckDefinition, Evaluation } from '../check.js';

/**
 * Earnings and fundamentals checks — 03 §3.6.
 *
 * QC-601 is the one with a body count. The existing app stored NVDA's
 * 2026-08-26 report as 2026-11-17 — one quarter late — because it trusted a
 * bulk calendar response that had been truncated at its 1,500-row cap, and the
 * bad write then silently suppressed all three mechanisms that would have
 * corrected it: the nearest-wins guard, the delta filter and the brief's own
 * refresh all skipped on the presence of a stored future date. The earnings
 * penalty never fired and the brief ranked NVDA wheel #1 on the day it printed.
 *
 * So the rule this check enforces is asymmetric, and deliberately so: a date may
 * move **nearer** without limit — a coverage gap hiding the near date is the
 * common case — but it may move **later** only by a little. A large later slip
 * is the truncation signature, not an issuer refining its plans.
 */

/** An issuer refining its date moves it by days; a coverage gap moves it by a quarter. */
const MAX_LATER_SLIP_DAYS = 14;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export const QC601_EARNINGS_SLIPS_LATER: CheckDefinition = {
  id: 'QC-601',
  domain: 'earnings',
  severity: 'blocking',
  description:
    'For a ticker and source, the newest observed report date is not more than 14 days later than ' +
    'the previous observation. A large later slip is the bulk-cap truncation signature: the cap ' +
    'drops the EARLIEST dates, so a truncated response reports the next quarter as if it were the ' +
    'next report. The asymmetry is the point — nearer is unbounded, later is not.',
  readsTables: ['raw_earnings_event'],
  testedQuantity: 'later_slip_days',
  testedUnit: 'days',
  thresholds: { maxLaterSlipDays: MAX_LATER_SLIP_DAYS },
  thresholdBasis: 'measured',
  thresholdEvidence:
    'The existing app stored NVDA 2026-08-26 as 2026-11-17, an 83-day slip, from a response sitting ' +
    'exactly at Finnhub\'s 1,500-row cap. Fourteen days is wide enough for an issuer moving its own ' +
    'date and far short of a quarter.',
  remediation: 'R4',
  run(ctx) {
    // The two newest observations per (ticker, source). Comparing to the
    // immediately previous observation rather than to the oldest is what makes
    // this a *change* detector: an issuer that has always reported on the 26th
    // never fires, however far away that date is.
    const rows = ctx.db
      .prepare(
        `WITH ranked AS (
           SELECT ticker, source, report_date, observed_at,
                  ROW_NUMBER() OVER (PARTITION BY ticker, source ORDER BY observed_at DESC, row_id DESC) AS rn
             FROM raw_earnings_event
         )
         SELECT n.ticker, n.source, n.report_date AS new_date, n.observed_at,
                p.report_date AS prev_date
           FROM ranked n
           JOIN ranked p ON p.ticker = n.ticker AND p.source = n.source AND p.rn = 2
          WHERE n.rn = 1 AND n.report_date <> p.report_date`
      )
      .all() as {
      ticker: string; source: string; new_date: string; prev_date: string; observed_at: string;
    }[];

    return rows.map((r) => {
      const slip = daysBetween(r.prev_date, r.new_date);
      return {
        key: `${r.ticker}:${r.source}`,
        // Only a LATER move is measured. A nearer move is legitimate and
        // reporting it as a negative magnitude would put it in the same
        // distribution as the fault and blur the boundary.
        value: Math.max(slip, 0),
        fired: slip > (this.thresholds['maxLaterSlipDays'] as number),
        detail: `${r.ticker} (${r.source}) moved ${r.prev_date} -> ${r.new_date}, ${slip} days later`,
        evidence: { ticker: r.ticker, source: r.source, previous: r.prev_date, observed: r.new_date, slipDays: slip }
      } satisfies Evaluation;
    });
  }
};

export const QC602_EARNINGS_SOURCE_DISAGREEMENT: CheckDefinition = {
  id: 'QC-602',
  domain: 'earnings',
  severity: 'warning',
  description:
    'Finnhub and E*Trade agree within a day on the same ticker\'s next report date. Two independent ' +
    'readings are the cheapest way to catch one feed drifting, and this domain has a documented ' +
    'history of one of them being confidently wrong.',
  readsTables: ['raw_earnings_event'],
  testedQuantity: 'source_disagreement_days',
  testedUnit: 'days',
  thresholds: { maxDisagreementDays: 1 },
  thresholdBasis: 'structural',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `WITH latest AS (
           SELECT ticker, source, report_date,
                  ROW_NUMBER() OVER (PARTITION BY ticker, source ORDER BY observed_at DESC, row_id DESC) AS rn
             FROM raw_earnings_event
            WHERE report_date >= ?
         )
         SELECT f.ticker, f.report_date AS finnhub_date, e.report_date AS etrade_date
           FROM latest f
           JOIN latest e ON e.ticker = f.ticker AND e.rn = 1 AND e.source = 'etrade'
          WHERE f.rn = 1 AND f.source = 'finnhub'`
      )
      .all(ctx.tradingDate) as { ticker: string; finnhub_date: string; etrade_date: string }[];

    return rows.map((r) => {
      const gap = Math.abs(daysBetween(r.finnhub_date, r.etrade_date));
      return {
        key: r.ticker,
        value: gap,
        fired: gap > (this.thresholds['maxDisagreementDays'] as number),
        detail: `${r.ticker}: finnhub ${r.finnhub_date} vs etrade ${r.etrade_date} (${gap} days apart)`,
        evidence: { ticker: r.ticker, finnhub: r.finnhub_date, etrade: r.etrade_date, gapDays: gap }
      } satisfies Evaluation;
    });
  }
};

export const QC603_EARNINGS_FRESHNESS: CheckDefinition = {
  id: 'QC-603',
  domain: 'earnings',
  severity: 'warning',
  description:
    'A common-stock ticker in the chain subset has a future report date observed recently. A ticker ' +
    'that has quietly dropped out of the calendar is the state in which no earnings penalty can ' +
    'fire, which is indistinguishable from a ticker with no earnings coming.',
  readsTables: ['raw_earnings_event', 'ref_chain_subset_membership'],
  testedQuantity: 'days_since_future_date_observed',
  testedUnit: 'days',
  thresholds: { maxDaysSinceObserved: 7 },
  thresholdBasis: 'working',
  remediation: 'R2',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT m.ticker,
                (SELECT MAX(substr(e.observed_at, 1, 10))
                   FROM raw_earnings_event e
                  WHERE e.ticker = m.ticker AND e.report_date >= ?) AS last_seen
           FROM ref_chain_subset_membership m
          WHERE m.valid_to IS NULL`
      )
      .all(ctx.tradingDate) as { ticker: string; last_seen: string | null }[];

    return rows.map((r) => {
      // Never observed is not zero days and not "fine". It is the largest
      // possible staleness, and giving it the threshold's own value would let
      // an empty domain read as a clean one.
      const days = r.last_seen === null ? 9999 : daysBetween(r.last_seen, ctx.tradingDate);
      return {
        key: r.ticker,
        value: days,
        fired: days > (this.thresholds['maxDaysSinceObserved'] as number),
        detail:
          r.last_seen === null
            ? `${r.ticker}: no future report date has ever been observed`
            : `${r.ticker}: future report date last observed ${r.last_seen} (${days} days ago)`,
        evidence: { ticker: r.ticker, lastObserved: r.last_seen }
      } satisfies Evaluation;
    });
  }
};

export const QC604_EARNINGS_WEEKEND_DATE: CheckDefinition = {
  id: 'QC-604',
  domain: 'earnings',
  severity: 'warning',
  description:
    'A report date falls on a trading day. A Saturday date is the UTC artefact the existing app ' +
    'shifts by hand: E*Trade dates are UTC, so a Thursday-evening ET report reads as Saturday. It is ' +
    'stored exactly as observed and flagged here rather than silently moved — the shift is a ' +
    'reader-side resolution, and a raw table that quietly corrects its source cannot be replayed.',
  readsTables: ['raw_earnings_event', 'ref_trading_day'],
  testedQuantity: 'non_trading_day_fraction',
  testedUnit: 'fraction',
  thresholds: { maxFraction: 0 },
  thresholdBasis: 'structural',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT DISTINCT ticker, report_date, source
           FROM raw_earnings_event
          WHERE report_date >= ?`
      )
      .all(ctx.tradingDate) as { ticker: string; report_date: string; source: string }[];
    if (rows.length === 0) return [];

    // `ref_trading_day` is the authority when it covers the date. When it does
    // not — the calendar is seeded a year at a time — weekday arithmetic in a
    // single time base is the fallback, never a mix of the two.
    const known = new Set(
      (
        ctx.db.prepare('SELECT date FROM ref_trading_day WHERE is_trading_day = 1').all() as {
          date: string;
        }[]
      ).map((r) => r.date)
    );
    const calendarMax = ctx.db
      .prepare('SELECT MAX(date) AS m FROM ref_trading_day')
      .get() as { m: string | null } | undefined;

    const offenders: typeof rows = [];
    for (const r of rows) {
      const inCalendarRange = calendarMax?.m != null && r.report_date <= calendarMax.m;
      const isTrading = inCalendarRange
        ? known.has(r.report_date)
        : ![0, 6].includes(new Date(`${r.report_date}T00:00:00Z`).getUTCDay());
      if (!isTrading) offenders.push(r);
    }

    const fraction = offenders.length / rows.length;
    return [
      {
        key: ctx.tradingDate,
        value: fraction,
        fired: offenders.length > 0,
        detail: `${offenders.length} of ${rows.length} future report dates fall on a non-trading day`,
        evidence: {
          total: rows.length,
          sample: offenders.slice(0, 20).map((o) => `${o.ticker} ${o.report_date} (${o.source})`)
        }
      }
    ];
  }
};

export const QC701_FILING_FRESHNESS: CheckDefinition = {
  id: 'QC-701',
  domain: 'fundamentals',
  severity: 'warning',
  description:
    'A common-stock ticker with a CIK has an XBRL fact whose period ends within 120 days, and is ' +
    'blocking past 180. A late filer is a real thing and the warning band is where it lives; past ' +
    'two quarters it is our pipeline, not the filer.',
  readsTables: ['raw_edgar_fact', 'raw_ticker_reference'],
  testedQuantity: 'days_since_newest_period_end',
  testedUnit: 'days',
  thresholds: { warnAfterDays: 120 },
  thresholdBasis: 'working',
  promoteToBlockingAtValue: 180,
  remediation: 'R2',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT r.ticker, r.cik,
                (SELECT MAX(f.period_end) FROM raw_edgar_fact f WHERE f.cik = r.cik) AS newest
           FROM raw_ticker_reference r
          WHERE r.cik IS NOT NULL
            AND r.security_type = 'CS'
            AND r.row_id IN (SELECT MAX(row_id) FROM raw_ticker_reference GROUP BY ticker)
            AND r.ticker IN (SELECT ticker FROM ref_chain_subset_membership WHERE valid_to IS NULL)`
      )
      .all() as { ticker: string; cik: string; newest: string | null }[];

    // A filer whose facts have never been pulled is not a stale filer — the
    // fact pull is filing-triggered and works through a queue. Reporting it as
    // 9999 days stale would fill the gate with findings about our own backlog.
    return rows
      .filter((r) => r.newest !== null)
      .map((r) => {
        const days = daysBetween(r.newest as string, ctx.tradingDate);
        return {
          key: r.ticker,
          value: days,
          fired: days > (this.thresholds['warnAfterDays'] as number),
          detail: `${r.ticker} (CIK ${r.cik}): newest fact period ends ${r.newest}, ${days} days ago`,
          evidence: { ticker: r.ticker, cik: r.cik, newestPeriodEnd: r.newest, days }
        } satisfies Evaluation;
      });
  }
};

export const QC702_FACT_SANITY: CheckDefinition = {
  id: 'QC-702',
  domain: 'fundamentals',
  severity: 'warning',
  description:
    'Share count from EDGAR agrees with the provider reference within 25 %. Neither side of this ' +
    'comparison existed in the old schema — its only share-count column is empty in practice and it ' +
    'has no CIK column at all — so the threshold could not be measured before the pilot, and it is a ' +
    'working value rather than a guess dressed as one.',
  readsTables: ['raw_edgar_fact', 'raw_ticker_reference'],
  testedQuantity: 'shares_disagreement_fraction',
  testedUnit: 'fraction',
  thresholds: { maxDisagreement: 0.25 },
  thresholdBasis: 'working',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `WITH latest_ref AS (
           SELECT ticker, cik, shares_outstanding
             FROM raw_ticker_reference
            WHERE cik IS NOT NULL AND shares_outstanding IS NOT NULL
              AND row_id IN (SELECT MAX(row_id) FROM raw_ticker_reference GROUP BY ticker)
         ),
         latest_fact AS (
           SELECT cik, value, period_end,
                  ROW_NUMBER() OVER (PARTITION BY cik ORDER BY period_end DESC, filed_date DESC) AS rn
             FROM raw_edgar_fact
            WHERE taxonomy = 'dei' AND concept = 'EntityCommonStockSharesOutstanding'
              AND unit = 'shares' AND value > 0
         )
         SELECT r.ticker, r.shares_outstanding AS ref_shares, f.value AS fact_shares, f.period_end
           FROM latest_ref r JOIN latest_fact f ON f.cik = r.cik AND f.rn = 1`
      )
      .all() as {
      ticker: string; ref_shares: number; fact_shares: number; period_end: string;
    }[];

    return rows.map((r) => {
      const disagreement = Math.abs(r.fact_shares - r.ref_shares) / r.ref_shares;
      return {
        key: r.ticker,
        value: disagreement,
        fired: disagreement > (this.thresholds['maxDisagreement'] as number),
        detail:
          `${r.ticker}: EDGAR ${r.fact_shares.toLocaleString()} vs reference ` +
          `${r.ref_shares.toLocaleString()} shares (${(disagreement * 100).toFixed(1)}%)`,
        evidence: {
          ticker: r.ticker, edgarShares: r.fact_shares, referenceShares: r.ref_shares,
          periodEnd: r.period_end, disagreement
        }
      } satisfies Evaluation;
    });
  }
};

export const EARNINGS_FUNDAMENTALS_CHECKS: readonly CheckDefinition[] = [
  QC601_EARNINGS_SLIPS_LATER,
  QC602_EARNINGS_SOURCE_DISAGREEMENT,
  QC603_EARNINGS_FRESHNESS,
  QC604_EARNINGS_WEEKEND_DATE,
  QC701_FILING_FRESHNESS,
  QC702_FACT_SANITY
];
