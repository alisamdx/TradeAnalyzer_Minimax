import { describe, it, expect } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { ExecutionControlApi, formatSse } from '../src/main/execution/control-api.js';
import { ExecutionCore } from '../src/main/execution/execution-core.js';
import { RiskGovernor } from '../src/main/execution/risk-governor.js';
import { MockExecutionBroker } from '../src/main/execution/mock-execution-broker.js';

const AUTH = { 'x-agent-token': 'test-token' };

function setup(onBriefReady?: () => void) {
  const db: DbHandle = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const broker = new MockExecutionBroker();
  const governor = new RiskGovernor(db);
  const core = new ExecutionCore(db, broker, governor, { now: () => new Date('2026-06-15T18:00:00Z') });
  const api = new ExecutionControlApi({ db, core, governor, token: 'test-token', onBriefReady });
  return { db, broker, governor, core, api };
}

describe('ExecutionControlApi — auth', () => {
  it('rejects without a token and allows the public health probe', async () => {
    const { api } = setup();
    expect((await api.inject({ method: 'GET', url: '/exec/state' })).statusCode).toBe(401);
    expect((await api.inject({ method: 'GET', url: '/exec/health' })).statusCode).toBe(200);
    expect((await api.inject({ method: 'GET', url: '/exec/state', headers: AUTH })).statusCode).toBe(200);
  });
});

describe('ExecutionControlApi — state + engine control', () => {
  it('reports the seeded stopped state', async () => {
    const { api } = setup();
    const res = await api.inject({ method: 'GET', url: '/exec/state', headers: AUTH });
    const body = res.json();
    expect(body.engineState).toBe('stopped');
    expect(body.executionMode).toBe('paper');
    expect(body.killSwitch.tripped).toBe(false);
  });

  it('starts, pauses, and stops the engine', async () => {
    const { api } = setup();
    const start = await api.inject({ method: 'POST', url: '/exec/engine/start', headers: AUTH });
    expect(start.json().started).toBe(true);

    const pause = await api.inject({ method: 'POST', url: '/exec/engine/pause', headers: AUTH });
    expect(pause.json().engineState).toBe('paused');

    const stop = await api.inject({ method: 'POST', url: '/exec/engine/stop', headers: AUTH });
    expect(stop.json().engineState).toBe('stopped');
  });

  it('returns 409 when pausing from a non-running state', async () => {
    const { api } = setup();
    const res = await api.inject({ method: 'POST', url: '/exec/engine/pause', headers: AUTH });
    expect(res.statusCode).toBe(409);
  });

  it('trips and clears the kill switch', async () => {
    const { api } = setup();
    await api.inject({ method: 'POST', url: '/exec/engine/start', headers: AUTH });
    const trip = await api.inject({ method: 'POST', url: '/exec/kill-switch/trip', headers: AUTH });
    expect(trip.json().engineState).toBe('kill_tripped');
    const clear = await api.inject({ method: 'POST', url: '/exec/kill-switch/clear', headers: AUTH });
    expect(clear.json().engineState).toBe('running');
  });
});

describe('ExecutionControlApi — reads', () => {
  it('serves config and risk state', async () => {
    const { api } = setup();
    const cfg = (await api.inject({ method: 'GET', url: '/exec/config', headers: AUTH })).json();
    expect(cfg.capitalCeiling).toBe(10000);
    expect(cfg.eligibleStrategies).toEqual(['inflection']);
    const risk = (await api.inject({ method: 'GET', url: '/exec/risk', headers: AUTH })).json();
    expect(risk.engineState).toBe('stopped');
  });

  it('serves open positions and the audit log', async () => {
    const { db, api } = setup();
    db.prepare(
      `INSERT INTO exec_positions (ticker, strategy, structure, legs_json, contracts, max_loss, opened_at, status)
       VALUES ('AAA', 'inflection', 'short-put-vertical', '[]', 1, 350, '2026-06-14', 'open')`
    ).run();
    const positions = (await api.inject({ method: 'GET', url: '/exec/positions', headers: AUTH })).json();
    expect(positions).toHaveLength(1);
    expect(positions[0].ticker).toBe('AAA');

    await api.inject({ method: 'POST', url: '/exec/engine/start', headers: AUTH });
    const audit = (await api.inject({ method: 'GET', url: '/exec/audit?limit=10', headers: AUTH })).json();
    expect(audit.length).toBeGreaterThan(0);
  });
});

describe('ExecutionControlApi — brief-ready handoff', () => {
  it('audits and invokes the onBriefReady hook', async () => {
    let called = 0;
    const { db, api } = setup(() => {
      called += 1;
    });
    const res = await api.inject({ method: 'POST', url: '/exec/brief-ready', headers: AUTH });
    expect(res.json().ok).toBe(true);
    expect(called).toBe(1);
    const events = (db.prepare('SELECT event FROM exec_audit_log').all() as Array<{ event: string }>).map((r) => r.event);
    expect(events).toContain('brief_ready');
  });
});

describe('formatSse', () => {
  it('frames a core event', () => {
    const frame = formatSse({ type: 'engine_state', state: 'running' });
    expect(frame).toBe('data: {"type":"engine_state","state":"running"}\n\n');
  });
});
