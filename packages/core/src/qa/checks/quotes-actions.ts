import type { CheckDefinition, Evaluation } from '../check.js';
import { verifiedGenuineSteps } from './bars.js';

/**
 * End-of-day quote and corporate-action checks — 03 §3.4, §3.6.
 */

export const QC301_QUOTE_COMPLETENESS: CheckDefinition = {
  id: 'QC-301',
  domain: 'quotes',
  severity: 'blocking',
  description:
    'Every active universe member has a snapshot row for the trading date. This threshold could not ' +
    'be measured against the existing app before the pilot: its `quote_cache` is keyed on ticker and ' +
    'keeps only the latest quote, so no per-run coverage rate exists to measure. The pilot is the ' +
    'first time the quantity exists at all.',
  readsTables: ['raw_eod_quote', 'ref_universe_membership'],
  testedQuantity: 'missing_ticker_fraction',
  testedUnit: 'fraction',
  thresholds: { maxMissingFraction: 0.01 },
  thresholdBasis: 'working',
  remediation: 'R1',
  run(ctx) {
    const expected = (
      ctx.db
        .prepare('SELECT DISTINCT ticker FROM ref_universe_membership WHERE valid_to IS NULL')
        .all() as { ticker: string }[]
    ).map((r) => r.ticker);
    if (expected.length === 0) return [];

    const stored = new Set(
      (
        ctx.db
          .prepare('SELECT DISTINCT ticker FROM raw_eod_quote WHERE as_of_date = ?')
          .all(ctx.tradingDate) as { ticker: string }[]
      ).map((r) => r.ticker)
    );
    const missing = expected.filter((t) => !stored.has(t));
    const fraction = missing.length / expected.length;

    return [
      {
        key: ctx.tradingDate,
        value: fraction,
        fired: fraction > this.thresholds['maxMissingFraction']!,
        detail: `${missing.length} of ${expected.length} members have no snapshot (${(fraction * 100).toFixed(2)}%)`,
        evidence: { expected: expected.length, missingSample: missing.slice(0, 20) }
      }
    ];
  }
};

export const QC302_CLOSE_DISAGREEMENT: CheckDefinition = {
  id: 'QC-302',
  domain: 'quotes',
  severity: 'warning',
  description:
    'The snapshot close agrees with the bar close for the same ticker and day. Two independent ' +
    'readings of the same number are the cheapest cross-source check there is, and a systematic ' +
    'drift between them is the earliest sign that one of the two feeds has changed shape.',
  readsTables: ['raw_eod_quote', 'raw_daily_bar'],
  testedQuantity: 'abs_close_disagreement_fraction',
  testedUnit: 'fraction',
  thresholds: { maxAbsDisagreement: 0.005 },
  thresholdBasis: 'working',
  // Per ticker it is a warning; across enough of them it means the feed moved,
  // which is a different and blocking kind of problem (03 §2).
  promoteToBlockingAtFiredFraction: 0.02,
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT q.ticker, q.day_close, b.close
           FROM raw_eod_quote q
           JOIN raw_daily_bar b ON b.ticker = q.ticker AND b.trade_date = q.as_of_date
          WHERE q.as_of_date = ? AND q.day_close IS NOT NULL AND b.close > 0`
      )
      .all(ctx.tradingDate) as { ticker: string; day_close: number; close: number }[];

    return rows.map((r) => {
      const disagreement = Math.abs(r.day_close - r.close) / r.close;
      return {
        key: r.ticker,
        value: disagreement,
        fired: disagreement > this.thresholds['maxAbsDisagreement']!,
        detail: `snapshot close ${r.day_close} vs bar close ${r.close} (${(disagreement * 100).toFixed(2)}%)`,
        evidence: { ticker: r.ticker, snapshotClose: r.day_close, barClose: r.close, disagreement }
      } satisfies Evaluation;
    });
  }
};

export const QC303_CROSSED_MARKET: CheckDefinition = {
  id: 'QC-303',
  domain: 'quotes',
  severity: 'warning',
  description:
    'Bid does not exceed ask when both are present. A crossed quote is not a price — it is a ' +
    'stale side, a feed artefact, or a snapshot taken mid-update — and anything that computes a ' +
    'spread from it gets a negative number that looks like free money.',
  readsTables: ['raw_eod_quote'],
  testedQuantity: 'crossed_fraction',
  testedUnit: 'fraction',
  thresholds: { maxCrossedFraction: 0 },
  // Structural: any at all is a finding, so the zero is a definition rather
  // than a number anyone chose. Calling it `working` would park it in the
  // pilot's threshold-review queue forever.
  thresholdBasis: 'structural',
  run(ctx) {
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN bid > ask THEN 1 ELSE 0 END) AS crossed
           FROM raw_eod_quote
          WHERE as_of_date = ? AND quote_status = 'ok'`
      )
      .get(ctx.tradingDate) as { total: number; crossed: number | null };
    if (row.total === 0) return [];
    const fraction = (row.crossed ?? 0) / row.total;
    return [
      {
        key: ctx.tradingDate,
        value: fraction,
        fired: (row.crossed ?? 0) > 0,
        detail: `${row.crossed ?? 0} of ${row.total} quotes are crossed`,
        evidence: { total: row.total, crossed: row.crossed ?? 0 }
      }
    ];
  }
};

