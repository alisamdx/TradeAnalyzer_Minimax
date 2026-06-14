import { describe, it, expect } from 'vitest';
import { MockExecutionBroker } from '../src/main/execution/mock-execution-broker.js';
import type {
  Fill,
  LegSpec,
  OrderStatusUpdate,
} from '../src/main/execution/execution-broker.js';

// Phase 1: the ExecutionBroker seam + deterministic mock. These tests pin the mock's
// contract so later phases (governor, loops) can rely on it.

// A bull-put credit spread: sell the 100 put, buy the 95 put.
// Default pricer = 2% of strike → credit = 0.02*(100-95) = 0.10 per share.
const SPREAD: LegSpec[] = [
  { ticker: 'XYZ', right: 'P', action: 'sell', strike: 100, expiry: '2026-07-17', ratio: 1 },
  { ticker: 'XYZ', right: 'P', action: 'buy', strike: 95, expiry: '2026-07-17', ratio: 1 },
];
// The same spread, reversed, to close it.
const CLOSE_SPREAD: LegSpec[] = [
  { ticker: 'XYZ', right: 'P', action: 'buy', strike: 100, expiry: '2026-07-17', ratio: 1 },
  { ticker: 'XYZ', right: 'P', action: 'sell', strike: 95, expiry: '2026-07-17', ratio: 1 },
];

function collectors(b: MockExecutionBroker) {
  const statuses: OrderStatusUpdate[] = [];
  const fills: Fill[] = [];
  b.onOrderStatus((u) => statuses.push(u));
  b.onFill((f) => fills.push(f));
  return { statuses, fills };
}

