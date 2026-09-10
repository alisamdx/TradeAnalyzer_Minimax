import { currentDb } from './generation.js';
import { MIN_OVERLAP_DAYS, MAX_MEDIAN_ABS_DIFF } from '@tradeanalyzer/core';
import type { IvSeriesDto, IvPointDto, IvOverlapDto, IvTickerDto } from '../shared/types.js';

/**
 * The IV view's main-process half — 05 §4.6, 04 §7.3.
 *
 * **Every table and column name lives here, never in the renderer** (AC-13).
 * What crosses the bridge is a UI vocabulary — `own`, `external`, `readable` —
 * chosen so the renderer can be schema-driven and so the structural scan in
 * `inspector.test.ts` stays meaningful rather than being worked around.
 *
 * The view's whole job is to make the stitch visible. The existing app spliced
 * two IV sources with **zero overlapping ticker-days** and nothing about that
 * splice is answerable now; this screen shows the overlap window, the paired
 * count, and the days on which our own series could not be computed — as gaps
 * with a reason, never interpolated across.
 */

const DERIVED = 'derived_iv30_daily';
const EXTERNAL = 'ext_iv_history';

/** Tickers with either series, so a name with only one still appears. */
export function ivTickers(): readonly IvTickerDto[] {
  const rows = currentDb()
    .prepare(
      `SELECT ticker,
              SUM(own) AS own_days,
              SUM(ext) AS ext_days
         FROM (
           SELECT ticker, 1 AS own, 0 AS ext FROM ${DERIVED} WHERE status = 'ok'
           UNION ALL
           SELECT ticker, 0 AS own, 1 AS ext FROM ${EXTERNAL}
         )
        GROUP BY ticker
        ORDER BY ticker`
    )
    .all() as { ticker: string; own_days: number; ext_days: number }[];

  return rows.map((r) => ({
    ticker: r.ticker,
    ownDays: r.own_days,
    externalDays: r.ext_days
  }));
}

/**
 * One ticker's two series, aligned on date.
 *
 * A full outer join by hand, because SQLite has none and because the days where
 * only one side exists are exactly the days worth looking at: they are the
 * shape of the stitch.
 */
export function ivSeries(ticker: string): IvSeriesDto {
  const db = currentDb();

  // Latest observation per day wins (P1) — the same resolution every reader of
  // an append-only table must do, and never an UPDATE in the table itself.
  const own = db
    .prepare(
      `WITH ranked AS (
         SELECT as_of_date, iv30, status,
                ROW_NUMBER() OVER (PARTITION BY as_of_date ORDER BY observed_at DESC, row_id DESC) AS rn
           FROM ${DERIVED}
          WHERE ticker = ?
       )
       SELECT as_of_date, iv30, status FROM ranked WHERE rn = 1 ORDER BY as_of_date`
    )
    .all(ticker) as { as_of_date: string; iv30: number | null; status: string }[];

  const ext = db
    .prepare(
      `SELECT date, iv30, accepted, source, method_note
         FROM ${EXTERNAL}
        WHERE ticker = ?
        ORDER BY date`
    )
    .all(ticker) as {
    date: string;
    iv30: number;
    accepted: number;
    source: string;
    method_note: string;
  }[];

  const byDate = new Map<string, { own: number | null; ownStatus: string | null; external: number | null }>();
  for (const r of own) {
    byDate.set(r.as_of_date, { own: r.iv30, ownStatus: r.status, external: null });
  }
  for (const r of ext) {
    const entry = byDate.get(r.date) ?? { own: null, ownStatus: null, external: null };
    entry.external = r.iv30;
    byDate.set(r.date, entry);
  }

  const points: IvPointDto[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      own: v.own,
      ownStatus: v.ownStatus,
      external: v.external,
      // The one fact the chart is really about: both series measured this day.
      paired: v.own !== null && v.ownStatus === 'ok' && v.external !== null
    }));

  const pairedDiffs = points
    .filter((p) => p.paired)
    .map((p) => Math.abs((p.external as number) - (p.own as number)))
    .sort((a, b) => a - b);

  const overlap: IvOverlapDto | null =
    ext.length === 0
      ? null
      : {
          pairedDays: pairedDiffs.length,
          requiredDays: MIN_OVERLAP_DAYS,
          medianAbsDiff: median(pairedDiffs),
          tolerance: MAX_MEDIAN_ABS_DIFF,
          // Deliberately NOT called `accepted`: that is a dictionary column
          // name, and AC-13's scan is a substring match, so the renderer may
          // not carry it. `readable` is also the more honest UI word — an
          // unaccepted series is one nothing reads.
          readable: ext.every((r) => r.accepted === 1),
          externalSource: ext[0]?.source ?? null,
          externalMethod: ext[0]?.method_note ?? null
        };

  return {
    ticker,
    points,
    stitchDate: stitchDate(),
    overlap
  };
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The date from which readers prefer our own series.
 *
 * Null until a bootstrap has been accepted, and that null is the normal state
 * rather than an error: rank computes from the derived series alone and
 * reports its declared gap, exactly as it would if nothing had been bought.
 */
function stitchDate(): string | null {
  const row = currentDb()
    .prepare('SELECT iv_stitch_date FROM meta_generation ORDER BY generation_no DESC LIMIT 1')
    .get() as { iv_stitch_date: string | null } | undefined;
  return row?.iv_stitch_date ?? null;
}
