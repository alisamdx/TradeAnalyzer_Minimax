// Brief Replay income/wheel picks settled on REAL premium (v1.1.337).
//
// The replay scored income/wheel on a proxy — a strike at 0.85 x entry never touched in 21
// sessions, no premium — which agreed with real outcomes only ~77% of the time on 2026-10-01 and
// overstated "kept". Where options_premium_history recorded the CSP the app recommended that day,
// the pick is now settled on it at expiry; the rest stay 'proxy' and are reported separately.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { BriefReplayService } from '../src/main/services/brief-replay-service.js';
import { ScoringService } from '../src/main/services/scoring-service.js';

let db: DbHandle;
let svc: BriefReplayService;

function day(i: number): string {
  return new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10);
}

function bars(ticker: string, closes: readonly number[]): void {
  const stmt = db.prepare(
    `INSERT INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, 1000)`
  );
  closes.forEach((c, i) => stmt.run(ticker, day(i), c, c, c, c));
}

function brief(strategy: string, asOf: string, tickers: string[]): void {
  const id = db.prepare(
    `INSERT INTO replay_briefs (as_of_date, strategy, picks, config_version) VALUES (?, ?, '[]', 'baseline_v3')`
  ).run(asOf, strategy).lastInsertRowid as number;
  const stmt = db.prepare(
    `INSERT INTO replay_outcomes (replay_brief_id, ticker, rank, composite_score, entry_price, stayed_above_strike)
     VALUES (?, ?, ?, 60, 100, 1)`
  );
  tickers.forEach((t, i) => stmt.run(id, t, i + 1));
}

function csp(strategy: string, asOf: string, ticker: string, expiration: string, strike: number, premium: number, lastPrice = 100): void {
  db.prepare(
    `INSERT INTO options_premium_history
       (as_of_date, ticker, strategy, structure, last_price, strike, expiration, dte, premium)
     VALUES (?, ?, ?, 'CSP', ?, ?, ?, 30, ?)`
  ).run(asOf, ticker, strategy, lastPrice, strike, expiration, premium);
}

const pick = (ticker: string, strategy = 'wheel') =>
  svc.getPickRows(strategy).find(p => p.ticker === ticker)!;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  svc = new BriefReplayService(db, new ScoringService(db));
});

describe('Brief Replay real-premium outcome', () => {
  it('settles a pick on the recorded CSP: kept premium when it expires out of the money', () => {
    bars('KEEP', Array(40).fill(100));
    brief('wheel', day(0), ['KEEP']);
    csp('wheel', day(0), 'KEEP', day(30), 95, 2);
    svc.settleRealOutcomes();
    const p = pick('KEEP');
    expect(p.outcomeSource).toBe('real');
    expect(p.realAssigned).toBe(false);
    expect(p.realRocPct).toBeCloseTo((2 / 95) * 100, 10);
  });

  it('marks an assignment the proxy called "kept" — the case the proxy gets wrong', () => {
    // Never dips 15 %, closes 7 % down at expiry: proxy kept, real put assigned.
    bars('SLIDE', [...Array(25).fill(100), ...Array(15).fill(93)]);
    brief('income', day(0), ['SLIDE']);
    csp('income', day(0), 'SLIDE', day(30), 95, 1);
    svc.settleRealOutcomes();
    const p = pick('SLIDE', 'income');
    expect(p.stayedAboveStrike).toBe(true);
    expect(p.realAssigned).toBe(true);
    expect(p.realRocPct).toBeCloseTo(((1 - 2) / 95) * 100, 10);
  });

  it('keeps the proxy, labelled, when no CSP was recorded for that date', () => {
    bars('OLD', Array(40).fill(100));
    brief('wheel', day(0), ['OLD']);
    svc.settleRealOutcomes();
    const p = pick('OLD');
    expect(p.outcomeSource).toBe('proxy');
    expect(p.realRocPct).toBeNull();
    expect(p.realSkipReason).toBeNull();
  });

  it('waits for an unexpired put, then settles it on a later evaluation', () => {
    bars('LATER', Array(20).fill(100));
    brief('wheel', day(0), ['LATER']);
    csp('wheel', day(0), 'LATER', day(30), 95, 2);
    svc.settleRealOutcomes();
    expect(pick('LATER')).toMatchObject({ outcomeSource: 'proxy', realSkipReason: 'not_expired' });

    // Prices arrive through expiry; the next summary load settles it.
    const stmt = db.prepare(`INSERT INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES ('LATER', ?, 100,100,100,100,1)`);
    for (let i = 20; i < 35; i++) stmt.run(day(i));
    svc.settleRealOutcomes();
    expect(pick('LATER')).toMatchObject({ outcomeSource: 'real', realAssigned: false, realSkipReason: null });
  });

  it('refuses to settle across a split and says why', () => {
    bars('SPLIT', Array(40).fill(100));
    brief('wheel', day(0), ['SPLIT']);
    csp('wheel', day(0), 'SPLIT', day(30), 380, 8, 400);
    svc.settleRealOutcomes();
    expect(pick('SPLIT')).toMatchObject({ outcomeSource: 'proxy', realSkipReason: 'scale_mismatch_entry', realRocPct: null });
  });

  it('matches the strategy: a wheel CSP does not settle an income pick', () => {
    bars('MIX', Array(40).fill(100));
    brief('income', day(0), ['MIX']);
    csp('wheel', day(0), 'MIX', day(30), 95, 2);
    svc.settleRealOutcomes();
    expect(pick('MIX', 'income').outcomeSource).toBe('proxy');
  });

  it('leaves non-premium strategies alone', () => {
    bars('BUY', Array(40).fill(100));
    brief('buy', day(0), ['BUY']);
    csp('wheel', day(0), 'BUY', day(30), 95, 2);
    svc.settleRealOutcomes();
    expect(pick('BUY', 'buy').outcomeSource).toBeNull();
    expect(svc.getSummaries().find(s => s.strategy === 'buy')!.real).toBeNull();
  });

  it('summarises real and proxy-only picks separately, never blended', () => {
    bars('W1', Array(40).fill(100));
    bars('W2', [...Array(25).fill(100), ...Array(15).fill(90)]);
    bars('W3', Array(40).fill(100));
    brief('wheel', day(0), ['W1', 'W2', 'W3']);
    csp('wheel', day(0), 'W1', day(30), 95, 2);  // kept: +2/95
    csp('wheel', day(0), 'W2', day(30), 95, 2);  // assigned: (2-5)/95
    // W3 has no CSP → proxy only
    svc.settleRealOutcomes();
    const real = svc.getSummaries().find(s => s.strategy === 'wheel')!.real!;
    expect(real.n).toBe(2);
    expect(real.assignedRate).toBe(50);
    expect(real.avgRocPct).toBeCloseTo(((2 / 95 + -3 / 95) / 2) * 100, 2);
    expect(real.proxyOnlyN).toBe(1);
    expect(real.proxyOnlyKeptRate).toBe(100);
  });

  it('a real outcome is final: later evaluations do not revisit it', () => {
    bars('FIN', Array(40).fill(100));
    brief('wheel', day(0), ['FIN']);
    csp('wheel', day(0), 'FIN', day(30), 95, 2);
    svc.settleRealOutcomes();
    db.prepare(`UPDATE options_premium_history SET premium = 9 WHERE ticker = 'FIN'`).run();
    svc.settleRealOutcomes();
    expect(pick('FIN').realPremium).toBe(2);
  });
});
