/**
 * Downside overnight gap-risk metric (display-only).
 *
 * Measures how hard a name gaps DOWN overnight relative to what its implied volatility
 * is pricing — the downside is what matters to a stock owner / short-put (wheel/CSP) seller.
 *
 *   adverseGapP95 = 95th-percentile magnitude of downside overnight gaps over the window
 *                   (gap_t = (open_t − close_{t-1}) / close_{t-1}; downside = negative gaps)
 *   ivDailyMove   = atmIv / √252                         (IV-implied 1-day move)
 *   score         = adverseGapP95 / ivDailyMove
 *
 * score > 1 ⇒ the name's realized downside-gap tail is FATTER than IV implies — i.e. you are
 * (historically) under-compensated by option premium for its jump risk. P95 (not the max) is
 * used so the metric is robust to a single outlier and is naturally mostly ex-earnings (the few
 * earnings gaps/yr sit in the top ~1.6%, above P95).
 *
 * NOTE: this is a DISPLAY/context metric only. A Brief-Replay study (2026-06-27, NEW_FRONTIER §9)
 * found it is NOT a shippable entry filter on the current ~13-month IV panel — directionally
 * informative on win-quality for naked short puts, but not the tail hedge the thesis claimed, and
 * inverted on defined-risk spreads (whose long wing caps gap loss). It is surfaced so the trader
 * can eyeball it, not gated on.
 *
 * see docs/formulas.md#gap-risk
 */
export interface GapRiskResult {
  /** adverseGapP95 / ivDailyMove. >1 = gaps harder than IV prices. */
  score: number;
  /** 95th-percentile downside overnight gap magnitude, as a percent (e.g. 4.2 = 4.2%). */
  adverseGapP95Pct: number;
  /** IV-implied 1-day move, as a percent. */
  ivDailyMovePct: number;
  /** Number of downside-gap observations in the window. */
  sampleDays: number;
}

export function computeGapRisk(
  bars: ReadonlyArray<{ o: number; c: number; t?: number }>,
  atmIvPct: number | null,
  window = 252,
): GapRiskResult | null {
  if (!bars || bars.length < 60 || atmIvPct === null || !(atmIvPct > 0)) return null;

  // Ensure chronological order when timestamps are present.
  const sorted = bars.slice();
  if (sorted.every((b) => typeof b.t === 'number')) {
    sorted.sort((a, b) => (a.t as number) - (b.t as number));
  }
  const use = sorted.slice(-(window + 1)); // window gaps need window+1 bars

  const adverse: number[] = [];
  for (let i = 1; i < use.length; i++) {
    const openT = use[i]!.o;
    const prevClose = use[i - 1]!.c;
    if (!(openT > 0) || !(prevClose > 0)) continue;
    const gap = (openT - prevClose) / prevClose;
    if (-gap > 0) adverse.push(-gap); // downside gap = adverse magnitude (positive)
  }
  if (adverse.length < 10) return null;

  adverse.sort((a, b) => a - b);
  const idx = Math.min(adverse.length - 1, Math.max(0, Math.round(0.95 * (adverse.length - 1))));
  const p95 = adverse[idx]!;
  const ivDaily = atmIvPct / 100 / Math.sqrt(252);
  if (!(ivDaily > 0)) return null;

  return {
    score: p95 / ivDaily,
    adverseGapP95Pct: p95 * 100,
    ivDailyMovePct: ivDaily * 100,
    sampleDays: adverse.length,
  };
}
