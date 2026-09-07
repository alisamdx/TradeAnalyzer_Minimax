import type { CheckDefinition, Evaluation } from '../check.js';

/**
 * Account checks — 03 §3.7.
 *
 * The domain where the existing app's failures were expensive rather than
 * merely invisible: every closed position's P&L was estimated from a last mark,
 * and the whole book read -$2,902 when the real fills said +$3,983.12. These
 * checks exist so a number that wrong cannot sit unremarked for a month.
 */

export const QC801_BALANCE_SNAPSHOT: CheckDefinition = {
  id: 'QC-801',
  domain: 'account',
  severity: 'blocking',
  description:
    'A balance row exists for the run and its total account value is present. Everything about ' +
    'position sizing rests on this one number, and a missing balance is the failure mode the ' +
    'existing app produced by patching the cash snapshot into one of the two sync paths.',
  readsTables: ['raw_account_balance_snapshot'],
  testedQuantity: 'usable_balance_rows',
  testedUnit: 'count',
  thresholds: { minUsableRows: 1 },
  thresholdBasis: 'structural',
  remediation: 'R1',
  run(ctx) {
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM raw_account_balance_snapshot
          WHERE as_of_date = ? AND total_account_value_status = 'ok'`
      )
      .get(ctx.tradingDate) as { n: number };

    return [
      {
        key: ctx.tradingDate,
        value: row.n,
        fired: row.n < this.thresholds['minUsableRows']!,
        detail:
          row.n === 0
            ? 'no balance row with a usable total account value for this run'
            : `${row.n} usable balance rows`,
        evidence: { usableRows: row.n }
      }
    ];
  }
};

export const QC802_POSITION_ORDER_RECONCILIATION: CheckDefinition = {
  id: 'QC-802',
  domain: 'account',
  severity: 'warning',
  description:
    'A position that appeared or vanished between snapshots has an executed order leg explaining the ' +
    'quantity change. Assignments, exercises and expiries show up as orders or transactions; a ' +
    'change with neither behind it means the account moved for a reason we did not capture, which is ' +
    'exactly what makes a reconstructed P&L wrong in both directions.',
  readsTables: ['raw_account_position_snapshot', 'raw_executed_order_leg', 'raw_account_transaction'],
  testedQuantity: 'unexplained_position_changes',
  testedUnit: 'count',
  thresholds: { maxUnexplained: 0 },
  thresholdBasis: 'structural',
  remediation: 'R7',
  run(ctx) {
    const previous = ctx.db
      .prepare(
        `SELECT MAX(as_of_date) AS d FROM raw_account_position_snapshot WHERE as_of_date < ?`
      )
      .get(ctx.tradingDate) as { d: string | null } | undefined;
    // Nothing to compare against on the first run — an absent baseline is not
    // evidence of an unexplained change.
    if (!previous?.d) return [];
    const priorDate = previous.d;

    const rows = ctx.db
      .prepare(
        `SELECT symbol,
                COALESCE(today.q, 0) AS today_qty,
                COALESCE(prior.q, 0) AS prior_qty
           FROM (
             SELECT DISTINCT symbol FROM raw_account_position_snapshot
              WHERE as_of_date IN (?, ?)
           ) s
           LEFT JOIN (
             SELECT symbol, SUM(quantity) AS q FROM raw_account_position_snapshot
              WHERE as_of_date = ? GROUP BY symbol
           ) today USING (symbol)
           LEFT JOIN (
             SELECT symbol, SUM(quantity) AS q FROM raw_account_position_snapshot
              WHERE as_of_date = ? GROUP BY symbol
           ) prior USING (symbol)`
      )
      .all(ctx.tradingDate, priorDate, ctx.tradingDate, priorDate) as {
      symbol: string;
      today_qty: number;
      prior_qty: number;
    }[];

    const explainedBy = ctx.db.prepare(
      `SELECT COUNT(*) AS n
         FROM raw_executed_order_leg l
         JOIN raw_executed_order o ON o.row_id = l.order_row_id
        WHERE l.symbol = ? AND o.executed_time > ?`
    );
    const inTransactions = ctx.db.prepare(
      `SELECT COUNT(*) AS n FROM raw_account_transaction
        WHERE symbol = ? AND transaction_date > ?`
    );

    const out: Evaluation[] = [];
    for (const r of rows) {
      const delta = r.today_qty - r.prior_qty;
      if (delta === 0) {
        out.push({ key: r.symbol, value: 0, fired: false });
        continue;
      }
      const orders = (explainedBy.get(r.symbol, priorDate) as { n: number }).n;
      const transactions = (inTransactions.get(r.symbol, priorDate) as { n: number }).n;
      const explained = orders > 0 || transactions > 0;

      out.push({
        key: r.symbol,
        value: explained ? 0 : 1,
        fired: !explained,
        detail: `${r.symbol} moved ${r.prior_qty} to ${r.today_qty} since ${priorDate} with no order or transaction behind it`,
        evidence: { symbol: r.symbol, priorQuantity: r.prior_qty, todayQuantity: r.today_qty, priorDate, delta }
      });
    }
    return out;
  }
};

export const QC803_ORDER_IDEMPOTENCE: CheckDefinition = {
  id: 'QC-803',
  domain: 'account',
  severity: 'blocking',
  description:
    'An executed order that has been stored twice with different leg data. An executed order is ' +
    'immutable, so two versions of one order id means either the provider changed its answer or our ' +
    'parser changed its mind — and both need looking at before anything reconciles against them. ' +
    'This is why `order_id` is deliberately not unique: a unique index would turn the finding into ' +
    'an insert failure indistinguishable from a parse fault.',
  readsTables: ['raw_executed_order'],
  testedQuantity: 'distinct_fingerprints_per_order',
  testedUnit: 'count',
  thresholds: { maxFingerprintsPerOrder: 1 },
  thresholdBasis: 'structural',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT order_id, COUNT(DISTINCT order_fingerprint) AS versions
           FROM raw_executed_order GROUP BY order_id HAVING versions > 1`
      )
      .all() as { order_id: string; versions: number }[];

    // Reported per offending order; when none exists the check still records a
    // zero so its distribution says it looked, rather than saying nothing.
    if (rows.length === 0) return [{ key: ctx.tradingDate, value: 1, fired: false }];

    return rows.map((r) => ({
      key: r.order_id,
      value: r.versions,
      fired: true,
      detail: `order ${r.order_id} is stored with ${r.versions} different leg fingerprints`,
      evidence: { orderId: r.order_id, versions: r.versions }
    })) satisfies Evaluation[];
  }
};

