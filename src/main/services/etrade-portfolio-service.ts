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

  // ─── Sync status query ────────────────────────────────────────────────────

  /** Returns ISO timestamp of the most recent E*Trade sync, or null. */
  getLastSyncedAt(db: Database): string | null {
    const row = db.prepare(
      "SELECT last_synced_at FROM positions WHERE last_synced_at IS NOT NULL ORDER BY last_synced_at DESC LIMIT 1"
    ).get() as { last_synced_at: string } | undefined;
    return row?.last_synced_at ?? null;
  }
}
