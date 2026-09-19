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

/**
 * Polygon reference types that are funds rather than issuers: no earnings, no analyst coverage.
 * ETV covers commodity vehicles (GLD, SLV). A ticker with no reference row is not excluded —
 * unknown is not the same as a fund.
 */
export const FUND_TYPES = "('ETF', 'ETV', 'ETN', 'ETS', 'FUND')";

/** How long a filer whose companyfacts lacked its newest report waits before the fact pull asks again. */
export const FACTS_RETRY_DAYS = 7;

/** A report this recent puts the next one about a quarter out, possibly past the 90-day sweep. */
const RECENT_REPORT_GRACE_DAYS = 21;

/** The two independent readings QC-602 exists to compare. Both must be present or it is vacuous. */
const EARNINGS_CROSS_SOURCES = ['finnhub', 'etrade'] as const;

/**
 * The sentinel for "these dates cannot be compared at all", well past any real
 * disagreement. QC-603 uses the same device for a date never observed: an
 * unmeasurable case must never take the threshold's own value, or an empty
 * domain reads as a clean one.
 */
const UNCOMPARABLE_DISAGREEMENT_DAYS = 9999;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export const QC601_EARNINGS_SLIPS_LATER: CheckDefinition = {
  id: 'QC-601',
  domain: 'earnings',
  severity: 'blocking',
  description:
    'For a ticker and source, the NEAREST FUTURE report date is not more than 14 days later than ' +
    'the nearest future date the previous sweep saw. A large later slip is the bulk-cap truncation ' +
    'signature: the cap drops the EARLIEST dates, so a truncated response reports the next quarter ' +
    'as if it were the next report. The asymmetry is the point — nearer is unbounded, later is not.',
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
    // The nearest FUTURE report date per sweep, compared sweep to sweep — not
    // the newest row compared to the row before it.
    //
    // A sweep is subdivided into windows, because the bulk calendar truncates at
    // its row cap, so one run writes one row per window per ticker. MU's
    // 2026-09-30 and its 2026-12-15 are two real reports in two windows of the
    // SAME sweep, written 409 ms apart; read as successive observations they
    // reported a 76-day slip on entirely correct data. Seven of the eight
    // findings on 2026-09-17 were that artefact, and it grows as a quarter-end
    // pulls more tickers' second report inside the sweep horizon.
    //
    // Ranking by run also fixes the direction this check was blind in: the last
    // row written for a ticker is always its FARTHEST date, so a truncation that
    // moved the NEAREST one — the fault the check exists for — was masked by the
    // same confusion that manufactured the false ones.
    const rows = ctx.db
      .prepare(
        `WITH nearest AS (
           SELECT ticker, source, run_id, as_of_date, MIN(report_date) AS near_date
             FROM raw_earnings_event
            WHERE report_date >= as_of_date
            GROUP BY ticker, source, run_id
         ),
         ranked AS (
           SELECT ticker, source, run_id, as_of_date, near_date,
                  ROW_NUMBER() OVER (PARTITION BY ticker, source ORDER BY run_id DESC) AS rn
             FROM nearest
         )
         SELECT n.ticker, n.source, n.near_date AS new_date, n.as_of_date AS new_as_of,
                p.near_date AS prev_date
           FROM ranked n
           JOIN ranked p ON p.ticker = n.ticker AND p.source = n.source AND p.rn = 2
          WHERE n.rn = 1 AND n.near_date <> p.near_date`
      )
      .all() as {
      ticker: string; source: string; new_date: string; new_as_of: string; prev_date: string;
    }[];

    return rows.map((r) => {
      const slip = daysBetween(r.prev_date, r.new_date);
      // A date the issuer has already reported on rolls to the next quarter, and
      // that roll is the calendar working, not a slip. GIS moved 2026-09-15 ->
      // 2026-12-15 two days after it reported. Clamped like a nearer move and
      // for the same reason: a legitimate move left in the fault's distribution
      // blurs the boundary the threshold is drawn against.
      const rolledAfterReport = r.prev_date < r.new_as_of;
      return {
        key: `${r.ticker}:${r.source}`,
        // Only a LATER move is measured. A nearer move is legitimate and
        // reporting it as a negative magnitude would put it in the same
        // distribution as the fault and blur the boundary.
        value: rolledAfterReport ? 0 : Math.max(slip, 0),
        fired: !rolledAfterReport && slip > (this.thresholds['maxLaterSlipDays'] as number),
        detail:
          `${r.ticker} (${r.source}) nearest report moved ${r.prev_date} -> ${r.new_date}, ${slip} days later`,
        evidence: {
          ticker: r.ticker, source: r.source, previous: r.prev_date, observed: r.new_date,
          slipDays: slip, rolledAfterReport
        }
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
    'history of one of them being confidently wrong. A missing second source is itself the finding: ' +
    'with one source every ticker passes unexamined, which is indistinguishable from agreement.',
  readsTables: ['raw_earnings_event'],
  testedQuantity: 'source_disagreement_days',
  testedUnit: 'days',
  thresholds: { maxDisagreementDays: 1 },
  thresholdBasis: 'structural',
  run(ctx) {
    // This check self-joined on source = 'etrade', and `raw_earnings_event` has
    // only ever held finnhub rows — the collector does not fetch the second
    // source at all. So it evaluated 0 on every daily run of the generation and
    // could not have fired, the vacuous pass this framework exists to make
    // visible. It was dead on 2026-09-17, the night QC-601 fired eight earnings
    // findings it was the only available corroboration for.
    //
    // Collecting E*Trade earnings is a collection change, not a check change, so
    // until it lands the absence is REPORTED rather than passed over in silence.
    const present = new Set(
      (
        ctx.db
          .prepare('SELECT DISTINCT source FROM raw_earnings_event WHERE report_date >= ?')
          .all(ctx.tradingDate) as { source: string }[]
      ).map((r) => r.source)
    );
    const missing = EARNINGS_CROSS_SOURCES.filter((s) => !present.has(s));
    if (missing.length > 0) {
      return [
        {
          key: 'sources',
          // The largest possible disagreement, never the threshold's own value:
          // "cannot be compared" must not read as "compared and agreed".
          value: UNCOMPARABLE_DISAGREEMENT_DAYS,
          fired: true,
          detail:
            `no cross-source comparison is possible: ${missing.join(' and ')} ` +
            `${missing.length === 1 ? 'has' : 'have'} no future-dated row` +
            `${present.size > 0 ? ` (present: ${[...present].sort().join(', ')})` : ''}`,
          evidence: { present: [...present].sort(), missing }
        } satisfies Evaluation
      ];
    }

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

    // Both sources present and NO ticker dated by both is the same finding as a missing
    // source (v1.1.270). E*Trade is asked mainly for tickers Finnhub did not date, so without
    // this the check would pass every night on zero comparisons — "no overlap" and "clean
    // overlap" must not look alike.
    if (rows.length === 0) {
      return [
        {
          key: 'sources',
          value: UNCOMPARABLE_DISAGREEMENT_DAYS,
          fired: true,
          detail: 'no cross-source comparison is possible: no ticker has a future date from both finnhub and etrade',
          evidence: { present: [...present].sort(), paired: 0 }
        } satisfies Evaluation
      ];
    }

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
    // Funds are excluded: an ETF has no earnings. On 2026-09-16, 47 of 68 findings were ETFs in
    // the chain subset (SPY, QQQ, GLD ...) that could never pass.
    const rows = ctx.db
      .prepare(
        `SELECT m.ticker,
                (SELECT MAX(substr(e.observed_at, 1, 10))
                   FROM raw_earnings_event e
                  WHERE e.ticker = m.ticker AND e.report_date >= ?) AS last_seen,
                (SELECT MAX(e.report_date)
                   FROM raw_earnings_event e
                  WHERE e.ticker = m.ticker AND e.report_date < ?) AS last_reported
           FROM ref_chain_subset_membership m
          WHERE m.valid_to IS NULL
            AND m.ticker NOT IN (
              SELECT ticker FROM raw_ticker_reference
               WHERE security_type IN ${FUND_TYPES}
                 AND row_id IN (SELECT MAX(row_id) FROM raw_ticker_reference GROUP BY ticker))`
      )
      .all(ctx.tradingDate, ctx.tradingDate) as { ticker: string; last_seen: string | null; last_reported: string | null }[];

    return rows.map((r) => {
      // Just reported: the next date lies about a quarter out and can fall past the sweep's
      // 90-day window. GIS and FPS reported 2026-09-15 and fired the next day. Absent from the
      // calendar here means "not yet in range", not "dropped out".
      const justReported =
        r.last_seen === null &&
        r.last_reported !== null &&
        daysBetween(r.last_reported, ctx.tradingDate) <= RECENT_REPORT_GRACE_DAYS;
      // Never observed (and not just reported) is the largest possible staleness, never the
      // threshold's own value, or an empty domain would read as a clean one.
      const days = justReported ? 0 : r.last_seen === null ? 9999 : daysBetween(r.last_seen, ctx.tradingDate);
      return {
        key: r.ticker,
        value: days,
        fired: days > (this.thresholds['maxDaysSinceObserved'] as number),
        detail:
          r.last_seen === null
            ? `${r.ticker}: no future report date has ever been observed`
            : `${r.ticker}: future report date last observed ${r.last_seen} (${days} days ago)`,
        evidence: { ticker: r.ticker, lastObserved: r.last_seen, lastReported: r.last_reported, justReported }
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
    'blocking past 180. Each finding names its cause: no newer filing seen (a late filer), a filing ' +
    'still queued for companyfacts, which is our backlog, or SEC companyfacts read after the filing and still ' +
    'missing it (SEC\'s aggregate — IQV and JCI on 2026-09-18, July 10-Qs filed with inline XBRL).',
  readsTables: ['raw_edgar_fact', 'raw_ticker_reference', 'raw_edgar_filing', 'meta_response'],
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

    // Why the facts are old, stated rather than assumed (v1.1.271). The description used to
    // say past 180 days "it is our pipeline, not the filer" — and on 2026-09-18 both findings
    // were neither: IQV and JCI filed their July 10-Qs with inline XBRL, the collector fetched
    // companyfacts AFTER those filings, and SEC's aggregate still did not contain them.
    const pendingFiling = ctx.db.prepare(
      `SELECT form, filed_date FROM raw_edgar_filing f
        WHERE f.cik = ? AND f.form IN ('10-K', '10-Q', '20-F', '40-F')
          AND NOT EXISTS (SELECT 1 FROM raw_edgar_fact x WHERE x.accession_no = f.accession_no)
        ORDER BY f.filed_date DESC LIMIT 1`
    );
    const lastFetch = ctx.db.prepare(
      `SELECT MAX(substr(requested_at, 1, 10)) AS at FROM meta_response
        WHERE endpoint = '/api/xbrl/companyfacts/CIK{cik}.json' AND parse_status = 'ok'
          AND json_extract(params_json, '$.cik') = ?`
    );

    // A filer whose facts have never been pulled is not a stale filer — the
    // fact pull is filing-triggered and works through a queue. Reporting it as
    // 9999 days stale would fill the gate with findings about our own backlog.
    return rows
      .filter((r) => r.newest !== null)
      .map((r) => {
        const days = daysBetween(r.newest as string, ctx.tradingDate);
        const fired = days > (this.thresholds['warnAfterDays'] as number);
        let cause: 'sec_companyfacts_missing' | 'awaiting_fetch' | 'no_newer_filing_seen' | null = null;
        let why = '';
        if (fired) {
          const filing = pendingFiling.get(r.cik) as { form: string; filed_date: string } | undefined;
          const fetched = (lastFetch.get(r.cik) as { at: string | null } | undefined)?.at ?? null;
          if (!filing) {
            cause = 'no_newer_filing_seen';
            why = ' — no newer report filing has been seen (a late filer, or a filing the submissions slice has not reached)';
          } else if (fetched !== null && fetched >= filing.filed_date) {
            cause = 'sec_companyfacts_missing';
            why = ` — SEC companyfacts fetched ${fetched} still has no facts for the ${filing.form} filed ${filing.filed_date}; SEC's aggregate is behind, not the pipeline (retried every ${FACTS_RETRY_DAYS} days)`;
          } else {
            cause = 'awaiting_fetch';
            const last = fetched ? `; companyfacts last read ${fetched}` : '';
            why = ` — the ${filing.form} filed ${filing.filed_date} is queued for companyfacts${last}`;
          }
        }
        return {
          key: r.ticker,
          value: days,
          fired,
          detail: `${r.ticker} (CIK ${r.cik}): newest fact period ends ${r.newest}, ${days} days ago${why}`,
          evidence: { ticker: r.ticker, cik: r.cik, newestPeriodEnd: r.newest, days, ...(cause ? { cause } : {}) }
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
