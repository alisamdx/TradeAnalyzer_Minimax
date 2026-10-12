import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost } from '../src/collector/host.js';
import { beginRun, captureRuleId } from '../src/collector/run.js';
import { runGate } from '../src/qa/gate.js';
import { QC211_MEMBER_STOPPED_TRADING } from '../src/qa/checks/bars.js';
import { buildTradingCalendar } from '../src/collector/trading-calendar.js';

/**
 * QC-211 — a universe member whose bars stopped (v1.1.348).
 *
 * gen-002, 2026-10-09: QRVO's last bar was 10-02 (acquired by Skyworks, delisted 10-05), and PSKY's
 * and WBD's were 10-05 (merged 10-06, trading as SKYD). Every check was quiet. QC-201 allows 1 %
 * missing, and three dead members of 1,083 is 0.28 %. QC-207 skips the days after a series' last bar
 * on purpose.
 */

let dir: string;
let raw: Database.Database;
let db: SqliteLike;

const DATE = '2026-10-09';
const SESSIONS = buildTradingCalendar('2026-09-01', DATE).filter((r) => r.isTradingDay).map((r) => r.date);

function host(): CollectorHost {
  return {
    openGenerationDb: () => db,
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => b,
    decryptFromArchive: (b) => b,
    polygonGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    etradeGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    httpGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    nowET: () => `${DATE}T18:00:00-04:00`,
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test', version: '0' }
  };
}

let runId = 0;
let ruleId = 0;

function member(ticker: string, from = '2021-01-01'): void {
  raw
    .prepare(
      `INSERT INTO ref_universe_membership (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
         ticker, list_source, valid_from, valid_to, change_reason)
       VALUES (?, ?, 't', ?, 9001, ?, 'sp500', ?, NULL, 'initial')`
    )
    .run(runId, DATE, ruleId, ticker, from);
}

/** Bars on every session from `from` to `to` inclusive. */
function bars(ticker: string, from: string, to: string): void {
  for (const d of SESSIONS.filter((s) => s >= from && s <= to)) {
    raw
      .prepare(
        `INSERT INTO raw_daily_bar (run_id, as_of_date, observed_at, capture_rule_id, source_response_id, ticker, trade_date,
           open, high, low, close, volume, adjusted_as_of, fetch_kind, is_final)
         VALUES (?, ?, 't', ?, 9001, ?, ?, 10, 10, 10, 10, 1000, ?, 'daily', 1)`
      )
      .run(runId, DATE, ruleId, ticker, d, DATE);
  }
}

const run = () => QC211_MEMBER_STOPPED_TRADING.run({ db, runId, tradingDate: DATE, observedAt: 't' });
const fired = () => run().filter((e) => e.fired).map((e) => [e.key, e.value]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-qc211-'));
  raw = new Database(join(dir, 'data.sqlite'));
  db = raw as unknown as SqliteLike;
  applyDictionary(db);
  raw.exec("INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) VALUES (1,'t','pilot','x','y')");
  const r = beginRun(db, host(), { kind: 'daily', tradingDate: DATE });
  runId = r.runId;
  ruleId = captureRuleId(db, host(), 'bars', { v: 1 }, 'test');
  raw.exec(
    "INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) " +
      `VALUES (9001, ${runId}, 'polygon', '/x', '{}', 't', 'a', 0, 'h', 0, 0, 'ok')`
  );
  for (const t of ['AAA', 'BBB', 'CCC', 'DDD']) {
    member(t);
    bars(t, '2026-09-01', DATE);
  }
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('QC-211 member stopped trading', () => {
  it('fires on the 2026-10-09 cases with their real last bars, and on nobody else', () => {
    member('QRVO'); bars('QRVO', '2026-09-01', '2026-10-02');
    member('PSKY'); bars('PSKY', '2026-09-01', '2026-10-05');
    member('WBD'); bars('WBD', '2026-09-01', '2026-10-05');
    expect(fired().sort()).toEqual([['PSKY', 4], ['QRVO', 5], ['WBD', 4]]);
    const psky = run().find((e) => e.key === 'PSKY')!;
    expect(psky.detail).toContain('last bar 2026-10-05');
    expect(psky.detail).toContain('constituents_excluded');
  });

  it('leaves room for a short halt: two missing sessions do not fire', () => {
    member('HALT'); bars('HALT', '2026-09-01', '2026-10-07');
    expect(run().find((e) => e.key === 'HALT')).toMatchObject({ value: 2, fired: false });
  });

  it('does not count sessions before a new member was admitted', () => {
    member('SKYD', '2026-10-08'); bars('SKYD', '2026-10-08', DATE);
    member('NEWB', DATE); // admitted today, first bar not stored yet
    expect(run().find((e) => e.key === 'SKYD')).toMatchObject({ value: 0, fired: false });
    expect(run().find((e) => e.key === 'NEWB')).toMatchObject({ value: 1, fired: false });
  });

  it('a member with no bar in the whole lookback fires, and says so', () => {
    member('GONE');
    const e = run().find((x) => x.key === 'GONE')!;
    expect(e.fired).toBe(true);
    expect(e.detail).toContain('none since');
  });

  it('a provider outage is QC-201, not one QC-211 per member', () => {
    // The next session, with no bar stored for anyone yet.
    expect(QC211_MEMBER_STOPPED_TRADING.run({ db, runId, tradingDate: '2026-10-12', observedAt: 't' })).toEqual([]);
  });

  it('closes a finding once the ticker leaves the universe', () => {
    member('QRVO'); bars('QRVO', '2026-09-01', '2026-10-02');
    const gate = (id: number) => runGate(db, host(), { runId: id, tradingDate: DATE, checks: [QC211_MEMBER_STOPPED_TRADING], domainsExpected: {} });
    gate(runId);
    const state = () => raw.prepare("SELECT state, resolution_kind FROM qa_exception WHERE check_id = 'QC-211'").get();
    expect(state()).toMatchObject({ state: 'open' });
    raw.prepare("UPDATE ref_universe_membership SET valid_to = '2026-10-05' WHERE ticker = 'QRVO'").run();
    raw.prepare("UPDATE meta_run SET status = 'complete' WHERE run_id = ?").run(runId);
    gate(beginRun(db, host(), { kind: 'daily', tradingDate: DATE }).runId);
    expect(state()).toMatchObject({ state: 'resolved', resolution_kind: 'data_corrected' });
  });
});
