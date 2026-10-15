import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost, ProviderResponse } from '../src/collector/host.js';
import { resetOffsetCache } from '../src/collector/archive.js';
import { beginRun, recordRenewCount } from '../src/collector/run.js';
import { runDaily } from '../src/collector/daily.js';
import { QC413_RENEW_STORM } from '../src/qa/checks/chains.js';

/**
 * QC-413 renew storm (v1.1.362).
 *
 * The check counted `meta_response` rows matching `renew_access_token`, but the host renews
 * inside its own transport and never captures the call, so on gen-002 it had evaluated zero
 * renews on every run and could not fire. It now reads `meta_run.etrade_renew_count`, which
 * `runDaily` takes from the host just before the gate.
 */

let dir: string;
let raw: Database.Database;
const DATE = '2026-10-14';

const db = (): SqliteLike => raw as unknown as SqliteLike;
const ok = (body = '{}'): ProviderResponse => ({ status: 200, body, requestedAt: `${DATE}T21:00:00Z`, respondedAt: `${DATE}T21:00:01Z` });

function makeHost(overrides: Partial<CollectorHost> = {}): CollectorHost {
  return {
    openGenerationDb: () => db(),
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    decryptFromArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    polygonGet: async () => ok('{"results":[]}'),
    etradeGet: async () => ok(),
    httpGet: async () => ok(),
    nowET: () => `${DATE}T17:30:00-04:00`,
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test-host', version: '0.0.0' },
    ...overrides
  };
}

const evaluate = (runId: number) =>
  QC413_RENEW_STORM.run({ db: db(), runId, tradingDate: DATE, observedAt: `${DATE}T17:30:00-04:00` });

const renewCount = (runId: number) =>
  (raw.prepare('SELECT etrade_renew_count AS n FROM meta_run WHERE run_id = ?').get(runId) as { n: number | null }).n;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-qc413-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
  raw.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) " +
      "VALUES (2, '2026-09-11T00:00:00-04:00', 'pilot', 'x', 'y')"
  );
  resetOffsetCache();
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('QC-413 renew storm', () => {
  it('is quiet at zero renews, and still evaluates (a measured zero, not vacuous)', () => {
    const run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
    recordRenewCount(db(), run, 0);
    const evals = evaluate(run.runId);
    expect(evals).toHaveLength(1);
    expect(evals[0]).toMatchObject({ value: 0, fired: false });
  });

  it('is quiet at the threshold and fires above it', () => {
    const atLimit = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
    recordRenewCount(db(), atLimit, 20);
    expect(evaluate(atLimit.runId)[0]).toMatchObject({ value: 20, fired: false });

    raw.prepare("UPDATE meta_run SET status = 'complete' WHERE run_id = ?").run(atLimit.runId);
    const storm = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
    recordRenewCount(db(), storm, 21);
    expect(evaluate(storm.runId)[0]).toMatchObject({ value: 21, fired: true });
  });

  it('evaluates nothing when no count was recorded, rather than reading NULL as zero', () => {
    const run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
    recordRenewCount(db(), run, null);
    expect(renewCount(run.runId)).toBeNull();
    expect(evaluate(run.runId)).toEqual([]);
  });

  it('adds to an earlier count, so a resumed run keeps what it already recorded', () => {
    const run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
    recordRenewCount(db(), run, 15);
    recordRenewCount(db(), run, 10);
    expect(evaluate(run.runId)[0]).toMatchObject({ value: 25, fired: true });
  });
});

describe('runDaily records the host renew count for QC-413', () => {
  it('stores the renews made during the run, not the host total before it', async () => {
    // A host that has already renewed 5 times before this run, and renews on every E*Trade call in it.
    let renews = 5;
    const host = makeHost({
      etradeGet: async () => {
        renews += 1;
        return ok();
      },
      etradeRenewAttempts: () => renews
    });
    const report = await runDaily(host, { tradingDate: DATE });
    expect(report.verdict).not.toBe('skipped');
    expect(renews).toBeGreaterThan(5);
    expect(renewCount(report.runId)).toBe(renews - 5);
  });

  it('leaves the column NULL for a host that does not report renews', async () => {
    const report = await runDaily(makeHost(), { tradingDate: DATE });
    expect(report.verdict).not.toBe('skipped');
    expect(renewCount(report.runId)).toBeNull();
  });
});
