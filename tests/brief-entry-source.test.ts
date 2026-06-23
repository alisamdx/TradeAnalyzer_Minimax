import { describe, it, expect } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import {
  briefPickToPickInput,
  setupLegToLegSpec,
  loadInflectionPickInputs,
  loadBriefPickInputs,
} from '../src/main/execution/brief-entry-source.js';
import type {
  BriefPick,
  CriticVerdict,
  SetupLeg,
  StrategyScore,
  StrategySetup,
} from '../src/shared/types.js';

// Phase 6b: the brief → PickInput entry source. Pins the mapping of an inflection brief pick
// (Strategy Lab structure) onto the normalized PickInput the EntryPolicy consumes.

const NOW = new Date('2026-06-15T18:00:00Z'); // Mon

function leg(side: 'put' | 'call', action: 'buy' | 'sell', strike: number, over: Partial<SetupLeg> = {}): SetupLeg {
  return {
    action, side, strike,
    expiration: '2026-07-17',
    delta: null, gamma: null, theta: null, vega: null,
    bid: 1.0, ask: 1.1, mid: 1.05, iv: 30,
    openInterest: 500, volume: 100, qty: 1,
    ...over,
  };
}

function setup(over: Partial<StrategySetup> = {}, legs?: SetupLeg[]): StrategySetup {
  return {
    slug: 'short-put-vertical', ticker: 'AAA', expiration: '2026-07-17', dte: 30, underlyingPrice: 100,
    legs: legs ?? [leg('put', 'sell', 100), leg('put', 'buy', 95)],
    netCredit: 1.0, netDebit: null, maxProfit: 100, maxLoss: -400, breakevens: [99],
    annualizedReturn: 50, popEstimate: 70, currentAtmIv: 30, unavailableReason: null,
    ...over,
  };
}

function score(slug: string, setupOver: Partial<StrategySetup> = {}, over: Partial<StrategyScore> = {}, legs?: SetupLeg[]): StrategyScore {
  return {
    slug, name: slug, category: 'directional', totalScore: 80, grade: 'A',
    ivScore: 20, directionScore: 20, premiumScore: 20, liquidityScore: 12,
    requiresStock: false, complexity: 'moderate', flags: [], aiRationale: null,
    setup: setup({ slug, ...setupOver }, legs),
    ...over,
  };
}

function critic(verdict: 'pass' | 'caution' | 'flag'): CriticVerdict {
  return { verdict, confidence: 'high', flags: [], rationale: null, generatedAt: NOW.toISOString() };
}

function briefPick(over: Partial<BriefPick> = {}, scores?: StrategyScore[]): BriefPick {
  return {
    ticker: 'AAA', compositeScore: 80, signals: {},
    strategyLabResult: { context: {} as never, scores: scores ?? [score('short-put-vertical')] },
    aiRationale: null, criticVerdict: critic('pass'), rank: 1, validated: true, price: 100,
    breakoutDirection: 'up',
    ...over,
  };
}

describe('setupLegToLegSpec', () => {
  it('maps side/action/strike/expiry/ratio', () => {
    const spec = setupLegToLegSpec('AAA', leg('call', 'sell', 105, { qty: 2, expiration: '2026-07-17T00:00:00Z' }));
    expect(spec).toEqual({ ticker: 'AAA', right: 'C', action: 'sell', strike: 105, expiry: '2026-07-17', ratio: 2 });
  });
});

