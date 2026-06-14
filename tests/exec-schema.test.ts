import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

// Phase 0 of the v2 execution subsystem: the exec_* schema (migration 045) +
// seeded singleton config/risk-state rows. Count-agnostic, in-memory.

function freshDb() {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

function tableNames(db: ReturnType<typeof freshDb>): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe('exec_* schema (migration 045)', () => {
  it('creates all seven execution tables', () => {
    const names = tableNames(freshDb());
    for (const t of [
      'exec_config',
      'exec_risk_state',
      'exec_proposals',
      'exec_orders',
      'exec_fills',
      'exec_positions',
      'exec_audit_log',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('seeds the singleton exec_config row with the locked v2.0 defaults', () => {
    const db = freshDb();
    const row = db.prepare('SELECT * FROM exec_config WHERE id = 1').get() as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.execution_mode).toBe('paper');
    expect(row.capital_ceiling).toBe(10000);
    expect(row.max_risk_per_trade_pct).toBe(5);
    expect(row.max_concurrent_positions).toBe(5);
    expect(row.daily_loss_trip_pct).toBe(10);
    expect(row.max_positions_per_ticker).toBe(1);
    expect(row.max_positions_per_strategy).toBeNull();
    expect(row.eligible_strategies).toBe('inflection');
    expect(row.proposal_shelf_life_min).toBe(120);
  });

  it('seeds the singleton exec_risk_state row in the stopped state', () => {
    const db = freshDb();
    const row = db.prepare('SELECT * FROM exec_risk_state WHERE id = 1').get() as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.engine_state).toBe('stopped');
    expect(row.kill_switch_tripped).toBe(0);
    expect(row.capital_deployed).toBe(0);
  });

  it('enforces the single-row CHECK on config/risk-state (id must be 1)', () => {
    const db = freshDb();
    expect(() => db.prepare('INSERT INTO exec_config (id) VALUES (2)').run()).toThrow();
    expect(() => db.prepare('INSERT INTO exec_risk_state (id) VALUES (2)').run()).toThrow();
  });

  it('rejects invalid enum values via CHECK constraints', () => {
    const db = freshDb();
    expect(() =>
      db.prepare("UPDATE exec_config SET execution_mode = 'real' WHERE id = 1").run()
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE exec_risk_state SET engine_state = 'go' WHERE id = 1").run()
    ).toThrow();
  });

  it('enforces idempotent seeding — re-running migrations does not duplicate singletons', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS_DIR); // second pass is a no-op
    expect((db.prepare('SELECT COUNT(*) AS n FROM exec_config').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM exec_risk_state').get() as { n: number }).n).toBe(1);
  });

  it('requires a unique client_order_id (idempotency key) on orders', () => {
    const db = freshDb();
    db.prepare("INSERT INTO exec_orders (client_order_id, status, side) VALUES ('coid-1', 'pending', 'open')").run();
    expect(() =>
      db.prepare("INSERT INTO exec_orders (client_order_id, status, side) VALUES ('coid-1', 'pending', 'open')").run()
    ).toThrow();
  });
});