export const QC804_FILLS_WITHOUT_PRICE: CheckDefinition = {
  id: 'QC-804',
  domain: 'account',
  severity: 'blocking',
  description:
    'A leg that filled has a fill price. `average_execution_price` is the number that supersedes ' +
    'every estimate, so a filled leg without one leaves the position priced by inference — which is ' +
    'the reconstruction that read an assigned CSP as a -$3,736 loss when it was a +$499.48 ' +
    'conversion into stock.',
  readsTables: ['raw_executed_order_leg'],
  testedQuantity: 'priceless_filled_legs',
  testedUnit: 'count',
  thresholds: { maxPricelessLegs: 0 },
  thresholdBasis: 'structural',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT l.row_id, l.symbol, l.filled_quantity, o.order_id
           FROM raw_executed_order_leg l
           JOIN raw_executed_order o ON o.row_id = l.order_row_id
          WHERE o.run_id = ? AND l.filled_quantity > 0
            AND (l.average_execution_price IS NULL OR l.average_execution_price = 0)`
      )
      .all(ctx.runId) as { row_id: number; symbol: string; filled_quantity: number; order_id: string }[];

    if (rows.length === 0) return [{ key: ctx.tradingDate, value: 0, fired: false }];

    return rows.map((r) => ({
      key: `${r.order_id}:${r.symbol}`,
      value: 1,
      fired: true,
      detail: `order ${r.order_id} filled ${r.filled_quantity} of ${r.symbol} with no execution price`,
      evidence: { orderId: r.order_id, symbol: r.symbol, filledQuantity: r.filled_quantity }
    })) satisfies Evaluation[];
  }
};

export const QC805_TRANSACTIONS_UNAVAILABLE: CheckDefinition = {
  id: 'QC-805',
  domain: 'account',
  severity: 'warning',
  description:
    'The transactions fallback answered this run. It is known to go unresponsive for ~120 s behind ' +
    'an `oauth_problem=nonce_used` mask that is a server-side timeout rather than an OAuth fault — a ' +
    'fresh nonce gets it too — so this is a warning that says the fallback is unavailable today, ' +
    'never a gate on the account domain.',
  readsTables: ['meta_response'],
  testedQuantity: 'failed_transaction_calls',
  testedUnit: 'count',
  thresholds: { maxFailedCalls: 0 },
  thresholdBasis: 'structural',
  remediation: 'R1',
  run(ctx) {
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN parse_status != 'ok' THEN 1 ELSE 0 END) AS failed
           FROM meta_response
          WHERE run_id = ? AND endpoint LIKE '%/transactions'`
      )
      .get(ctx.runId) as { total: number; failed: number | null };
    if (!row || row.total === 0) return [];

    const failed = row.failed ?? 0;
    return [
      {
        key: ctx.tradingDate,
        value: failed,
        fired: failed > 0,
        detail: `${failed} of ${row.total} transaction calls failed`,
        evidence: { total: row.total, failed }
      }
    ];
  }
};

export const QC806_ENCRYPTION: CheckDefinition = {
  id: 'QC-806',
  domain: 'account',
  severity: 'blocking',
  description:
    'Every account-domain response is recorded as encrypted at rest (P15). Positions, balances and ' +
    'fills are the one domain where an archive line in the clear is a disclosure rather than an ' +
    'inconvenience, so this is checked from the index rather than trusted from the writer.',
  readsTables: ['meta_response'],
  testedQuantity: 'unencrypted_account_responses',
  testedUnit: 'count',
  thresholds: { maxUnencrypted: 0 },
  thresholdBasis: 'structural',
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT source_response_id, endpoint FROM meta_response
          WHERE run_id = ? AND endpoint LIKE '/v1/accounts/%' AND encrypted = 0`
      )
      .all(ctx.runId) as { source_response_id: number; endpoint: string }[];

    if (rows.length === 0) return [{ key: ctx.tradingDate, value: 0, fired: false }];

    return rows.map((r) => ({
      key: `response ${String(r.source_response_id)}`,
      value: 1,
      fired: true,
      detail: `account response ${String(r.source_response_id)} (${r.endpoint}) is not marked encrypted`,
      evidence: { sourceResponseId: r.source_response_id, endpoint: r.endpoint }
    })) satisfies Evaluation[];
  }
};

export const ACCOUNT_CHECKS: readonly CheckDefinition[] = [
  QC801_BALANCE_SNAPSHOT,
  QC802_POSITION_ORDER_RECONCILIATION,
  QC803_ORDER_IDEMPOTENCE,
  QC804_FILLS_WITHOUT_PRICE,
  QC805_TRANSACTIONS_UNAVAILABLE,
  QC806_ENCRYPTION
];