describe('briefPickToPickInput', () => {
  it('maps an up-breakout pick to a short-put-vertical PickInput', () => {
    const p = briefPickToPickInput(briefPick(), 'inflection', 42);
    expect(p).not.toBeNull();
    expect(p!.ticker).toBe('AAA');
    expect(p!.strategy).toBe('inflection');
    expect(p!.structure).toBe('short-put-vertical');
    expect(p!.legs).toHaveLength(2);
    expect(p!.legs[0]).toEqual({ ticker: 'AAA', right: 'P', action: 'sell', strike: 100, expiry: '2026-07-17', ratio: 1 });
    expect(p!.compositeScore).toBe(80);
    expect(p!.criticVerdict).toBe('pass');
    expect(p!.hasAdequateLiquidity).toBe(true);
    expect(p!.earningsBeforeExpiry).toBe(false);
    expect(p!.maxLossPerContract).toBe(400); // abs of -400
    expect(p!.sourceBriefId).toBe(42);
  });

  it('locks a down-breakout to the short-call-vertical', () => {
    const scores = [score('short-call-vertical', {}, {}, [leg('call', 'sell', 100), leg('call', 'buy', 105)])];
    const p = briefPickToPickInput(briefPick({ breakoutDirection: 'down' }, scores), 'inflection', null);
    expect(p!.structure).toBe('short-call-vertical');
    expect(p!.legs.map((l) => l.right)).toEqual(['C', 'C']);
  });

  it('maps the critic verdict (pass/caution/flag/null)', () => {
    expect(briefPickToPickInput(briefPick({ criticVerdict: critic('caution') }), 'inflection', null)!.criticVerdict).toBe('caution');
    expect(briefPickToPickInput(briefPick({ criticVerdict: critic('flag') }), 'inflection', null)!.criticVerdict).toBe('flag');
    expect(briefPickToPickInput(briefPick({ criticVerdict: null }), 'inflection', null)!.criticVerdict).toBeNull();
  });

  it('flags earnings before expiry when an earnings date falls on/before the expiry', () => {
    expect(briefPickToPickInput(briefPick(), 'inflection', null,{ nextEarningsDate: '2026-07-10' })!.earningsBeforeExpiry).toBe(true);
    expect(briefPickToPickInput(briefPick(), 'inflection', null,{ nextEarningsDate: '2026-08-01' })!.earningsBeforeExpiry).toBe(false);
  });

  it('marks liquidity inadequate on a low lab liquidityScore', () => {
    const scores = [score('short-put-vertical', {}, { liquidityScore: 4 })];
    expect(briefPickToPickInput(briefPick({}, scores), 'inflection', null)!.hasAdequateLiquidity).toBe(false);
  });

  it('marks liquidity inadequate when a leg has no two-sided quote', () => {
    const scores = [score('short-put-vertical', {}, {}, [leg('put', 'sell', 100, { bid: 0 }), leg('put', 'buy', 95)])];
    expect(briefPickToPickInput(briefPick({}, scores), 'inflection', null)!.hasAdequateLiquidity).toBe(false);
  });

  it('returns null when the setup is unavailable', () => {
    const scores = [score('short-put-vertical', { unavailableReason: 'no chain' })];
    expect(briefPickToPickInput(briefPick({}, scores), 'inflection', null)).toBeNull();
  });

  it('returns null when max loss is unbounded/absent', () => {
    const scores = [score('short-put-vertical', { maxLoss: null })];
    expect(briefPickToPickInput(briefPick({}, scores), 'inflection', null)).toBeNull();
  });

  it('returns null when there is no inflection structure in the scores', () => {
    const scores = [score('iron-condor')];
    expect(briefPickToPickInput(briefPick({}, scores), 'inflection', null)).toBeNull();
  });

  it('maps a wheel pick to the defined-risk short-put-vertical', () => {
    // A wheel pick carries a short-put-vertical in its lab result; trade it as a put credit spread.
    const p = briefPickToPickInput(briefPick({ breakoutDirection: undefined }), 'wheel', 7);
    expect(p).not.toBeNull();
    expect(p!.strategy).toBe('wheel');
    expect(p!.structure).toBe('short-put-vertical');
    expect(p!.legs.map((l) => l.right)).toEqual(['P', 'P']);
    expect(p!.maxLossPerContract).toBe(400);
  });

  it('returns null for a wheel pick with no short-put-vertical setup', () => {
    const scores = [score('short-naked-put')]; // wheel's native structure, not a spread
    expect(briefPickToPickInput(briefPick({}, scores), 'wheel', null)).toBeNull();
  });

  it('maps an income pick to a 4-leg iron condor', () => {
    const icLegs = [
      leg('put', 'sell', 95), leg('put', 'buy', 90),
      leg('call', 'sell', 110), leg('call', 'buy', 115),
    ];
    const scores = [score('iron-condor', { maxLoss: -450 }, {}, icLegs)];
    const p = briefPickToPickInput(briefPick({}, scores), 'income', 9);
    expect(p).not.toBeNull();
    expect(p!.strategy).toBe('income');
    expect(p!.structure).toBe('iron-condor');
    expect(p!.legs).toHaveLength(4);
    expect(p!.legs.map((l) => `${l.action}${l.right}`)).toEqual(['sellP', 'buyP', 'sellC', 'buyC']);
    expect(p!.maxLossPerContract).toBe(450);
  });

  it('returns null for an income pick with no iron-condor setup', () => {
    const scores = [score('short-strangle')]; // undefined-risk; not what the engine trades
    expect(briefPickToPickInput(briefPick({}, scores), 'income', null)).toBeNull();
  });
});

