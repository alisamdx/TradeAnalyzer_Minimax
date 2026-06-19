import { describe, it, expect } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { RiskGovernor } from '../src/main/execution/risk-governor.js';
import { MockExecutionBroker } from '../src/main/execution/mock-execution-broker.js';
import type { GateCandidate } from '../src/main/execution/risk-gate.js';

// Phase 2: the DB-backed RiskGovernor. State changes, kill switch, day-P&L trip, sizing,
// gate integration with the mock broker, COID, audit.

function setup(): { db: DbHandle; gov: RiskGovernor } {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return { db, gov: new RiskGovernor(db) };
}

function insertPosition(db: DbHandle, p: { ticker: string; strategy: string; maxLoss: number; status?: string }) {
  db.prepare(
    `INSERT INTO exec_positions (ticker, strategy, structure, legs_json, contracts, max_loss, opened_at, status)
     VALUES (?, ?, 'short-put-vertical', '[]', 1, ?, '2026-06-14', ?)`
  ).run(p.ticker, p.strategy, p.maxLoss, p.status ?? 'open');
}

const CAND: GateCandidate = {
  ticker: 'AAA',
  strategy: 'inflection',
  structure: 'short-put-vertical',
  isDefinedRisk: true,
  contracts: 1,
  maxLossPerContract: 350,
};

describe('RiskGovernor — config', () => {
  it('reads the seeded defaults', () => {
    const { gov } = setup();
    const c = gov.getConfig();
    expect(c.capitalCeiling).toBe(10000);
    expect(c.maxRiskPerTradePct).toBe(5);
    expect(c.eligibleStrategies).toEqual(['inflection', 'wheel', 'income']);
    expect(c.maxPositionsPerStrategy).toBeNull();
  });

  it('updates config (incl. array round-trip)', () => {
    const { gov } = setup();
    const c = gov.updateConfig({ capitalCeiling: 25000, eligibleStrategies: ['inflection', 'wheel'] });
    expect(c.capitalCeiling).toBe(25000);
    expect(c.eligibleStrategies).toEqual(['inflection', 'wheel']);
  });
});

describe('RiskGovernor — engine state machine', () => {
  it('starts from stopped → running and stops back', () => {
    const { gov } = setup();
    expect(gov.getEngineState()).toBe('stopped');
    gov.start();
    expect(gov.getEngineState()).toBe('running');
    gov.stop();
    expect(gov.getEngineState()).toBe('stopped');
  });

  it('pauses only from running', () => {
    const { gov } = setup();
    expect(() => gov.pause()).toThrow(); // from stopped
    gov.start();
    gov.pause();
    expect(gov.getEngineState()).toBe('paused');
  });

  it('cannot start while kill-tripped; clear re-arms to running', () => {
    const { gov } = setup();
    gov.start();
    gov.tripKillSwitch('manual');
    expect(gov.getEngineState()).toBe('kill_tripped');
    expect(gov.getRiskState().killSwitchTripped).toBe(true);
    expect(() => gov.start()).toThrow();
    gov.clearKillSwitch();
    expect(gov.getEngineState()).toBe('running');
    expect(gov.getRiskState().killSwitchTripped).toBe(false);
  });

  it('keeps the first trip reason on a repeated trip', () => {
    const { gov } = setup();
    gov.start();
    gov.tripKillSwitch('daily_loss');
    gov.tripKillSwitch('manual');
    expect(gov.getRiskState().killSwitchReason).toBe('daily_loss');
  });
});

