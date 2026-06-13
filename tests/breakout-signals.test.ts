// Regression tests for the breakout/continuation signal (Inflection strategy, v0.32.98).
// Fresh 20-day high/low break, gated to with-trend; emits state/level/decisiveness/
// volume-surge/ATR%. Also asserts migration 041 columns exist.

import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { computeBreakout } from '../src/main/services/jobs/daily-technical-signals-job.js';
import type { Bar } from '../src/shared/types.js';

// Build a flat base of `n` bars at `price`, then append custom bars.
function bars(base: number, n: number, ...tail: Array<Partial<Bar> & { c: number }>): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) out.push({ t: i, o: base, h: base * 1.005, l: base * 0.995, c: base, v: 1_000_000 });
  for (const b of tail) out.push({ t: out.length, o: b.o ?? b.c, h: b.h ?? b.c, l: b.l ?? b.c, c: b.c, v: b.v ?? 1_000_000 });
  return out;
}

describe('computeBreakout', () => {
  it('flags a fresh 20-day high breakout in an uptrend', () => {
    // 40 bars at 100 (prior-20 high ≈ 100.5), then a decisive close at 108 on 3x volume.
    const b = bars(100, 40, { c: 108, h: 108, l: 101, v: 3_000_000 });
    const sma50 = 100; // close 108 > sma50 → with-trend
    const r = computeBreakout(b, sma50);
    expect(r.breakoutState).toBe(1);
    expect(r.breakoutLevel).toBeGreaterThan(99);
    expect(r.breakoutDecisiveness!).toBeGreaterThan(0);
    expect(r.volumeSurge!).toBeGreaterThan(2);   // ~3x the 20d avg
    expect(r.atrPct!).toBeGreaterThan(0);
  });

  it('flags a fresh 20-day low breakdown in a downtrend', () => {
    const b = bars(100, 40, { c: 92, h: 99, l: 92, v: 2_500_000 });
    const sma50 = 100; // close 92 < sma50 → with-trend (down)
    const r = computeBreakout(b, sma50);
    expect(r.breakoutState).toBe(-1);
    expect(r.breakoutLevel!).toBeLessThan(101);
  });

  it('does NOT flag a breakout that fights the trend (up break below SMA50)', () => {
    const b = bars(100, 40, { c: 108, h: 108, l: 101, v: 3_000_000 });
    const sma50 = 120; // close 108 < sma50 → not a with-trend up breakout
    expect(computeBreakout(b, sma50).breakoutState).toBe(0);
  });

  it('returns state 0 when price stays inside the 20-day range', () => {
    const b = bars(100, 41); // flat — no break
    expect(computeBreakout(b, 100).breakoutState).toBe(0);
  });

  it('returns neutral when there is insufficient history', () => {
    expect(computeBreakout(bars(100, 10), 100).breakoutState).toBe(0);
  });
});

describe('migration 041 — technical_signals breakout columns', () => {
  it('adds the breakout columns', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const cols = (db.prepare(`PRAGMA table_info(technical_signals)`).all() as { name: string }[]).map(c => c.name);
    for (const c of ['breakout_state', 'breakout_level', 'breakout_decisiveness', 'volume_surge', 'atr_pct']) {
      expect(cols).toContain(c);
    }
    db.close();
  });
});
