import { greekConsistencyFor, type SqliteLike } from '@tradeanalyzer/core';
import { currentDb } from './generation.js';
import { cellsFor, viewColumns } from './view-columns.js';
import type {
  ChainGridDto,
  ChainLegDto,
  ChainRowDto,
  ContractHistoryDto,
  ExpirationOptionDto
} from '../shared/types.js';

/**
 * The Chains view's main-process half — 05 §4.2.
 *
 * Calls on the left, puts on the right, strikes down the middle, and the ATM row
 * marked from the underlying price the chain call itself carried rather than
 * from a second source.
 */

const SNAPSHOT = 'raw_option_contract_snapshot';

/** The grid's per-leg columns, in the order 05 §4.2 lists them. */
const LEG_COLUMNS = viewColumns(SNAPSHOT, [
  { column: 'bid' },
  { column: 'ask' },
  { column: 'last' },
  { column: 'iv', label: 'IV' },
  { column: 'delta' },
  { column: 'gamma' },
  { column: 'theta' },
  { column: 'vega' },
  { column: 'open_interest', label: 'OI' },
  { column: 'volume' }
]);

/** Rows within a quarter percent of the underlying are "at the money" for the highlight. */
const ATM_BAND = 0.0025;

export function chainDates(): readonly string[] {
  return (
    currentDb()
      .prepare(`SELECT DISTINCT as_of_date AS d FROM ${SNAPSHOT} ORDER BY d DESC LIMIT 400`)
      .all() as { d: string }[]
  ).map((r) => r.d);
}

export function chainTickers(asOfDate: string): readonly string[] {
  return (
    currentDb()
      .prepare(`SELECT DISTINCT ticker AS t FROM ${SNAPSHOT} WHERE as_of_date = ? ORDER BY t`)
      .all(asOfDate) as { t: string }[]
  ).map((r) => r.t);
}

/**
 * Every expiration E*Trade listed for the ticker that day — including the ones
 * the rule declined, with the reason.
 *
 * The declined ones are the point. A selector that offered only what was
 * captured could not answer "why is there no chain for January", which is the
 * question a missing expiration actually raises.
 */
export function chainExpirations(ticker: string, asOfDate: string): readonly ExpirationOptionDto[] {
  const rows = currentDb()
    .prepare(
      `SELECT e.expiration_date, e.expiry_type, e.window_reason, e.in_capture_window,
              (SELECT COUNT(*) FROM ${SNAPSHOT} c
                WHERE c.ticker = e.ticker AND c.as_of_date = e.as_of_date
                  AND c.expiration_date = e.expiration_date) AS contracts
         FROM raw_option_expiration e
        WHERE e.ticker = ? AND e.as_of_date = ?
        ORDER BY e.expiration_date`
    )
    .all(ticker, asOfDate) as {
    expiration_date: string;
    expiry_type: string;
    window_reason: string;
    in_capture_window: number;
    contracts: number;
  }[];

  return rows.map((r) => ({
    expirationDate: r.expiration_date,
    expiryType: r.expiry_type,
    windowReason: r.window_reason,
    inCaptureWindow: r.in_capture_window === 1,
    contractCount: r.contracts
  }));
}

