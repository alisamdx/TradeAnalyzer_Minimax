// Premium vs cost basis on stock holdings — the DB read. The computation and its rules live in
// src/shared/premium-basis.ts (pure, so the renderer can share its types).
// see docs/formulas.md#premium-basis

import type { DbHandle } from '../db/connection.js';
import { computePremiumBasis, type PremiumBasisHolding, type PremiumBasisPositionRow } from '@shared/premium-basis.js';

/** Reads every position row and computes the per-holding read. */
export function getPremiumBasis(db: DbHandle): PremiumBasisHolding[] {
  const rows = db.prepare(`
    SELECT id, ticker, position_type AS positionType, quantity, entry_price AS entryPrice,
           entry_date AS entryDate, exit_price AS exitPrice, exit_date AS exitDate,
           strike_price AS strikePrice, expiration_date AS expirationDate,
           realized_pnl AS realizedPnl, status
      FROM positions
     WHERE position_type IN ('Stock', 'CSP', 'CC')
  `).all() as PremiumBasisPositionRow[];
  return computePremiumBasis(rows);
}
