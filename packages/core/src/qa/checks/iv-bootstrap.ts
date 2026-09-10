import type { CheckDefinition, CheckContext, Evaluation } from '../check.js';

/**
 * The external IV bootstrap's overlap checks — 03 §3.8a, 04 §7.3 (Q17).
 *
 * **Registered only once a `bootstrap_iv` load exists.** An unbought bootstrap
 * has no series to check, and a check registered against nothing would evaluate
 * nothing every run and sit in the zero-fire list looking exactly like one that
 * is silently broken. `ivBootstrapChecks(db)` returns an empty list until there
 * is something to compare.
 *
 * **Zero paired days is the maximum firing of QC-907, not a pass.** The check
 * was first drafted as "for every day both series exist, store the paired
 * difference" — which on zero such days evaluates nothing, stores nothing, and
 * reads as clean. That is not hypothetical: the existing app's `iv_history`
 * splices two sources with **zero overlapping ticker-days** across 1,055 shared
 * tickers, and nothing in the stored data can now say whether that splice
 * distorted IV rank. Making the day count a thresholded quantity in its own
 * right is the whole difference between a check that cannot fire and one that
 * fires hardest precisely when there is nothing to compare.
 */

/** 04 §7.3. A working value, to be replaced by what the first bootstrap's own distribution says. */
export const MIN_OVERLAP_DAYS = 20;

/** 04 §7.3 †. Two vol points, as a fraction — both series store fractions, not percentages. */
export const MAX_MEDIAN_ABS_DIFF = 0.02;

interface PairedRow {
  ticker: string;
  paired_days: number;
}

/**
 * Pairs the two series **per ticker, on days both measured it**.
 *
 * The join is an inner join on `(ticker, date)` and that is the point: it counts
 * only genuine common days. The count it produces is then reported whether the
 * check fires or not, so "we never had an overlap" and "the overlap was clean"
 * cannot look alike.
 *
 * Only `ok` derived rows pair. A day our own derivation declared
 * `insufficient_expirations` is not a day on which both series measured the
 * same thing, and counting it would inflate the very quantity the check exists
 * to protect.
 */
export function pairedOverlap(ctx: CheckContext): readonly PairedRow[] {
  return ctx.db
    .prepare(
      `SELECT e.ticker AS ticker, COUNT(*) AS paired_days
         FROM ext_iv_history e
         JOIN derived_iv30_daily d
           ON d.ticker = e.ticker AND d.as_of_date = e.date
        WHERE e.accepted = 0
          AND d.status = 'ok' AND d.iv30_status = 'ok' AND d.iv30 IS NOT NULL
        GROUP BY e.ticker
        ORDER BY e.ticker`
    )
    .all() as PairedRow[];
}

/**
 * The median, computed in JS because SQLite has none — and a mean is not a
 * substitute here. The overlap compares two different *methods*, so a handful
 * of days where one of them priced badly should not move the verdict, which is
 * exactly what an average would let them do.
 */
function medianAbsDiff(ctx: CheckContext, ticker: string): number | null {
  const diffs = (
    ctx.db
      .prepare(
        `SELECT ABS(e.iv30 - d.iv30) AS diff
           FROM ext_iv_history e
           JOIN derived_iv30_daily d
             ON d.ticker = e.ticker AND d.as_of_date = e.date
          WHERE e.ticker = ? AND e.accepted = 0
            AND d.status = 'ok' AND d.iv30_status = 'ok' AND d.iv30 IS NOT NULL
          ORDER BY diff`
      )
      .all(ticker) as { diff: number }[]
  ).map((r) => r.diff);

  if (diffs.length === 0) return null;
  const mid = Math.floor(diffs.length / 2);
  return diffs.length % 2 === 1
    ? (diffs[mid] as number)
    : ((diffs[mid - 1] as number) + (diffs[mid] as number)) / 2;
}

/** Tickers with an unaccepted external series, whether or not they have paired days yet. */
function unacceptedTickers(ctx: CheckContext): readonly string[] {
  return (
    ctx.db
      .prepare('SELECT DISTINCT ticker FROM ext_iv_history WHERE accepted = 0 ORDER BY ticker')
      .all() as { ticker: string }[]
  ).map((r) => r.ticker);
}

