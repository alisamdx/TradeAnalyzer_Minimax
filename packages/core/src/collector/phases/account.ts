import type { SqliteLike } from '../../db/sqlite-like.js';
import type { CollectorHost } from '../host.js';
import { throwIfCancelled } from '../host.js';
import { captureResponse } from '../capture.js';
import { recipes } from '../../ingest/recipes.js';
import { captureRuleId, type RunHandle } from '../run.js';
import { osiSymbol } from '../../ingest/osi.js';

/**
 * Phase 5 — the operator's account (04 §2, §4.4).
 *
 * Four calls, under a minute, and the only phase whose archive lines are
 * encrypted (P15, Q20). It runs early precisely because it is cheap and because
 * phase 6 reads its output: an option held in the book is a sticky contract, and
 * a sticky contract keeps being captured to expiry even if its underlying leaves
 * the chain subset.
 *
 * **The account key never reaches the database.** It is masked out of the
 * endpoint string before `meta_response` is written and stored only as a digest
 * on the rows themselves.
 */

export const ACCOUNT_RULE = { ordersLookbackDays: 30, transactionsFallback: true } as const;

export interface AccountPhaseResult {
  readonly positions: number;
  readonly balanceRows: number;
  readonly ordersStored: number;
  readonly transactionsStored: number;
  readonly stickyOpened: number;
  /**
   * True when the transactions fallback failed. Known intermittent — the
   * endpoint answers `oauth_problem=nonce_used` for ~120 s behind what is a
   * server-side timeout rather than an OAuth fault — so it is QC-805's warning
   * and never a blocking failure of the phase.
   */
  readonly transactionsFailed: boolean;
}

/** The key appears in the path; it must not appear in what we store (P15). */
export function maskAccountKey(path: string, accountKey: string): string {
  return accountKey.length > 0 ? path.split(accountKey).join('{accountKey}') : path;
}