describe('MockExecutionBroker', () => {
  it('connects and reports connection state to listeners', async () => {
    const b = new MockExecutionBroker();
    const seen: string[] = [];
    b.onConnectionState((s) => seen.push(s));
    expect(b.isConnected()).toBe(false);
    await b.connect();
    expect(b.isConnected()).toBe(true);
    expect(seen).toContain('connected');
  });

  it('prices a credit spread deterministically (positive net credit)', async () => {
    const b = new MockExecutionBroker();
    const q = await b.priceCombo(SPREAD);
    expect(q.netCredit).toBeCloseTo(0.1, 5);
    expect(q.bid).toBeCloseTo(0.05, 5);
    expect(q.ask).toBeCloseTo(0.15, 5);
  });

  it('qualifies contracts with a deterministic conId', async () => {
    const b = new MockExecutionBroker();
    const qc = await b.qualifyContract(SPREAD[0]!);
    expect(qc.qualified).toBe(true);
    expect(qc.multiplier).toBe(100);
    expect(qc.conId).toContain('XYZ');
  });

  it('auto-fills an order: status sequence + fill + opens a position', async () => {
    const b = new MockExecutionBroker();
    const { statuses, fills } = collectors(b);
    await b.connect();
    const ack = await b.placeOrder({
      clientOrderId: 'coid-1',
      legs: SPREAD,
      side: 'open',
      netLimit: 0.1,
      contracts: 1,
    });
    expect(ack.accepted).toBe(true);
    expect(statuses.map((s) => s.status)).toEqual(['submitted', 'working', 'filled']);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.price).toBeCloseTo(0.1, 5);
    expect(fills[0]!.contracts).toBe(1);
    expect(fills[0]!.commission).toBeCloseTo(1.3, 5); // 0.65 * 1 * 2 legs

    const positions = await b.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.ticker).toBe('XYZ');
    expect(positions[0]!.contracts).toBe(1);
    expect(positions[0]!.avgPrice).toBeCloseTo(0.1, 5);
  });

  it('is idempotent on clientOrderId — a repeated COID never duplicates', async () => {
    const b = new MockExecutionBroker();
    await b.connect();
    const first = await b.placeOrder({ clientOrderId: 'coid-dup', legs: SPREAD, side: 'open', netLimit: 0.1, contracts: 1 });
    const second = await b.placeOrder({ clientOrderId: 'coid-dup', legs: SPREAD, side: 'open', netLimit: 0.1, contracts: 1 });
    expect(second.brokerOrderId).toBe(first.brokerOrderId);
    const orders = await b.getOrders();
    expect(orders).toHaveLength(1);
    const positions = await b.getOpenPositions();
    expect(positions[0]!.contracts).toBe(1); // not double-filled
  });

  it('refuses to place when not connected (fail-closed)', async () => {
    const b = new MockExecutionBroker();
    const ack = await b.placeOrder({ clientOrderId: 'coid-x', legs: SPREAD, side: 'open', netLimit: 0.1, contracts: 1 });
    expect(ack.accepted).toBe(false);
    expect(ack.rejectReason).toBe('not_connected');
  });

  it('rejects in reject mode and opens no position', async () => {
    const b = new MockExecutionBroker({ fillMode: 'reject' });
    const { statuses } = collectors(b);
    await b.connect();
    await b.placeOrder({ clientOrderId: 'coid-r', legs: SPREAD, side: 'open', netLimit: 0.1, contracts: 1 });
    expect(statuses.map((s) => s.status)).toContain('rejected');
    expect(await b.getOpenPositions()).toHaveLength(0);
  });

  it('manual mode leaves the order working until driven', async () => {
    const b = new MockExecutionBroker({ fillMode: 'manual' });
    const { statuses, fills } = collectors(b);
    await b.connect();
    await b.placeOrder({ clientOrderId: 'coid-m', legs: SPREAD, side: 'open', netLimit: 0.1, contracts: 1 });
    expect(statuses[statuses.length - 1]!.status).toBe('working');
    expect(fills).toHaveLength(0);
    b.fillOrder('coid-m');
    expect(statuses[statuses.length - 1]!.status).toBe('filled');
    expect(fills).toHaveLength(1);
  });

  it('partial mode fills half, then completes when driven', async () => {
    const b = new MockExecutionBroker({ fillMode: 'partial' });
    const { statuses } = collectors(b);
    await b.connect();
    await b.placeOrder({ clientOrderId: 'coid-p', legs: SPREAD, side: 'open', netLimit: 0.1, contracts: 2 });
    expect(statuses[statuses.length - 1]!.status).toBe('partially_filled');
    expect((await b.getOpenPositions())[0]!.contracts).toBe(1);
    b.fillOrder('coid-p');
    expect(statuses[statuses.length - 1]!.status).toBe('filled');
    expect((await b.getOpenPositions())[0]!.contracts).toBe(2);
  });

  it('a close order (reversed legs) reduces/removes the position', async () => {
    const b = new MockExecutionBroker();
    await b.connect();
    await b.placeOrder({ clientOrderId: 'open-1', legs: SPREAD, side: 'open', netLimit: 0.1, contracts: 1 });
    expect(await b.getOpenPositions()).toHaveLength(1);
    await b.placeOrder({ clientOrderId: 'close-1', legs: CLOSE_SPREAD, side: 'close', netLimit: 0.05, contracts: 1 });
    expect(await b.getOpenPositions()).toHaveLength(0);
  });

  it('reflects a driven mark on the open position', async () => {
    const b = new MockExecutionBroker();
    await b.connect();
    await b.placeOrder({ clientOrderId: 'm-1', legs: SPREAD, side: 'open', netLimit: 0.1, contracts: 1 });
    b.setMark('XYZ', 0.04);
    expect((await b.getOpenPositions())[0]!.mark).toBeCloseTo(0.04, 5);
  });

  it('cancels a working order in manual mode', async () => {
    const b = new MockExecutionBroker({ fillMode: 'manual' });
    const { statuses } = collectors(b);
    await b.connect();
    await b.placeOrder({ clientOrderId: 'c-1', legs: SPREAD, side: 'open', netLimit: 0.1, contracts: 1 });
    await b.cancelOrder('c-1');
    expect(statuses[statuses.length - 1]!.status).toBe('cancelled');
  });
});
