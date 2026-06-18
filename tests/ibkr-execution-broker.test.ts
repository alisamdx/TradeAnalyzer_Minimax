import { describe, it, expect } from 'vitest';
import {
  toIbkrExpiry,
  fromIbkrExpiry,
  legToOptionContract,
  comboLimitOrderParams,
  ibkrFillToNetCredit,
  comboQuoteFromLegs,
  mapIbkrOrderStatus,
  isBenignNotice,
} from '../src/main/execution/ibkr-execution-broker.js';
import { resolveBrokerSettings } from '../src/main/execution/broker-factory.js';
import type { LegSpec } from '../src/main/execution/execution-broker.js';

// Phase 6: the IBKR adapter's pure mapping logic — the parts testable with no live
// connection. Live connection/order behaviour is calibrated against the paper account
// (Phase 7); these pin the IBKR conventions the adapter encodes.

const SELL_LEG: LegSpec = { ticker: 'XYZ', right: 'P', action: 'sell', strike: 100, expiry: '2026-07-17', ratio: 1 };

describe('IBKR adapter — expiry mapping', () => {
  it('converts YYYY-MM-DD ↔ YYYYMMDD', () => {
    expect(toIbkrExpiry('2026-07-17')).toBe('20260717');
    expect(fromIbkrExpiry('20260717')).toBe('2026-07-17');
  });
  it('round-trips', () => {
    expect(fromIbkrExpiry(toIbkrExpiry('2026-12-31'))).toBe('2026-12-31');
  });
  it('passes through malformed input unchanged', () => {
    expect(fromIbkrExpiry('bogus')).toBe('bogus');
  });
});

describe('IBKR adapter — option contract', () => {
  it('maps a leg to an OPT contract with the right fields', () => {
    const c = legToOptionContract(SELL_LEG, { exchange: 'SMART', currency: 'USD' });
    expect(c.symbol).toBe('XYZ');
    expect(c.secType).toBe('OPT');
    expect(c.lastTradeDateOrContractMonth).toBe('20260717');
    expect(c.strike).toBe(100);
    expect(c.right).toBe('P');
    expect(c.multiplier).toBe(100);
    expect(c.exchange).toBe('SMART');
    expect(c.currency).toBe('USD');
  });
});

describe('IBKR adapter — combo net-price convention', () => {
  it('a credit (positive netLimit) becomes a negative IBKR BUY limit', () => {
    const { action, lmtPrice } = comboLimitOrderParams(0.1);
    expect(action).toBe('BUY');
    expect(lmtPrice).toBe(-0.1);
  });
  it('a debit (negative netLimit) becomes a positive IBKR BUY limit', () => {
    expect(comboLimitOrderParams(-0.25).lmtPrice).toBe(0.25);
  });
  it('an IBKR fill price inverts back to credit-positive', () => {
    expect(ibkrFillToNetCredit(-0.1)).toBe(0.1);
  });
  it('order params and fill conversion are inverses', () => {
    const credit = 0.42;
    const { lmtPrice } = comboLimitOrderParams(credit);
    expect(ibkrFillToNetCredit(lmtPrice)).toBeCloseTo(credit, 5);
  });
});