function knownOrderFingerprints(db: SqliteLike): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT order_id, order_fingerprint FROM raw_executed_order
        WHERE row_id IN (SELECT MAX(row_id) FROM raw_executed_order GROUP BY order_id)`
    )
    .all() as { order_id: string; order_fingerprint: string }[];
  return new Map(rows.map((r) => [r.order_id, r.order_fingerprint]));
}

function knownTransactionIds(db: SqliteLike): Set<string> {
  return new Set(
    (db.prepare('SELECT transaction_id FROM raw_account_transaction').all() as {
      transaction_id: string;
    }[]).map((r) => r.transaction_id)
  );
}

/**
 * Opens a `ref_sticky_contract` row for every option currently held.
 *
 * Idempotent by design: an open row for the same `(osi_symbol, reason)` is left
 * alone rather than re-opened, so re-running a day does not multiply the pins.
 * Nothing is closed here — a pin ends at expiry, which the chain phase handles.
 *
 * **The pin's symbol is BUILT by `osiSymbol`, not copied from the position
 * (v1.1.269).** `raw_account_position_snapshot.osi_symbol` is constructed by the
 * account parser in OCC's space-padded form, while a pin is matched against the
 * chain's `osiKey`, which is dash-padded. Copying it wrote a space-padded pin
 * every run that the chain phase's repair closed the same day — and closed
 * WITHOUT reopening whenever the contract was also recommended, so AMD's held
 * 520 put lost its `held_in_book` reason on 2026-09-18. The raw column is left
 * as it is: it is parser output, and changing it would make every replay of an
 * earlier day read `different`.
 */
export function deriveHeldStickyContracts(
  db: SqliteLike,
  run: RunHandle
): number {
  const positions = db
    .prepare(
      `SELECT symbol AS ticker, expiration_date, "right", strike,
              MIN(row_id) AS origin, MIN(source_response_id) AS src
         FROM raw_account_position_snapshot
        WHERE as_of_date = ? AND security_type = 'OPTN' AND osi_symbol IS NOT NULL
          AND expiration_date IS NOT NULL AND "right" IS NOT NULL AND strike IS NOT NULL
        GROUP BY osi_symbol`
    )
    .all(run.tradingDate) as {
    ticker: string;
    expiration_date: string;
    right: 'call' | 'put';
    strike: number;
    origin: number;
    src: number;
  }[];
  const held = positions.map((p) => ({
    ...p,
    osi_symbol: osiSymbol({ ticker: p.ticker, expiration: p.expiration_date, side: p.right, strike: p.strike })
  }));

  let opened = 0;
  for (const h of held) {
    const existing = db
      .prepare(
        `SELECT 1 FROM ref_sticky_contract
          WHERE osi_symbol = ? AND reason = 'held_in_book' AND valid_to IS NULL`
      )
      .get(h.osi_symbol);
    if (existing) continue;

    db.prepare(
      `INSERT INTO ref_sticky_contract
         (run_id, as_of_date, observed_at, source_response_id,
          osi_symbol, ticker, expiration_date, reason, valid_from, origin_ref)
       VALUES (?,?,?,?,?,?,?, 'held_in_book', ?, ?)`
    ).run(
      run.runId,
      run.tradingDate,
      run.startedAt,
      h.src,
      h.osi_symbol,
      h.ticker,
      h.expiration_date,
      run.tradingDate,
      `raw_account_position_snapshot.row_id=${String(h.origin)}`
    );
    opened++;
  }
  return opened;
}

/**
 * The account keys to collect, discovered rather than configured.
 *
 * The list response is archived (encrypted, like every account line) but never
 * ingested: it is the one place the raw key appears, and there is no raw table
 * that should hold it. Closed accounts are skipped; every open brokerage account
 * is collected, because capturing only the first would silently drop a book.
 */
export function accountKeysFrom(body: string): readonly string[] {
  const parsed = JSON.parse(body) as {
    AccountListResponse?: { Accounts?: { Account?: { accountIdKey?: string; accountStatus?: string }[] } };
  };
  return (parsed.AccountListResponse?.Accounts?.Account ?? [])
    .filter((a) => typeof a.accountIdKey === 'string' && a.accountStatus !== 'CLOSED')
    .map((a) => a.accountIdKey as string);
}

export async function runAccountPhase(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  args: { readonly accountKeys?: readonly string[]; readonly ordersLookbackDays?: number } = {}
): Promise<AccountPhaseResult> {
  const ruleId = captureRuleId(
    db,
    host,
    'account',
    ACCOUNT_RULE,
    'Positions, balance, executed orders and the transactions fallback.'
  );
  const lookback = args.ordersLookbackDays ?? ACCOUNT_RULE.ordersLookbackDays;

  const common = {
    host, db, runId: run.runId, asOfDate: run.tradingDate,
    provider: 'etrade' as const, captureRuleId: ruleId
  };

  let keys = args.accountKeys;
  if (!keys) {
    throwIfCancelled(host, 'phase-5-account');
    host.progress('account', 0, 5, 'accounts');
    const listResponse = await host.etradeGet('/v1/accounts/list', {});
    captureResponse({
      ...common,
      endpoint: '/v1/accounts/list',
      slug: 'account-list',
      params: {},
      response: listResponse
    });
    keys =
      listResponse.status !== null && listResponse.status >= 200 && listResponse.status < 300
        ? accountKeysFrom(listResponse.body)
        : [];
  }

  const totals = { positions: 0, balanceRows: 0, ordersStored: 0, transactionsStored: 0 };
  let transactionsFailed = false;

  for (const key of keys) {
    const one = await collectOneAccount(host, db, run, { key, lookback, common });
    totals.positions += one.positions;
    totals.balanceRows += one.balanceRows;
    totals.ordersStored += one.ordersStored;
    totals.transactionsStored += one.transactionsStored;
    transactionsFailed = transactionsFailed || one.transactionsFailed;
  }

  const stickyOpened = deriveHeldStickyContracts(db, run);

  return { ...totals, stickyOpened, transactionsFailed };
}

async function collectOneAccount(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  args: {
    readonly key: string;
    readonly lookback: number;
    readonly common: Omit<Parameters<typeof captureResponse>[0], 'endpoint' | 'slug' | 'params' | 'response'>;
  }
): Promise<Omit<AccountPhaseResult, 'stickyOpened'>> {
  const { key, lookback, common } = args;

  // ── positions ────────────────────────────────────────────────────────────
  throwIfCancelled(host, 'phase-5-account');
  host.progress('account', 1, 5, 'positions');
  const portfolioPath = `/v1/accounts/${key}/portfolio`;
  const portfolio = await host.etradeGet(portfolioPath, { count: '250' });
  const positions = captureResponse({
    ...common,
    endpoint: maskAccountKey(portfolioPath, key),
    slug: 'account-portfolio',
    params: { count: '250' },
    response: portfolio,
    recipe: recipes.positions(key)
  });

  // ── balance ──────────────────────────────────────────────────────────────
  // Inside the phase every caller reaches, never at a call site: the existing
  // app added its cash snapshot to the scheduled job only, so the UI's Sync
  // button produced "no balance synced yet" and an API log with zero /balance
  // calls, which reads as a broken feature rather than an uncalled one.
  throwIfCancelled(host, 'phase-5-account');
  host.progress('account', 2, 5, 'balance');
  const balancePath = `/v1/accounts/${key}/balance`;
  const balanceParams = { instType: 'BROKERAGE', realTimeNAV: 'true' };
  const balance = await host.etradeGet(balancePath, balanceParams);
  const balanceResult = captureResponse({
    ...common,
    endpoint: maskAccountKey(balancePath, key),
    slug: 'account-balance',
    params: balanceParams,
    response: balance,
    recipe: recipes.balance(key)
  });

  // ── executed orders ──────────────────────────────────────────────────────
  throwIfCancelled(host, 'phase-5-account');
  host.progress('account', 3, 5, 'executed orders');
  const from = new Date(Date.parse(`${run.tradingDate}T00:00:00Z`) - lookback * 86_400_000);
  const fmt = (d: Date): string =>
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCFullYear())}`;
  const ordersPath = `/v1/accounts/${key}/orders`;
  const ordersParams = {
    status: 'EXECUTED',
    fromDate: fmt(from),
    toDate: fmt(new Date(Date.parse(`${run.tradingDate}T00:00:00Z`))),
    count: '100'
  };
  const orders = await host.etradeGet(ordersPath, ordersParams);
  const ordersResult = captureResponse({
    ...common,
    endpoint: maskAccountKey(ordersPath, key),
    slug: 'account-orders',
    params: ordersParams,
    response: orders,
    recipe: recipes.orders({ accountKey: key, knownOrders: knownOrderFingerprints(db) })
  });

  // ── transactions (fallback only) ─────────────────────────────────────────
  throwIfCancelled(host, 'phase-5-account');
  host.progress('account', 4, 5, 'transactions');
  const txPath = `/v1/accounts/${key}/transactions`;
  // `sortOrder=DESC` is not cosmetic: without it the endpoint does not respond
  // at all.
  const txParams = { sortOrder: 'DESC', count: '50' };
  const tx = await host.etradeGet(txPath, txParams);
  const txResult = captureResponse({
    ...common,
    endpoint: maskAccountKey(txPath, key),
    slug: 'account-transactions',
    params: txParams,
    response: tx,
    recipe: recipes.transactions({ accountKey: key, knownIds: knownTransactionIds(db) })
  });

  return {
    positions: positions.rowsWritten,
    balanceRows: balanceResult.rowsWritten,
    ordersStored: ordersResult.rowsWritten,
    transactionsStored: txResult.rowsWritten,
    transactionsFailed: txResult.parseStatus !== 'ok'
  };
}
