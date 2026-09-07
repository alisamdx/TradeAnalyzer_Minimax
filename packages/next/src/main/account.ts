import { currentDb } from './generation.js';
import { cellsFor, viewColumns } from './view-columns.js';
import type { BalancesDto, OrdersDto, PositionsDto, PositionRowDto } from '../shared/types.js';

/**
 * The Account view's main-process half — 05 §4.4.
 *
 * **No derived P&L, anywhere** (Q13). The provider's own gain fields are shown,
 * in a visibly separate group labelled as estimates, because that is what they
 * are: the existing app reconstructed P&L from them and read an assigned CSP as
 * a -$3,736 loss when the fill said +$499.48, and the whole book at -$2,902 when
 * it was +$3,983.12. Nothing here computes a return.
 */

const POSITIONS = 'raw_account_position_snapshot';
const ORDERS = 'raw_executed_order';
const LEGS = 'raw_executed_order_leg';
const BALANCES = 'raw_account_balance_snapshot';

const ESTIMATES = 'provider estimates';

const POSITION_COLUMNS = viewColumns(POSITIONS, [
  { column: 'symbol', group: 'position' },
  { column: 'security_type', label: 'Type', group: 'position' },
  { column: 'right', group: 'position' },
  { column: 'strike', group: 'position' },
  { column: 'expiration_date', label: 'Expiry', group: 'position' },
  { column: 'quantity', group: 'position' },
  { column: 'price_paid', label: 'Cost basis', group: 'position' },
  { column: 'total_cost', group: 'position' },
  { column: 'last_price', group: 'market' },
  { column: 'market_value', group: 'market' },
  { column: 'days_gain', label: "Day gain (provider's)", group: ESTIMATES },
  { column: 'total_gain', label: "Total gain (provider's)", group: ESTIMATES }
]);

const ORDER_COLUMNS = viewColumns(ORDERS, [
  { column: 'order_id' },
  { column: 'order_type', label: 'Type' },
  { column: 'executed_time' },
  { column: 'price_type' },
  { column: 'limit_price' },
  { column: 'status' }
]);

const LEG_COLUMNS = viewColumns(LEGS, [
  { column: 'symbol' },
  { column: 'right' },
  { column: 'strike' },
  { column: 'expiration_date', label: 'Expiry' },
  { column: 'order_action', label: 'Action' },
  { column: 'filled_quantity', label: 'Filled' },
  { column: 'average_execution_price', label: 'Fill price' },
  { column: 'estimated_commission', label: 'Commission' },
  { column: 'estimated_fees', label: 'Fees' }
]);

const BALANCE_COLUMNS = viewColumns(BALANCES, [
  { column: 'total_account_value' },
  { column: 'net_cash' },
  { column: 'cash_available_for_investment' },
  { column: 'cash_buying_power' },
  { column: 'margin_buying_power' }
]);

export function snapshotDates(): readonly string[] {
  return (
    currentDb()
      .prepare(`SELECT DISTINCT as_of_date AS d FROM ${POSITIONS} ORDER BY d DESC`)
      .all() as { d: string }[]
  ).map((r) => r.d);
}

function latestPerSymbol(asOfDate: string): Record<string, unknown>[] {
  return currentDb()
    .prepare(
      `SELECT * FROM ${POSITIONS}
        WHERE row_id IN (
          SELECT MAX(row_id) FROM ${POSITIONS} WHERE as_of_date = ? GROUP BY symbol, osi_symbol
        )
        ORDER BY symbol, osi_symbol`
    )
    .all(asOfDate) as Record<string, unknown>[];
}

/**
 * Positions as of a date, diffed against the previous snapshot, with the order
 * legs that explain each change.
 *
 * A change with nothing explaining it is left visibly unexplained rather than
 * quietly reconciled — that absence is QC-802's finding and the view says so.
 */
