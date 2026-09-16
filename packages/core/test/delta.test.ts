import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import { runGate, beginRun } from '../src/index.js';
import { computeRunDelta, deltaHeadline, deltaLines } from '../src/qa/delta.js';
import { buildStatusEmail } from '../src/qa/email.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CheckDefinition, Evaluation } from '../src/qa/check.js';
import type { CollectorHost } from '../src/collector/host.js';

/**
 * The run delta — 03 §7.2c.
 *
 * Every daily run this generation has had came back RED, so the verdict said the
 * same thing on the night a check first fired at 92 % as on the night nothing
 * moved. These tests pin the distinction the operator actually needs: what this
 * run *changed*, separated from the backlog it merely inherited.
 */

let dir: string;
let raw: Database.Database;
const db = (): SqliteLike => raw as unknown as SqliteLike;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-delta-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeHost(): CollectorHost {
  let n = 0;
  return {
    nowET: () => `2026-09-${String(10 + n++).padStart(2, '0')}T17:05:00-04:00`,
    hostApp: { name: 'test', version: '0.0.0' }
  } as unknown as CollectorHost;
}

/** A check whose findings the test dictates run by run. */
function check(id: string, keys: readonly string[], severity: 'blocking' | 'warning' = 'blocking'): CheckDefinition {
  return {
    id,
    domain: 'chains',
    severity,
    description: `${id} for tests`,
    readsTables: [],
    testedQuantity: 'n',
    testedUnit: 'count',
    thresholds: { max: 0 },
    thresholdBasis: 'structural',
    remediation: 'R1',
    run: () =>
      keys.map((k) => ({ key: k, value: 1, fired: true, detail: `${id} fired on ${k}` })) satisfies Evaluation[]
  } as CheckDefinition;
}

/** One gate run over the given checks, returning its run id. */
function gateRun(tradingDate: string, checks: CheckDefinition[]): number {
  const host = makeHost();
  const run = beginRun(db(), host, { kind: 'daily', tradingDate });
  runGate(db(), host, { runId: run.runId, tradingDate, checks, domainsExpected: {} });
  raw.prepare("UPDATE meta_run SET status='complete' WHERE run_id=?").run(run.runId);
  return run.runId;
}

describe('there is no baseline on the first run, and that is not "no change"', () => {
  it('says so explicitly rather than reporting a quiet night', () => {
    const runId = gateRun('2026-09-14', [check('QC-801', ['AAA', 'BBB'])]);
    const delta = computeRunDelta(db(), runId);

    expect(delta.baselineRunId).toBeNull();
    expect(deltaHeadline(delta)).toBe('first run, no baseline');
    // The exact trap this project keeps hitting: an absence rendering as a pass.
    expect(deltaLines(delta).join('\n')).not.toContain('Nothing changed');
    expect(deltaLines(delta).join('\n')).toContain('No previous gate run');
  });
});

