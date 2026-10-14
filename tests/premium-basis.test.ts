import { describe, it, expect } from 'vitest';
import { computePremiumBasis, type PremiumBasisPositionRow } from '../src/shared/premium-basis.js';

// Premium vs cost basis on stock holdings — Bec's "risk line" (v1.1.359). Reporting only.

let nextId = 1;
const row = (p: Partial<PremiumBasisPositionRow> & Pick<PremiumBasisPositionRow, 'ticker' | 'positionType'>): PremiumBasisPositionRow => ({
  id: nextId++, quantity: 1, entryPrice: 0, entryDate: '2026-08-01', exitPrice: null, exitDate: null,
  strikePrice: null, expirationDate: null, realizedPnl: null, status: 'closed', ...p,
});
const stock = (ticker: string, shares: number, cost: number, acquired: string) =>
  row({ ticker, positionType: 'Stock', quantity: shares, entryPrice: cost, entryDate: acquired, status: 'open' });
const filled = (ticker: string, type: 'CSP' | 'CC', strike: number, exp: string, exit: string, pnl: number, credit = 2) =>
  row({ ticker, positionType: type, strikePrice: strike, expirationDate: exp, exitDate: exit, exitPrice: 0.1, realizedPnl: pnl, entryPrice: credit });

describe('premium vs cost basis', () => {
  it('nets premium kept from closed calls off the cost basis, in date order', () => {
    const [h] = computePremiumBasis([
      stock('AAA', 100, 50, '2026-08-21'),
      filled('AAA', 'CC', 55, '2026-09-11', '2026-09-11', 120),
      filled('AAA', 'CC', 55, '2026-08-28', '2026-08-28', 80),
    ]);
    expect(h!.premiumKept).toBe(200);
    expect(h!.premiumKeptPerShare).toBe(2);
    expect(h!.netBasis).toBe(48);
    expect(h!.reductionPct).toBe(4);
    expect(h!.steps.map(s => [s.date, s.basisAfter])).toEqual([['2026-08-28', 49.2], ['2026-09-11', 48]]);
    expect(h!.onlyFallen).toBe(true);
  });

  it('marks a call bought back at a loss as the line rising — her test', () => {
    const [h] = computePremiumBasis([
      stock('AAA', 100, 50, '2026-08-21'),
      filled('AAA', 'CC', 52, '2026-08-28', '2026-08-28', 150),
      filled('AAA', 'CC', 51, '2026-09-04', '2026-09-03', -230),
    ]);
    expect(h!.rises).toBe(1);
    expect(h!.onlyFallen).toBe(false);
    expect(h!.steps[1]).toMatchObject({ rose: true, basisAfter: 50.8 });
    expect(h!.netBasis).toBeGreaterThan(50); // net premium negative: the basis is ABOVE cost
  });

  it('counts the assigning put once, and leaves out trades from an earlier cycle', () => {
    const [h] = computePremiumBasis([
      stock('AAA', 100, 50, '2026-08-24'),
      filled('AAA', 'CSP', 50, '2026-08-21', '2026-08-24', 180, 1.8),   // assigned these shares
      filled('AAA', 'CSP', 48, '2026-06-19', '2026-06-19', 140),        // an earlier cycle
      filled('AAA', 'CSP', 45, '2026-08-21', '2026-08-21', 60),         // same expiry, wrong strike
      filled('AAA', 'CC', 52, '2026-09-04', '2026-09-04', 90),
    ]);
    expect(h!.steps.map(s => s.type)).toEqual(['CSP', 'CC']);
    expect(h!.premiumKept).toBe(270);
    expect(h!.steps[0]!.inBrokerBasis).toBe(false);
  });

  it('does not subtract the assigning put again when the broker cost already includes it', () => {
    // Strike 50, credit 1.80 → an adjusted basis of 48.20 is what the broker reports.
    const [h] = computePremiumBasis([
      stock('AAA', 100, 48.2, '2026-08-24'),
      filled('AAA', 'CSP', 50, '2026-08-21', '2026-08-24', 180, 1.8),
      filled('AAA', 'CC', 52, '2026-09-04', '2026-09-04', 90),
    ]);
    expect(h!.steps[0]).toMatchObject({ type: 'CSP', inBrokerBasis: true, basisAfter: 48.2, rose: false });
    expect(h!.premiumInBrokerBasis).toBe(180);
    expect(h!.premiumKept).toBe(90);
    expect(h!.netBasis).toBe(47.3);
  });

  it('counts an estimated row that vanished at expiry at its full credit, never at the bogus mark', () => {
    // The TSLA 350 shape: assigned, no closing fill, sync estimate −$3,736. Real result was the credit.
    const est = row({
      ticker: 'TSLA', positionType: 'CSP', quantity: 1, entryPrice: 5, strikePrice: 350,
      expirationDate: '2026-08-21', exitDate: '2026-08-24', exitPrice: null, realizedPnl: -3736,
    });
    const [h] = computePremiumBasis([stock('TSLA', 100, 350, '2026-08-24'), est]);
    expect(h!.steps[0]).toMatchObject({ estimated: true, kept: 500, rose: false });
    expect(h!.premiumKept).toBe(500);
  });

  it('leaves a no-fill row that vanished BEFORE expiry unresolved instead of guessing', () => {
    const early = row({
      ticker: 'AAA', positionType: 'CC', quantity: 1, entryPrice: 1.5, strikePrice: 55,
      expirationDate: '2026-09-18', exitDate: '2026-09-10', exitPrice: null, realizedPnl: -40,
    });
    const [h] = computePremiumBasis([stock('AAA', 100, 50, '2026-08-21'), early]);
    expect(h!.steps).toEqual([]);
    expect(h!.unresolved).toEqual([expect.objectContaining({ positionId: early.id, type: 'CC' })]);
    expect(h!.netBasis).toBe(50);
  });

  it('shows open short-call credit apart from kept premium, and ignores tickers with no stock', () => {
    const out = computePremiumBasis([
      stock('AAA', 200, 50, '2026-08-21'),
      row({ ticker: 'AAA', positionType: 'CC', quantity: 2, entryPrice: 1.25, strikePrice: 55, expirationDate: '2026-10-16', status: 'open' }),
      filled('BBB', 'CSP', 30, '2026-09-11', '2026-09-11', 75),   // a put-only ticker: no holding
    ]);
    expect(out.map(h => h.ticker)).toEqual(['AAA']);
    expect(out[0]).toMatchObject({ openCredit: 250, openShortCalls: 2, premiumKept: 0, netBasis: 50, onlyFallen: true });
  });

  it('weights cost across lots by shares and dates the window from the earliest lot', () => {
    const [h] = computePremiumBasis([
      stock('AAA', 100, 50, '2026-08-21'),
      stock('AAA', 300, 40, '2026-09-18'),
      filled('AAA', 'CC', 55, '2026-09-04', '2026-09-04', 100),
    ]);
    expect(h!.shares).toBe(400);
    expect(h!.costPerShare).toBe(42.5);
    expect(h!.acquired).toBe('2026-08-21');
    expect(h!.netBasis).toBe(42.25);
  });
});
