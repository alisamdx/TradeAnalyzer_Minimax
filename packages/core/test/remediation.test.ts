import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost } from '../src/collector/host.js';
import { beginRun } from '../src/collector/run.js';
import { runGate } from '../src/qa/gate.js';
import { QC204_DISCONTINUITY } from '../src/qa/checks/bars.js';
import { QC501_UNEXPLAINED_DISCONTINUITY } from '../src/qa/checks/quotes-actions.js';
import type { CheckDefinition } from '../src/qa/check.js';
import { runR6ActionRefetch, r6Candidates, type RemediationAttempt } from '../src/collector/remediation.js';

/**
 * R6 — the first remediation in the system that runs.
 *
 * Measured on gen-002, 2026-09-17: all 12,970 exceptions carried
 * `remediations_json = '[]'`, nothing in the repo wrote one, and every check's
 * `remediation:` field was a declaration of intent. The consequence one level up
 * is what these tests care about: `reconcileStoppedFiring` may auto-resolve only
 * when *a remediation succeeded and the fingerprint now evaluates clean*, so it
 * read a field nothing wrote and could never fire.
 */

let dir: string;
let raw: Database.Database;
let db: SqliteLike;
let calls: { path: string; params: Record<string, string> }[];

const DATE = '2026-09-17';

function makeHost(over: Partial<CollectorHost> = {}): CollectorHost {
  return {
    openGenerationDb: () => db,
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => b,
    decryptFromArchive: (b) => b,
    polygonGet: async (path, params) => {
      calls.push({ path, params: (params ?? {}) as Record<string, string> });
      return { status: 200, body: '{"results":[]}', requestedAt: 't', respondedAt: 't' };
    },
    etradeGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    httpGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    nowET: () => '2026-09-17T19:05:00-04:00',
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test', version: '0' },
    ...over
  };
}

/** Raises real QC-204 findings for `keys` through the gate, so states are genuine. */
function raiseDiscontinuities(keys: readonly string[]): number {
  const host = makeHost();
  const run = beginRun(db, host, { kind: 'daily', tradingDate: DATE });
  runGate(db, host, {
    runId: run.runId, tradingDate: DATE,
    checks: [{
      ...QC204_DISCONTINUITY,
      run: () => keys.map((k) => ({ key: k, value: 0.9, fired: true, detail: 'step with no explaining action' }))
    }]
  });
  return run.runId;
}

