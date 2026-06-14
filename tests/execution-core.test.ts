import { describe, it, expect } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { ExecutionCore, type CoreEvent } from '../src/main/execution/execution-core.js';
import { RiskGovernor } from '../src/main/execution/risk-governor.js';
import { MockExecutionBroker } from '../src/main/execution/mock-execution-broker.js';

const MARKET_OPEN = '2026-06-15T18:00:00Z'; // Mon 14:00 ET
const MARKET_CLOSED = '2026-06-13T18:00:00Z'; // Sat

function setup(initial = MARKET_OPEN) {
  let clock = new Date(initial);
  const db: DbHandle = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const broker = new MockExecutionBroker();
  const gov = new RiskGovernor(db);
  const core = new ExecutionCore(db, broker, gov, { now: () => clock, watchdogMaxGapMs: 60_000 });
  return { db, broker, gov, core, setClock: (s: string) => (clock = new Date(s)) };
}

function insertOpenPosition(db: DbHandle, ticker: string) {
  db.prepare(
    `INSERT INTO exec_positions (ticker, strategy, structure, legs_json, contracts, max_loss, opened_at, status)
     VALUES (?, 'inflection', 'short-put-vertical', '[]', 1, 350, '2026-06-14', 'open')`
  ).run(ticker);
}

describe('ExecutionCore — lifecycle', () => {
  it('starts after a clean cold-start reconcile', async () => {
    const { core, gov } = setup();
    const r = await core.startEngine();
    expect(r.started).toBe(true);
    expect(gov.getEngineState()).toBe('running');
  });

  it('refuses to start on cold-start drift and flags the position', async () => {
    const { db, core, gov } = setup();
    insertOpenPosition(db, 'BBB'); // broker has nothing → mismatch
    const r = await core.startEngine();
    expect(r.started).toBe(false);
    expect(r.reason).toBe('reconcile_mismatch');
    expect(gov.getEngineState()).toBe('stopped');
    const status = (db.prepare('SELECT status FROM exec_positions WHERE ticker = ?').get('BBB') as { status: string }).status;
    expect(status).toBe('needs_attention');
  });

  it('emits engine_state on start', async () => {
    const { core } = setup();
    const events: CoreEvent[] = [];
    core.onEvent((e) => events.push(e));
    await core.startEngine();
    expect(events.some((e) => e.type === 'engine_state' && e.state === 'running')).toBe(true);
  });
});

describe('ExecutionCore — runCycle', () => {
  it('skips when the engine is not running', async () => {
    const { core } = setup();
    expect((await core.runCycle()).status).toBe('skipped_not_running');
  });

  it('runs a clean cycle and calls the market hook when open', async () => {
    const { core } = setup(MARKET_OPEN);
    let hookCalls = 0;
    core.setMarketCycleHook(() => {
      hookCalls += 1;
    });
    await core.startEngine();
    const r = await core.runCycle();
    expect(r.status).toBe('ok');
    expect(r.marketOpen).toBe(true);
    expect(hookCalls).toBe(1);
  });

  it('skips the market hook when the market is closed', async () => {
    const { core } = setup(MARKET_CLOSED);
    let hookCalls = 0;
    core.setMarketCycleHook(() => {
      hookCalls += 1;
    });
    await core.startEngine();
    const r = await core.runCycle();
    expect(r.status).toBe('skipped_market_closed');
    expect(hookCalls).toBe(0);
  });

  it('fails closed when the broker is disconnected', async () => {
    const { core, broker } = setup();
    await core.startEngine();
    broker.setConnectionState('disconnected');
    expect((await core.runCycle()).status).toBe('skipped_broker_disconnected');
  });

  it('trips the kill switch on drift during a running cycle', async () => {
    const { db, core, gov } = setup();
    await core.startEngine();
    insertOpenPosition(db, 'CCC'); // appears with no broker position → mismatch
    const r = await core.runCycle();
    expect(r.status).toBe('tripped_reconcile');
    expect(gov.getEngineState()).toBe('kill_tripped');
    expect(gov.getRiskState().killSwitchReason).toBe('reconcile_mismatch');
  });
});

describe('ExecutionCore — health watchdog', () => {
  it('is healthy right after a cycle', async () => {
    const { core } = setup();
    await core.startEngine();
    await core.runCycle();
    expect(core.getHealth().healthy).toBe(true);
  });

  it('reports degraded when the broker is disconnected', async () => {
    const { core, broker } = setup();
    await core.startEngine();
    broker.setConnectionState('disconnected');
    expect(core.getHealth().degradedReason).toBe('broker_disconnected');
  });

  it('reports a stale cycle once the watchdog gap is exceeded', async () => {
    const { core, setClock } = setup();
    await core.startEngine();
    await core.runCycle();
    setClock('2026-06-15T18:05:00Z'); // +5 min > 60s gap
    expect(core.getHealth().degradedReason).toBe('stale_cycle');
  });
});