describe('RiskGovernor — day P&L + kill switch', () => {
  it('trips when day loss reaches the configured %', () => {
    const { gov } = setup();
    gov.start();
    gov.updateDayPnl(-1100, 0, '2026-06-14'); // 11% of 10000 ≥ 10%
    expect(gov.getEngineState()).toBe('kill_tripped');
    expect(gov.getRiskState().killSwitchReason).toBe('daily_loss');
  });

  it('does not trip on a small loss', () => {
    const { gov } = setup();
    gov.start();
    gov.updateDayPnl(-100, -50, '2026-06-14'); // 1.5%
    expect(gov.getEngineState()).toBe('running');
    expect(gov.dayLossPct()).toBeCloseTo(1.5, 5);
  });

  it('counts unrealized losses toward the trip', () => {
    const { gov } = setup();
    gov.start();
    gov.updateDayPnl(0, -1000, '2026-06-14'); // 10% all unrealized
    expect(gov.getEngineState()).toBe('kill_tripped');
  });

  it('resets the day at a new session anchor', () => {
    const { gov } = setup();
    gov.start();
    gov.updateDayPnl(-300, 0, '2026-06-14');
    gov.updateDayPnl(50, 0, '2026-06-15'); // new day, prior loss cleared
    expect(gov.dayLossPct()).toBe(0);
    expect(gov.getRiskState().dayRealizedPnl).toBe(50);
  });
});

describe('RiskGovernor — capital + sizing', () => {
  it('recomputes deployed from open positions (excludes closed)', () => {
    const { db, gov } = setup();
    insertPosition(db, { ticker: 'A', strategy: 'inflection', maxLoss: 350 });
    insertPosition(db, { ticker: 'B', strategy: 'inflection', maxLoss: 200, status: 'closed' });
    insertPosition(db, { ticker: 'C', strategy: 'inflection', maxLoss: 150, status: 'needs_attention' });
    expect(gov.recomputeDeployed()).toBe(500); // 350 + 150, not the closed 200
  });

  it('sizes an entry against per-trade risk and remaining capital', () => {
    const { gov } = setup();
    expect(gov.sizeEntry(350).contracts).toBe(1); // $500 cap / 350
    expect(gov.sizeEntry(600).reason).toBe('exceeds_per_trade_risk');
  });
});

describe('RiskGovernor — checkEntry (gate integration)', () => {
  it('passes a clean entry when running + broker connected', async () => {
    const { gov } = setup();
    const broker = new MockExecutionBroker();
    await broker.connect();
    gov.start();
    const r = await gov.checkEntry(CAND, broker);
    expect(r.passed).toBe(true);
  });

  it('fails when the engine is not running', async () => {
    const { gov } = setup();
    const broker = new MockExecutionBroker();
    await broker.connect();
    const r = await gov.checkEntry(CAND, broker); // still stopped
    expect(r.passed).toBe(false);
    expect(r.rejectReason).toBe('engine_running');
  });

  it('fails per-ticker when a position on the ticker is already open', async () => {
    const { db, gov } = setup();
    const broker = new MockExecutionBroker();
    await broker.connect();
    gov.start();
    insertPosition(db, { ticker: 'AAA', strategy: 'inflection', maxLoss: 350 });
    const r = await gov.checkEntry(CAND, broker);
    expect(r.rejectReason).toBe('per_ticker');
  });

  it('fails buying_power when the broker reports too little', async () => {
    const { gov } = setup();
    const broker = new MockExecutionBroker({ buyingPower: 100 });
    await broker.connect();
    gov.start();
    const r = await gov.checkEntry(CAND, broker);
    expect(r.rejectReason).toBe('buying_power');
  });
});

describe('RiskGovernor — COID + audit', () => {
  it('mints unique client order ids', () => {
    const { gov } = setup();
    const a = gov.newClientOrderId();
    const b = gov.newClientOrderId();
    expect(a).not.toBe(b);
    expect(a.startsWith('ta_')).toBe(true);
  });

  it('writes an append-only audit trail for state changes and gate decisions', async () => {
    const { db, gov } = setup();
    const broker = new MockExecutionBroker();
    await broker.connect();
    gov.start();
    await gov.checkEntry(CAND, broker);
    const events = (db.prepare('SELECT event FROM exec_audit_log ORDER BY id').all() as Array<{ event: string }>).map(
      (r) => r.event
    );
    expect(events).toContain('engine_state');
    expect(events).toContain('gate_pass');
  });
});

function insertClosed(db: DbHandle, ticker: string, pnl: number): void {
  db.prepare(
    `INSERT INTO exec_positions (ticker, strategy, structure, legs_json, contracts, max_loss, opened_at, status, current_pnl)
     VALUES (?, 'inflection', 'short-put-vertical', '[]', 1, 100, '2026-06-14', 'closed', ?)`
  ).run(ticker, pnl);
}