function attemptsOn(key: string): RemediationAttempt[] {
  const row = raw.prepare('SELECT remediations_json FROM qa_exception WHERE key = ?').get(key) as
    | { remediations_json: string } | undefined;
  return JSON.parse(row?.remediations_json ?? '[]') as RemediationAttempt[];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-r6-'));
  raw = new Database(join(dir, 'data.sqlite'));
  db = raw as unknown as SqliteLike;
  applyDictionary(db);
  raw.exec("INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) VALUES (1,'t','pilot','x','y')");
  calls = [];
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('R6 — a ticker\'s splits and dividends, re-fetched around an unexplained step', () => {
  it('fetches both actions once per TICKER, not once per finding', async () => {
    // SOLS carried 21 QC-204 findings on 2026-09-17. A ticker's splits and
    // dividends are one fetch whatever the number of steps, and per-finding
    // would have been 42 calls for one ticker.
    const runId = raiseDiscontinuities(['AAOI 2022-09-16', 'AAOI 2023-08-04', 'AAOI 2024-11-08']);

    const report = await runR6ActionRefetch(makeHost(), db, { runId, tradingDate: DATE });

    expect(report.tickersAttempted).toBe(1);
    expect(report.exceptionsMarked).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.path)).toEqual(['/v3/reference/splits', '/v3/reference/dividends']);
  });

  it('asks for a window spanning every step of that ticker, with room either side', async () => {
    const runId = raiseDiscontinuities(['AAOI 2022-09-16', 'AAOI 2024-11-08']);
    await runR6ActionRefetch(makeHost(), db, { runId, tradingDate: DATE });

    expect(calls[0]!.params['ticker']).toBe('AAOI');
    expect(calls[0]!.params['execution_date.gte']).toBe('2022-09-09');
    expect(calls[0]!.params['execution_date.lte']).toBe('2024-11-15');
    expect(calls[1]!.params['ex_dividend_date.gte']).toBe('2022-09-09');
  });

  it('records the attempt on every finding for the ticker', async () => {
    const runId = raiseDiscontinuities(['AAOI 2022-09-16', 'AAOI 2023-08-04']);
    await runR6ActionRefetch(makeHost(), db, { runId, tradingDate: DATE });

    for (const key of ['AAOI 2022-09-16', 'AAOI 2023-08-04']) {
      const attempts = attemptsOn(key);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.code).toBe('R6');
      expect(attempts[0]!.outcome).toBe('success');
    }
  });

  it('does not attempt the same finding twice — the attempt cap', async () => {
    // The collector's removed claim loop re-ran one failing job 70 times in a
    // night because nothing capped the attempts. A step still unexplained after
    // a re-fetch is an operator's question, not something to re-fetch nightly.
    const runId = raiseDiscontinuities(['AAOI 2022-09-16']);
    await runR6ActionRefetch(makeHost(), db, { runId, tradingDate: DATE });
    calls = [];

    const second = await runR6ActionRefetch(makeHost(), db, { runId, tradingDate: DATE });

    expect(second.tickersAttempted).toBe(0);
    expect(calls).toHaveLength(0);
    expect(attemptsOn('AAOI 2022-09-16')).toHaveLength(1);
  });

  it('records a failure rather than throwing, and never fails the run', async () => {
    const runId = raiseDiscontinuities(['AAOI 2022-09-16']);
    const host = makeHost({ polygonGet: async () => { throw new Error('connection reset'); } });

    const report = await runR6ActionRefetch(host, db, { runId, tradingDate: DATE });

    expect(report.tickersFailed).toBe(1);
    const attempt = attemptsOn('AAOI 2022-09-16')[0]!;
    expect(attempt.outcome).toBe('failed');
    expect(attempt.detail).toContain('connection reset');
  });

  it('caps the tickers per run and reports what it deferred', async () => {
    const runId = raiseDiscontinuities(['AAA 2022-01-03', 'BBB 2022-01-04', 'CCC 2022-01-05']);

    const report = await runR6ActionRefetch(makeHost(), db, { runId, tradingDate: DATE, maxTickers: 2 });

    expect(report.tickersAttempted).toBe(2);
    expect(report.deferred).toBe(1);
  });

  it('ignores findings from an earlier run — it remediates what THIS run raised', async () => {
    const first = raiseDiscontinuities(['AAOI 2022-09-16']);
    const second = beginRun(db, makeHost(), { kind: 'manual', tradingDate: DATE }).runId;

    expect(r6Candidates(db, second)).toHaveLength(0);
    expect(r6Candidates(db, first)).toHaveLength(1);
  });
});

