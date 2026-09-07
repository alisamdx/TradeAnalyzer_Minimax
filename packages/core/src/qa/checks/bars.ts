import type { CheckDefinition, Evaluation } from '../check.js';

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

export const QC204_DISCONTINUITY: CheckDefinition = {
  id: 'QC-204',
  domain: 'bars',
  severity: 'blocking',
  description:
    'A close that moves more than 40 % against the previous close, with no split or special dividend ' +
    'on the boundary. An unadjusted split is the usual cause and it corrupts every indicator that ' +
    'spans the date — silently, because the series still looks like prices.',
  readsTables: ['raw_daily_bar', 'raw_split', 'raw_dividend'],
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
    // Latest observation per (ticker, trade_date), so a re-fetched series is
    // compared at its current version rather than against a superseded row.
    const rows = ctx.db
      .prepare(
        `SELECT b.ticker, b.trade_date, b.close
           FROM raw_daily_bar b
           JOIN (SELECT ticker, trade_date, MAX(observed_at) AS latest
                   FROM raw_daily_bar GROUP BY ticker, trade_date) m
             ON m.ticker = b.ticker AND m.trade_date = b.trade_date AND m.latest = b.observed_at
          WHERE b.ticker IN (SELECT DISTINCT ticker FROM raw_daily_bar WHERE run_id = ?)
          ORDER BY b.ticker, b.trade_date`
      )
      .all(ctx.runId) as { ticker: string; trade_date: string; close: number }[];

    const out: Evaluation[] = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!;
      const cur = rows[i]!;
      if (prev.ticker !== cur.ticker || prev.close <= 0) continue;

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

      // Every comparison is recorded, fired or not — that is the distribution.
      out.push({
        key: `${cur.ticker} ${cur.trade_date}`,
        value: change,
        fired: fired && !explained,
        detail: fired
          ? `close ${cur.close} vs prev ${prev.close} (${((cur.close / prev.close - 1) * 100).toFixed(1)}%)` +
            (explained ? ' — explained by a corporate action' : ' with no explaining action')
          : undefined,
        evidence: { ticker: cur.ticker, close: cur.close, prevClose: prev.close, change, explained },
        affects: [cur.trade_date]
      });
    }
    return out;
  }
};

export const QC205_VOLUME_REGIME: CheckDefinition = {
  id: 'QC-205',
  domain: 'bars',
  severity: 'blocking',
  description:
    'Volume regime around a discontinuity. This is the check that tells the three causes apart, and ' +
    'it discriminates on VOLUME rather than price: ticker reuse shifts the volume regime permanently ' +
    'by 15x or more, while a genuine violent move stays within 5x. No re-fetch can ever fix reuse — ' +
    'the provider keys by ticker too — so the operator must truncate before the splice.',
  readsTables: ['raw_daily_bar'],
  testedQuantity: 'volume_regime_ratio',
  testedUnit: 'ratio',
  thresholds: { minRegimeRatio: 15 },
  thresholdBasis: 'measured',
  thresholdEvidence:
    'The same 2026-08-28 episode set. Ticker reuse at 76x (BNY) and 53,592x (SPCX) against genuine ' +
    'violent moves at 5.0x or less (MRNA). Two orders of magnitude apart.',
  run(ctx) {
    const tickers = (
      ctx.db
        .prepare('SELECT DISTINCT ticker FROM raw_daily_bar WHERE run_id = ?')
        .all(ctx.runId) as { ticker: string }[]
    ).map((r) => r.ticker);

    const out: Evaluation[] = [];
    for (const ticker of tickers) {
      const vols = (
        ctx.db
          .prepare(
            `SELECT volume FROM raw_daily_bar WHERE ticker = ?
              ORDER BY trade_date DESC LIMIT 40`
          )
          .all(ticker) as { volume: number }[]
      ).map((r) => r.volume);
      if (vols.length < 40) continue;

      const median = (xs: readonly number[]) => {
        const s = [...xs].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)] as number;
      };
      const recent = median(vols.slice(0, 20));
      const older = median(vols.slice(20));
      if (older <= 0 || recent <= 0) continue;

      const ratio = Math.max(recent / older, older / recent);
      out.push({
        key: ticker,
        value: ratio,
        fired: ratio >= this.thresholds['minRegimeRatio']!,
        detail: `20-day median volume shifted ${ratio.toFixed(1)}x (${older} to ${recent}) — the ticker-reuse signature`,
        evidence: { ticker, recentMedian: recent, olderMedian: older, ratio }
      });
    }
    return out;
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
      const missing = [...window].filter((d) => !have.has(d));
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

export const BAR_CHECKS: readonly CheckDefinition[] = [
  QC201_BAR_COMPLETENESS,
  QC202_OHLC_ORDER,
  QC203_NON_FINAL_BAR,
  QC204_DISCONTINUITY,
  QC205_VOLUME_REGIME,
  QC207_TRADING_DAY_GAP
];
