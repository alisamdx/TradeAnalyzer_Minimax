/**
 * The stored-brief panel: every `daily_briefs` row and, when asked, the `structure_liquidity_log`,
 * served through GET /diagnostics/brief-history-panel. It exists so the expiry and liquidity study
 * scripts (fr-expiry-liquidity-study, fr-expiry-realized-ab, fr-liquidity-slot-comparison,
 * fr-wheel-liquidity-calibration) stop opening `trade-analyzer.sqlite` themselves. From Claude
 * Code's MSIX-redirected shell such an open MOVES a WAL database (CLAUDE.md). Same fix as
 * spread-study-panel (v1.1.338).
 *
 * `picks` is returned as the stored JSON text, unparsed. The scripts parse each row inside a
 * try/catch and skip a malformed one, and a server-side parse would silently decide that for them.
 *
 * A liquidity log that cannot be read is `null`, never an empty list, so "no table" and "no rows"
 * stay distinguishable.
 *
 * Read-only: SELECTs only.
 */

import type { PanelDb } from './settled-csp-panel';

export interface BriefHistoryRow {
  readonly strategy: string;
  readonly generatedAt: string;
  /** JSON text of BriefPick[], exactly as stored. */
  readonly picks: string;
}

export interface LiquidityLogRow {
  readonly capturedAt: string;
  readonly dateEt: string;
  readonly ticker: string;
  readonly slug: string;
  readonly liquidityScore: number | null;
  readonly noBidLeg: number;
}

export interface BriefHistoryPanel {
  readonly briefs: readonly BriefHistoryRow[];
  readonly liquidityLog: readonly LiquidityLogRow[] | null;
}

export function briefHistoryPanel(db: PanelDb, opts: { strategy?: string; liquidityLog?: boolean } = {}): BriefHistoryPanel {
  const briefs = (opts.strategy
    ? db.prepare('SELECT strategy, generated_at AS generatedAt, picks FROM daily_briefs WHERE strategy = ? ORDER BY generated_at').all(opts.strategy)
    : db.prepare('SELECT strategy, generated_at AS generatedAt, picks FROM daily_briefs ORDER BY generated_at').all()
  ) as BriefHistoryRow[];

  let liquidityLog: LiquidityLogRow[] | null = null;
  if (opts.liquidityLog) {
    try {
      liquidityLog = db.prepare(
        `SELECT captured_at AS capturedAt, date_et AS dateEt, ticker, slug,
                liquidity_score AS liquidityScore, no_bid_leg AS noBidLeg
           FROM structure_liquidity_log ORDER BY id`
      ).all() as LiquidityLogRow[];
    } catch {
      liquidityLog = null;
    }
  }
  return { briefs, liquidityLog };
}
