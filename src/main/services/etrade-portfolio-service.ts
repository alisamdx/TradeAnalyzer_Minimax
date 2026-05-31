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
import { etradeGet, type OAuthCredentials } from './etrade-auth.js';
import type { EtradeAccount, EtradeSyncResult } from '@shared/types.js';

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

// ─── Internal closed-position record ─────────────────────────────────────────

interface ClosedPosition {
  ticker: string;
  positionType: 'CSP' | 'CC' | 'Stock';
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
    const raw = await etradeGet('/v1/accounts/list', {}, creds);

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
      } catch (err) {
        result.errors.push(
          `Account ${acct.accountId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return result;
  }

  // ─── Fetch positions for one account ─────────────────────────────────────

  private async fetchPositions(
    accountIdKey: string,
    creds: OAuthCredentials
  ): Promise<EtradePositionRaw[]> {
    const raw = await etradeGet(
      `/v1/accounts/${accountIdKey}/portfolio`,
      { totalsRequired: 'true', lotsRequired: 'false', view: 'COMPLETE' },
      creds
    );

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
    let positionType: 'CSP' | 'CC' | 'Stock';
    let ticker: string;
    let strikePrice: number | null = null;
    let expirationDate: string | null = null;

    if (Product.securityType === 'EQ') {
      positionType = 'Stock';
      ticker = Product.symbol;
    } else if (Product.securityType === 'OPTN') {
      // Only track SHORT options
      if (raw.positionType !== 'SHORT' && raw.quantity >= 0) {
        return false; // long option — skip
      }

      if (Product.callPut === 'PUT') {
        positionType = 'CSP';
      } else if (Product.callPut === 'CALL') {
        positionType = 'CC';
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
    const delta = num(Complete?.delta);
    const gamma = num(Complete?.gamma);
    const theta = num(Complete?.theta);
    const vega  = num(Complete?.vega);
    // IV: E*Trade returns decimal fraction (0.3882) — convert to percentage
    const ivRaw = num(Complete?.iv);
    const iv    = ivRaw !== null ? ivRaw * 100 : null;
    const beta  = num(Complete?.Fundamental?.beta);

    // ── Quantity: store as absolute contracts (sign from positionType) ───────
    const qty = Math.abs(raw.quantity);

    // ── Cost basis (entry price) ─────────────────────────────────────────────
    const entryPrice = num(raw.pricePaid) ?? num(raw.costPerShare) ?? 0;
    const entryDate  = epochToDate(raw.dateAcquired);

    // ── Premium received (for CSP/CC: cost per share = premium collected) ────
    const premiumReceived = positionType !== 'Stock'
      ? (num(raw.pricePaid) ?? num(raw.costPerShare))
      : null;

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
        num(raw.marketValue), num(raw.totalGainPct),
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
          market_value, total_gain_pct, days_gain, days_gain_pct,
          cost_per_share, pct_of_portfolio,
          delta, gamma, theta, vega, iv, beta,
          last_synced_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, 'open',
          ?, ?,
          ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?
        )
      `).run(
        ticker, positionType, qty, entryPrice, entryDate,
        strikePrice, expirationDate, premiumReceived,
        raw.positionId, accountId,
        num(raw.marketValue), num(raw.totalGainPct),
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
        const legs = await this.fetchTransactionLegs(acct.accountIdKey, start, end, creds);
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
    let marker: string | undefined;

    // E*Trade uses MM/dd/yyyy for transaction date params
    const fmt = (iso: string) => {
      const [y, m, d] = iso.split('-') as [string, string, string];
      return `${m}/${d}/${y}`;
    };

    do {
      const params: Record<string, string> = {
        startDate: fmt(startDate),
        endDate:   fmt(endDate),
        count:     '50',
      };
      if (marker) params['marker'] = marker;

      const raw = await etradeGet(
        `/v1/accounts/${accountIdKey}/transactions`,
        params,
        creds
      ) as Record<string, unknown>;

      const resp = raw['TransactionListResponse'] as Record<string, unknown> | undefined;
      if (!resp) break;

      const txArr = resp['Transaction'];
      if (Array.isArray(txArr)) {
        for (const tx of txArr as EtradeTransaction[]) {
          const leg = this.classifyTransaction(tx);
          if (leg) legs.push(leg);
        }
      }

      marker = typeof resp['marker'] === 'string' ? resp['marker'] : undefined;
    } while (marker);

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

    return { txId: tx.transactionId, date, action, secType, ticker, symbolKey, strikePrice, expirationDate, callPut, qty, price, commission };
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
        let positionType: 'CSP' | 'CC' | 'Stock';

        if (secType === 'OPTN') {
          positionType = open.callPut === 'PUT' ? 'CSP' : 'CC';
        } else {
          positionType = 'Stock';
        }

        const multiplier  = secType === 'OPTN' ? open.qty * 100 : open.qty;
        const closePrice  = close.action === 'expired' ? 0 : close.price;
        // For short options: profit = (open_price - close_price) × multiplier
        // For long stock:    profit = (close_price - open_price) × multiplier
        const realizedPnl = secType === 'OPTN'
          ? (open.price - closePrice) * multiplier - open.commission - close.commission
          : (closePrice - open.price) * multiplier - open.commission - close.commission;

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
          premiumReceived: secType === 'OPTN' ? open.price : null,
          realizedPnl,
        });
      }
    }

    return result;
  }

  // ─── Insert one closed position (with dedup check) ────────────────────────

  private insertClosedPosition(db: Database, pos: ClosedPosition): boolean {
    // Dedup: skip if a closed position with same ticker + type + entry_date + exit_date exists
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