export const QC907_BOOTSTRAP_OVERLAP: CheckDefinition = {
  id: 'QC-907',
  domain: 'iv_bootstrap',
  severity: 'blocking',
  description:
    'Every unaccepted external IV series has been compared against our own on at least ' +
    `${MIN_OVERLAP_DAYS} common trading days. **Zero paired days is the maximum firing of this ` +
    'check, not a pass** — the tested quantity is the paired-day count itself, reported on every ' +
    'evaluation whether it fired or not, so "we never had an overlap" and "the overlap was clean" ' +
    'can never look alike. Blocking on the bootstrap only: it never makes a daily domain unusable.',
  readsTables: ['ext_iv_history', 'derived_iv30_daily'],
  testedQuantity: 'paired_days',
  testedUnit: 'count',
  thresholds: { minPairedDays: MIN_OVERLAP_DAYS },
  thresholdBasis: 'working',
  thresholdEvidence:
    '20 is the smallest window giving a per-ticker paired difference more than a handful of ' +
    'observations while staying inside a single month of subscription (04 §7.3). To be replaced by ' +
    "whatever the first bootstrap's own distribution says was needed.",
  run(ctx): readonly Evaluation[] {
    const paired = new Map(pairedOverlap(ctx).map((p) => [p.ticker, p]));

    // Driven from the ticker list, NOT from the join. A ticker whose series has
    // no common day at all produces no join row, and iterating the join would
    // silently skip exactly the case this check exists for — the vacuous pass
    // that the existing app's splice actually suffered.
    return unacceptedTickers(ctx).map((ticker): Evaluation => {
      const days = paired.get(ticker)?.paired_days ?? 0;
      const fired = days < MIN_OVERLAP_DAYS;
      return {
        key: ticker,
        value: days,
        fired,
        detail: fired
          ? `${ticker}: ${days} paired day(s) against ${MIN_OVERLAP_DAYS} required — ` +
            (days === 0
              ? 'the two series have never measured the same day, so no comparison exists to pass'
              : 'the series stays unread until the days accumulate')
          : undefined,
        evidence: { pairedDays: days, required: MIN_OVERLAP_DAYS }
      };
    });
  }
};

export const QC908_BOOTSTRAP_DISAGREEMENT: CheckDefinition = {
  id: 'QC-908',
  domain: 'iv_bootstrap',
  severity: 'blocking',
  description:
    'Where the overlap is sufficient, the median absolute difference between our own IV30 and the ' +
    'external series is within tolerance. Evaluated only on series that have cleared QC-907 — ' +
    'a disagreement measured over three days is not a disagreement.',
  readsTables: ['ext_iv_history', 'derived_iv30_daily'],
  testedQuantity: 'median_abs_diff',
  testedUnit: 'fraction',
  thresholds: { maxMedianAbsDiff: MAX_MEDIAN_ABS_DIFF },
  thresholdBasis: 'working',
  thresholdEvidence:
    'Two vol points, chosen before any measurement. **IVX is IVolatility\'s own constant-maturity ' +
    'computation and ours interpolates variance between bracketing expirations from our own chain ' +
    'snapshots** — the overlap measures two different METHODS on the same days, not two vendors, so ' +
    'a 2-point median difference may well be ordinary. Set it from the observed distribution over ' +
    'the first 20 paired days, the way every other † is set.',
  run(ctx): readonly Evaluation[] {
    return pairedOverlap(ctx)
      .filter((p) => p.paired_days >= MIN_OVERLAP_DAYS)
      .map((p) => ({ ...p, median: medianAbsDiff(ctx, p.ticker) }))
      .filter((p): p is PairedRow & { median: number } => p.median !== null)
      .map((p): Evaluation => {
        const diff = p.median;
        const fired = diff > MAX_MEDIAN_ABS_DIFF;
        return {
          key: p.ticker,
          value: diff,
          fired,
          detail: fired
            ? `${p.ticker}: median |ext − own| = ${(diff * 100).toFixed(2)} vol points over ` +
              `${p.paired_days} paired days, above the ${(MAX_MEDIAN_ABS_DIFF * 100).toFixed(0)}-point tolerance`
            : undefined,
          evidence: { medianAbsDiff: diff, pairedDays: p.paired_days }
        };
      });
  }
};

/**
 * The bootstrap checks, **only when there is a bootstrap**.
 *
 * 03 §3.8a is explicit that these are registered once a load exists. Returning
 * them unconditionally would put two permanently-zero-fire checks into the
 * registry, and QC-952's zero-fire review exists precisely so that a check
 * which never fires gets looked at — filling that list with checks that
 * *cannot* fire is how the review stops being read.
 */
export function ivBootstrapChecks(db: {
  prepare(sql: string): { get(...args: unknown[]): unknown };
}): readonly CheckDefinition[] {
  const any = db.prepare('SELECT 1 AS present FROM ext_iv_history LIMIT 1').get() as
    | { present: number }
    | undefined;
  return any ? [QC907_BOOTSTRAP_OVERLAP, QC908_BOOTSTRAP_DISAGREEMENT] : [];
}