describe('the gate\'s auto-resolve branch, which could never fire before', () => {
  it('resolves a finding whose remediation succeeded and whose fingerprint has gone quiet', async () => {
    // The whole point of writing remediations_json. `reconcileStoppedFiring`
    // resolves only when a remediation succeeded AND the check now evaluates
    // clean; with nothing ever writing an attempt, the first half was never
    // true and the branch was dead.
    const runId = raiseDiscontinuities(['AAOI 2022-09-16']);
    await runR6ActionRefetch(makeHost(), db, { runId, tradingDate: DATE });

    const host = makeHost();
    const next = beginRun(db, host, { kind: 'manual', tradingDate: DATE });
    // The re-fetched action now explains the step, so QC-204 evaluates clean.
    runGate(db, host, {
      runId: next.runId, tradingDate: DATE,
      checks: [{ ...QC204_DISCONTINUITY, run: () => [{ key: 'AAOI 2022-09-16', value: 0.9, fired: false }] }]
    });

    const row = raw
      .prepare('SELECT state, resolution_kind, resolution_note FROM qa_exception WHERE key = ?')
      .get('AAOI 2022-09-16') as { state: string; resolution_kind: string; resolution_note: string };
    expect(row.state).toBe('resolved');
    expect(row.resolution_kind).toBe('data_corrected');
    expect(row.resolution_note).toContain('remediation succeeded');
  });

  it('leaves it OPEN when the remediation failed, even though the check went quiet', async () => {
    // A finding that stops firing without a successful remediation stays open —
    // "it went away" is how the earnings-date bug hid for a quarter.
    const runId = raiseDiscontinuities(['AAOI 2022-09-16']);
    await runR6ActionRefetch(makeHost({ polygonGet: async () => { throw new Error('nope'); } }), db, {
      runId, tradingDate: DATE
    });

    const host = makeHost();
    const next = beginRun(db, host, { kind: 'manual', tradingDate: DATE });
    runGate(db, host, {
      runId: next.runId, tradingDate: DATE,
      checks: [{ ...QC204_DISCONTINUITY, run: () => [{ key: 'AAOI 2022-09-16', value: 0.9, fired: false }] }]
    });

    const row = raw.prepare('SELECT state, still_firing FROM qa_exception WHERE key = ?')
      .get('AAOI 2022-09-16') as { state: string; still_firing: number };
    expect(row.state).toBe('open');
    expect(row.still_firing).toBe(0);
  });

  it('closes the QC-501 alias the way its QC-204 finding was closed (v1.1.278)', async () => {
    // QC-501 reads only OPEN QC-204 findings, so after QC-204 resolved it stopped evaluating the
    // key — and a key never evaluated no longer counts as clean. Without mirroring, the alias
    // would stay open for ever with nothing able to close it.
    const key = 'AAOI 2022-09-16';
    const firing204 = { ...QC204_DISCONTINUITY, run: () => [{ key, value: 0.9, fired: true, detail: 'step' }] };
    const clean204 = { ...QC204_DISCONTINUITY, run: () => [{ key, value: 0.9, fired: false }] };
    const gate = (checks: CheckDefinition[]): number => {
      const host = makeHost();
      const run = beginRun(db, host, { kind: 'manual', tradingDate: DATE });
      runGate(db, host, { runId: run.runId, tradingDate: DATE, checks });
      raw.prepare("UPDATE meta_run SET status = 'complete' WHERE run_id = ?").run(run.runId);
      return run.runId;
    };

    raw.prepare("UPDATE meta_run SET status = 'complete' WHERE run_id = ?").run(raiseDiscontinuities([key]));
    const runId = gate([firing204, QC501_UNEXPLAINED_DISCONTINUITY]); // QC-501 now sees QC-204 open
    await runR6ActionRefetch(makeHost(), db, { runId, tradingDate: DATE });
    gate([clean204, QC501_UNEXPLAINED_DISCONTINUITY]);            // QC-204 resolves; QC-501 lags a run
    gate([clean204, QC501_UNEXPLAINED_DISCONTINUITY]);

    const rows = raw
      .prepare('SELECT check_id, state, resolution_kind, resolution_note FROM qa_exception WHERE key = ? ORDER BY check_id')
      .all(key) as { check_id: string; state: string; resolution_kind: string; resolution_note: string }[];
    expect(rows.map((r) => [r.check_id, r.state, r.resolution_kind])).toEqual([
      ['QC-204', 'resolved', 'data_corrected'],
      ['QC-501', 'resolved', 'data_corrected']
    ]);
    expect(rows[1]!.resolution_note).toContain('QC-204 finding resolved data_corrected');
  });
});
