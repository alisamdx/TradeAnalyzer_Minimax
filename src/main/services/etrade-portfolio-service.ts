/**
 * E*Trade Portfolio Sync Service.
 *
 * Phase 1 of the AI Portfolio Advisor feature (migration 014).
 *
 * Fetches live positions from E*Trade and upserts them into the local
 * `positions` table using `etrade_position_id` as the upsert key.
 *
 * OCC symbol format: AAPL250620C00150000
 *   → regex (\w+?)(\d{6})(C|P)(\d{8})
 *   → ticker=AAPL, expiry=2025-06-20, type=CALL, strike=150.00
 *
 * Position type mapping:
 *   EQ                            → Stock
 *   OPTN + PUT  + SHORT position  → CSP
 *   OPTN + CALL + SHORT position  → CC
 *   (LONG options not tracked — skipped)
 *
 * IV ingestion: E*Trade returns IV as a decimal fraction (0.3882 = 38.82%).
 * Always multiply by 100 when persisting.
 * see docs/formulas.md#iv-ingestion
 */

import type { Database } from 'better-sqlite3';
import { etradeGet, renewAccessToken, ETRADE_SLOW_TIMEOUT_MS, type OAuthCredentials } from './etrade-auth.js';
import type { EtradeAccount, EtradeSyncResult } from '@shared/types.js';
import { toPositionSignedGreeks } from '@shared/position-greeks.js';

// ─── E*Trade API response shapes ─────────────────────────────────────────────

interface EtradeAccountRaw {
  accountId: string;
  accountIdKey: string;
  accountName: string;
  accountType: string;
  institutionType: string;
}

interface EtradeProduct {
  symbol: string;
  securityType: 'EQ' | 'OPTN' | 'MF' | 'BOND' | string;
  callPut?: 'CALL' | 'PUT';
  expiryYear?: number;
  expiryMonth?: number;
  expiryDay?: number;
  strikePrice?: number;
}

// ─── Transaction API response shapes ─────────────────────────────────────────

interface EtradeTxProduct {
  symbol: string;
  securityType: 'EQ' | 'OPTN' | string;
  callPut?: 'CALL' | 'PUT';
  strikePrice?: number;
  expiryYear?: number;
  expiryMonth?: number;
  expiryDay?: number;
}

interface EtradeBrokerage {
  transactionType: string;   // "Bought" | "Sold" | "EXPIRED" | "ASSIGNED" | "EXERCISED"
  quantity: number;
  price: number;
  amount: number;
  commission?: number;
  product?: EtradeTxProduct;
}

interface EtradeTransaction {
  transactionId: string;
  transactionDate: number;   // epoch ms
  amount: number;
  description: string;
  Brokerage?: EtradeBrokerage;
}

// Normalised single-leg record after classifying a transaction
interface TxLeg {
  txId: string;
  date: string;              // YYYY-MM-DD
  action: 'open' | 'close' | 'expired' | 'assigned';
  /**
   * Whether the OPENING side was a sell (short premium) or a buy (long).
   *
   * Without this every option was priced as short premium, which inverts the sign on a long
   * position: the TSLA Jul-17 $375 put was bought at 19.63 and sold at 15.98 for a REAL LOSS of
   * \u2212$364.06, and it was recorded as +$361.97. A $726 error on one row, and it also mislabelled
   * the position as a CSP. Only meaningful on an `open` leg.
   */
  openedShort: boolean;
  secType: 'OPTN' | 'EQ';
  ticker: string;
  symbolKey: string;         // OCC for options, ticker for EQ
  strikePrice: number | null;
  expirationDate: string | null;
  callPut: 'CALL' | 'PUT' | null;
  qty: number;               // absolute contracts / shares
  price: number;             // per share
  commission: number;
}

interface EtradePositionComplete {
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  iv?: number;             // decimal fraction — multiply by 100
  Fundamental?: {
    beta?: number;
  };
}

interface EtradePositionRaw {
  positionId: number;
  symbolDescription: string;
  dateAcquired?: number;   // epoch ms
  pricePaid?: number;
  quantity: number;        // negative = short
  marketValue?: number;
  totalGain?: number;
  totalGainPct?: number;
  daysGain?: number;
  daysGainPct?: number;
  pctOfPortfolio?: number;
  costPerShare?: number;
  Product: EtradeProduct;
  positionType?: 'SHORT' | 'LONG';
  Complete?: EtradePositionComplete;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OCC_RE = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})(C|P)(\d{8})$/;

interface ParsedOcc {
  ticker: string;
  expiry: string;     // YYYY-MM-DD
  callPut: 'CALL' | 'PUT';
  strike: number;
}

function parseOccSymbol(sym: string): ParsedOcc | null {
  const m = OCC_RE.exec(sym.toUpperCase());
  if (!m) return null;
  const [, ticker, yy, mm, dd, cp, strikeRaw] = m as unknown as [string, string, string, string, string, string, string];
  const year  = 2000 + parseInt(yy, 10);
  const month = mm.padStart(2, '0');
  const day   = dd.padStart(2, '0');
  return {
    ticker,
    expiry: `${year}-${month}-${day}`,
    callPut: cp === 'C' ? 'CALL' : 'PUT',
    strike: parseInt(strikeRaw, 10) / 1000,
  };
}

/** Epoch ms → YYYY-MM-DD, or today if missing. */
function epochToDate(ms?: number): string {
  if (!ms) return new Date().toISOString().slice(0, 10);
  return new Date(ms).toISOString().slice(0, 10);
}

function num(v: number | undefined | null): number | null {
  return v != null && isFinite(v) ? v : null;
}

/**
 * Coerce an untyped JSON field to a finite number.
 *
 * The Orders payload is walked as `Record<string, unknown>`, and E*Trade returns some numeric
 * fields as strings, so `num()`'s typed signature does not fit there.
 */
