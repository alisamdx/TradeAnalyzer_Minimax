/**
 * The spread-capture panel — what the BPS-4 and BPS-19 harnesses (`scripts/fr-spread-dte-cost-study.mjs`,
 * `scripts/fr-spread-monthly-rule-study.mjs`, via `scripts/lib/spread-study-lib.mjs`) read, served
 * through GET /diagnostics/spread-capture-panel so they run against the live app instead of opening
 * `trade-analyzer.sqlite` themselves.
 *
 * Both opened the production database from their own shell and so could not run inside the Claude app,
 * whose shell is MSIX-redirected (CLAUDE.md). Same fix as spread-study-panel (v1.1.338).
 *
 * Returns exactly what the library's SQL selected: every `reason = 'entry'` row of
 * `spread_chain_capture` in the same order (a `track` row exists only because its expiry was already
 * picked, a selection effect), and — when asked — `earnings_calendar`. A table that cannot be read is
 * `null`, never `[]`: "no capture table" and "no captures" are different findings.
 *
 * Read-only: SELECTs only.
 */

import type { PanelDb } from './settled-csp-panel';

export interface CaptureRow {
  readonly as_of_date: string;
  readonly slot: string;
  readonly ticker: string;
  readonly expiration: string;
  readonly dte: number;
  readonly underlying_price: number | null;
  readonly puts_json: string;
}

export interface SpreadCapturePanel {
  readonly captures: readonly CaptureRow[] | null;
  readonly earnings: readonly { ticker: string; report_date: string }[] | null;
}

function tryAll<T>(db: PanelDb, sql: string): T[] | null {
  try {
    return db.prepare(sql).all() as T[];
  } catch {
    return null;
  }
}

export function spreadCapturePanel(db: PanelDb, includeEarnings: boolean): SpreadCapturePanel {
  return {
    captures: tryAll<CaptureRow>(
      db,
      `SELECT as_of_date, slot, ticker, expiration, dte, underlying_price, puts_json
         FROM spread_chain_capture WHERE reason = 'entry' ORDER BY as_of_date, slot, ticker, dte`
    ),
    earnings: includeEarnings
      ? tryAll<{ ticker: string; report_date: string }>(db, 'SELECT ticker, report_date FROM earnings_calendar')
      : null
  };
}
