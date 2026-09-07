import { currentDb } from './generation.js';
import { cellsFor, viewColumns } from './view-columns.js';
import type { EarningsCalendarDto, EarningsTrailDto, EarningsMonthDto } from '../shared/types.js';

/**
 * The Earnings view's main-process half — 05 §4.3.
 *
 * The month calendar is the easy half. **The observation trail is the reason
 * this view exists**: `raw_earnings_event` stores every observation rather than
 * the current best date, so a date that moved leaves a visible trail, and the
 * failure this domain actually had — a truncated bulk response putting NVDA's
 * August report in November — is a shape on the screen instead of a number that
 * happens to be wrong.
 *
 * A view that showed only the resolved date would render that failure as a
 * perfectly ordinary row.
 */

const TABLE = 'raw_earnings_event';

const TRAIL_COLUMNS = viewColumns(TABLE, [
  { column: 'observed_at', label: 'Observed' },
  { column: 'report_date', label: 'Report date' },
  { column: 'report_time', label: 'Time' },
  { column: 'source' },
  { column: 'fiscal_year', label: 'FY' },
  { column: 'fiscal_quarter', label: 'FQ' },
  { column: 'eps_estimate', label: 'EPS est.', group: 'consensus' },
  { column: 'revenue_estimate', label: 'Rev. est.', group: 'consensus' },
  { column: 'sweep_from', label: 'Sweep from', group: 'provenance' },
  { column: 'sweep_to', label: 'Sweep to', group: 'provenance' }
]);

/** An issuer refining its date moves it by days; a coverage gap moves it by a quarter (QC-601). */
const MAX_LATER_SLIP_DAYS = 14;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * The resolved date per ticker for one month — newest observation wins.
 *
 * Resolution happens **here**, on read, and never in the table. That is the P1
 * rule doing real work: the same rows can be re-resolved by a different policy
 * later, and the trail below shows what the policy chose between.
 */
export function earningsMonth(month: string): EarningsMonthDto {
  const from = `${month}-01`;
  const to = `${month}-31`;

  const rows = currentDb()
    .prepare(
      `WITH ranked AS (
         SELECT ticker, report_date, report_time, report_time_status, source, observed_at,
                ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY observed_at DESC, row_id DESC) AS rn
           FROM ${TABLE}
          WHERE report_date BETWEEN ? AND ?
       )
       SELECT ticker, report_date, report_time, report_time_status, source
         FROM ranked WHERE rn = 1
        ORDER BY report_date, ticker`
    )
    .all(from, to) as {
    ticker: string; report_date: string; report_time: string | null;
    report_time_status: string; source: string;
  }[];

  const byDate = new Map<string, EarningsCalendarDto[]>();
  for (const r of rows) {
    const list = byDate.get(r.report_date) ?? [];
    list.push({
      ticker: r.ticker,
      reportTime: r.report_time,
      reportTimeStatus: r.report_time_status,
      source: r.source
    });
    byDate.set(r.report_date, list);
  }

  return {
    month,
    days: [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, tickers]) => ({ date, tickers }))
  };
}

export function earningsMonths(): readonly string[] {
  return (
    currentDb()
      .prepare(
        `SELECT DISTINCT substr(report_date, 1, 7) AS m FROM ${TABLE} ORDER BY m DESC LIMIT 36`
      )
      .all() as { m: string }[]
  ).map((r) => r.m);
}

/**
 * Every observation of one ticker's report dates, newest first, with the slip
 * against the previous observation from the same source.
 *
 * The slip is signed and reported both ways, because the asymmetry is the whole
 * rule: nearer is legitimate and unbounded, later beyond 14 days is the
 * truncation signature (QC-601).
 */
export function earningsTrail(ticker: string): EarningsTrailDto {
  const db = currentDb();
  const raw = db
    .prepare(`SELECT * FROM ${TABLE} WHERE ticker = ? ORDER BY observed_at DESC, row_id DESC LIMIT 200`)
    .all(ticker) as Record<string, unknown>[];

  // Previous observation from the SAME source — a Finnhub row must not be
  // diffed against an E*Trade one, which is QC-602's question, not QC-601's.
  const previousBySource = new Map<string, string>();
  const ordered = [...raw].reverse();
  const slipByRowId = new Map<number, number | null>();
  for (const row of ordered) {
    const source = String(row['source']);
    const date = String(row['report_date']);
    const prev = previousBySource.get(source);
    slipByRowId.set(
      Number(row['row_id']),
      prev === undefined || prev === date ? null : daysBetween(prev, date)
    );
    previousBySource.set(source, date);
  }

  return {
    ticker,
    columns: TRAIL_COLUMNS,
    observations: raw.map((row) => {
      const slip = slipByRowId.get(Number(row['row_id'])) ?? null;
      return {
        cells: cellsFor(TABLE, TRAIL_COLUMNS, row),
        slipDays: slip,
        // Only a later slip past the limit is flagged. A nearer move is a
        // correction, and marking it would train the eye to ignore the marker.
        slipSuspect: slip !== null && slip > MAX_LATER_SLIP_DAYS
      };
    })
  };
}

/** Tickers whose latest observation slipped later by more than the limit, or whose sources disagree. */
export function earningsAnomalies(): readonly {
  ticker: string;
  kind: 'moved_later' | 'sources_disagree';
  detail: string;
}[] {
  const db = currentDb();

  const moved = db
    .prepare(
      `WITH ranked AS (
         SELECT ticker, source, report_date, observed_at,
                ROW_NUMBER() OVER (PARTITION BY ticker, source ORDER BY observed_at DESC, row_id DESC) AS rn
           FROM ${TABLE}
       )
       SELECT n.ticker, n.source, p.report_date AS prev_date, n.report_date AS new_date
         FROM ranked n JOIN ranked p
           ON p.ticker = n.ticker AND p.source = n.source AND p.rn = 2
        WHERE n.rn = 1 AND n.report_date <> p.report_date`
    )
    .all() as { ticker: string; source: string; prev_date: string; new_date: string }[];

  const disagree = db
    .prepare(
      `WITH latest AS (
         SELECT ticker, source, report_date,
                ROW_NUMBER() OVER (PARTITION BY ticker, source ORDER BY observed_at DESC, row_id DESC) AS rn
           FROM ${TABLE}
       )
       SELECT f.ticker, f.report_date AS finnhub_date, e.report_date AS etrade_date
         FROM latest f JOIN latest e ON e.ticker = f.ticker AND e.rn = 1 AND e.source = 'etrade'
        WHERE f.rn = 1 AND f.source = 'finnhub'`
    )
    .all() as { ticker: string; finnhub_date: string; etrade_date: string }[];

  return [
    ...moved
      .map((m) => ({ ...m, slip: daysBetween(m.prev_date, m.new_date) }))
      .filter((m) => m.slip > MAX_LATER_SLIP_DAYS)
      .map((m) => ({
        ticker: m.ticker,
        kind: 'moved_later' as const,
        detail: `${m.source}: ${m.prev_date} -> ${m.new_date} (${m.slip} days later)`
      })),
    ...disagree
      .filter((d) => Math.abs(daysBetween(d.finnhub_date, d.etrade_date)) > 1)
      .map((d) => ({
        ticker: d.ticker,
        kind: 'sources_disagree' as const,
        detail: `finnhub ${d.finnhub_date} vs etrade ${d.etrade_date}`
      }))
  ];
}