function numOf(v: unknown): number | null {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
  return null;
}

// ─── Internal closed-position record ─────────────────────────────────────────

interface ClosedPosition {
  ticker: string;
  /** 'Long Call'/'Long Put' match the labels the position sync already writes. */
  positionType: 'CSP' | 'CC' | 'Stock' | 'Long Call' | 'Long Put';
  quantity: number;
  entryPrice: number;
  entryDate: string;
  exitPrice: number;
  exitDate: string;
  exitNotes: string | null;
  strikePrice: number | null;
  expirationDate: string | null;
  premiumReceived: number | null;
  realizedPnl: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class EtradePortfolioService {

  // ─── Account list ─────────────────────────────────────────────────────────

  async listAccounts(creds: OAuthCredentials): Promise<EtradeAccount[]> {
    const raw = await this.withRenew(creds, () => etradeGet('/v1/accounts/list', {}, creds));

    // Shape: { AccountListResponse: { Accounts: { Account: [...] } } }
    const accountList = (raw as Record<string, unknown>)['AccountListResponse'];
    if (!accountList || typeof accountList !== 'object') {
      throw new Error('E*Trade /v1/accounts/list returned unexpected shape');
    }

    const accounts = (accountList as Record<string, unknown>)['Accounts'];
    if (!accounts || typeof accounts !== 'object') return [];

    const arr = (accounts as Record<string, unknown>)['Account'];
    if (!Array.isArray(arr)) return [];

    return (arr as EtradeAccountRaw[]).map(a => ({
      accountId:       a.accountId      ?? '',
      accountIdKey:    a.accountIdKey   ?? '',
      accountName:     a.accountName    ?? '',
      accountType:     a.accountType    ?? '',
      institutionType: a.institutionType ?? '',
    }));
  }

  // ─── Portfolio sync ───────────────────────────────────────────────────────

  async syncPortfolio(
    db: Database,
    creds: OAuthCredentials,
    targetAccountIdKey?: string
  ): Promise<EtradeSyncResult> {
    const result: EtradeSyncResult = {
      accountsScanned:  0,
      positionsUpserted: 0,
      positionsSkipped: 0,
      positionsClosed: 0,
      errors: [],
      syncedAt: new Date().toISOString(),
    };

    // ── 1. Get accounts ──────────────────────────────────────────────────────
    let accounts: EtradeAccount[];
    try {
      accounts = await this.listAccounts(creds);
    } catch (err) {
      result.errors.push(`Failed to list accounts: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }

    if (accounts.length === 0) {
      result.errors.push('No accounts found');
      return result;
    }

    const toSync = targetAccountIdKey
      ? accounts.filter(a => a.accountIdKey === targetAccountIdKey)
      : accounts;

    // ── 2. Fetch portfolio for each account ──────────────────────────────────
    for (const acct of toSync) {
      result.accountsScanned++;
      try {
        const positions = await this.fetchPositions(acct.accountIdKey, creds);
        for (const pos of positions) {
          try {
            const upserted = this.upsertPosition(db, acct.accountId, pos);
            if (upserted) result.positionsUpserted++;
            else          result.positionsSkipped++;
          } catch (err) {
            result.errors.push(
              `Position ${pos.positionId} (${pos.symbolDescription}): ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        // ── Reconcile: full sync. Any OPEN broker-synced position for THIS account that
        // E*Trade no longer reports (e.g. a closed NVDA) is marked closed so it drops off the
        // portfolio. Runs only after a SUCCESSFUL fetch (so a fetch error never closes
        // everything); never touches manual positions (etrade_position_id IS NULL).
        result.positionsClosed = (result.positionsClosed ?? 0)
          + this.closeMissingPositions(db, acct.accountId, positions.map(p => String(p.positionId)));
      } catch (err) {
        result.errors.push(
          `Account ${acct.accountId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return result;
  }

  /**
   * Mark as closed any OPEN, E*Trade-sourced position for `accountId` whose broker position id
   * is NOT in `seenIds` (the ids returned by the just-completed fetch) — i.e. positions closed
   * at the broker. Preserves the row (notes / history); the portfolio view shows only
   * `status='open'`. Manual positions (no `etrade_position_id`) are left untouched.
   *
   * Realized P&L: estimated from the position's last mark (E*Trade `totalGain`, stored in
   * `unrealized_pnl`) so the Closed tab isn't blank — `COALESCE(realized_pnl, unrealized_pnl)`
   * never overwrites a value already set by the transaction-history sync, which remains the
   * authoritative source. `exit_date` defaults to the detection time and `exit_notes` flags the
   * estimate. Returns the number of positions closed.
   */
  private closeMissingPositions(db: Database, accountId: string, seenIds: string[]): number {
    const open = db.prepare(
      `SELECT id, etrade_position_id FROM positions
       WHERE etrade_account_id = ? AND status = 'open' AND etrade_position_id IS NOT NULL`
    ).all(accountId) as Array<{ id: number; etrade_position_id: string | number }>;
    if (open.length === 0) return 0;

    const seen = new Set(seenIds);
    const now = new Date().toISOString();
    const note = 'Closed via E*Trade sync (no longer at broker); realized P&L estimated from last mark — run Sync Closed Positions for exact figures';
    const closeStmt = db.prepare(
      `UPDATE positions SET
         status       = 'closed',
         realized_pnl = COALESCE(realized_pnl, unrealized_pnl),
         exit_date    = COALESCE(exit_date, ?),
         exit_notes   = COALESCE(exit_notes, ?),
         last_synced_at = ?,
         updated_at     = ?
       WHERE id = ?`
    );
    let closed = 0;
    for (const row of open) {
      if (!seen.has(String(row.etrade_position_id))) {
        closeStmt.run(now, note, now, now, row.id);
        closed++;
      }
    }
    return closed;
  }

  // ─── Fetch positions for one account ─────────────────────────────────────

  private async fetchPositions(
    accountIdKey: string,
    creds: OAuthCredentials
  ): Promise<EtradePositionRaw[]> {
    const raw = await this.withRenew(creds, () => etradeGet(
      `/v1/accounts/${accountIdKey}/portfolio`,
      { totalsRequired: 'true', lotsRequired: 'false', view: 'COMPLETE' },
      creds
    ));

    // Shape: { PortfolioResponse: { AccountPortfolio: [{ Position: [...] }] } }
    const resp = (raw as Record<string, unknown>)['PortfolioResponse'];
    if (!resp || typeof resp !== 'object') {
      throw new Error(`Unexpected portfolio response shape for ${accountIdKey}`);
    }

    const portfolios = (resp as Record<string, unknown>)['AccountPortfolio'];
    if (!Array.isArray(portfolios)) return [];

    const positions: EtradePositionRaw[] = [];
    for (const portfolio of portfolios as Record<string, unknown>[]) {
      const arr = portfolio['Position'];
      if (Array.isArray(arr)) {
        positions.push(...(arr as EtradePositionRaw[]));
      }
    }
    return positions;
  }

  // ─── Upsert one position ──────────────────────────────────────────────────

  /**
   * Maps an E*Trade position to the local schema and upserts.
   * Returns true if a row was inserted/updated, false if skipped (e.g. LONG option).
   */
  private upsertPosition(
    db: Database,
    accountId: string,
    raw: EtradePositionRaw
  ): boolean {
    const { Product, Complete } = raw;

    // ── Determine local position type ────────────────────────────────────────
    let positionType: 'CSP' | 'CC' | 'Stock' | 'Long Put' | 'Long Call';
    let ticker: string;
    let strikePrice: number | null = null;
    let expirationDate: string | null = null;

    if (Product.securityType === 'EQ') {
      positionType = 'Stock';
      ticker = Product.symbol;
    } else if (Product.securityType === 'OPTN') {
      const isShort = raw.positionType === 'SHORT' || raw.quantity < 0;

      if (Product.callPut === 'PUT') {
        positionType = isShort ? 'CSP' : 'Long Put';
      } else if (Product.callPut === 'CALL') {
        positionType = isShort ? 'CC' : 'Long Call';
      } else {
        return false; // unknown option type
      }

      // Parse OCC symbol for clean ticker / expiry / strike
      const occ = parseOccSymbol(raw.symbolDescription);
      if (occ) {
        ticker       = occ.ticker;
        strikePrice  = occ.strike;
        expirationDate = occ.expiry;
      } else {
        // Fallback to Product fields
        ticker = Product.symbol;
        strikePrice = num(Product.strikePrice);
        if (Product.expiryYear && Product.expiryMonth && Product.expiryDay) {
          expirationDate = `${Product.expiryYear}-${String(Product.expiryMonth).padStart(2,'0')}-${String(Product.expiryDay).padStart(2,'0')}`;
        }
      }
    } else {
      return false; // mutual fund, bond, etc. — skip
    }

    // ── Greeks + IV ──────────────────────────────────────────────────────────
    // E*Trade returns RAW contract greeks (a short put's delta is negative). Store them
    // POSITION-SIGNED via the shared helper so the convention matches the chain-refresh path
    // and every consumer (they used to disagree — the v1.1.80 "CSP reads bearish" bug).
    const gamma = num(Complete?.gamma); // gamma stays raw (not part of the signed convention)
    const { delta, theta, vega } = toPositionSignedGreeks(
      positionType,
      num(Complete?.delta),
      num(Complete?.theta),
      num(Complete?.vega),
    );
    // IV: E*Trade returns decimal fraction (0.3882) — convert to percentage
    const ivRaw = num(Complete?.iv);
    const iv    = ivRaw !== null ? ivRaw * 100 : null;
    const beta  = num(Complete?.Fundamental?.beta);

    // ── Quantity: store as absolute contracts (sign from positionType) ───────
    const qty = Math.abs(raw.quantity);

    // ── Cost basis (entry price) ─────────────────────────────────────────────
    const entryPrice = num(raw.pricePaid) ?? num(raw.costPerShare) ?? 0;
    const entryDate  = epochToDate(raw.dateAcquired);

    // ── Premium received (short options only — long options pay premium) ────
    const premiumReceived = (positionType === 'CSP' || positionType === 'CC')
      ? (num(raw.pricePaid) ?? num(raw.costPerShare))
      : null;

    // Unrealized P&L: E*Trade gives the dollar total gain/loss directly. Without persisting it
    // the per-position P&L and the "Unrealized P&L" summary read $0 (getPnLSummary sums
    // unrealized_pnl), even though only total_gain_PCT was being stored.
    const unrealizedPnl = num(raw.totalGain);

    const now = new Date().toISOString();

    // ── Upsert ────────────────────────────────────────────────────────────────
    // Use INSERT OR REPLACE with etrade_position_id as unique key.
    // Preserve existing manual notes and realized_pnl.
    const existing = db.prepare(
      'SELECT id, entry_notes, realized_pnl FROM positions WHERE etrade_position_id = ?'
    ).get(raw.positionId) as { id: number; entry_notes: string | null; realized_pnl: number | null } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE positions SET
          status               = 'open',
          ticker               = ?,
          position_type        = ?,
          quantity             = ?,
          entry_price          = ?,
          entry_date           = ?,
          strike_price         = ?,
          expiration_date      = ?,
          premium_received     = ?,
          etrade_account_id    = ?,
          market_value         = ?,
          total_gain_pct       = ?,
          unrealized_pnl       = ?,
          days_gain            = ?,
          days_gain_pct        = ?,
          cost_per_share       = ?,
          pct_of_portfolio     = ?,
          delta                = ?,
          gamma                = ?,
          theta                = ?,
          vega                 = ?,
          iv                   = ?,
          beta                 = ?,
          last_synced_at       = ?,
          updated_at           = ?
        WHERE etrade_position_id = ?
      `).run(
        ticker, positionType, qty, entryPrice, entryDate,
        strikePrice, expirationDate, premiumReceived,
        accountId,
        num(raw.marketValue), num(raw.totalGainPct), unrealizedPnl,
        num(raw.daysGain), num(raw.daysGainPct),
        num(raw.costPerShare), num(raw.pctOfPortfolio),
        delta, gamma, theta, vega, iv, beta,
        now, now,
        raw.positionId
      );
    } else {
      db.prepare(`
        INSERT INTO positions (
          ticker, position_type, quantity, entry_price, entry_date,
          strike_price, expiration_date, premium_received, status,
          etrade_position_id, etrade_account_id,
          market_value, total_gain_pct, unrealized_pnl, days_gain, days_gain_pct,
          cost_per_share, pct_of_portfolio,
          delta, gamma, theta, vega, iv, beta,
          last_synced_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, 'open',
          ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?
        )
      `).run(
        ticker, positionType, qty, entryPrice, entryDate,
        strikePrice, expirationDate, premiumReceived,
        raw.positionId, accountId,
        num(raw.marketValue), num(raw.totalGainPct), unrealizedPnl,
        num(raw.daysGain), num(raw.daysGainPct),
        num(raw.costPerShare), num(raw.pctOfPortfolio),
        delta, gamma, theta, vega, iv, beta,
        now, now, now
      );
    }

    return true;
  }

  // ─── Closed positions sync (transaction history) ─────────────────────────

  /**
   * Fetches YTD transaction history from E*Trade and reconstructs closed
   * positions (single open + single close, or open + expiration).
   * Skips positions that already exist in the local DB (dedup by ticker +
   * type + entry_date + exit_date).
   */
  async syncClosedPositions(
    db: Database,
    creds: OAuthCredentials,
    targetAccountIdKey?: string
  ): Promise<EtradeSyncResult> {
    const result: EtradeSyncResult = {
      accountsScanned:   0,
      positionsUpserted: 0,
      positionsSkipped:  0,
      errors:            [],
      syncedAt:          new Date().toISOString(),
    };

    let accounts: EtradeAccount[];
    try {
      accounts = await this.listAccounts(creds);
    } catch (err) {
      result.errors.push(`Failed to list accounts: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }

    const toSync = targetAccountIdKey
      ? accounts.filter(a => a.accountIdKey === targetAccountIdKey)
      : accounts;

    const now   = new Date();
    const start = `${now.getFullYear()}-01-01`;
    const end   = now.toISOString().slice(0, 10);

    for (const acct of toSync) {
      result.accountsScanned++;
      try {
        // Transactions first, then EXECUTED orders as a fallback.
        //
        // `/transactions` is unresponsive for this account: nine hypotheses tested and all
        // falsified (range 8mo/31d/7d/none, path with and without `.json`, sortOrder,
        // count 5/50, fresh nonce, our signing) against 28 other calls on the same
        // credentials all returning 200 in ~300 ms. E*Trade exposes no dedicated
        // closed-positions endpoint, so Orders is the documented alternative source of fills.
        //
        // Orders is arguably the better source anyway: `orderAction` states OPEN vs CLOSE
        // explicitly (no "a sell must be an open" guessing, which is what the transactions
        // path had to do) and `averageExecutionPrice` is the realised fill — the whole point
        // of this import.
        // ORDERS FIRST, transactions as the fallback.
        //
        // Reversed on 2026-09-02 after measuring both against the same account. Executed
        // orders produced 25 correct closed positions with real fills. Transactions, on the
        // run where every one of its 9 slices finally returned 200, produced **zero** usable
        // positions: `classifyTransaction` has to infer intent from "sold means opened,
        // bought means closed" and then pairs opens to closes BY INDEX, which yields nothing
        // here. Orders needs no inference at all — `orderAction` states OPEN vs CLOSE and
        // `averageExecutionPrice` is the realised fill.
        //
        // Transactions is kept as a fallback only because it is the documented alternative and
        // may cover activity orders misses (dividends, fees, corporate actions).
        let legs: TxLeg[];
        try {
          legs = await this.fetchOrderLegs(acct.accountIdKey, start, end, creds);
          if (legs.length === 0) {
            result.errors.push('Executed orders returned no legs; trying transactions.');
            legs = await this.fetchTransactionLegs(acct.accountIdKey, start, end, creds);
          }
        } catch (ordErr) {
          const msg = ordErr instanceof Error ? ordErr.message : String(ordErr);
          result.errors.push(`Executed orders unavailable, falling back to transactions: ${msg.slice(0, 160)}`);
          legs = await this.fetchTransactionLegs(acct.accountIdKey, start, end, creds);
        }
        const closed = this.matchClosedPositions(legs);
        for (const pos of closed) {
          try {
            const inserted = this.insertClosedPosition(db, pos);
            if (inserted) result.positionsUpserted++;
            else          result.positionsSkipped++;
          } catch (err) {
            result.errors.push(`${pos.ticker}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        result.errors.push(`Account ${acct.accountId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return result;
  }

  // ─── Fetch + classify all transaction legs ────────────────────────────────

  private async fetchTransactionLegs(
    accountIdKey: string,
    startDate: string,
    endDate: string,
    creds: OAuthCredentials
  ): Promise<TxLeg[]> {
    const legs: TxLeg[] = [];

    // E*Trade requires MMDDYYYY (no separators), e.g. "07112018"
    const fmt = (iso: string) => {
      const [y, m, d] = iso.split('-') as [string, string, string];
      return `${m}${d}${y}`;
    };

    // Query in ~1-month slices rather than one YTD span.
    //
    // NOTE ON WHY: the original rationale (v1.1.146) was that a narrow window would return
    // promptly and so avoid the stall. **That was tested and is false** — a 31-day slice
    // still exceeded 30 s (2026-09-02, `startDate=01012026&endDate=01312026` aborted at
    // 30,003 ms). This endpoint is slow per call regardless of range, so it is given its own
    // ETRADE_SLOW_TIMEOUT_MS budget instead.
    //
    // Slicing is kept for a different and still-valid reason: it bounds each response and
    // its pagination, so one oversized window cannot swallow the whole import, and a failure
    // localises to a month instead of the year. It is not the stall fix.
    // ── Capability negotiation for a hostile endpoint ────────────────────────
    // `/transactions` hangs for this account and reports it as `oauth_problem=nonce_used`
    // after ~120 s. Four hypotheses were tested one per release and all falsified against the
    // API log: range width (31 days stalls like 8 months), transport replay (a FRESH nonce got
    // the same error), date parameters (a no-param request still hung 45 s), and our signing
    // (28 other calls on the same key/code all returned 200 in ~300 ms).
    //
    // So rather than guess a fifth variant per release, try the remaining plausible request
    // SHAPES in one pass with a short budget each, and use whichever answers. Every attempt is
    // visible in logs/api, so a total failure is still fully diagnostic.
    const variants: Array<{ label: string; suffix: string; params: Record<string, string> }> = [
      // E*Trade honours a format suffix on many endpoints; `Accept: application/json` alone
      // may not be enough here (its error envelopes come back as XML even so).
      // sortOrder FIRST: proven necessary on 2026-09-02. `{sortOrder:DESC, count:50}` returned
      // 200 in 447 ms on an endpoint that had never answered without it, across nine earlier
      // hypotheses. It is now also a default on every sliced request below.
      { label: 'sortOrder',          suffix: '',      params: { sortOrder: 'DESC', count: '50' } },
      { label: 'json-suffix',        suffix: '.json', params: { count: '50' } },
      // `sortOrder` is documented for this endpoint and may be required for `count` to bound
      // the result set — an unbounded scan would explain a fixed ~120 s server timeout.
      { label: 'json+sortOrder',     suffix: '.json', params: { sortOrder: 'DESC', count: '50' } },
      // A tiny page: if the endpoint is merely slow per row, 5 rows should return.
      { label: 'tiny-count',         suffix: '',      params: { count: '5' } },
      // A 7-day window — narrower than any range tried so far.
      { label: 'week-window',        suffix: '',      params: {
          startDate: fmt(new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)),
          endDate:   fmt(new Date().toISOString().slice(0, 10)),
          count: '50',
        } },
    ];

    let working: { suffix: string; params: Record<string, string> } | null = null;
    const tried: string[] = [];
    for (const v of variants) {
      try {
        await etradeGet(
          `/v1/accounts/${accountIdKey}/transactions${v.suffix}`,
          v.params,
          creds,
          { timeoutMs: 20_000 },
        );
        working = { suffix: v.suffix, params: v.params };
        console.log(`[etrade] transactions endpoint responded to variant "${v.label}"`);
        break;
      } catch (err) {
        tried.push(`${v.label}: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
      }
    }

    if (!working) {
      throw new Error(
        'E*Trade transactions endpoint did not respond to any request shape. Tried '
        + `${variants.length} variants (${variants.map(v => v.label).join(', ')}); every other `
        + 'E*Trade call on the same credentials works, so this is server-side at E*Trade or an '
        + `account entitlement, not a client bug. Attempts: ${tried.join(' | ')}`,
      );
    }

    const slices: Array<{ from: string; to: string }> = [];
    {
      const endMs = Date.parse(`${endDate}T00:00:00Z`);
      let cur = Date.parse(`${startDate}T00:00:00Z`);
      while (cur <= endMs) {
        const next = Math.min(cur + 30 * 86_400_000, endMs);
        slices.push({
          from: new Date(cur).toISOString().slice(0, 10),
          to:   new Date(next).toISOString().slice(0, 10),
        });
        if (next >= endMs) break;
        cur = next + 86_400_000;
      }
    }

    for (const slice of slices) {
    let marker: string | undefined;
    do {
      const params: Record<string, string> = {
        // `sortOrder` is REQUIRED by this endpoint (proven 2026-09-02: it answered in 447 ms
        // with it, and never without it across nine other hypotheses). Defaulted here so a
        // slice does not depend on which negotiation variant happened to win.
        sortOrder: 'DESC',
        // Carry any other params the working variant needed.
        ...Object.fromEntries(
          Object.entries(working.params).filter(([k]) => k !== 'startDate' && k !== 'endDate'),
        ),
        startDate: fmt(slice.from),
        endDate:   fmt(slice.to),
      };
      if (marker) params['marker'] = marker;

      // The negotiation probes above are deliberately NOT wrapped: they are meant to fail
      // fast, and renewing five times over would double an already-slow diagnostic.
      const raw = await this.withRenew(creds, () => etradeGet(
        `/v1/accounts/${accountIdKey}/transactions${working.suffix}`,
        params,
        creds,
        // Measured 120,250 ms for a YTD query; 31 days still exceeded 30 s. The default
        // budget is tuned to the ~300 ms every other E*Trade call takes and would guarantee
        // failure here. see ETRADE_SLOW_TIMEOUT_MS.
        { timeoutMs: ETRADE_SLOW_TIMEOUT_MS },
      )) as Record<string, unknown>;

      const resp = raw['TransactionListResponse'] as Record<string, unknown> | undefined;
      if (!resp) break;

      const txArr = resp['Transaction'];
      if (Array.isArray(txArr)) {
        for (const tx of txArr as EtradeTransaction[]) {
          const leg = this.classifyTransaction(tx);
          if (leg) legs.push(leg);
        }
      }

      // E*Trade returns the paging marker as a string or a number depending on endpoint;
      // coercing both keeps pagination working instead of silently stopping after page 1.
      const rawMarker = resp['marker'];
      marker = typeof rawMarker === 'string' ? rawMarker
             : typeof rawMarker === 'number' ? String(rawMarker)
             : undefined;
    } while (marker);
    }

    return legs;
  }

  // ─── Classify one transaction into a TxLeg ───────────────────────────────

  private classifyTransaction(tx: EtradeTransaction): TxLeg | null {
    const br = tx.Brokerage;
    if (!br?.product) return null;

    const prod     = br.product;
    const secType  = prod.securityType === 'OPTN' ? 'OPTN' : prod.securityType === 'EQ' ? 'EQ' : null;
    if (!secType) return null;

    const txType   = (br.transactionType ?? '').toLowerCase();
    const date     = epochToDate(tx.transactionDate);
    const qty      = Math.abs(br.quantity ?? 0);
    const price    = Math.abs(br.price ?? 0);
    const commission = Math.abs(br.commission ?? 0);

    let action: TxLeg['action'];
    if (/expired/i.test(txType))         action = 'expired';
    else if (/assigned|exercise/i.test(txType)) action = 'assigned';
    else if (/sold|sell/i.test(txType))  action = 'open';   // sold-to-open = short position opened
    else if (/bought|buy/i.test(txType)) action = 'close';  // bought-to-close = short position closed
    else return null;

    let ticker: string;
    let symbolKey: string;
    let strikePrice: number | null = null;
    let expirationDate: string | null = null;
    let callPut: 'CALL' | 'PUT' | null = null;

    if (secType === 'OPTN') {
      const occ = parseOccSymbol(prod.symbol);
      if (occ) {
        ticker         = occ.ticker;
        symbolKey      = prod.symbol.toUpperCase();
        strikePrice    = occ.strike;
        expirationDate = occ.expiry;
        callPut        = occ.callPut;
      } else {
        ticker    = prod.symbol;
        symbolKey = prod.symbol.toUpperCase();
        strikePrice = num(prod.strikePrice);
        callPut   = prod.callPut ?? null;
        if (prod.expiryYear && prod.expiryMonth && prod.expiryDay) {
          expirationDate = `${prod.expiryYear}-${String(prod.expiryMonth).padStart(2,'0')}-${String(prod.expiryDay).padStart(2,'0')}`;
        }
      }
    } else {
      ticker    = prod.symbol;
      symbolKey = prod.symbol.toUpperCase();
    }

    // This path infers `open` only from a SELL, so an opening leg is short by construction.
    // It cannot represent a long option at all — another reason orders is the primary source.
    return { txId: tx.transactionId, date, action, openedShort: action === 'open', secType, ticker, symbolKey, strikePrice, expirationDate, callPut, qty, price, commission };
  }

  // ─── Fetch executed ORDERS as an alternative source of fills ──────────

  /**
   * Build TxLegs from executed orders.
   *
   * E*Trade exposes no closed-positions endpoint; Transactions and Orders are the two ways to
   * reconstruct one. Orders carries exactly what this import needs:
   *   - `orderAction` states OPEN vs CLOSE outright, so no "a sell must be an open" heuristic
   *   - `averageExecutionPrice` is the realised fill rather than a mark
   */
  /**
   * Renew-and-retry wrapper for E*Trade calls.
   *
   * Every other E*Trade consumer has had this since v1.1.94; this service was the last one
   * without it, so a dormant token failed the whole portfolio sync outright instead of
   * recovering. Tokens go dormant after 2 h of inactivity, and this service is driven by
   * manual button clicks — precisely the usage pattern that idles past the window.
   *
   * Retries on ANY error, deliberately. A dormant token does NOT reliably surface as a 401:
   * it can kill or hang the response stream instead (undici `terminated`). Gating renewal on
   * an auth-shaped message is the exact bug that halted the evening orchestrator chain 8 of 10
   * trading days before v1.1.92 and silently emptied option chains before v1.1.94. Renewing an
   * already-active token errors harmlessly, so the retry decides the outcome either way.
   *
   * E*Trade's renew REACTIVATES the existing access token rather than issuing a new one (which
   * is why `renewAccessToken` returns void), so the same `creds` object stays valid.
   */
  private async withRenew<T>(creds: OAuthCredentials, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      try {
        await renewAccessToken(creds);
      } catch { /* renewing an active token errors harmlessly; the retry decides */ }
      return await fn();
    }
  }

  private async fetchOrderLegs(
    accountIdKey: string,
    startDate: string,
    endDate: string,
    creds: OAuthCredentials
  ): Promise<TxLeg[]> {
    const legs: TxLeg[] = [];
    const fmt = (iso: string) => {
      const [y, m, d] = iso.split('-') as [string, string, string];
      return `${m}${d}${y}`;
    };

    let marker: string | undefined;
    let loggedShape = false;

    do {
      const params: Record<string, string> = {
        status:   'EXECUTED',
        fromDate: fmt(startDate),
        toDate:   fmt(endDate),
        count:    '100',
      };
      if (marker) params['marker'] = marker;

      const raw = await this.withRenew(creds, () => etradeGet(
        `/v1/accounts/${accountIdKey}/orders`,
        params,
        creds,
        { timeoutMs: ETRADE_SLOW_TIMEOUT_MS },
      )) as Record<string, unknown>;

      const resp = raw['OrdersResponse'] as Record<string, unknown> | undefined;
      if (!resp) break;

      // Structural summary only \u2014 key NAMES, never values. Success bodies are deliberately
      // never logged (they carry fills and balances), but if E*Trade's schema differs from the
      // documented one this is what makes the mismatch diagnosable without another blind guess.
      if (!loggedShape) {
        loggedShape = true;
        const first = Array.isArray(resp['Order']) ? (resp['Order'] as unknown[])[0] : undefined;
        const detail = first && typeof first === 'object'
          ? (first as Record<string, unknown>)['OrderDetail'] : undefined;
        const det0 = Array.isArray(detail)
          ? detail[0] as Record<string, unknown> | undefined : undefined;
        const inst0 = det0 && Array.isArray(det0['Instrument'])
          ? (det0['Instrument'] as unknown[])[0] as Record<string, unknown> | undefined : undefined;
        const prod0 = inst0 && typeof inst0['Product'] === 'object' && inst0['Product']
          ? inst0['Product'] as Record<string, unknown> : undefined;
        console.log('[etrade] OrdersResponse shape: ' + JSON.stringify({
          response:    Object.keys(resp),
          orderCount:  Array.isArray(resp['Order']) ? (resp['Order'] as unknown[]).length : 0,
          order:       first && typeof first === 'object' ? Object.keys(first) : null,
          orderDetail: det0  ? Object.keys(det0)  : null,
          instrument:  inst0 ? Object.keys(inst0) : null,
          product:     prod0 ? Object.keys(prod0) : null,
        }));
      }

      const orders = Array.isArray(resp['Order'])
        ? resp['Order'] as Record<string, unknown>[] : [];
      for (const order of orders) {
        const orderId = String(order['orderId'] ?? '');
        const details = Array.isArray(order['OrderDetail'])
          ? order['OrderDetail'] as Record<string, unknown>[] : [];
        for (const det of details) {
          const when = det['executedTime'] ?? det['placedTime'];
          const date = typeof when === 'number' ? epochToDate(when) : null;
          const instruments = Array.isArray(det['Instrument'])
            ? det['Instrument'] as Record<string, unknown>[] : [];
          for (const inst of instruments) {
            const leg = this.orderInstrumentToLeg(orderId, date, inst);
            if (leg) legs.push(leg);
          }
        }
      }

      const rawMarker = resp['marker'];
      marker = typeof rawMarker === 'string' ? rawMarker
             : typeof rawMarker === 'number' ? String(rawMarker)
             : undefined;
    } while (marker);

    return legs;
  }

  /** Map one executed order Instrument to a TxLeg, or null when it is not usable. */
  private orderInstrumentToLeg(
    orderId: string,
    date: string | null,
    inst: Record<string, unknown>
  ): TxLeg | null {
    if (!date) return null;
    const product = inst['Product'] as Record<string, unknown> | undefined;
    if (!product) return null;

    const secType = product['securityType'] === 'OPTN' ? 'OPTN'
                  : product['securityType'] === 'EQ'   ? 'EQ' : null;
    if (!secType) return null;

    // `orderAction` is explicit about intent \u2014 precisely what the transactions path had to
    // guess at with "sold means opened, bought means closed".
    const act = String(inst['orderAction'] ?? '').toUpperCase();
    let action: TxLeg['action'];
    if      (act.endsWith('_OPEN'))  action = 'open';
    else if (act.endsWith('_CLOSE')) action = 'close';
    else if (act === 'BUY'  || act === 'SELL_SHORT')   action = 'open';
    else if (act === 'SELL' || act === 'BUY_TO_COVER') action = 'close';
    else return null;

    // Direction of the OPENING side. SELL_OPEN is short premium (the wheel's CSP/CC);
    // BUY_OPEN is a long option, where profit runs the other way.
    const openedShort = act.startsWith('SELL');

    const filled = numOf(inst['filledQuantity']) ?? numOf(inst['quantity']) ?? 0;
    const price  = numOf(inst['averageExecutionPrice']) ?? 0;
    if (!(filled > 0)) return null;

    const ticker = String(product['symbol'] ?? '').toUpperCase();
    if (!ticker) return null;

    let symbolKey = ticker;
    let strikePrice: number | null = null;
    let expirationDate: string | null = null;
    let callPut: 'CALL' | 'PUT' | null = null;

    if (secType === 'OPTN') {
      strikePrice = numOf(product['strikePrice']);
      const cp = String(product['callPut'] ?? '').toUpperCase();
      callPut = cp === 'CALL' ? 'CALL' : cp === 'PUT' ? 'PUT' : null;
      const y = numOf(product['expiryYear']);
      const m = numOf(product['expiryMonth']);
      const d = numOf(product['expiryDay']);
      if (y && m && d) {
        expirationDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
      symbolKey = `${ticker}|${expirationDate ?? ''}|${strikePrice ?? ''}|${callPut ?? ''}`;
    }

    return {
      txId: `${orderId}:${symbolKey}:${date}`,
      date, action, openedShort, secType, ticker, symbolKey,
      strikePrice, expirationDate, callPut,
      qty: Math.abs(filled),
      price: Math.abs(price),
      commission: numOf(inst['estimatedCommission']) ?? 0,
    };
  }

  // ─── Match open legs to close/expiration legs ─────────────────────────────

  private matchClosedPositions(legs: TxLeg[]): ClosedPosition[] {
    // Group by symbol key
    const bySymbol = new Map<string, TxLeg[]>();
    for (const leg of legs) {
      const arr = bySymbol.get(leg.symbolKey) ?? [];
      arr.push(leg);
      bySymbol.set(leg.symbolKey, arr);
    }

    const result: ClosedPosition[] = [];

    for (const [, group] of bySymbol) {
      // Sort chronologically
      group.sort((a, b) => a.date.localeCompare(b.date));

      const opens   = group.filter(l => l.action === 'open');
      const closes  = group.filter(l => l.action === 'close' || l.action === 'expired' || l.action === 'assigned');

      // Pair each open with its corresponding close (FIFO)
      for (let i = 0; i < opens.length; i++) {
        const open = opens[i]!;
        const close = closes[i]; // may be undefined if still open or no matching close yet

        // Only process if there's a matching close (or expiration)
        if (!close) continue;

        const secType = open.secType;
        let positionType: ClosedPosition['positionType'];
        if (secType === 'OPTN') {
          // Long options are NOT wheel positions and must not be labelled CSP/CC — the naming
          // matches the rows the position sync already writes ('Long Call' / 'Long Put').
          positionType = open.openedShort
            ? (open.callPut === 'PUT' ? 'CSP' : 'CC')
            : (open.callPut === 'PUT' ? 'Long Put' : 'Long Call');
        } else {
          positionType = 'Stock';
        }

        const multiplier  = secType === 'OPTN' ? open.qty * 100 : open.qty;
        const closePrice  = close.action === 'expired' ? 0 : close.price;
        // Direction decides the sign. Short premium profits when the close is CHEAPER than the
        // open; a long position profits when it is DEARER. Treating every option as short
        // inverted the sign on long trades (TSLA $375 put: real −$364.06, recorded +$361.97).
        const shortSide = secType === 'OPTN' ? open.openedShort : false;
        const gross = shortSide
          ? (open.price - closePrice) * multiplier
          : (closePrice - open.price) * multiplier;
        const realizedPnl = gross - open.commission - close.commission;

        result.push({
          ticker:          open.ticker,
          positionType,
          quantity:        open.qty,
          entryPrice:      open.price,
          entryDate:       open.date,
          exitPrice:       closePrice,
          exitDate:        close.date,
          exitNotes:       close.action === 'expired' ? 'Expired worthless' : close.action === 'assigned' ? 'Assigned' : null,
          strikePrice:     open.strikePrice,
          expirationDate:  open.expirationDate,
          // Only a SHORT option collects premium; a long one pays a debit.
          premiumReceived: secType === 'OPTN' && open.openedShort ? open.price : null,
          realizedPnl,
        });
      }
    }

    return result;
  }

  // ─── Insert one closed position (with dedup check) ────────────────────────

  private insertClosedPosition(db: Database, pos: ClosedPosition): boolean {
    // A closed position can already exist in one of two forms:
    //
    //   1. An ESTIMATE written by the position sync when the row vanished from the broker
    //      ("realized P&L estimated from last mark", exit_price NULL). Those are systematically
    //      wrong: an ASSIGNED CSP reads as a large loss when it was really a conversion into
    //      stock (TSLA 350 showed -$3,735.53; the real fill is +$499.48), and a position closed
    //      by expiry is booked at its last mark rather than zero (TSLA 360 CC showed -$463.02;
    //      the real fill is +$347.47). A real fill must SUPERSEDE those, not sit beside them.
    //
    //   2. A previously imported real fill, which should simply be skipped.
    //
    // The supersede key is deliberately tight — ticker + type + strike + expiry + entry_date +
    // quantity. Matching on ticker+type alone collapsed an open 100-share assignment lot into a
    // closed 60-share lot from four months earlier. `IS` rather than `=` so NULL strike/expiry
    // (equities) compare correctly.
    const stale = db.prepare(`
      SELECT id FROM positions
      WHERE ticker = ? AND position_type = ?
        AND strike_price IS ? AND expiration_date IS ?
        AND entry_date = ? AND quantity = ?
        AND status = 'closed' AND exit_price IS NULL
      LIMIT 1
    `).get(
      pos.ticker, pos.positionType, pos.strikePrice, pos.expirationDate,
      pos.entryDate, pos.quantity,
    ) as { id: number } | undefined;

    if (stale) {
      db.prepare(`
        UPDATE positions
           SET exit_price = ?, exit_date = ?, exit_notes = ?, realized_pnl = ?,
               entry_price = ?, premium_received = ?, updated_at = ?
         WHERE id = ?
      `).run(
        pos.exitPrice, pos.exitDate,
        'Superseded by actual E*Trade fill (was estimated from last mark)',
        pos.realizedPnl, pos.entryPrice, pos.premiumReceived,
        new Date().toISOString(), stale.id,
      );
      return true;
    }

    // Already imported with a real fill — nothing to do.
    const existing = db.prepare(`
      SELECT id FROM positions
      WHERE ticker = ? AND position_type = ? AND entry_date = ? AND exit_date = ? AND status = 'closed'
    `).get(pos.ticker, pos.positionType, pos.entryDate, pos.exitDate);

    if (existing) return false;

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO positions (
        ticker, position_type, quantity, entry_price, entry_date,
        exit_price, exit_date, exit_notes,
        strike_price, expiration_date, premium_received,
        realized_pnl, status, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, 'closed', ?, ?
      )
    `).run(
      pos.ticker, pos.positionType, pos.quantity, pos.entryPrice, pos.entryDate,
      pos.exitPrice, pos.exitDate, pos.exitNotes,
      pos.strikePrice, pos.expirationDate, pos.premiumReceived,
      pos.realizedPnl,
      now, now
    );

    return true;
  }

  // ─── Sync status query ────────────────────────────────────────────────────

  /** Returns ISO timestamp of the most recent E*Trade sync, or null. */
  getLastSyncedAt(db: Database): string | null {
    const row = db.prepare(
      "SELECT last_synced_at FROM positions WHERE last_synced_at IS NOT NULL ORDER BY last_synced_at DESC LIMIT 1"
    ).get() as { last_synced_at: string } | undefined;
    return row?.last_synced_at ?? null;
  }
}
