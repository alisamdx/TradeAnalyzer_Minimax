import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { RiskGovernor } from '../src/main/execution/risk-governor.js';
import { ExitPolicy, daysBetweenDates, type ManagedPositionView } from '../src/main/execution/exit-policy.js';
import type { ExecConfig } from '../src/shared/types.js';

const NOW = new Date('2026-06-15T18:00:00Z');
const FAR = '2026-07-17'; // ~32 DTE

function config(): ExecConfig {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return new RiskGovernor(db).getConfig();
}

function view(o: Partial<ManagedPositionView> = {}): ManagedPositionView {
  return { id: 1, entryNetCredit: 0.1, currentMark: 0.08, openedAt: NOW.toISOString(), expiry: FAR, ...o };
}

describe('daysBetweenDates', () => {
  it('counts calendar days', () => {
    expect(daysBetweenDates('2026-06-15', '2026-06-17')).toBe(2);
  });
});

describe('ExitPolicy.evaluate', () => {
  const cfg = config();
  const policy = new ExitPolicy();

  it('returns null when no rule triggers', () => {
    expect(policy.evaluate(view(), cfg, NOW)).toBeNull();
  });

  it('fires a protective stop at ≥ 2× credit loss', () => {
    expect(policy.evaluate(view({ currentMark: 0.35 }), cfg, NOW)).toEqual({ reason: 'stop', cls: 'protective' });
  });

  it('fires a protective defensive close near expiry', () => {
    expect(policy.evaluate(view({ expiry: '2026-06-16' }), cfg, NOW)).toEqual({ reason: 'defensive', cls: 'protective' });
  });

  it('fires a discretionary profit target at 50% of credit', () => {
    expect(policy.evaluate(view({ currentMark: 0.04 }), cfg, NOW)).toEqual({ reason: 'profit_target', cls: 'discretionary' });
  });

  it('fires a discretionary time stop after hold_days', () => {
    const old = new Date(NOW.getTime() - 6 * 86_400_000).toISOString();
    expect(policy.evaluate(view({ openedAt: old }), cfg, NOW)).toEqual({ reason: 'time_stop', cls: 'discretionary' });
  });

  it('prioritises stop over defensive', () => {
    expect(policy.evaluate(view({ currentMark: 0.35, expiry: '2026-06-16' }), cfg, NOW)?.reason).toBe('stop');
  });

  it('prioritises defensive over profit target', () => {
    expect(policy.evaluate(view({ currentMark: 0.04, expiry: '2026-06-16' }), cfg, NOW)?.reason).toBe('defensive');
  });

  it('skips priced rules when the mark is unknown', () => {
    expect(policy.evaluate(view({ currentMark: null }), cfg, NOW)).toBeNull();
  });
});
