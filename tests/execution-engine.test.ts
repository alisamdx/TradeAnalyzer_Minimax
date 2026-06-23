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

  describe('unattended automation', () => {
    // A minimal valid inflection brief pick (today's date), so the cycle's entry source produces one.
    function seedBrief(db: DbHandle, strategy = 'inflection', ticker = 'AAA'): void {
      const leg = (side: string, action: string, strike: number) => ({
        action, side, strike, expiration: '2026-07-17', delta: null, gamma: null, theta: null, vega: null,
        bid: 1.0, ask: 1.1, mid: 1.05, iv: 30, openInterest: 500, volume: 100, qty: 1,
      });
      const lab = {
        slug: 'short-put-vertical', ticker, expiration: '2026-07-17', dte: 30, underlyingPrice: 100,
        legs: [leg('put', 'sell', 100), leg('put', 'buy', 95)],
        netCredit: 1.0, netDebit: null, maxProfit: 100, maxLoss: -400, breakevens: [99],
        annualizedReturn: 50, popEstimate: 70, currentAtmIv: 30, unavailableReason: null,
      };
      const score = {
        slug: 'short-put-vertical', name: 'spv', category: 'directional', totalScore: 80, grade: 'A',
        ivScore: 20, directionScore: 20, premiumScore: 20, liquidityScore: 12, requiresStock: false,
        complexity: 'moderate', flags: [], aiRationale: null, setup: lab,
      };
      const pick = {
        ticker, compositeScore: 80, signals: {}, strategyLabResult: { context: {}, scores: [score] },
        aiRationale: null, criticVerdict: { verdict: 'pass', confidence: 'high', flags: [], rationale: null, generatedAt: MARKET_OPEN },
        rank: 1, validated: true, price: 100, breakoutDirection: 'up',
      };
      // generated_at = same ET date as MARKET_OPEN (2026-06-15) → passes the freshness gate.
      db.prepare("INSERT INTO daily_briefs (generated_at, valid_until, strategy, picks, run_meta) VALUES (?, ?, ?, ?, '{}')")
        .run('2026-06-15T18:30:00Z', '2026-06-16T13:30:00Z', strategy, JSON.stringify([pick]));
    }

    it('unattended paper: auto-enters from a fresh brief (no pending proposal)', async () => {
      const { db, engine } = setup();
      seedBrief(db);
      engine.updateConfig({ automationMode: 'unattended' }); // paper by default
      await engine.startEngine();
      await engine.runCycle();
      expect(engine.getPositions()).toHaveLength(1);
      expect(engine.getProposals()).toHaveLength(0); // auto-approved
    });

    it('semi mode: the cycle proposes but does not auto-approve', async () => {
      const { db, engine } = setup();
      seedBrief(db);
      // automationMode defaults to 'semi'
      await engine.startEngine();
      await engine.runCycle();
      expect(engine.getProposals()).toHaveLength(1);
      expect(engine.getPositions()).toHaveLength(0);
    });

    it('live + unattended: never auto-enters (paper-only invariant)', async () => {
      const { db, engine } = setup();
      seedBrief(db);
      engine.updateConfig({ automationMode: 'unattended', executionMode: 'live' });
      await engine.startEngine();
      await engine.runCycle();
      expect(engine.getPositions()).toHaveLength(0); // no auto-entry in live
      expect(engine.getProposals()).toHaveLength(1); // proposed, awaiting human approval
    });

    it('dry-run: records a would-be entry, places nothing', async () => {
      const { db, engine } = setup();
      seedBrief(db);
      engine.updateConfig({ automationMode: 'dry_run' });
      await engine.startEngine();
      await engine.runCycle();
      expect(engine.getPositions()).toHaveLength(0);
      expect(engine.getProposals()).toHaveLength(0);
      const dry = engine.getDryRunLog() as Array<{ ticker: string; kind: string }>;
      expect(dry).toHaveLength(1);
      expect(dry[0]!.ticker).toBe('AAA');
      expect(dry[0]!.kind).toBe('entry');
      // No gate_pass audit pollution from the dry-run evaluation.
      expect(db.prepare("SELECT 1 FROM exec_audit_log WHERE event = 'gate_pass'").get()).toBeUndefined();
    });

    it('dry-run dedupes the same would-be entry across cycles', async () => {
      const { db, engine } = setup();
      seedBrief(db);
      engine.updateConfig({ automationMode: 'dry_run' });
      await engine.startEngine();
      await engine.runCycle();
      await engine.runCycle();
      expect(engine.getDryRunLog()).toHaveLength(1);
    });

    it('exposes automationMode + armed in state', async () => {
      const { engine } = setup();
      engine.updateConfig({ automationMode: 'unattended' });
      await engine.startEngine();
      const st = engine.getState();
      expect(st.automationMode).toBe('unattended');
      expect(st.armed).toBe(true); // running + unattended + paper
    });
  });
});
