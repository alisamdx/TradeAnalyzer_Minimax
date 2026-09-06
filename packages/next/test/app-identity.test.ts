import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The two exes must stay strangers on disk — 06 §3.
 *
 * Both are installed and running at the same time all through stage 1, so a
 * shared `userData` directory would put this app's settings, logs and window
 * state on top of the daily driver's. The default userData name is derived from
 * `productName`, which is "TradeAnalyzer 2" — close enough to the existing
 * "TradeAnalyzer" that a later rename could silently collide. So the separation
 * is asserted here rather than left to a default.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('app identity', () => {
  const pkg = JSON.parse(read('../package.json')) as {
    version: string;
    build: { appId: string; productName: string };
  };

  it('uses an appId distinct from the existing app', () => {
    expect(pkg.build.appId).toBe('com.tradeanalyzer.next');
    expect(pkg.build.appId).not.toBe('com.tradeanalyzer.app');
  });

  it('ships as "TradeAnalyzer 2"', () => {
    expect(pkg.build.productName).toBe('TradeAnalyzer 2');
  });

  it('stays on the 0.x line until pilot exit (06 §6)', () => {
    expect(pkg.version).toMatch(/^0\./);
  });

  it('overrides userData to trade-analyzer-next, not the productName default', () => {
    const main = read('../src/main/index.ts');
    expect(main).toMatch(/app\.setPath\(\s*'userData'/);
    expect(main).toContain("'trade-analyzer-next'");
    // The existing app's directory must never appear in this package.
    expect(main).not.toMatch(/'trade-analyzer'/);
  });

  it('pins Electron to the same range as the root, and to the version actually installed', () => {
    // 06 §4: one `electron` copy for the whole workspace, so the existing
    // ABI-swap script still governs both apps. Two things can break that and
    // neither is loud: a different RANGE here (npm would install a second copy,
    // rebuilt for the wrong runtime silently — the failure CLAUDE.md warns
    // about), or an `electronVersion` in the build config that has drifted from
    // what is installed (electron-builder would package a runtime the native
    // modules were not built against).
    const rootPkg = JSON.parse(read('../../../package.json')) as {
      devDependencies: Record<string, string>;
    };
    const nextPkg = JSON.parse(read('../package.json')) as {
      devDependencies: Record<string, string>;
      build: { electronVersion: string };
    };
    const installed = (
      JSON.parse(read('../../../node_modules/electron/package.json')) as { version: string }
    ).version;

    expect(nextPkg.devDependencies['electron']).toBe(rootPkg.devDependencies['electron']);
    expect(nextPkg.build.electronVersion).toBe(installed);
  });

  it('keeps the renderer context-isolated with node integration off', () => {
    const main = read('../src/main/index.ts');
    expect(main).toMatch(/contextIsolation:\s*true/);
    expect(main).toMatch(/nodeIntegration:\s*false/);
  });

  it('ships a multi-size icon that electron-builder will actually find', () => {
    // Windows picks a different frame out of the .ico for the taskbar (16/24),
    // the alt-tab switcher (32/48) and the desktop (256). An .ico holding one
    // large frame is legal, builds without a murmur, and looks blurred at every
    // size that matters — so the frame list is asserted rather than assumed.
    const nextPkg = JSON.parse(read('../package.json')) as { build: { win: { icon: string } } };
    expect(nextPkg.build.win.icon).toBe('build/icon.ico');

    const icoPath = fileURLToPath(new URL('../build/icon.ico', import.meta.url));
    expect(existsSync(icoPath)).toBe(true);

    const raw = readFileSync(icoPath);
    expect(raw.readUInt16LE(0)).toBe(0); // reserved
    expect(raw.readUInt16LE(2)).toBe(1); // type 1 = icon
    const count = raw.readUInt16LE(4);

    const frames: number[] = [];
    const offsets = new Set<number>();
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      frames.push(raw[entry] === 0 ? 256 : raw[entry]!); // 0 encodes 256
      offsets.add(raw.readUInt32LE(entry + 12));
    }
    expect(frames).toEqual([16, 24, 32, 48, 64, 128, 256]);
    // Distinct payload offsets: each size is its own drawing, not one image
    // resampled seven times, which is what the generator exists to guarantee.
    expect(offsets.size).toBe(count);
  });

  it('sets the window icon in dev only — packaged Windows uses the exe resource', () => {
    const main = read('../src/main/index.ts');
    expect(main).toMatch(/if \(app\.isPackaged\) return undefined;/);
    expect(main).toContain("'../../build/icon.png'");
  });

  it('declares the window.api shape in exactly one place', () => {
    // TS2717 in the existing app came from per-file redeclaration (CLAUDE.md).
    const preload = read('../src/preload/index.ts');
    expect(preload).toMatch(/import type \{ NextApi \}/);
    expect(read('../src/preload/api.ts')).toMatch(/export interface NextApi/);
  });
});
