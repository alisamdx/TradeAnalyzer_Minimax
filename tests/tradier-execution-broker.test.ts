import { describe, it, expect } from 'vitest';
import {
  toOccSymbol,
  fromOccSymbol,
  tradierLegSide,
  tradierNetType,
  tradierFillToNetCredit,
  buildMultilegPayload,
  sanitizeTag,
  mapTradierOrderStatus,
  netComboFromLegs,
  classifyTradierPreview,
  extractErrors,
} from '../src/main/execution/tradier-execution-broker.js';
import type { LegSpec } from '../src/main/execution/execution-broker.js';

describe('Tradier adapter — OCC/OSI symbols', () => {
  it('builds a compact OSI symbol (root + yymmdd + C/P + strike×1000)', () => {
    expect(toOccSymbol({ ticker: 'SPY', expiry: '2026-06-19', right: 'P', strike: 450 })).toBe('SPY260619P00450000');
    expect(toOccSymbol({ ticker: 'aapl', expiry: '2026-01-16', right: 'C', strike: 180.5 })).toBe('AAPL260116C00180500');
  });
  it('round-trips through fromOccSymbol (with the supplied action)', () => {
    const leg = fromOccSymbol('SPY260619P00450000', 'sell');
    expect(leg).toEqual({ right: 'P', action: 'sell', strike: 450, expiry: '2026-06-19', ratio: 1 });
  });
  it('returns null for a non-OSI (e.g. equity) symbol', () => {
    expect(fromOccSymbol('SPY')).toBeNull();
  });
});

describe('Tradier adapter — order sides', () => {
  it('combines leg action + open/close into Tradier sides', () => {
    expect(tradierLegSide('buy', 'open')).toBe('buy_to_open');
    expect(tradierLegSide('sell', 'open')).toBe('sell_to_open');
    expect(tradierLegSide('buy', 'close')).toBe('buy_to_close');
    expect(tradierLegSide('sell', 'close')).toBe('sell_to_close');
  });
});

describe('Tradier adapter — net price convention', () => {
  it('a positive netLimit is a credit; negative is a debit; zero is even', () => {
    expect(tradierNetType(1.25)).toEqual({ type: 'credit', price: 1.25 });
    expect(tradierNetType(-0.8)).toEqual({ type: 'debit', price: 0.8 });
    expect(tradierNetType(0)).toEqual({ type: 'even', price: 0 });
  });
  it('fill price inverts back to credit-positive net', () => {
    expect(tradierFillToNetCredit('credit', 1.25)).toBe(1.25);
    expect(tradierFillToNetCredit('debit', 0.8)).toBe(-0.8);
    expect(tradierFillToNetCredit('even', 5)).toBe(0);
  });
  it('net type and fill conversion are inverses', () => {
    const credit = 1.37;
    const { type, price } = tradierNetType(credit);
    expect(tradierFillToNetCredit(type, price)).toBeCloseTo(credit, 5);
  });
});

