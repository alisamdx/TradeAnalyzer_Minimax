import type { CheckContext, CheckDefinition, Evaluation } from '../check.js';
import type { SqliteLike } from '../../db/sqlite-like.js';
import { tradingDaysInRange } from '../../collector/trading-calendar.js';

/**
 * Daily bar checks — 03 §3.3.
 *
 * Two of these carry **measured** thresholds (‡), not guesses, and re-opening
 * them needs new evidence rather than a fresh opinion. Both were measured on the
 * same episode set in the existing app on 2026-08-28.
 */

export const QC201_BAR_COMPLETENESS: CheckDefinition = {
  id: 'QC-201',
  domain: 'bars',
  severity: 'blocking',
  description:
    'Every active universe member has a bar for the trading date. Measured baseline: the existing ' +
    'app reaches 1,083 of 1,089 in steady state — a persistent 0.55 % miss, the same six tickers ' +
    'daily rather than a transient one. The 1 % line is about twice that floor, leaving roughly five ' +
    'tickers of headroom, and the non-zero baseline is recorded so a future session does not read ' +
    '0.55 % as a fault.',
  readsTables: ['raw_daily_bar', 'ref_universe_membership'],
  testedQuantity: 'missing_ticker_fraction',
  testedUnit: 'fraction',
  thresholds: { maxMissingFraction: 0.01 },
  thresholdBasis: 'working',
  remediation: 'R2',
  run(ctx) {
    const expected = (
      ctx.db
        .prepare(
          `SELECT DISTINCT ticker FROM ref_universe_membership
            WHERE valid_to IS NULL OR valid_to >= ?`
        )
        .all(ctx.tradingDate) as { ticker: string }[]
    ).map((r) => r.ticker);
    if (expected.length === 0) return [];

    const stored = new Set(
      (
        ctx.db
          .prepare('SELECT DISTINCT ticker FROM raw_daily_bar WHERE trade_date = ?')
          .all(ctx.tradingDate) as { ticker: string }[]
      ).map((r) => r.ticker)
    );

    const missing = expected.filter((t) => !stored.has(t));
    const fraction = missing.length / expected.length;

    // One evaluation for the whole day: the tested quantity is a fraction of the
    // universe, not a per-ticker value, so the distribution across runs is what
    // makes the threshold reviewable.
    return [
      {
        key: ctx.tradingDate,
        value: fraction,
        fired: fraction > this.thresholds['maxMissingFraction']!,
        detail: `${missing.length} of ${expected.length} active members have no bar (${(fraction * 100).toFixed(2)}%)`,
        evidence: { expected: expected.length, stored: expected.length - missing.length, missingSample: missing.slice(0, 20) }
      }
    ];
  }
};

export const QC202_OHLC_ORDER: CheckDefinition = {
  id: 'QC-202',
  domain: 'bars',
  severity: 'blocking',
  description:
    'Within each bar, low is at or below both open and close, both are at or below high, and no ' +
    'price is zero or negative. A bar that fails this is not a price series at all, and every ' +
    'indicator computed over it inherits the fault silently.',
  readsTables: ['raw_daily_bar'],
  testedQuantity: null,
  testedUnit: null,
  thresholds: {},
  thresholdBasis: 'not_applicable',
  run(ctx) {
    const bad = ctx.db
      .prepare(
        `SELECT ticker, trade_date, open, high, low, close FROM raw_daily_bar
          WHERE run_id = ?
            AND (low > open OR low > close OR open > high OR close > high
                 OR open <= 0 OR high <= 0 OR low <= 0 OR close <= 0)
          LIMIT 200`
      )
      .all(ctx.runId) as Record<string, unknown>[];

    if (bad.length === 0) return [{ key: ctx.tradingDate, fired: false }];
    return bad.map((b) => ({
      key: `${String(b['ticker'])} ${String(b['trade_date'])}`,
      fired: true,
      detail: `OHLC out of order: o=${String(b['open'])} h=${String(b['high'])} l=${String(b['low'])} c=${String(b['close'])}`,
      evidence: b,
      affects: [String(b['trade_date'])]
    }));
  }
};