describe('RiskGovernor — drawdown-scaled risk (FR-SEY-2)', () => {
  it('ratchets the equity high-water mark up on a winning close (drawdown 0 at a new peak)', () => {
    const { db, gov } = setup();
    expect(gov.getDrawdownPct()).toBe(0);
    insertClosed(db, 'W', 500);
    expect(gov.getDrawdownPct()).toBe(0);
    expect(gov.getRiskState().equityHighWater).toBe(10500);
  });

  it('reports a positive drawdown below the high-water mark', () => {
    const { db, gov } = setup();
    insertClosed(db, 'W', 500); // hwm → 10500
    gov.getDrawdownPct();
    insertClosed(db, 'L', -1500); // closed total -1000 → equity 9000
    expect(gov.getDrawdownPct()).toBeCloseTo(((10500 - 9000) / 10500) * 100, 5);
  });

  it('throttles sizing only when enabled and past the threshold', () => {
    const { db, gov } = setup();
    insertClosed(db, 'L', -1500); // equity 8500 → 15% drawdown (hwm 10000)
    expect(gov.sizeEntry(100).contracts).toBe(5); // throttle off by default → $500/100
    gov.updateConfig({ drawdownThrottlePct: 10, drawdownThrottleFactor: 0.5 });
    expect(gov.sizeEntry(100).contracts).toBe(2); // throttled $250/100
  });

  it('applies the throttle to the pre-trade gate', async () => {
    const { db, gov } = setup();
    const broker = new MockExecutionBroker();
    await broker.connect();
    gov.start();
    insertClosed(db, 'L', -1500); // 15% drawdown
    gov.updateConfig({ drawdownThrottlePct: 10, drawdownThrottleFactor: 0.5 });
    const r = await gov.checkEntry(CAND, broker); // CAND maxLoss 350 > throttled $250 budget
    expect(r.rejectReason).toBe('per_trade_risk');
  });
});

function setFundSector(db: DbHandle, ticker: string, sector: string): void {
  db.prepare('INSERT OR REPLACE INTO fundamentals_cache (ticker, payload_json) VALUES (?, ?)').run(
    ticker,
    JSON.stringify({ sector })
  );
}

describe('RiskGovernor — sector concentration cap (FR-SEY-1)', () => {
  it('rejects a candidate that would breach the per-sector cap (same bucket)', async () => {
    const { db, gov } = setup();
    const broker = new MockExecutionBroker();
    await broker.connect();
    gov.start();
    gov.updateConfig({ maxPositionsPerSector: 1 });
    setFundSector(db, 'AAA', 'semiconductors & related devices'); // → XLK
    setFundSector(db, 'BBB', 'prepackaged software');             // → XLK
    insertPosition(db, { ticker: 'BBB', strategy: 'inflection', maxLoss: 100 });
    const r = await gov.checkEntry(CAND, broker); // CAND ticker AAA, also XLK
    expect(r.rejectReason).toBe('per_sector');
  });

  it('allows a candidate in a different sector', async () => {
    const { db, gov } = setup();
    const broker = new MockExecutionBroker();
    await broker.connect();
    gov.start();
    gov.updateConfig({ maxPositionsPerSector: 1 });
    setFundSector(db, 'AAA', 'crude petroleum & natural gas'); // → XLE
    setFundSector(db, 'BBB', 'prepackaged software');          // → XLK
    insertPosition(db, { ticker: 'BBB', strategy: 'inflection', maxLoss: 100 });
    expect((await gov.checkEntry(CAND, broker)).passed).toBe(true);
  });

  it('does not constrain by sector when the cap is off (default)', async () => {
    const { db, gov } = setup();
    const broker = new MockExecutionBroker();
    await broker.connect();
    gov.start();
    setFundSector(db, 'AAA', 'semiconductors & related devices');
    setFundSector(db, 'BBB', 'prepackaged software');
    insertPosition(db, { ticker: 'BBB', strategy: 'inflection', maxLoss: 100 });
    expect((await gov.checkEntry(CAND, broker)).passed).toBe(true);
  });
});
