// The Spread Shadow view's data path (v1.1.295): IPC channel → preload bridge → routed view.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); } },
}));

const { registerSpreadModeIpc } = await import('../src/main/ipc/ipc-spread-mode.js');

describe('spread-mode:shadow-report', () => {
  it('returns the shadow report as an IpcResult', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    db.prepare(
      `INSERT INTO spread_mode_picks (as_of_date, slot, generated_at, mode, ticker, outcome, rank, expiration, dte, spot,
         short_strike, long_strike, net_credit, max_loss) VALUES ('2026-09-14', 'intraday', 'x', 'shadow', 'EOG', 'pick', 1, '2099-10-16', 30, 150, 145, 135, 2.15, 7.85)`,
    ).run();
    registerSpreadModeIpc(db);
    const r = handlers.get('spread-mode:shadow-report')!() as { ok: boolean; value: { counts: { positions: number }; positions: Array<{ ticker: string }> } };
    expect(r.ok).toBe(true);
    expect(r.value.counts.positions).toBe(1);
    expect(r.value.positions[0]!.ticker).toBe('EOG');
    // Must survive structured clone across the IPC boundary: plain data only.
    expect(() => structuredClone(r.value)).not.toThrow();
  });

  it('reports a failure instead of throwing', () => {
    registerSpreadModeIpc(openDatabase(':memory:')); // no migrations → the query fails
    const r = handlers.get('spread-mode:shadow-report')!() as { ok: boolean; error?: { code: string } };
    expect(r).toMatchObject({ ok: false, error: { code: 'SPREAD_MODE_ERROR' } });
  });
});

describe('spread-mode settings over IPC (v1.1.296)', () => {
  it('round-trips through the service, returning what was STORED', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    registerSpreadModeIpc(db);
    const set = handlers.get('spread-mode:set-settings')!;
    const saved = set({}, { mode: 'shadow', maxLossPerPosition: 3000, maxOpenPositions: 6, maxOpenPerSector: 9 }) as
      { ok: boolean; value: { maxOpenPerSector: number; maxLossPerPosition: number } };
    expect(saved.ok).toBe(true);
    expect(saved.value).toMatchObject({ maxLossPerPosition: 3000, maxOpenPositions: 6, maxOpenPerSector: 6 });
    const got = handlers.get('spread-mode:get-settings')!() as { value: unknown };
    expect(got.value).toEqual(saved.value);
  });
});

describe('the view is reachable', () => {
  it('is bridged in preload and routed in the sidebar', () => {
    const preload = readFileSync(resolve('src/preload/index.ts'), 'utf8');
    expect(preload).toContain("invoke<SpreadShadowReport>('spread-mode:shadow-report')");
    expect(preload).toContain("invoke<SpreadModeSettings>('spread-mode:set-settings', next)");
    const settingsView = readFileSync(resolve('src/renderer/src/views/SettingsView.tsx'), 'utf8');
    expect(settingsView).toContain("setActiveTab('Strategies')");
    expect(settingsView).toContain('window.api.spreadMode.setSettings');
    expect(preload).toMatch(/briefReplay, spreadMode, execution/);
    const app = readFileSync(resolve('src/renderer/src/App.tsx'), 'utf8');
    expect(app).toContain("case 'spreadShadow': return <SpreadShadowView />;");
    expect(app).toContain("navigateSidebar('spreadShadow')");
    const main = readFileSync(resolve('src/main/index.ts'), 'utf8');
    expect(main).toContain('registerSpreadModeIpc(db);');
  });

  it('scrolls: `.main` clips a view that does not scroll itself (v1.1.298)', () => {
    const css = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8');
    expect(css).toMatch(/\.view-scroll\s*\{[^}]*overflow-y:\s*auto[^}]*\}/);
    expect(css).toMatch(/\.view-scroll\s*\{[^}]*min-height:\s*0[^}]*\}/); // or overflow-y never engages
    expect(readFileSync(resolve('src/renderer/src/views/SpreadShadowView.tsx'), 'utf8')).toContain('className="view-scroll"');
  });
});