describe('Tradier adapter — multileg payload', () => {
  const legs: LegSpec[] = [
    { ticker: 'SPY', right: 'P', action: 'sell', strike: 450, expiry: '2026-06-19', ratio: 1 },
    { ticker: 'SPY', right: 'P', action: 'buy', strike: 445, expiry: '2026-06-19', ratio: 1 },
  ];
  it('builds class=multileg with parallel indexed arrays and the COID tag', () => {
    const p = buildMultilegPayload({ underlying: 'SPY', legs, side: 'open', netLimit: 1.2, contracts: 3, clientOrderId: 'coid-1' });
    expect(p.class).toBe('multileg');
    expect(p.symbol).toBe('SPY');
    expect(p.type).toBe('credit');
    expect(p.price).toBe('1.20');
    expect(p.duration).toBe('day');
    expect(p.tag).toBe('coid-1');
    expect(p['option_symbol[0]']).toBe('SPY260619P00450000');
    expect(p['side[0]']).toBe('sell_to_open');
    expect(p['quantity[0]']).toBe('3');
    expect(p['option_symbol[1]']).toBe('SPY260619P00445000');
    expect(p['side[1]']).toBe('buy_to_open');
    expect(p['quantity[1]']).toBe('3');
  });
  it('scales per-leg quantity by the leg ratio', () => {
    const ratioed: LegSpec[] = [{ ...legs[0]!, ratio: 2 }, legs[1]!];
    const p = buildMultilegPayload({ underlying: 'SPY', legs: ratioed, side: 'open', netLimit: 1, contracts: 2, clientOrderId: 'x' });
    expect(p['quantity[0]']).toBe('4'); // 2 contracts × ratio 2
    expect(p['quantity[1]']).toBe('2');
  });
  it('maps close orders to *_to_close sides', () => {
    const p = buildMultilegPayload({ underlying: 'SPY', legs, side: 'close', netLimit: -0.4, contracts: 1, clientOrderId: 'c' });
    expect(p.type).toBe('debit');
    expect(p['side[0]']).toBe('sell_to_close');
    expect(p['side[1]']).toBe('buy_to_close');
  });
});

describe('Tradier adapter — tag sanitization', () => {
  it('strips disallowed characters and caps length', () => {
    expect(sanitizeTag('coid:abc/123')).toBe('coid-abc-123');
    expect(sanitizeTag('a'.repeat(300)).length).toBe(255);
  });
});

describe('Tradier adapter — status mapping', () => {
  it('maps Tradier statuses to the seam enum', () => {
    expect(mapTradierOrderStatus('open')).toBe('submitted');
    expect(mapTradierOrderStatus('partially_filled')).toBe('partially_filled');
    expect(mapTradierOrderStatus('filled')).toBe('filled');
    expect(mapTradierOrderStatus('canceled')).toBe('cancelled');
    expect(mapTradierOrderStatus('expired')).toBe('cancelled');
    expect(mapTradierOrderStatus('rejected')).toBe('rejected');
    expect(mapTradierOrderStatus('error')).toBe('rejected');
  });
});

describe('Tradier adapter — combo pricing from legs', () => {
  const legs: LegSpec[] = [
    { ticker: 'SPY', right: 'P', action: 'sell', strike: 450, expiry: '2026-06-19', ratio: 1 },
    { ticker: 'SPY', right: 'P', action: 'buy', strike: 445, expiry: '2026-06-19', ratio: 1 },
  ];
  it('nets a credit spread (sold premium minus bought premium)', () => {
    const q = netComboFromLegs(legs, [
      { bid: 2.0, ask: 2.2 }, // sold leg
      { bid: 1.0, ask: 1.1 }, // bought leg
    ]);
    expect(q.netCredit).toBeCloseTo(1.05, 2); // 2.1 mid − 1.05 mid
    expect(q.bid).toBeLessThan(q.ask);
  });
});

describe('Tradier adapter — preview classification (fail-closed)', () => {
  it('a permission error is a missing spread permission', () => {
    const r = classifyTradierPreview({ errors: { error: 'Your account is not approved for this option level' } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_spread_permission');
  });
  it('a non-permission error is check_failed', () => {
    const r = classifyTradierPreview({ errors: { error: 'Invalid symbol' } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('check_failed');
  });
  it('an order with cost/margin back means permitted', () => {
    const r = classifyTradierPreview({ order: { status: 'ok', cost: 500, margin_change: 500 } });
    expect(r.ok).toBe(true);
    expect(r.code).toBe('ok');
  });
  it('extractErrors handles both a single string and an array', () => {
    expect(extractErrors({ errors: { error: 'one' } })).toEqual(['one']);
    expect(extractErrors({ errors: { error: ['a', 'b'] } })).toEqual(['a', 'b']);
    expect(extractErrors({})).toEqual([]);
  });
});