export function positions(asOfDate: string): PositionsDto {
  const db = currentDb();
  const previous = db
    .prepare(`SELECT MAX(as_of_date) AS d FROM ${POSITIONS} WHERE as_of_date < ?`)
    .get(asOfDate) as { d: string | null } | undefined;
  const priorDate = previous?.d ?? null;

  const today = latestPerSymbol(asOfDate);
  const prior = priorDate ? latestPerSymbol(priorDate) : [];

  const keyOf = (r: Record<string, unknown>): string =>
    `${String(r['symbol'])}|${String(r['osi_symbol'] ?? '')}`;
  const priorByKey = new Map(prior.map((r) => [keyOf(r), r]));

  // An option position is explained by a leg on the same CONTRACT; a stock
  // position by a leg on the same symbol. Matching a stock line on symbol alone
  // is right; matching an option line that way would let an unrelated strike
  // explain it, which is the collapse that put an open assignment lot together
  // with a closed one in the existing app.
  const byContract = db.prepare(
    `SELECT o.order_id, l.order_action, l.filled_quantity
       FROM ${LEGS} l JOIN ${ORDERS} o ON o.row_id = l.order_row_id
      WHERE l.osi_symbol = ? AND o.executed_time > ?`
  );
  const bySymbol = db.prepare(
    `SELECT o.order_id, l.order_action, l.filled_quantity
       FROM ${LEGS} l JOIN ${ORDERS} o ON o.row_id = l.order_row_id
      WHERE l.symbol = ? AND l.osi_symbol IS NULL AND o.executed_time > ?`
  );

  const explain = (r: Record<string, unknown>): readonly string[] => {
    if (priorDate === null) return [];
    const osi = r['osi_symbol'] as string | null;
    const found = (
      osi
        ? byContract.all(osi, priorDate)
        : bySymbol.all(r['symbol'], priorDate)
    ) as { order_id: string; order_action: string; filled_quantity: number }[];
    return found.map((e) => `${e.order_action} ${String(e.filled_quantity)} — order ${e.order_id}`);
  };

  const rows: PositionRowDto[] = [];

  for (const r of today) {
    const key = keyOf(r);
    const was = priorByKey.get(key);
    const quantity = r['quantity'] as number;
    const previousQuantity = was ? (was['quantity'] as number) : null;
    const change =
      was === undefined
        ? 'appeared'
        : previousQuantity === quantity
          ? 'unchanged'
          : 'quantity_changed';

    rows.push({
      key,
      cells: cellsFor(POSITIONS, POSITION_COLUMNS, r),
      change,
      previousQuantity,
      explainedBy: change === 'unchanged' ? [] : explain(r)
    });
    priorByKey.delete(key);
  }

  // Whatever is left in the prior snapshot and not in today's has gone. It is a
  // row here, not an absence: a position that vanishes is detected by comparing
  // snapshots, never by deleting anything.
  for (const [key, was] of priorByKey) {
    rows.push({
      key,
      cells: cellsFor(POSITIONS, POSITION_COLUMNS, was),
      change: 'disappeared',
      previousQuantity: was['quantity'] as number,
      explainedBy: explain(was)
    });
  }

  return { asOfDate, previousAsOfDate: priorDate, columns: POSITION_COLUMNS, rows };
}

export function orders(limit = 100): OrdersDto {
  const db = currentDb();
  const capped = Math.min(Math.max(limit, 1), 500);
  const orderRows = db
    .prepare(
      `SELECT * FROM ${ORDERS}
        WHERE row_id IN (SELECT MAX(row_id) FROM ${ORDERS} GROUP BY order_id)
        ORDER BY executed_time DESC, row_id DESC LIMIT ${capped}`
    )
    .all() as Record<string, unknown>[];

  const legRows = db.prepare(`SELECT * FROM ${LEGS} WHERE order_row_id = ? ORDER BY leg_index`);

  return {
    columns: ORDER_COLUMNS,
    legColumns: LEG_COLUMNS,
    orders: orderRows.map((o) => ({
      orderId: o['order_id'] as string,
      cells: cellsFor(ORDERS, ORDER_COLUMNS, o),
      // A combo is one order with N legs, filled as a package — never N
      // independent orders, and the view shows it that way.
      legs: (legRows.all(o['row_id']) as Record<string, unknown>[]).map((l) => ({
        cells: cellsFor(LEGS, LEG_COLUMNS, l)
      }))
    }))
  };
}

export function balances(): BalancesDto {
  const rows = currentDb()
    .prepare(
      `SELECT * FROM ${BALANCES}
        WHERE row_id IN (SELECT MAX(row_id) FROM ${BALANCES} GROUP BY as_of_date)
        ORDER BY as_of_date`
    )
    .all() as Record<string, unknown>[];

  return {
    columns: BALANCE_COLUMNS,
    points: rows.map((r) => ({
      asOfDate: r['as_of_date'] as string,
      cells: cellsFor(BALANCES, BALANCE_COLUMNS, r)
    }))
  };
}
