import { describe, it, expect } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { EntryPolicy, type PickInput } from '../src/main/execution/entry-policy.js';
import { RiskGovernor } from '../src/main/execution/risk-governor.js';
import { MockExecutionBroker } from '../src/main/execution/mock-execution-broker.js';

const NOW = new Date('2026-06-15T18:00:00Z'); // Mon 14:00 ET — inside the 10:00–15:00 window

function setup() {
  const db: DbHandle = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const broker = new MockExecutionBroker();
  const governor = new RiskGovernor(db);
  const policy = new EntryPolicy(db, governor);
  return { db, broker, governor, policy };
}

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

describe('EntryPolicy.filterPick', () => {
  it('accepts a clean pick', () => {
    const { policy, governor } = setup();
    expect(policy.filterPick(pick(), governor.getConfig(), NOW).accepted).toBe(true);
  });

  const rejects: Array<[string, Partial<PickInput>, string]> = [
    ['ineligible strategy', { strategy: 'wheel' }, 'strategy_not_eligible'],
    ['flag verdict', { criticVerdict: 'flag' }, 'critic_verdict'],
    ['no verdict', { criticVerdict: null }, 'critic_verdict'],
    ['below composite', { compositeScore: 40 }, 'below_min_composite'], // gate is 50 (migration 052)
    ['thin liquidity', { hasAdequateLiquidity: false }, 'inadequate_liquidity'],
    ['earnings before expiry', { earningsBeforeExpiry: true }, 'earnings_before_expiry'],
  ];
  for (const [label, override, reason] of rejects) {
    it(`rejects ${label}`, () => {
      const { policy, governor } = setup();
      expect(policy.filterPick(pick(override), governor.getConfig(), NOW).reason).toBe(reason);
    });
  }

  it('rejects a down-breakout (bear call) inflection pick by default (FR-SEY-3 guard)', () => {
    const { policy, governor } = setup();
    const downPick = pick({ structure: 'short-call-vertical' });
    expect(policy.filterPick(downPick, governor.getConfig(), NOW).reason).toBe('inflection_direction');
  });

  it("accepts a down-breakout pick when inflectionDirection = 'both'", () => {
    const { policy, governor } = setup();
    governor.updateConfig({ inflectionDirection: 'both' });
    const downPick = pick({ structure: 'short-call-vertical' });
    expect(policy.filterPick(downPick, governor.getConfig(), NOW).accepted).toBe(true);
  });

  it('rejects outside the entry window', () => {
    const { policy, governor } = setup();
    const late = new Date('2026-06-15T21:00:00Z'); // 17:00 ET
    expect(policy.filterPick(pick(), governor.getConfig(), late).reason).toBe('outside_entry_window');
  });
});

describe('EntryPolicy.buildProposal', () => {
  it('creates a priced, gated, pending proposal', async () => {
    const { db, broker, governor, policy } = setup();
    await broker.connect();
    governor.start();
    const out = await policy.buildProposal(pick(), broker, NOW);
    expect(out.proposalId).not.toBeNull();
    expect(out.rejected).toBeNull();
    const row = db.prepare('SELECT * FROM exec_proposals WHERE id = ?').get(out.proposalId) as Record<string, unknown>;
    expect(row.status).toBe('pending');
    expect(row.kind).toBe('entry');
    expect(row.contracts).toBe(1);
    expect(row.net_credit).toBeCloseTo(0.1, 5);
    const events = (db.prepare('SELECT event FROM exec_audit_log').all() as Array<{ event: string }>).map((r) => r.event);
    expect(events).toContain('proposal_created');
  });

  it('rejects when sizing exceeds the per-trade cap', async () => {
    const { broker, governor, policy } = setup();
    await broker.connect();
    governor.start();
    const out = await policy.buildProposal(pick({ maxLossPerContract: 600 }), broker, NOW);
    expect(out.proposalId).toBeNull();
    expect(out.rejected).toBe('exceeds_per_trade_risk');
  });

  it('rejects when the gate fails (engine not running)', async () => {
    const { broker, policy } = setup();
    await broker.connect(); // engine left stopped
    const out = await policy.buildProposal(pick(), broker, NOW);
    expect(out.rejected).toBe('engine_running');
  });

  it('rejects a wide-market combo when the liquidity gate is on', async () => {
    const { governor, policy } = setup();
    governor.start();
    governor.updateConfig({ maxComboSpreadPct: 0.2 });
    const wide = new MockExecutionBroker(); // halfSpread 0.05 vs ~0.10 credit → relSpread ~1.0
    await wide.connect();
    const out = await policy.buildProposal(pick(), wide, NOW);
    expect(out.rejected).toBe('wide_market');
  });

  it('passes a tight-market combo with the liquidity gate on', async () => {
    const { governor, policy } = setup();
    governor.start();
    governor.updateConfig({ maxComboSpreadPct: 0.2 });
    const tight = new MockExecutionBroker({ halfSpread: 0.005 }); // relSpread ~0.1
    await tight.connect();
    const out = await policy.buildProposal(pick(), tight, NOW);
    expect(out.proposalId).not.toBeNull();
  });
});

describe('EntryPolicy.generateEntries', () => {
  it('honours the daily cap, highest composite first', async () => {
    const { db, broker, governor, policy } = setup();
    await broker.connect();
    governor.start();
    const outcomes = await policy.generateEntries([pick({ ticker: 'AAA', compositeScore: 80 }), pick({ ticker: 'BBB', compositeScore: 75 })], broker, NOW);
    expect(outcomes[0]!.ticker).toBe('AAA');
    expect(outcomes[0]!.proposalId).not.toBeNull();
    expect(outcomes[1]!.rejected).toBe('daily_cap');
    expect((db.prepare('SELECT COUNT(*) AS n FROM exec_proposals').get() as { n: number }).n).toBe(1);
  });

  it('passes through a filter rejection', async () => {
    const { broker, governor, policy } = setup();
    await broker.connect();
    governor.start();
    const outcomes = await policy.generateEntries([pick({ criticVerdict: 'flag' })], broker, NOW);
    expect(outcomes[0]!.rejected).toBe('critic_verdict');
  });
});

describe('exec_config entry params (migration 046)', () => {
  it('exposes the seeded entry-policy defaults', () => {
    const { governor } = setup();
    const c = governor.getConfig();
    expect(c.minCompositeScore).toBe(50); // lowered 70 -> 50 in migration 052 (backtest-validated)
    expect(c.maxNewEntriesPerDay).toBe(1);
    expect(c.maxNewEntriesPerWeek).toBe(3);
    expect(c.avoidEarningsBeforeExpiry).toBe(true);
    expect(c.entryWindowStart).toBe('10:00');
  });
});