export function chainGrid(ticker: string, asOfDate: string, expirationDate: string): ChainGridDto {
  const db = currentDb();
  const rows = db
    .prepare(
      `SELECT osi_symbol, strike, "right", underlying_price, price_status, size_status,
              greeks_status, iv_status, last_status, volume_status, open_interest_status,
              bid, ask, last, iv, delta, gamma, theta, vega, sticky_reason, observed_at
         FROM ${SNAPSHOT}
        WHERE row_id IN (
          SELECT MAX(row_id) FROM ${SNAPSHOT}
           WHERE ticker = ? AND as_of_date = ? AND expiration_date = ?
           GROUP BY osi_symbol
        )
        ORDER BY strike`
    )
    .all(ticker, asOfDate, expirationDate) as Record<string, unknown>[];

  // `bid`/`ask` and the Greeks share one status column each, so the raw row is
  // re-shaped into the per-column status the generic cell renderer expects.
  const shaped: Record<string, unknown>[] = rows.map((r) => ({
    ...r,
    bid_status: r['price_status'],
    ask_status: r['price_status'],
    delta_status: r['greeks_status'],
    gamma_status: r['greeks_status'],
    theta_status: r['greeks_status'],
    vega_status: r['greeks_status']
  }));

  const underlying =
    shaped.length > 0 ? ((shaped[0]?.['underlying_price'] as number | null) ?? null) : null;

  const byStrike = new Map<number, { call?: ChainLegDto; put?: ChainLegDto }>();
  for (const r of shaped) {
    const strike = r['strike'] as number;
    const leg: ChainLegDto = {
      osiSymbol: r['osi_symbol'] as string,
      stickyReason: (r['sticky_reason'] as string | null) ?? null,
      cells: cellsFor(SNAPSHOT, LEG_COLUMNS, r)
    };
    const entry = byStrike.get(strike) ?? {};
    if (r['right'] === 'call') entry.call = leg;
    else entry.put = leg;
    byStrike.set(strike, entry);
  }

  const grid: ChainRowDto[] = [...byStrike.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([strike, sides]) => ({
      strike,
      atm: underlying !== null && Math.abs(strike - underlying) <= underlying * ATM_BAND,
      call: sides.call ?? null,
      put: sides.put ?? null
    }));

  return {
    ticker,
    asOfDate,
    expirationDate,
    underlyingPrice: underlying,
    columns: LEG_COLUMNS,
    rows: grid,
    // QC-410's own verdict for the ticker and date, not a copy of its exception row:
    // an exception's dates are overwritten every run, so it cannot say what held on
    // a past date, while recomputing from the stored chain always can.
    greeks: greekConsistencyFor(db as unknown as SqliteLike, asOfDate, ticker)
  };
}

/**
 * One contract across every date it was captured, with the gaps labelled.
 *
 * A gap has two quite different causes and only the stored expiration row can
 * tell them apart: the rule declined the expiration that day, or the ticker was
 * not in the subset at all. Rendering both as "no data" would lose the one thing
 * worth knowing about a hole in a series.
 */
export function contractHistory(osiSymbol: string): ContractHistoryDto {
  const db = currentDb();
  const rows = db
    .prepare(
      `SELECT as_of_date, ticker, expiration_date, bid, ask, last, iv, delta, volume, open_interest,
              price_status, last_status, iv_status, greeks_status, volume_status, open_interest_status
         FROM ${SNAPSHOT}
        WHERE row_id IN (
          SELECT MAX(row_id) FROM ${SNAPSHOT} WHERE osi_symbol = ? GROUP BY as_of_date
        )
        ORDER BY as_of_date`
    )
    .all(osiSymbol) as Record<string, unknown>[];

  const columns = viewColumns(SNAPSHOT, [
    { column: 'bid' },
    { column: 'ask' },
    { column: 'last' },
    { column: 'iv', label: 'IV' },
    { column: 'delta' },
    { column: 'volume' },
    { column: 'open_interest', label: 'OI' }
  ]);

  if (rows.length === 0) {
    return { osiSymbol, columns, rows: [] };
  }

  const ticker = rows[0]?.['ticker'] as string;
  const expiration = rows[0]?.['expiration_date'] as string;
  // Every date the collector ran between the first and last capture. A date the
  // collector never reached is not a gap in this contract's history.
  const runDates = (
    db
      .prepare(
        `SELECT DISTINCT as_of_date AS d FROM raw_option_expiration
          WHERE as_of_date BETWEEN ? AND ? ORDER BY d`
      )
      .all(rows[0]?.['as_of_date'], rows[rows.length - 1]?.['as_of_date']) as { d: string }[]
  ).map((r) => r.d);

  const gapReason = db.prepare(
    `SELECT window_reason FROM raw_option_expiration
      WHERE ticker = ? AND as_of_date = ? AND expiration_date = ? LIMIT 1`
  );
  const byDate = new Map(rows.map((r) => [r['as_of_date'] as string, r]));

  return {
    osiSymbol,
    columns,
    rows: runDates.map((date) => {
      const row = byDate.get(date);
      if (row) {
        return {
          asOfDate: date,
          captured: true,
          gapReason: null,
          cells: cellsFor(SNAPSHOT, columns, {
            ...row,
            bid_status: row['price_status'],
            ask_status: row['price_status'],
            delta_status: row['greeks_status']
          })
        };
      }
      const listed = gapReason.get(ticker, date, expiration) as { window_reason: string } | undefined;
      return {
        asOfDate: date,
        captured: false,
        gapReason: listed
          ? `the rule declined this expiration (${listed.window_reason})`
          : 'the ticker was not in the chain subset that day',
        cells: columns.map(() => ({ value: null, status: null }))
      };
    })
  };
}
