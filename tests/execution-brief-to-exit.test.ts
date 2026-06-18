import { describe, it, expect } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { ExecutionEngine } from '../src/main/execution/execution-engine.js';
import { MockExecutionBroker } from '../src/main/execution/mock-execution-broker.js';
import type { BriefPick, CriticVerdict, SetupLeg, StrategyScore, StrategySetup } from '../src/shared/types.js';

// End-to-end pipeline on the mock broker: a committed inflection brief → entry generation on the
// market cycle (the Phase 6b path) → approve → fill → manage → protective-stop exit. This exercises
// the real ExecutionEngine assembly (brief-entry-source + EntryPolicy + OrderManager + ManagementLoop)
// the way it runs in production, not the direct generateEntries() shortcut the other tests use.

const MARKET_OPEN = '2026-06-15T18:00:00Z'; // Mon 14:00 ET — market open, inside the 10:00–15:00 window

function legOf(side: 'put' | 'call', action: 'buy' | 'sell', strike: number): SetupLeg {
  return {
    action, side, strike, expiration: '2026-07-17',
    delta: null, gamma: null, theta: null, vega: null,
    bid: 1.0, ask: 1.1, mid: 1.05, iv: 30, openInterest: 500, volume: 100, qty: 1,
  };
}

function setupOf(): StrategySetup {
  return {
    slug: 'short-put-vertical', ticker: 'AAA', expiration: '2026-07-17', dte: 32, underlyingPrice: 102,
    legs: [legOf('put', 'sell', 100), legOf('put', 'buy', 95)],
    netCredit: 1.0, netDebit: null, maxProfit: 100, maxLoss: -400, breakevens: [99],
    annualizedReturn: 50, popEstimate: 70, currentAtmIv: 30, unavailableReason: null,
  };
}

function score(): StrategyScore {
  return {
    slug: 'short-put-vertical', name: 'Short Put Vertical', category: 'directional',
    totalScore: 82, grade: 'A', ivScore: 20, directionScore: 22, premiumScore: 22, liquidityScore: 13,
    requiresStock: false, complexity: 'moderate', flags: [], aiRationale: null, setup: setupOf(),
  };
}

function critic(): CriticVerdict {
  return { verdict: 'pass', confidence: 'high', flags: [], rationale: null, generatedAt: MARKET_OPEN };
}

function inflectionPick(): BriefPick {
  return {
    ticker: 'AAA', compositeScore: 80, signals: {},
    strategyLabResult: { context: {} as never, scores: [score()] },
    aiRationale: null, criticVerdict: critic(), rank: 1, validated: true, price: 102, breakoutDirection: 'up',
  };
}

function seedBrief(db: DbHandle, picks: BriefPick[]): void {
  db.prepare(
    "INSERT INTO daily_briefs (generated_at, valid_until, strategy, picks, run_meta) VALUES ('2026-06-15T20:30:00Z', '2026-06-16T13:30:00Z', 'inflection', ?, '{}')"
  ).run(JSON.stringify(picks));
}

function setup() {
  let clock = new Date(MARKET_OPEN);
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const broker = new MockExecutionBroker();
  const engine = new ExecutionEngine(db, broker, { now: () => clock, watchdogMaxGapMs: 60_000 });
  return { db, broker, engine, setClock: (s: string) => (clock = new Date(s)) };
}

describe('brief → entry → fill → exit (mock, full pipeline)', () => {
  it('generates a proposal from a committed brief on the market cycle', async () => {
    const { db, engine } = setup();
    seedBrief(db, [inflectionPick()]);
    await engine.startEngine();

    expect(engine.getProposals()).toHaveLength(0); // nothing until a cycle runs
    await engine.runCycle(); // market-cycle hook: manage (no-op) then generate from the brief

    const proposals = engine.getProposals();
    expect(proposals).toHaveLength(1);
    const p = proposals[0] as { ticker: string; structure: string; kind: string };
    expect(p.ticker).toBe('AAA');
    expect(p.structure).toBe('short-put-vertical');
    expect(p.kind).toBe('entry');
  });

  it('runs the whole loop: brief → proposal → approve → fill → stop-exit', async () => {
    const { db, broker, engine } = setup();
    seedBrief(db, [inflectionPick()]);
    await engine.startEngine();

    // 1) entry generated from the brief on the cycle
    await engine.runCycle();
    const proposalId = (engine.getProposals()[0] as { id: number }).id;

    // 2) semi-auto approval → order → mock fill → open position
    const res = await engine.approveProposal(proposalId);
    expect(res.ok).toBe(true);
    expect(engine.getPositions()).toHaveLength(1);

    // 3) the daily cap prevents a duplicate entry on the next cycle
    await engine.runCycle();
    expect(engine.getPositions()).toHaveLength(1);
    expect(engine.getProposals().filter((p) => (p as { kind: string }).kind === 'entry')).toHaveLength(0);

    // 4) mark moves against us → protective stop auto-closes on the next cycle
    broker.setMark('AAA', 0.35); // loss ≥ 2× the ~0.10 credit
    await engine.runCycle();
    expect(engine.getPositions()).toHaveLength(0);

    // 5) the audit trail records the lifecycle
    const events = (engine.getAudit(200) as Array<{ event: string }>).map((e) => e.event);
    expect(events).toContain('proposal_created');
  });

  it('does not generate entries when the engine is stopped', async () => {
    const { db, engine } = setup();
    seedBrief(db, [inflectionPick()]);
    // never started → runCycle short-circuits as skipped_not_running
    const r = await engine.runCycle();
    expect(r.status).toBe('skipped_not_running');
    expect(engine.getProposals()).toHaveLength(0);
  });
});