describe('IBKR adapter — combo pricing from legs', () => {
  // short put vertical: SELL 280P (1.90/2.00), BUY 275P (1.30/1.41)
  const vertical: LegSpec[] = [
    { ticker: 'AAPL', right: 'P', action: 'sell', strike: 280, expiry: '2026-07-17', ratio: 1 },
    { ticker: 'AAPL', right: 'P', action: 'buy', strike: 275, expiry: '2026-07-17', ratio: 1 },
  ];

  it('nets a credit spread from leg top-of-book', () => {
    const q = comboQuoteFromLegs(vertical, [{ bid: 1.9, ask: 2.0 }, { bid: 1.3, ask: 1.41 }]);
    expect(q.mid).toBeCloseTo(0.59, 2); // (1.95) - (1.355)
    expect(q.bid).toBeCloseTo(0.49, 2); // sell.bid - buy.ask = 1.90 - 1.41
    expect(q.ask).toBeCloseTo(0.7, 2); // sell.ask - buy.bid = 2.00 - 1.30
    expect(q.netCredit).toBe(q.mid);
    expect(q.bid).toBeLessThanOrEqual(q.ask);
  });

  it('prices a lone short put (CSP) as a positive credit', () => {
    const csp: LegSpec[] = [{ ticker: 'XYZ', right: 'P', action: 'sell', strike: 100, expiry: '2026-07-17', ratio: 1 }];
    const q = comboQuoteFromLegs(csp, [{ bid: 1.0, ask: 1.2 }]);
    expect(q.mid).toBeCloseTo(1.1, 2);
    expect(q.bid).toBeCloseTo(1.0, 2);
    expect(q.ask).toBeCloseTo(1.2, 2);
  });

  it('returns a negative net (debit) when the bought leg costs more', () => {
    const debit: LegSpec[] = [
      { ticker: 'XYZ', right: 'C', action: 'buy', strike: 100, expiry: '2026-07-17', ratio: 1 },
      { ticker: 'XYZ', right: 'C', action: 'sell', strike: 105, expiry: '2026-07-17', ratio: 1 },
    ];
    const q = comboQuoteFromLegs(debit, [{ bid: 3.0, ask: 3.2 }, { bid: 1.0, ask: 1.1 }]);
    expect(q.mid).toBeLessThan(0); // net debit
  });

  it('honours leg ratios', () => {
    const ratioed: LegSpec[] = [{ ticker: 'XYZ', right: 'P', action: 'sell', strike: 100, expiry: '2026-07-17', ratio: 2 }];
    const q = comboQuoteFromLegs(ratioed, [{ bid: 1.0, ask: 1.2 }]);
    expect(q.mid).toBeCloseTo(2.2, 2); // 1.1 * 2
  });
});

describe('IBKR adapter — status + notice mapping', () => {
  it('maps IBKR statuses to the seam enum', () => {
    expect(mapIbkrOrderStatus('PreSubmitted')).toBe('submitted');
    expect(mapIbkrOrderStatus('Submitted')).toBe('working');
    expect(mapIbkrOrderStatus('Filled')).toBe('filled');
    expect(mapIbkrOrderStatus('Cancelled')).toBe('cancelled');
    expect(mapIbkrOrderStatus('ApiCancelled')).toBe('cancelled');
    expect(mapIbkrOrderStatus('Inactive')).toBe('cancelled');
  });
  it('classifies benign data-farm notices as non-errors', () => {
    expect(isBenignNotice(2104)).toBe(true);
    expect(isBenignNotice(2106)).toBe(true);
    expect(isBenignNotice(2158)).toBe(true);
    expect(isBenignNotice(201)).toBe(false); // order rejected — a real error
  });
});

describe('broker factory — settings resolution', () => {
  it('defaults to the mock broker (IBKR is opt-in)', () => {
    expect(resolveBrokerSettings('paper', {}).kind).toBe('mock');
  });
  it('selects IBKR on TA_EXEC_BROKER=ibkr with TWS paper port', () => {
    const s = resolveBrokerSettings('paper', { TA_EXEC_BROKER: 'ibkr' });
    expect(s.kind).toBe('ibkr');
    expect(s.port).toBe(7497);
    expect(s.host).toBe('127.0.0.1');
    expect(s.clientId).toBe(7);
  });
  it('uses TWS live port in live mode', () => {
    expect(resolveBrokerSettings('live', { TA_EXEC_BROKER: 'ibkr' }).port).toBe(7496);
  });
  it('switches to Gateway ports with TA_IBKR_GATEWAY=1', () => {
    expect(resolveBrokerSettings('paper', { TA_EXEC_BROKER: 'ibkr', TA_IBKR_GATEWAY: '1' }).port).toBe(4002);
    expect(resolveBrokerSettings('live', { TA_EXEC_BROKER: 'ibkr', TA_IBKR_GATEWAY: '1' }).port).toBe(4001);
  });
  it('an explicit TA_IBKR_PORT overrides the table', () => {
    expect(resolveBrokerSettings('paper', { TA_EXEC_BROKER: 'ibkr', TA_IBKR_PORT: '4002' }).port).toBe(4002);
  });
  it('honours host + clientId overrides', () => {
    const s = resolveBrokerSettings('paper', { TA_EXEC_BROKER: 'ibkr', TA_IBKR_HOST: '10.0.0.5', TA_IBKR_CLIENT_ID: '12' });
    expect(s.host).toBe('10.0.0.5');
    expect(s.clientId).toBe(12);
  });
});
