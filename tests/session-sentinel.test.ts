// Regression for 2026-09-28: the app went silent at 10:41:54 ET mid-brief and nothing
// could say whether it was closed, crashed or froze. The session sentinel makes the next
// boot report an unclean end and when the session was last alive.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startSessionSentinel,
  readPreviousSession,
  type SessionRecord
} from '../src/main/services/session-sentinel';
import type { ErrorLogEntry } from '../src/main/services/logger';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sentinel-'));
  path = join(dir, 'session.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function clock(start: string): { now: () => Date; advance: (ms: number) => void } {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (ms) => { t += ms; } };
}

function start(now: () => Date, logs: ErrorLogEntry[], pid = 100) {
  return startSessionSentinel({ path, appVersion: '9.9.9', log: (e) => logs.push(e), now, pid, intervalMs: 3_600_000 });
}

describe('session sentinel', () => {
  it('first boot ever reports nothing', () => {
    const logs: ErrorLogEntry[] = [];
    start(clock('2026-09-28T14:00:00Z').now, logs).stop();
    expect(logs).toEqual([]);
  });

  it('a clean quit is not reported on the next boot', () => {
    const c = clock('2026-09-28T14:00:00Z');
    const first: ErrorLogEntry[] = [];
    start(c.now, first).markCleanExit('quit');
    expect(readPreviousSession(path).kind).toBe('clean');

    const second: ErrorLogEntry[] = [];
    c.advance(3_600_000);
    start(c.now, second, 200).stop();
    expect(second).toEqual([]);
  });

  it('a session that stopped without quitting is reported with its last-alive time', () => {
    // The 2026-09-28 shape: alive through the morning, then nothing, next boot the following day.
    const c = clock('2026-09-28T14:19:00Z');
    const first: ErrorLogEntry[] = [];
    const s = start(c.now, first, 4242);
    c.advance(22 * 60_000 + 54_000); // 14:41:54Z
    s.beat();
    s.stop(); // the process is gone: no markCleanExit, no further beats

    c.advance(17 * 3_600_000);
    const second: ErrorLogEntry[] = [];
    start(c.now, second, 5151).stop();

    expect(second).toHaveLength(1);
    const e = second[0]!;
    expect(e.operation).toBe('app:previous-session');
    expect(e.level).toBe('WARNING');
    expect(e.message).toContain('WITHOUT a clean quit');
    expect(e.message).toContain('pid 4242');
    expect(e.message).toContain('last alive 2026-09-28T14:41:54.000Z');
  });

  it('the new session takes over the file, so one unclean end is reported once', () => {
    const c = clock('2026-09-28T14:00:00Z');
    start(c.now, []).stop(); // unclean
    const second: ErrorLogEntry[] = [];
    start(c.now, second, 2).markCleanExit('quit');
    const third: ErrorLogEntry[] = [];
    start(c.now, third, 3).stop();
    expect(second).toHaveLength(1);
    expect(third).toEqual([]);
  });

  it('beats after a clean exit do not reopen the record', () => {
    const c = clock('2026-09-28T14:00:00Z');
    const s = start(c.now, []);
    s.markCleanExit('quit');
    c.advance(60_000);
    s.beat();
    const rec = JSON.parse(readFileSync(path, 'utf8')) as SessionRecord;
    expect(rec.cleanExit).toBe(true);
    expect(rec.exitReason).toBe('quit');
  });

  it('an unreadable record is reported, never thrown', () => {
    writeFileSync(path, '{not json', 'utf8');
    const logs: ErrorLogEntry[] = [];
    expect(() => start(clock('2026-09-28T14:00:00Z').now, logs).stop()).not.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.message).toContain('unreadable');
  });

  it('a log function that throws does not stop the sentinel starting', () => {
    const c = clock('2026-09-28T14:00:00Z');
    start(c.now, []).stop(); // leave an unclean record
    const s = startSessionSentinel({
      path, appVersion: '9.9.9', now: c.now, pid: 7, intervalMs: 3_600_000,
      log: () => { throw new Error('disk full'); }
    });
    s.stop();
    expect((JSON.parse(readFileSync(path, 'utf8')) as SessionRecord).pid).toBe(7);
  });
});