export const QC203_NON_FINAL_BAR: CheckDefinition = {
  id: 'QC-203',
  domain: 'bars',
  severity: 'warning',
  description:
    'A bar fetched before the settlement window closed was re-fetched before the run ended. Polygon ' +
    'keeps settling the day past 16:00 ET, and the existing app stored a partial same-day bar from ' +
    'its morning slot and then scored breakouts and volume surges off it.',
  readsTables: ['raw_daily_bar'],
  testedQuantity: 'non_final_fraction',
  testedUnit: 'fraction',
  thresholds: { maxNonFinalFraction: 0 },
  // Structural: any at all is a finding, so the zero is a definition rather
  // than a number anyone chose. Calling it `working` would park it in the
  // pilot's threshold-review queue forever.
  thresholdBasis: 'structural',
  run(ctx) {
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN is_final = 0 THEN 1 ELSE 0 END) AS non_final
           FROM raw_daily_bar WHERE run_id = ? AND trade_date = ?`
      )
      .get(ctx.runId, ctx.tradingDate) as { total: number; non_final: number | null };
    if (row.total === 0) return [];
    const fraction = (row.non_final ?? 0) / row.total;
    return [
      {
        key: ctx.tradingDate,
        value: fraction,
        fired: fraction > 0,
        detail: `${row.non_final ?? 0} of ${row.total} bars are still non-final at run end`,
        evidence: { total: row.total, nonFinal: row.non_final ?? 0 }
      }
    ];
  }
};

/**
 * How old a step must be before a verified-genuine verdict is final (v1.1.277). The documented
 * rule is that a "genuine move" verdict must expire, because providers backfill corporate actions
 * late; 90 days is past any realistic late backfill, so a step older than that whose bars came
 * from one adjusted fetch and whose actions R6 re-fetched is not re-examined again.
 */
export const VERIFIED_MOVE_MIN_AGE_DAYS = 90;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * QC-204 steps whose splits and dividends R6 re-fetched successfully, keyed by the finding's key,
 * with when. On 2026-09-18, 121 of 123 open steps had one — the re-fetch found nothing, which is
 * the evidence a genuine move needs and that the old rule could only ask an operator to restate.
 */
function refetchedByR6(ctx: CheckContext): ReadonlyMap<string, string> {
  const rows = ctx.db
    .prepare(
      `SELECT key, remediations_json FROM qa_exception
        WHERE check_id = 'QC-204' AND remediations_json LIKE '%"R6"%'`
    )
    .all() as { key: string; remediations_json: string }[];
  // A step that is evidence of ticker REUSE is not a genuine move, however well verified its
  // prices are: META's 2022-06-09 step is a Roundhill ETF becoming Meta. It stays a finding until
  // the operator's reuse ruling splits the series (after which it is not compared at all).
  const reuse = ctx.db
    .prepare(
      `SELECT check_id, key FROM qa_exception
        WHERE check_id IN ('QC-205', 'QC-209', 'QC-210') AND state IN ('open', 'acknowledged')`
    )
    .all() as { check_id: string; key: string }[];
  const reuseSteps = new Set(reuse.filter((r) => r.check_id !== 'QC-210').map((r) => r.key));
  const reuseTickers = new Set(reuse.filter((r) => r.check_id === 'QC-210').map((r) => r.key));
  const out = new Map<string, string>();
  for (const r of rows) {
    if (reuseSteps.has(r.key) || reuseTickers.has(r.key.split(' ')[0]!)) continue;
    const ok = (JSON.parse(r.remediations_json) as { code?: string; outcome?: string; at?: string }[])
      .filter((x) => x.code === 'R6' && x.outcome === 'success');
    if (ok.length > 0) out.set(r.key, ok[ok.length - 1]!.at ?? '');
  }
  return out;
}

/**
 * The verified-genuine-move verdict for specific QC-204 keys, for a check that mirrors QC-204
 * (QC-501) and must reach the same answer on the same run without re-reading 1.3 M bars. Same
 * conditions as QC-204's own: one adjusted fetch after the step, a successful R6 re-fetch, no
 * open reuse evidence, older than `VERIFIED_MOVE_MIN_AGE_DAYS`. Returns key → closing note.
 */
function verifiedNote(adjustedAsOf: string, refetchedAt: string): string {
  return (
    `verified genuine move: both bars from one split-adjusted fetch dated ${adjustedAsOf}, ` +
    `R6 re-fetched splits and dividends (${refetchedAt}) and found none, step older than ` +
    `${VERIFIED_MOVE_MIN_AGE_DAYS} days`
  );
}

export function verifiedGenuineSteps(ctx: CheckContext, keys: readonly string[]): ReadonlyMap<string, string> {
  const refetched = refetchedByR6(ctx);
  const bar = ctx.db.prepare(
    `SELECT b.trade_date, b.adjusted_as_of FROM raw_daily_bar b
      WHERE b.ticker = ? AND b.trade_date <= ?
        AND b.observed_at = (SELECT MAX(x.observed_at) FROM raw_daily_bar x
                              WHERE x.ticker = b.ticker AND x.trade_date = b.trade_date)
      ORDER BY b.trade_date DESC LIMIT 2`
  );
  const out = new Map<string, string>();
  for (const key of keys) {
    const [ticker, date] = key.split(' ');
    const r6At = refetched.get(key);
    if (!ticker || !date || r6At === undefined) continue;
    if (daysBetween(date, ctx.tradingDate) <= VERIFIED_MOVE_MIN_AGE_DAYS) continue;
    const [cur, prev] = bar.all(ticker, date) as { trade_date: string; adjusted_as_of: string }[];
    if (!cur || !prev || cur.trade_date !== date) continue;
    if (prev.adjusted_as_of !== cur.adjusted_as_of || !(date < cur.adjusted_as_of)) continue;
    out.set(key, verifiedNote(cur.adjusted_as_of, r6At));
  }
  return out;
}

export const QC204_DISCONTINUITY: CheckDefinition = {
  id: 'QC-204',
  domain: 'bars',
  severity: 'blocking',
  description:
    'A close that moves more than 40 % against the previous close, with no split or special dividend ' +
    'on the boundary. An unadjusted split is the usual cause and it corrupts every indicator that ' +
    'spans the date — silently, because the series still looks like prices. A step is a VERIFIED ' +
    'genuine move, measured but not fired, when both bars come from one split-adjusted fetch made ' +
    'after it, R6 re-fetched its splits and dividends and found none, and it is over 90 days old.',
  readsTables: ['raw_daily_bar', 'raw_split', 'raw_dividend', 'qa_exception'],
  testedQuantity: 'abs_close_change_fraction',
  testedUnit: 'fraction',
  thresholds: { maxAbsChange: 0.4 },
  thresholdBasis: 'measured',
  thresholdEvidence:
    '153 discontinuities across 126 tickers, measured 2026-08-28 on the existing app. Unadjusted ' +
    'splits sat at -74 % (CRWD 4:1), +203 % (DD) and +177 % (MRNA) against SPY\'s largest genuine ' +
    'daily move of 2.58 %. 40 % sits in a wide empty gap between the two populations.',
  remediation: 'R5',
  run(ctx) {
    const entityStart = entityStartDates(ctx.db);
    // Latest observation per (ticker, trade_date), so a re-fetched series is
    // compared at its current version rather than against a superseded row.
    const rows = ctx.db
      .prepare(
        `SELECT b.ticker, b.trade_date, b.close, b.adjusted_as_of
           FROM raw_daily_bar b
           JOIN (SELECT ticker, trade_date, MAX(observed_at) AS latest
                   FROM raw_daily_bar GROUP BY ticker, trade_date) m
             ON m.ticker = b.ticker AND m.trade_date = b.trade_date AND m.latest = b.observed_at
          WHERE b.ticker IN (SELECT DISTINCT ticker FROM raw_daily_bar WHERE run_id = ?)
          ORDER BY b.ticker, b.trade_date`
      )
      .all(ctx.runId) as { ticker: string; trade_date: string; close: number; adjusted_as_of: string }[];

    const refetched = refetchedByR6(ctx);
    const out: Evaluation[] = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!;
      const cur = rows[i]!;
      if (prev.ticker !== cur.ticker || prev.close <= 0) continue;
      // Bars from before a recorded splice belong to a previous occupant of the
      // symbol. Comparing across or within them compares two companies.
      const start = entityStart.get(cur.ticker);
      if (start !== undefined && prev.trade_date < start) continue;

      const change = Math.abs(cur.close / prev.close - 1);
      const fired = change > this.thresholds['maxAbsChange']!;

      let explained = false;
      if (fired) {
        const action = ctx.db
          .prepare(
            `SELECT 1 FROM raw_split WHERE ticker = ? AND execution_date BETWEEN ? AND ?
              UNION ALL
             SELECT 1 FROM raw_dividend WHERE ticker = ? AND ex_dividend_date BETWEEN ? AND ?
                AND dividend_type <> 'CD'`
          )
          .get(cur.ticker, prev.trade_date, cur.trade_date, cur.ticker, prev.trade_date, cur.trade_date);
        explained = action !== undefined;
      }

      // A verified genuine move (v1.1.277): both bars come from one split-adjusted fetch made
      // after the step, so no split between them can be left unadjusted; R6 re-fetched the
      // splits and dividends around it and found none; and it is old enough that a late
      // corporate-action backfill is no longer a realistic explanation.
      const key = `${cur.ticker} ${cur.trade_date}`;
      const r6At = refetched.get(key);
      const verified =
        fired && !explained && r6At !== undefined &&
        prev.adjusted_as_of === cur.adjusted_as_of && cur.trade_date < cur.adjusted_as_of &&
        daysBetween(cur.trade_date, ctx.tradingDate) > VERIFIED_MOVE_MIN_AGE_DAYS;

      // Every comparison is recorded, fired or not — that is the distribution.
      out.push({
        key,
        value: change,
        fired: fired && !explained && !verified,
        detail: fired
          ? `close ${cur.close} vs prev ${prev.close} (${((cur.close / prev.close - 1) * 100).toFixed(1)}%)` +
            (explained
              ? ' — explained by a corporate action'
              : verified
                ? ' — verified genuine move: one adjusted fetch, R6 found no action'
                : ' with no explaining action')
          : undefined,
        evidence: {
          ticker: cur.ticker, close: cur.close, prevClose: prev.close, change, explained,
          ...(verified ? { verifiedGenuineMove: { adjustedAsOf: cur.adjusted_as_of, refetchedAt: r6At } } : {})
        },
        closesAs: verified
          ? {
              kind: 'false_positive',
              note: verifiedNote(cur.adjusted_as_of, r6At as string)
            }
          : undefined,
        affects: [cur.trade_date]
      });
    }
    return out;
  }
};

/** Exchange sessions of volume on each side of a discontinuity — 03 §3.3's "20-day median". */
export const REGIME_WINDOW = 20;

/**
 * Bars a 20-session window must actually hold to count as measured, or — for
 * QC-209 — to count as "trading again".
 *
 * **Windows are counted in exchange SESSIONS, not in stored bars.** The first
 * rewrite took "the 20 bars either side", and on 2026-09-12 SOLS showed why that
 * is wrong: a $0.0001 shell printing once every few weeks has 20 bars spanning
 * two years, so its "next 20 bars" reached across the 2025-10-30 splice into
 * Solstice Advanced Materials. Three shell-internal steps from 2024 and early
 * 2025 all reported the same post-splice median (4,222,115). A window measured
 * in sessions cannot cross into another entity's history; one measured in bars
 * can cross any distance the series happens to be empty for.
 */
export const MIN_WINDOW_BARS = 15;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface VolumeBar {
  readonly ticker: string;
  readonly trade_date: string;
  readonly close: number;
  readonly volume: number | null;
}

/** Each bar's position on the exchange calendar; undefined for a date that is not a session. */
function sessionsOf(series: readonly VolumeBar[], sessionIndex: ReadonlyMap<string, number>): (number | undefined)[] {
  return series.map((b) => sessionIndex.get(b.trade_date));
}

/** Indices of the bars whose session lies in `[from, to]`, scanning outward from `start`. */
function barsInSessions(
  sessions: readonly (number | undefined)[],
  start: number,
  from: number,
  to: number,
  direction: -1 | 1
): number[] {
  const out: number[] = [];
  for (let j = start; j >= 0 && j < sessions.length; j += direction) {
    const s = sessions[j];
    if (s === undefined) continue;
    if (direction === -1 ? s < from : s > to) break;
    if (s >= from && s <= to) out.push(j);
  }
  return out;
}

function isStep(prev: VolumeBar, cur: VolumeBar, stepAt: number): boolean {
  return prev.close > 0 && Math.abs(cur.close / prev.close - 1) > stepAt;
}

/**
 * QC-205 over one ticker's series, oldest first: an evaluation per discontinuity
 * whose two 20-session windows each hold at least `MIN_WINDOW_BARS` volumes.
 */
export function volumeRegimeAroundSteps(
  series: readonly VolumeBar[],
  sessionIndex: ReadonlyMap<string, number>,
  stepAt: number,
  minRatio: number
): Evaluation[] {
  const out: Evaluation[] = [];
  const sessions = sessionsOf(series, sessionIndex);
  const volumes = (idx: readonly number[]): number[] =>
    idx.map((j) => series[j]!.volume).filter((v): v is number => v !== null);

  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!;
    const cur = series[i]!;
    const at = sessions[i];
    if (at === undefined || !isStep(prev, cur, stepAt)) continue;

    const before = volumes(barsInSessions(sessions, i - 1, at - REGIME_WINDOW, at - 1, -1));
    const after = volumes(barsInSessions(sessions, i, at, at + REGIME_WINDOW - 1, 1));
    // Not measured rather than measured thinly. A step younger than 20 sessions
    // is measured on the run that completes its window; a step in a sparse
    // series is never measured here — that shape is QC-209's.
    if (before.length < MIN_WINDOW_BARS || after.length < MIN_WINDOW_BARS) continue;

    const b = median(before);
    const a = median(after);
    // A zero median has no ratio to report, and inventing one (Infinity, a cap)
    // would put a made-up number into the distribution the threshold is judged on.
    if (b <= 0 || a <= 0) continue;

    const ratio = Math.max(a / b, b / a);
    out.push({
      key: `${cur.ticker} ${cur.trade_date}`,
      value: ratio,
      fired: ratio >= minRatio,
      detail:
        `median volume ${ratio.toFixed(1)}x across the ${cur.trade_date} step ` +
        `(${Math.round(b)} before over ${before.length} sessions, ${Math.round(a)} after over ${after.length}) ` +
        '— the ticker-reuse signature',
      evidence: {
        ticker: cur.ticker, stepDate: cur.trade_date, medianBefore: b, medianAfter: a, ratio,
        barsBefore: before.length, barsAfter: after.length
      },
      affects: [cur.trade_date]
    });
  }
  return out;
}

/**
 * QC-209 over one ticker's series: for every discontinuity, the sessions that
 * passed with no bar before it. Fires when that gap is long AND the symbol then
 * trades on most of the next 20 sessions — a dormant symbol resuming as an
 * active one. The second condition is what keeps a shell's own sparse,
 * sub-penny steps from firing: they follow long gaps too, but nothing dense
 * follows them.
 */
export function dormancyBeforeSteps(
  series: readonly VolumeBar[],
  sessionIndex: ReadonlyMap<string, number>,
  stepAt: number,
  minGap: number
): Evaluation[] {
  const out: Evaluation[] = [];
  const sessions = sessionsOf(series, sessionIndex);

  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!;
    const cur = series[i]!;
    const at = sessions[i];
    const was = sessions[i - 1];
    if (at === undefined || was === undefined || !isStep(prev, cur, stepAt)) continue;

    const gap = at - was - 1;
    const tradedAfter = barsInSessions(sessions, i, at, at + REGIME_WINDOW - 1, 1).length;
    const fired = gap >= minGap && tradedAfter >= MIN_WINDOW_BARS;
    out.push({
      key: `${cur.ticker} ${cur.trade_date}`,
      value: gap,
      fired,
      detail: fired
        ? `${gap} sessions with no bar before the ${cur.trade_date} step (last bar ${prev.trade_date}, close ` +
          `${prev.close} → ${cur.close}), then ${tradedAfter} of the next ${REGIME_WINDOW} sessions traded ` +
          '— a dormant symbol resuming as an active one'
        : undefined,
      evidence: {
        ticker: cur.ticker, stepDate: cur.trade_date, lastBarBefore: prev.trade_date,
        gapSessions: gap, tradedOfNext20: tradedAfter, closeBefore: prev.close, closeAfter: cur.close
      },
      affects: [cur.trade_date]
    });
  }
  return out;
}

/**
 * The latest observation per (ticker, trade_date) for the tickers this run
 * wrote, grouped by ticker, with the exchange calendar indexed over the span.
 * Latest by MAX(row_id) — the chain subset's supersession rule.
 */
/**
 * Where each ticker's CURRENT entity begins, for the tickers an operator has
 * ruled a ticker reuse on — the `valid_from` of the open membership range whose
 * `change_reason` is `ticker_change`.
 *
 * Only `recordTickerReuse` writes such a row, which is what makes this safe to
 * read. A plain `valid_from` is when the ticker joined our universe LIST, not
 * when the listing began, so intersecting bars with membership in general would
 * throw away every bar before the seed and gut these checks. The narrow reading
 * — a recorded splice, nothing else — is the only one that means what it says.
 *
 * Until v1.1.261 nothing read it at all: `recordTickerReuse` closed one range
 * and opened another "so a reader intersecting bars with membership sees one
 * entity at a time", and there was no such reader, so a ruled reuse kept firing
 * on the previous occupant's bars every run and the operator's ruling lasted
 * exactly until the next one.
 */
export function entityStartDates(db: SqliteLike): ReadonlyMap<string, string> {
  const rows = db
    .prepare(
      `SELECT ticker, MIN(valid_from) AS start
         FROM ref_universe_membership
        WHERE valid_to IS NULL AND change_reason = 'ticker_change'
        GROUP BY ticker`
    )
    .all() as { ticker: string; start: string }[];
  return new Map(rows.map((r) => [r.ticker, r.start]));
}

function latestSeries(ctx: CheckContext): { readonly byTicker: VolumeBar[][]; readonly sessionIndex: Map<string, number> } {
  const entityStart = entityStartDates(ctx.db);
  const rows = ctx.db
    .prepare(
      `SELECT ticker, trade_date, close, volume FROM raw_daily_bar
        WHERE row_id IN (
          SELECT MAX(row_id) FROM raw_daily_bar
           WHERE ticker IN (SELECT DISTINCT ticker FROM raw_daily_bar WHERE run_id = ?)
           GROUP BY ticker, trade_date
        )
        ORDER BY ticker, trade_date`
    )
    .all(ctx.runId) as VolumeBar[];

  const byTicker: VolumeBar[][] = [];
  let from: string | undefined;
  let to: string | undefined;
  for (const r of rows) {
    // A ruled splice ends the previous occupant's series; the volume and
    // dormancy windows must not reach back across it.
    const start = entityStart.get(r.ticker);
    if (start !== undefined && r.trade_date < start) continue;
    const last = byTicker[byTicker.length - 1];
    if (last && last[0]!.ticker === r.ticker) last.push(r);
    else byTicker.push([r]);
    if (from === undefined || r.trade_date < from) from = r.trade_date;
    if (to === undefined || r.trade_date > to) to = r.trade_date;
  }
  const sessionIndex = new Map<string, number>();
  if (from !== undefined && to !== undefined) {
    tradingDaysInRange(ctx.db, from, to).forEach((d, i) => sessionIndex.set(d, i));
  }
  return { byTicker, sessionIndex };
}

export const QC205_VOLUME_REGIME: CheckDefinition = {
  id: 'QC-205',
  domain: 'bars',
  severity: 'blocking',
  description:
    'Volume regime around a discontinuity: the median volume over the 20 exchange sessions after a ' +
    'close that moved more than QC-204\'s threshold, against the 20 sessions before it, measured only ' +
    'when each window holds at least 15 bars. This is the check that tells the three causes apart, ' +
    'and it discriminates on VOLUME rather than price: ticker reuse shifts the volume regime ' +
    'permanently by 15x or more, while a genuine violent move stays within 5x. No re-fetch can ever ' +
    'fix reuse — the provider keys by ticker too — so the operator must truncate before the splice. ' +
    'A dormant symbol has no window to measure; QC-209 covers that form. A step the operator ' +
    'resolved as `false_positive` (a genuine event on a continuing listing, not reuse) is measured ' +
    'but never fires again.',
  readsTables: ['raw_daily_bar', 'ref_trading_day', 'qa_exception'],
  testedQuantity: 'volume_regime_ratio',
  testedUnit: 'ratio',
  thresholds: { minRegimeRatio: 15 },
  thresholdBasis: 'measured',
  thresholdEvidence:
    'The same 2026-08-28 episode set. Ticker reuse at 76x (BNY) and 53,592x (SPCX) against genuine ' +
    'violent moves at 5.0x or less (MRNA). Two orders of magnitude apart.',
  run(ctx) {
    // The first version compared the last 20 ROWS with the 20 before them —
    // stacked backfills made that ~13 days, and it only looked at the tail. It
    // never found out, because zero volumes made it evaluate nothing at all.
    const { byTicker, sessionIndex } = latestSeries(ctx);
    const stepAt = QC204_DISCONTINUITY.thresholds['maxAbsChange']!;
    const minRatio = this.thresholds['minRegimeRatio']!;
    return withNotReuseRulings(
      ctx, byTicker.flatMap((series) => volumeRegimeAroundSteps(series, sessionIndex, stepAt, minRatio))
    );
  }
};

/**
 * QC-205 steps the operator has ruled are NOT ticker reuse, keyed by the finding's key
 * (`TICKER yyyy-mm-dd`), with the ruling's note (v1.1.276).
 *
 * The counterpart of the reuse ruling. On 2026-09-18 all ten QC-205 findings were genuine
 * events on continuing listings — APLD's uplisting from OTC, BMNR's treasury pivot, GME's May
 * 2024 squeeze, QXO's takeover, SMMT's licensing deal, WAL in the regional-bank crisis — and none
 * could be closed: they are historic steps, so they fire every night; an acceptance expires; a
 * `false_positive` resolution was reopened by the next run as a recurrence. A step's volume
 * regime cannot change after the fact, so the ruling is permanent for THAT step: a resolution
 * of kind `false_positive` on a QC-205 finding makes the check evaluate that key as not fired.
 * A new step on the same ticker is a different key and still fires.
 */
function notReuseRulings(ctx: Parameters<CheckDefinition['run']>[0]): ReadonlyMap<string, string> {
  const rows = ctx.db
    .prepare(
      `SELECT key, resolution_note FROM qa_exception
        WHERE check_id IN ('QC-205', 'QC-209') AND state = 'resolved' AND resolution_kind = 'false_positive'`
    )
    .all() as { key: string; resolution_note: string | null }[];
  return new Map(rows.map((r) => [r.key, r.resolution_note ?? '']));
}

/**
 * Applies the "not reuse" rulings to QC-205's or QC-209's evaluations (v1.1.279). The ruling is
 * about the STEP — both checks key it `TICKER yyyy-mm-dd` and ask the same question of it — so a
 * ruling made on either finding holds for both. Until v1.1.279 only QC-205 read them, and a
 * `false_positive` on a QC-209 finding was reopened by the next run as a recurrence.
 */
function withNotReuseRulings(
  ctx: Parameters<CheckDefinition['run']>[0],
  evaluations: readonly Evaluation[]
): Evaluation[] {
  const ruled = notReuseRulings(ctx);
  return evaluations.map((e) => {
    const note = ruled.get(e.key);
    // Still measured, so the distribution stays whole; just no longer a finding.
    return note === undefined || !e.fired
      ? e
      : { ...e, fired: false, evidence: { ...(e.evidence ?? {}), ruledNotReuse: note } };
  });
}

export const QC209_DORMANT_SERIES_RESUMES: CheckDefinition = {
  id: 'QC-209',
  domain: 'bars',
  severity: 'blocking',
  description:
    'A discontinuity preceded by 20 or more exchange sessions with no bar, after which the symbol trades ' +
    'on at least 15 of the next 20 sessions: a dormant symbol resuming as an active one. The form of ' +
    'ticker reuse QC-205 cannot measure, because a symbol that printed a few times a year has no ' +
    '20-session volume window before the step. Found 2026-09-12 on SOLS: a $0.0001 shell trading once ' +
    'every few weeks until 2025-10-30, then Solstice Advanced Materials at $48.74 with ~100,000 trades a ' +
    'day — the step that was also QC-204\'s maximum (487,399x). A step ruled `false_positive` (not ' +
    'reuse) on this finding or its QC-205 twin is measured but never fires again.',
  readsTables: ['raw_daily_bar', 'ref_trading_day', 'qa_exception'],
  testedQuantity: 'sessions_without_bar_before_step',
  testedUnit: 'sessions',
  thresholds: { minGapSessions: 20 },
  // 20 sessions (about a month) matches QC-205's window and sits far above the
  // one-to-three-session gaps of a halt or a data hole, but it has not been set
  // from a distribution yet: the pilot's review queue is where that happens.
  thresholdBasis: 'working',
  run(ctx) {
    const { byTicker, sessionIndex } = latestSeries(ctx);
    const stepAt = QC204_DISCONTINUITY.thresholds['maxAbsChange']!;
    const minGap = this.thresholds['minGapSessions']!;
    return withNotReuseRulings(
      ctx, byTicker.flatMap((series) => dormancyBeforeSteps(series, sessionIndex, stepAt, minGap))
    );
  }
};

export const QC207_TRADING_DAY_GAP: CheckDefinition = {
  id: 'QC-207',
  domain: 'bars',
  severity: 'warning',
  description:
    'A ticker with bars on both sides of a trading day has one for that day too. A hole in the ' +
    'middle of a series is invisible to anything that reads the tail and assumes the history is ' +
    'contiguous — which is most indicators.',
  readsTables: ['raw_daily_bar', 'ref_trading_day'],
  testedQuantity: 'missing_day_count',
  testedUnit: 'count',
  thresholds: { maxMissingDays: 0 },
  // Structural: any at all is a finding, so the zero is a definition rather
  // than a number anyone chose. Calling it `working` would park it in the
  // pilot's threshold-review queue forever.
  thresholdBasis: 'structural',
  run(ctx) {
    const tradingDays = (
      ctx.db
        .prepare(
          `SELECT date FROM ref_trading_day
            WHERE is_trading_day = 1 AND date <= ? ORDER BY date DESC LIMIT 20`
        )
        .all(ctx.tradingDate) as { date: string }[]
    ).map((r) => r.date);
    if (tradingDays.length < 3) return [];

    const window = new Set(tradingDays);
    const tickers = (
      ctx.db
        .prepare('SELECT DISTINCT ticker FROM raw_daily_bar WHERE run_id = ?')
        .all(ctx.runId) as { ticker: string }[]
    ).map((r) => r.ticker);

    const out: Evaluation[] = [];
    for (const ticker of tickers) {
      const have = new Set(
        (
          ctx.db
            .prepare('SELECT DISTINCT trade_date FROM raw_daily_bar WHERE ticker = ? AND trade_date >= ?')
            .all(ticker, tradingDays[tradingDays.length - 1]) as { trade_date: string }[]
        ).map((r) => r.trade_date)
      );
      if (have.size === 0) continue;
      // Only days BETWEEN the ticker's first and last bar in the window are
      // holes. The first version counted every window day without a bar, so a
      // series that simply began inside the window — every ticker on a new
      // generation, a new listing — read as a gap on each day before it began:
      // 1,083 findings of 17 missing days on gen-001's first full run.
      const inWindow = [...have].filter((d) => window.has(d)).sort();
      const first = inWindow[0];
      const last = inWindow[inWindow.length - 1];
      const missing =
        first === undefined || last === undefined
          ? []
          : [...window].filter((d) => d > first && d < last && !have.has(d)).sort();
      out.push({
        key: ticker,
        value: missing.length,
        fired: missing.length > 0,
        detail: missing.length > 0 ? `no bar on ${missing.slice(0, 5).join(', ')}` : undefined,
        evidence: { ticker, missing: missing.slice(0, 20) }
      });
    }
    return out;
  }
};

export const QC210_BARS_PREDATE_LISTING: CheckDefinition = {
  id: 'QC-210',
  domain: 'bars',
  severity: 'blocking',
  description:
    'A stored bar dated before the ticker\'s current listing began. A bar older than `list_date` ' +
    'belongs, by definition, to a previous occupant of the symbol, so the series splices two ' +
    'entities and no re-fetch can repair it — the provider keys by ticker too. This is the same ' +
    'fault QC-205 and QC-209 look for, tested on identity rather than on behaviour: they ask ' +
    'whether the volume regime or the trading gap LOOKS like a splice, and this asks the reference ' +
    'data where the listing started.',
  readsTables: ['raw_daily_bar', 'raw_ticker_reference'],
  testedQuantity: 'bars_before_list_date',
  testedUnit: 'count',
  thresholds: { maxBarsBeforeListing: 0 },
  // Structural: one bar belonging to another company is a finding, and that is a
  // definition rather than a number anyone chose.
  thresholdBasis: 'structural',
  thresholdEvidence:
    'Measured over gen-002 on 2026-09-17: 11 of 1,082 tickers with a list_date (1.0 %) hold bars ' +
    'before it, and EVERY gap exceeds 365 days — none in the 1-5 or 6-90 day bands. So there is no ' +
    'borderline population for a grace period to protect, and a zero threshold costs nothing. The ' +
    'error is also one-directional: a list_date that is too EARLY causes a miss, and only one that ' +
    'is too late could indict good history. Detail carries the day gap so a future artefact is ' +
    'ruled out at a glance.',
  // None. Truncate-before-listing is an operator action (03 section 6), exactly as
  // for QC-205 and QC-209 — and a relisting or redomicile (ASND, JHX, COLB, SAIL
  // on this sample) may be continuous history that must NOT be truncated.
  run(ctx) {
    // The CURRENT listing, one row per ticker. A newer reference row supersedes an
    // older one, so read the latest rather than any.
    const listed = new Map(
      (
        ctx.db
          .prepare(
            `SELECT t.ticker, t.list_date, t.name
               FROM raw_ticker_reference t
               JOIN (SELECT ticker, MAX(row_id) AS m FROM raw_ticker_reference GROUP BY ticker) x
                 ON x.m = t.row_id
              WHERE t.list_date IS NOT NULL`
          )
          .all() as { ticker: string; list_date: string; name: string | null }[]
      ).map((r) => [r.ticker, r])
    );

    // Only tickers whose listing we actually know are evaluated. A ticker with no
    // reference row is untestable, and recording it as zero would be a pass this
    // check never earned.
    const rows = ctx.db
      .prepare(
        `SELECT ticker, MIN(trade_date) AS first_bar, COUNT(*) AS bars
           FROM raw_daily_bar
          WHERE ticker IN (SELECT DISTINCT ticker FROM raw_daily_bar WHERE run_id = ?)
          GROUP BY ticker`
      )
      .all(ctx.runId) as { ticker: string; first_bar: string; bars: number }[];

    // A ruled splice is the answer to this check's own question, so the ticker
    // leaves the population rather than firing for ever on history the operator
    // has already accounted for.
    const ruled = entityStartDates(ctx.db);

    const out: Evaluation[] = [];
    for (const r of rows) {
      const ref = listed.get(r.ticker);
      if (ref === undefined || ruled.has(r.ticker)) continue;
      if (r.first_bar >= ref.list_date) {
        // Recorded, not skipped: the zeros are the distribution this check's
        // 1 % base rate is read from.
        out.push({ key: r.ticker, value: 0, fired: false });
        continue;
      }
      const before = (
        ctx.db
          .prepare('SELECT COUNT(*) AS n FROM raw_daily_bar WHERE ticker = ? AND trade_date < ?')
          .get(r.ticker, ref.list_date) as { n: number }
      ).n;
      const gapDays = Math.round(
        (Date.parse(`${ref.list_date}T00:00:00Z`) - Date.parse(`${r.first_bar}T00:00:00Z`)) / 86_400_000
      );
      out.push({
        key: r.ticker,
        value: before,
        fired: before > (this.thresholds['maxBarsBeforeListing'] as number),
        detail:
          `${r.ticker} (${ref.name ?? '?'}) listed ${ref.list_date}, but ${before} bar(s) are stored ` +
          `from ${r.first_bar} — ${gapDays} days earlier, so the series splices two entities`,
        evidence: {
          ticker: r.ticker, listDate: ref.list_date, firstBar: r.first_bar,
          barsBeforeListing: before, gapDays, name: ref.name
        }
      });
    }
    return out;
  }
};

export const BAR_CHECKS: readonly CheckDefinition[] = [
  QC201_BAR_COMPLETENESS,
  QC202_OHLC_ORDER,
  QC203_NON_FINAL_BAR,
  QC204_DISCONTINUITY,
  QC205_VOLUME_REGIME,
  QC207_TRADING_DAY_GAP,
  QC209_DORMANT_SERIES_RESUMES,
  QC210_BARS_PREDATE_LISTING
];