describe('loadInflectionPickInputs', () => {
  function db(): DbHandle {
    const d = openDatabase(':memory:');
    runMigrations(d, MIGRATIONS_DIR);
    return d;
  }

  function insertBrief(d: DbHandle, picks: BriefPick[], generatedAt = '2026-06-15T20:30:00Z'): number {
    const info = d
      .prepare("INSERT INTO daily_briefs (generated_at, valid_until, strategy, picks, run_meta) VALUES (?, ?, 'inflection', ?, '{}')")
      .run(generatedAt, '2026-06-16T13:30:00Z', JSON.stringify(picks));
    return Number(info.lastInsertRowid);
  }

  it('returns empty when there is no inflection brief', () => {
    expect(loadInflectionPickInputs(db(), NOW)).toEqual({ briefId: null, picks: [] });
  });

  it('maps the latest brief and stamps its id as sourceBriefId', () => {
    const d = db();
    insertBrief(d, [briefPick()], '2026-06-14T20:30:00Z'); // older
    const newId = insertBrief(d, [briefPick({ ticker: 'BBB' })], '2026-06-15T20:30:00Z'); // latest
    const { briefId, picks } = loadInflectionPickInputs(d, NOW);
    expect(briefId).toBe(newId);
    expect(picks).toHaveLength(1);
    expect(picks[0]!.ticker).toBe('BBB');
    expect(picks[0]!.sourceBriefId).toBe(newId);
  });

  it('resolves earnings-before-expiry from earnings_calendar', () => {
    const d = db();
    d.prepare("INSERT INTO earnings_calendar (ticker, report_date, source) VALUES ('AAA', '2026-07-01', 'etrade')").run();
    insertBrief(d, [briefPick()]);
    expect(loadInflectionPickInputs(d, NOW).picks[0]!.earningsBeforeExpiry).toBe(true);
  });

  it('skips picks with no viable defined-risk structure', () => {
    const d = db();
    insertBrief(d, [briefPick({}, [score('short-put-vertical', { unavailableReason: 'no chain' })]), briefPick({ ticker: 'CCC' })]);
    const { picks } = loadInflectionPickInputs(d, NOW);
    expect(picks.map((p) => p.ticker)).toEqual(['CCC']);
  });

  it('returns the brief id but no picks when picks JSON is malformed', () => {
    const d = db();
    const id = Number(
      d.prepare("INSERT INTO daily_briefs (generated_at, valid_until, strategy, picks, run_meta) VALUES ('2026-06-15T20:30:00Z', '2026-06-16T13:30:00Z', 'inflection', 'not json', '{}')").run().lastInsertRowid
    );
    expect(loadInflectionPickInputs(d, NOW)).toEqual({ briefId: id, picks: [] });
  });
});

describe('loadBriefPickInputs (multi-strategy)', () => {
  function db(): DbHandle {
    const d = openDatabase(':memory:');
    runMigrations(d, MIGRATIONS_DIR);
    return d;
  }
  function insert(d: DbHandle, strategy: string, picks: BriefPick[]): number {
    return Number(
      d.prepare("INSERT INTO daily_briefs (generated_at, valid_until, strategy, picks, run_meta) VALUES ('2026-06-15T20:30:00Z', '2026-06-16T13:30:00Z', ?, ?, '{}')")
        .run(strategy, JSON.stringify(picks)).lastInsertRowid
    );
  }

  it('pulls picks from every eligible strategy, tagging each with its strategy', () => {
    const d = db();
    insert(d, 'inflection', [briefPick({ ticker: 'INF' })]);
    insert(d, 'wheel', [briefPick({ ticker: 'WHL', breakoutDirection: undefined })]);
    const { picks } = loadBriefPickInputs(d, ['inflection', 'wheel'], NOW);
    const byTicker = Object.fromEntries(picks.map((p) => [p.ticker, p.strategy]));
    expect(byTicker).toEqual({ INF: 'inflection', WHL: 'wheel' });
    expect(picks.every((p) => p.structure === 'short-put-vertical')).toBe(true);
  });

  it('only loads the requested strategies (inflection-only = today default)', () => {
    const d = db();
    insert(d, 'inflection', [briefPick({ ticker: 'INF' })]);
    insert(d, 'wheel', [briefPick({ ticker: 'WHL', breakoutDirection: undefined })]);
    const { picks } = loadBriefPickInputs(d, ['inflection'], NOW);
    expect(picks.map((p) => p.ticker)).toEqual(['INF']);
  });

  it('freshness gate (requireToday): skips a prior-day brief, keeps today\'s', () => {
    const d = db();
    // A prior-day brief (generated 2026-06-12, ET date != NOW's 2026-06-15).
    d.prepare("INSERT INTO daily_briefs (generated_at, valid_until, strategy, picks, run_meta) VALUES ('2026-06-12T20:30:00Z', '2026-06-13T13:30:00Z', 'inflection', ?, '{}')")
      .run(JSON.stringify([briefPick({ ticker: 'OLD' })]));
    expect(loadBriefPickInputs(d, ['inflection'], NOW, true).picks).toHaveLength(0);
    // requireToday=false still returns the latest regardless of date.
    expect(loadBriefPickInputs(d, ['inflection'], NOW, false).picks.map((p) => p.ticker)).toEqual(['OLD']);
    // Today's brief (generated 2026-06-15) is now the latest → the gate lets it through.
    insert(d, 'inflection', [briefPick({ ticker: 'NEW' })]);
    expect(loadBriefPickInputs(d, ['inflection'], NOW, true).picks.map((p) => p.ticker)).toEqual(['NEW']);
  });
});