describe('what the delta separates', () => {
  it('calls a check that had nothing open before NEW, and leads with it', () => {
    gateRun('2026-09-14', [check('QC-801', ['AAA'])]);
    const second = gateRun('2026-09-15', [check('QC-801', ['AAA']), check('QC-802', ['XXX', 'YYY'])]);

    const delta = computeRunDelta(db(), second);
    expect(delta.baselineRunId).not.toBeNull();
    const fresh = delta.changed.find((c) => c.checkId === 'QC-802');
    expect(fresh).toMatchObject({ kind: 'new', firing: 2, previousFiring: 0, added: 2 });
    expect(delta.changed[0]!.checkId).toBe('QC-802');
    // QC-801 did not move, so it is counted rather than listed.
    expect(delta.changed.some((c) => c.checkId === 'QC-801')).toBe(false);
    expect(delta).toMatchObject({ unchangedChecks: 1, unchangedFindings: 1 });
    expect(deltaHeadline(delta)).toBe('1 NEW');
  });

  it('reports growth as previous → current, which is the number worth acting on', () => {
    gateRun('2026-09-14', [check('QC-801', ['AAA', 'BBB'])]);
    const second = gateRun('2026-09-15', [check('QC-801', ['AAA', 'BBB', 'CCC', 'DDD'])]);

    const delta = computeRunDelta(db(), second);
    expect(delta.changed).toHaveLength(1);
    expect(delta.changed[0]).toMatchObject({ kind: 'growing', previousFiring: 2, firing: 4, added: 2 });
    expect(deltaLines(delta).join('\n')).toContain('2 → 4 (+2)');
    expect(deltaHeadline(delta)).toBe('1 growing');
  });

  it('reports a shrinking check, and a check that went quiet entirely', () => {
    gateRun('2026-09-14', [check('QC-801', ['AAA', 'BBB', 'CCC']), check('QC-802', ['XXX'])]);
    const second = gateRun('2026-09-15', [check('QC-801', ['AAA']), check('QC-802', [])]);

    const delta = computeRunDelta(db(), second);
    expect(delta.changed.find((c) => c.checkId === 'QC-801')).toMatchObject({
      kind: 'shrinking', previousFiring: 3, firing: 1, stopped: 2
    });
    // Stopped firing is NOT resolved — it stays open and is still reported,
    // because "it went away" is how the earnings-date bug hid for a quarter.
    expect(delta.changed.find((c) => c.checkId === 'QC-802')).toMatchObject({
      kind: 'gone', previousFiring: 1, firing: 0
    });
  });

  /**
   * The case a plain count cannot see. A check that swaps one ticker for another
   * has the same total on both runs — and if the delta reported that as
   * unchanged it would be the same "stable number hiding a moving population"
   * mistake as everything else in this file.
   */
  it('reports a check whose count is identical but whose findings are different', () => {
    gateRun('2026-09-14', [check('QC-801', ['AAA', 'BBB'])]);
    const second = gateRun('2026-09-15', [check('QC-801', ['AAA', 'CCC'])]);

    const delta = computeRunDelta(db(), second);
    expect(delta.changed).toHaveLength(1);
    expect(delta.changed[0]).toMatchObject({ kind: 'churned', previousFiring: 2, firing: 2, added: 1, stopped: 1 });
    expect(delta.unchangedChecks).toBe(0);
    expect(deltaHeadline(delta)).toBe('1 churned');
  });

  it('says "no change" only when the findings really are the same set', () => {
    gateRun('2026-09-14', [check('QC-801', ['AAA', 'BBB'])]);
    const second = gateRun('2026-09-15', [check('QC-801', ['AAA', 'BBB'])]);

    const delta = computeRunDelta(db(), second);
    expect(delta.changed).toHaveLength(0);
    expect(deltaHeadline(delta)).toBe('no change');
    expect(deltaLines(delta).join('\n')).toContain('Nothing changed. 1 check still firing, 2 findings');
  });

  it('compares against the previous RUN, so a same-day re-run sees its own delta', () => {
    gateRun('2026-09-15', [check('QC-801', ['AAA'])]);
    const second = gateRun('2026-09-15', [check('QC-801', ['AAA', 'BBB'])]);

    const delta = computeRunDelta(db(), second);
    expect(delta.baselineTradingDate).toBe('2026-09-15');
    expect(delta.changed[0]).toMatchObject({ kind: 'growing', previousFiring: 1, firing: 2 });
  });
});

describe('the delta reaches the subject line', () => {
  it('distinguishes two RED runs that carry different news', () => {
    const args = (runId: number) => ({
      runId, tradingDate: '2026-09-15', slot: 'after_close', verdict: 'red' as const,
      generationNo: 2, generationStatus: 'pilot', collectorVersion: '0.6.10',
      startedAt: '2026-09-15T17:05:00-04:00', finishedAt: '2026-09-15T18:58:00-04:00',
      domains: {}
    });

    gateRun('2026-09-14', [check('QC-801', ['AAA'])]);
    const quiet = gateRun('2026-09-15', [check('QC-801', ['AAA'])]);
    const quietEmail = buildStatusEmail(db(), args(quiet));

    const noisy = gateRun('2026-09-16', [check('QC-801', ['AAA']), check('QC-802', ['XXX'])]);
    const noisyEmail = buildStatusEmail(db(), args(noisy));

    // Same verdict, same blocking count on the quiet night — and the subjects
    // must not be interchangeable, because the subject is what decides whether
    // the email is opened.
    expect(quietEmail.subject).toContain('RED (1 blocking) · no change');
    expect(noisyEmail.subject).toContain('· 1 NEW');
    expect(quietEmail.subject).not.toEqual(noisyEmail.subject);

    // And the body leads with the change, above the standing backlog.
    expect(noisyEmail.text.indexOf('CHANGED SINCE RUN')).toBeLessThan(noisyEmail.text.indexOf('BLOCKING'));
    expect(noisyEmail.text).toContain('QC-802 fired on XXX');
  });

  it('keeps the email small when the delta itself is large', () => {
    const many = Array.from({ length: 300 }, (_, i) => `K${i}`);
    gateRun('2026-09-14', [check('QC-801', ['AAA'])]);
    const second = gateRun('2026-09-15', [check('QC-801', ['AAA']), check('QC-802', many)]);

    const email = buildStatusEmail(db(), {
      runId: second, tradingDate: '2026-09-15', slot: 'after_close', verdict: 'red',
      generationNo: 2, generationStatus: 'pilot', collectorVersion: '0.6.10',
      startedAt: 't', finishedAt: 't', domains: {}
    });
    // One line per changed check, not one per finding.
    expect(Buffer.byteLength(email.html, 'utf8')).toBeLessThan(102_400);
    expect(email.text).toContain('×300 first seen');
  });
});
