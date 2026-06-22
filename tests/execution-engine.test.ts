import { describe, it, expect } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { ExecutionEngine } from '../src/main/execution/execution-engine.js';
import { MockExecutionBroker } from '../src/main/execution/mock-execution-broker.js';
import type { PickInput } from '../src/main/execution/entry-policy.js';

const MARKET_OPEN = '2026-06-15T18:00:00Z'; // Mon 14:00 ET (inside entry window)

function pick(overrides: Partial<PickInput> = {}): PickInput {
  return {
    ticker: 'AAA',
    strategy: 'inflection',
    structure: 'short-put-vertical',
    legs: [
      { ticker: 'AAA', right: 'P', action: 'sell', strike: 100, expiry: '2026-07-17', ratio: 1 },
      { ticker: 'AAA', right: 'P', action: 'buy', strike: 95, expiry: '2026-07-17', ratio: 1 },
    ],
    compositeScore: 80,
    criticVerdict: 'pass',
    hasAdequateLiquidity: true,
    earningsBeforeExpiry: false,
    maxLossPerContract: 350,
    sourceBriefId: null,
    ...overrides,
  };
}

function setup() {
  let clock = new Date(MARKET_OPEN);
  const db: DbHandle = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const broker = new MockExecutionBroker();
  const engine = new ExecutionEngine(db, broker, { now: () => clock, watchdogMaxGapMs: 60_000 });
  return { db, broker, engine, setClock: (s: string) => (clock = new Date(s)) };
}

describe('ExecutionEngine', () => {
  it('starts stopped and goes running on startEngine', async () => {
    const { engine } = setup();
    expect(engine.getState().engineState).toBe('stopped');
    const r = await engine.startEngine();
    expect(r.started).toBe(true);
    expect(engine.getState().engineState).toBe('running');
  });

  it('generates a proposal, approves it, and opens a position', async () => {
    const { engine } = setup();
    await engine.startEngine();
    const outcomes = await engine.generateEntries([pick()]);
    expect(outcomes[0]!.proposalId).not.toBeNull();
    expect(engine.getProposals()).toHaveLength(1);

    const proposalId = outcomes[0]!.proposalId!;
    const res = await engine.approveProposal(proposalId);
    expect(res.ok).toBe(true);
    expect(engine.getPositions()).toHaveLength(1);
  });

  it('runs the full loop: open → mark moves → protective stop closes it', async () => {
    const { broker, engine } = setup();
    await engine.startEngine();
    const [out] = await engine.generateEntries([pick()]);
    await engine.approveProposal(out!.proposalId!);
    expect(engine.getPositions()).toHaveLength(1);

    broker.setMark('AAA', 0.35); // loss ≥ 2× credit → protective stop
    await engine.runCycle(); // reconcile syncs the mark, management fires the stop
    expect(engine.getPositions()).toHaveLength(0); // closed
  });

  it('routes approval of a discretionary exit proposal', async () => {
    const { broker, engine } = setup();
    await engine.startEngine();
    const [out] = await engine.generateEntries([pick()]);
    await engine.approveProposal(out!.proposalId!);

    broker.setMark('AAA', 0.04); // ≤ 50% of credit → discretionary profit target
    await engine.runCycle(); // creates an exit proposal (propose mode)
    const exit = engine.getProposals().find((p) => (p as { kind: string }).kind === 'exit') as { id: number } | undefined;
    expect(exit).toBeTruthy();

    const res = await engine.approveProposal(exit!.id);
    expect(res.ok).toBe(true);
    expect(engine.getPositions()).toHaveLength(0);
  });

  it('rejects a pending proposal', async () => {
    const { engine } = setup();
    await engine.startEngine();
    const [out] = await engine.generateEntries([pick()]);
    expect(engine.rejectProposal(out!.proposalId!).ok).toBe(true);
    expect(engine.getProposals()).toHaveLength(0);
  });

  it('exposes config and risk state', async () => {
    const { engine } = setup();
    expect(engine.getConfig().capitalCeiling).toBe(10000);
    engine.updateConfig({ capitalCeiling: 25000 });
    expect(engine.getConfig().capitalCeiling).toBe(25000);
    expect(engine.getRiskState().engineState).toBe('stopped');
  });

  describe('live spread-permission preflight', () => {
    it('paper mode skips the preflight (broker is never probed)', async () => {
      const { db, engine, broker } = setup();
      let probed = false;
      broker.checkSpreadPermission = () => {
        probed = true;
        return Promise.resolve({ ok: true as const, code: 'ok' as const, message: '' });
      };
      const r = await engine.startEngine();
      expect(r.started).toBe(true);
      expect(probed).toBe(false);
      const audit = db.prepare("SELECT event FROM exec_audit_log WHERE event LIKE 'preflight%'").all();
      expect(audit).toHaveLength(0);
    });

    it('live mode refuses to start when the account lacks spread permission', async () => {
      const { db, engine, broker } = setup();
      engine.updateConfig({ executionMode: 'live' });
      broker.checkSpreadPermission = () =>
        Promise.resolve({ ok: false as const, code: 'no_spread_permission' as const, message: 'options level 1' });
      const r = await engine.startEngine();
      expect(r.started).toBe(false);
      expect(r.reason).toBe('spread_permission:no_spread_permission');
      expect(engine.getState().engineState).toBe('stopped');
      const failed = db.prepare("SELECT detail_json FROM exec_audit_log WHERE event = 'preflight_permission_failed'").get() as
        | { detail_json: string }
        | undefined;
      expect(failed).toBeTruthy();
      expect(failed!.detail_json).toContain('no_spread_permission');
    });

    it('live mode starts when the account has spread permission', async () => {
      const { db, engine } = setup(); // MockExecutionBroker grants permission by default
      engine.updateConfig({ executionMode: 'live' });
      const r = await engine.startEngine();
      expect(r.started).toBe(true);
      expect(engine.getState().engineState).toBe('running');
      const ok = db.prepare("SELECT 1 FROM exec_audit_log WHERE event = 'preflight_permission_ok'").get();
      expect(ok).toBeTruthy();
    });
  });
});