export const QC501_UNEXPLAINED_DISCONTINUITY: CheckDefinition = {
  id: 'QC-501',
  domain: 'corporate_actions',
  severity: 'blocking',
  description:
    'Seen from the actions side: a bar discontinuity has a split or dividend within a trading day of ' +
    'the boundary. The same finding as QC-204 from the other direction — this one asks whether the ' +
    'ACTION feed is complete, rather than whether the price series is.',
  readsTables: ['raw_daily_bar', 'raw_split', 'raw_dividend', 'qa_exception'],
  testedQuantity: 'unexplained_count',
  testedUnit: 'count',
  thresholds: { maxUnexplained: 0 },
  // Structural: any at all is a finding, so the zero is a definition rather
  // than a number anyone chose. Calling it `working` would park it in the
  // pilot's threshold-review queue forever.
  thresholdBasis: 'structural',
  remediation: 'R6',
  run(ctx) {
    const open = ctx.db
      .prepare(
        `SELECT key, evidence_json FROM qa_exception
          WHERE check_id = 'QC-204' AND state IN ('open', 'acknowledged')`
      )
      .all() as { key: string; evidence_json: string }[];

    if (open.length === 0) return [{ key: ctx.tradingDate, value: 0, fired: false }];

    // QC-204 closes its verified genuine moves in this same gate run, AFTER every check has
    // run — so reading its open findings alone left QC-501 firing on all of them for one more
    // night, and its own findings open with nothing to close them (v1.1.277). Same verdict,
    // reached the same way, closing this check's finding with the same reason.
    const verified = verifiedGenuineSteps(ctx, open.map((e) => e.key));

    return open.map((e) => {
      const note = verified.get(e.key);
      return note === undefined
        ? {
            key: e.key,
            value: 1,
            fired: true,
            detail: `bar discontinuity on ${e.key} still has no corporate action explaining it`,
            evidence: JSON.parse(e.evidence_json) as Record<string, unknown>
          }
        : {
            key: e.key,
            value: 0,
            fired: false,
            evidence: { ...(JSON.parse(e.evidence_json) as Record<string, unknown>), verifiedGenuineMove: true },
            closesAs: { kind: 'false_positive' as const, note }
          };
    });
  }
};

export const QC502_ACTION_WITHOUT_EFFECT: CheckDefinition = {
  id: 'QC-502',
  domain: 'corporate_actions',
  severity: 'info',
  description:
    'A split whose ratio is not visible in the bar series on its execution date. Expected rather ' +
    'than alarming — Polygon returns an adjusted series, so a split it already applied leaves no ' +
    'step. Recorded as info because the absence of a step is how you know the adjustment happened.',
  readsTables: ['raw_split', 'raw_daily_bar'],
  testedQuantity: 'ratio_visibility',
  testedUnit: 'ratio',
  thresholds: { minVisibleRatio: 1.5 },
  thresholdBasis: 'working',
  run(ctx) {
    const splits = ctx.db
      .prepare('SELECT ticker, execution_date, split_from, split_to FROM raw_split WHERE run_id = ?')
      .all(ctx.runId) as { ticker: string; execution_date: string; split_from: number; split_to: number }[];

    const out: Evaluation[] = [];
    for (const s of splits) {
      const bars = ctx.db
        .prepare(
          `SELECT close FROM raw_daily_bar
            WHERE ticker = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 2`
        )
        .all(s.ticker, s.execution_date) as { close: number }[];
      if (bars.length < 2 || bars[1]!.close <= 0) continue;
      const observed = Math.max(bars[0]!.close / bars[1]!.close, bars[1]!.close / bars[0]!.close);
      out.push({
        key: `${s.ticker} ${s.execution_date}`,
        value: observed,
        fired: observed >= this.thresholds['minVisibleRatio']!,
        detail: `split ${s.split_from}:${s.split_to} shows a ${observed.toFixed(2)}x step in the series`,
        evidence: { ticker: s.ticker, executionDate: s.execution_date, observedRatio: observed }
      });
    }
    return out;
  }
};

export const QUOTE_AND_ACTION_CHECKS: readonly CheckDefinition[] = [
  QC301_QUOTE_COMPLETENESS,
  QC302_CLOSE_DISAGREEMENT,
  QC303_CROSSED_MARKET,
  QC501_UNEXPLAINED_DISCONTINUITY,
  QC502_ACTION_WITHOUT_EFFECT
];
