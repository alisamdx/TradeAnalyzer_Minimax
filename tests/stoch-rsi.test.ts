import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeStochRsi, stochRsiSeries, STOCH_RSI } from '../src/main/services/stoch-rsi.js';
import type { Bar } from '../src/shared/types.js';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

// Stochastic RSI 14/14/3/3 — Bec's entry timing, display only (v1.1.358).

const bars = (closes: number[]): Bar[] =>
  closes.map((c, i) => ({ t: Date.UTC(2026, 0, 1) + i * 86_400_000, o: c, h: c, l: c, c, v: 1e6 }));

/**
 * 40 bars of sideways chop, then an accelerating 8-bar sell-off that drives RSI to new lows, so
 * %K and %D both pin at 0. (A regular sawtooth decline does NOT do this: RSI cycles inside its own
 * range and %K sits near 50 — the first fixture here made that mistake.)
 */
function selloff(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 40; i++) out.push(100 + 2 * Math.sin(i / 2));
  for (let i = 1; i <= 8; i++) out.push(out[out.length - 1]! - (0.8 + i * 0.3));
  return out;
}
const then = (base: number[], ...moves: number[]): number[] => {
  const out = [...base];
  for (const m of moves) out.push(out[out.length - 1]! + m);
  return out;
};

describe('stochastic RSI', () => {
  it('is null with too little history, and null rather than invented on a flat RSI window', () => {
    expect(computeStochRsi(bars([100, 101, 102]))).toEqual({ k: null, d: null, state: null });
    // A straight-line rise pins RSI at 100: no position inside a zero range exists.
    const rise = computeStochRsi(bars(Array.from({ length: 60 }, (_, i) => 100 + i)));
    expect(rise).toEqual({ k: null, d: null, state: null });
  });

  it('keeps %K and %D inside 0–100, with %D the 3-bar average of %K', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + 8 * Math.sin(i / 3) + i * 0.1);
    const { k, d } = stochRsiSeries(bars(closes));
    for (let i = 0; i < k.length; i++) {
      if (k[i] != null) expect(k[i]!).toBeGreaterThanOrEqual(0);
      if (k[i] != null) expect(k[i]!).toBeLessThanOrEqual(100);
      if (d[i] != null) {
        const avg = (k[i]! + k[i - 1]! + k[i - 2]!) / 3;
        expect(d[i]!).toBeCloseTo(avg, 9);
      }
    }
    // Needs RSI (15 bars) + the stochastic window (14) + two 3-bar smoothings before %D exists.
    const firstD = d.findIndex(v => v != null);
    expect(firstD).toBe(STOCH_RSI.rsiPeriod + STOCH_RSI.stochPeriod - 1 + STOCH_RSI.kSmooth - 1 + STOCH_RSI.dSmooth - 1);
  });

  it('reads a sell-off that bottoms and bounces as turned_up — her entry', () => {
    // %K leaves a pinned 0/0 for 5.1 over 1.7, then 16.4 over 7.2: a cross out of K = D counts.
    const s = computeStochRsi(bars(then(selloff(), 1.5, 2)));
    expect(s.state).toBe('turned_up');
    expect(s.k!).toBeGreaterThan(s.d!);
  });

  it('reads a sell-off still pinned at the bottom as falling, not as a cross (K = D = 0)', () => {
    const s = computeStochRsi(bars(selloff()));
    expect(s).toEqual({ k: 0, d: 0, state: 'falling' });
  });

  it('reads a bounce that rolls back over as falling — her "do not enter"', () => {
    // Five up days, then three down: %K 72.2 → 65.8 against %D 69.5 → 69.9 (smoothing lags, so a
    // two-day dip is not yet a roll-over).
    const s = computeStochRsi(bars(then(selloff(), 1.5, 2, 2.5, 2, 1, -2, -3, -3)));
    expect(s.state).toBe('falling');
    expect(s.k!).toBeLessThan(s.d!);
  });

  it('walks one wave through the whole cycle: falling → turned up (3 bars) → rising → falling', () => {
    // A rising trend with a regular wave on top. Measured %K per bar count: 7 at N=61 (falling),
    // the cross up at 62, the turn held for turnBars = 3, then plain rising until it rolls over at 70.
    const wave = (n: number) => computeStochRsi(bars(Array.from({ length: n }, (_, i) => 100 + i * 0.8 + 3 * Math.sin(i / 2)))).state;
    expect(wave(61)).toBe('falling');
    for (const n of [62, 63, 64]) expect(wave(n)).toBe('turned_up');
    for (const n of [65, 66, 67, 68, 69]) expect(wave(n)).toBe('rising');
    expect(wave(70)).toBe('falling');
  });
});

describe('migration 094', () => {
  it('adds the three columns and refuses an unknown state', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const ins = db.prepare(
      `INSERT INTO technical_signals (ticker, stoch_rsi_k, stoch_rsi_d, stoch_rsi_state) VALUES (?, 12.5, 9.1, ?)`,
    );
    expect(() => ins.run('A', 'turned_up')).not.toThrow();
    expect(() => ins.run('B', null)).not.toThrow();
    expect(() => ins.run('C', 'sideways')).toThrow(/CHECK/);
  });
});

// "Display only" is a claim; make it a checked one. These are the files that score, rank, gate or
// brief the critic. Comments are stripped (CLAUDE.md: a source scan must not fire on its own docs);
// strings are KEPT, because reading the column from SQL is exactly the reach this guard is for.
describe('Stochastic RSI stays display-only', () => {
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const decisionPaths = [
    'src/main/services/scoring-service.ts',
    'src/main/services/critic-service.ts',
    'src/main/services/roll-the-dice.ts',
    'src/shared/brief-ranking.ts',
  ];
  const reach = /stoch_?rsi/i;

  it.each(decisionPaths)('%s never reads it', (path) => {
    expect(reach.test(stripComments(readFileSync(resolve(path), 'utf8')))).toBe(false);
  });

  it('the scan fires on code and not on a comment (both directions, so it cannot go vacuous)', () => {
    expect(reach.test(stripComments('const x = pick.stochRsi?.k;'))).toBe(true);
    expect(reach.test(stripComments("db.prepare('SELECT stoch_rsi_k FROM technical_signals')"))).toBe(true);
    expect(reach.test(stripComments('// stochRsi is display only\nconst y = 1;'))).toBe(false);
  });
});
