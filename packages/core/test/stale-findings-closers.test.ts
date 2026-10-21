import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CheckContext } from '../src/qa/check.js';
import { QC302_CLOSE_DISAGREEMENT } from '../src/qa/checks/quotes-actions.js';
import { QC804_FILLS_WITHOUT_PRICE } from '../src/qa/checks/account.js';

/**
 * Blocking findings that stopped firing and could never close (2026-10-20 snapshot: QC-302 x687,
 * QC-804 606:TSLA, QC-701 CTSH/D/LEN, QC-956 replay). Each check now re-judges its own open
 * findings and says how to close them. QC-701 and QC-956 are covered in filing-facts.test.ts and
 * pilot-exit.test.ts.
 */

let dir: string;
let raw: Database.Database;
const db = (): SqliteLike => raw as unknown as SqliteLike;
const ctx = (tradingDate: string, runId = 1): CheckContext => ({ db: db(), runId, tradingDate, observedAt: 't' });

/** Inserts a row, filling every NOT NULL column the test does not care about. */
function insert(table: string, values: Record<string, unknown>): number {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string; type: string; notnull: number; dflt_value: unknown; pk: number;
  }[];
  const dummy = (type: string): unknown => (/INT|REAL|NUM/i.test(type) ? 1 : 'x');
  const byName = new Map(cols.map((c) => [c.name, c]));
  const row: Record<string, unknown> = {};
  for (const c of cols) {
    if (c.pk || c.name in values || c.dflt_value !== null) continue;
    if (c.name.endsWith('_status')) {
      // A status column pairs with its value: `ok` with a value present, so fill both.
      const base = byName.get(c.name.slice(0, -'_status'.length));
      if (base && !(base.name in values)) row[base.name] = dummy(base.type);
      row[c.name] = 'ok';
    } else if (!(c.name in row) && (c.notnull || /INT|REAL|NUM/i.test(c.type))) {
      // Nullable numbers too: a status column can govern several of them as a group.
      row[c.name] = dummy(c.type);
    }
  }
  Object.assign(row, values);
  const names = Object.keys(row);
  const info = raw
    .prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`)
    .run(...names.map((n) => row[n] as never));
  return Number(info.lastInsertRowid);
}

function openFinding(checkId: string, domain: string, key: string, dates: string[], evidence: object = {}): void {
  raw.prepare(
    `INSERT INTO qa_exception (
       fingerprint, check_id, domain, key, severity, base_severity, state, detail, evidence_json,
       first_seen_run_id, last_seen_run_id, consecutive_runs, remediations_json,
       affects_trading_dates_json, still_firing
     ) VALUES (?, ?, ?, ?, 'blocking', 'warning', 'open', 'd', ?, 1, 1, 1, '[]', ?, 0)`
  ).run(`${checkId}|${key}`, checkId, domain, key, JSON.stringify(evidence), JSON.stringify(dates));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-stale-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
  raw.pragma('foreign_keys = OFF');
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('QC-302 — compares the latest snapshot with the latest bar', () => {
  const quote = (ticker: string, date: string, close: number) =>
    insert('raw_eod_quote', { ticker, as_of_date: date, day_close: close });
  const bar = (ticker: string, date: string, close: number) =>
    insert('raw_daily_bar', { ticker, as_of_date: date, trade_date: date, open: close, high: close, low: close, close, fetch_kind: 'daily', is_final: 1 });

  /** 2026-10-16: a 12:09 ET snapshot and partial bar, then the after-close pair. */
  function intradayThenFinal(ticker: string) {
    quote(ticker, '2026-10-16', 100);
    bar(ticker, '2026-10-16', 100);
    quote(ticker, '2026-10-16', 103);
    bar(ticker, '2026-10-16', 103);
  }

  it('does not pair the midday snapshot with the final bar', () => {
    intradayThenFinal('RKLB');
    const evals = QC302_CLOSE_DISAGREEMENT.run(ctx('2026-10-16'));
    expect(evals).toHaveLength(1);
    expect(evals[0]).toMatchObject({ key: 'RKLB', fired: false, value: 0 });
  });

  it('still fires when the latest pair disagrees', () => {
    quote('MPWR', '2026-10-16', 1210.86);
    bar('MPWR', '2026-10-16', 1239.395);
    expect(QC302_CLOSE_DISAGREEMENT.run(ctx('2026-10-16'))[0]).toMatchObject({ key: 'MPWR', fired: true });
  });

  it('closes an open finding whose own date agrees under the latest pairing, from a later run', () => {
    intradayThenFinal('RKLB');
    quote('RKLB', '2026-10-20', 50);
    bar('RKLB', '2026-10-20', 50);
    openFinding('QC-302', 'quotes', 'RKLB', ['2026-10-16']);
    const e = QC302_CLOSE_DISAGREEMENT.run(ctx('2026-10-20')).find((x) => x.key === 'RKLB');
    expect(e?.fired).toBe(false);
    expect(e?.closesAs?.kind).toBe('rule_changed');
    expect(e?.closesAs?.note).toContain('2026-10-16 0.00%');
  });

  it('leaves open a finding whose date still disagrees, however clean tonight is', () => {
    quote('MPWR', '2026-10-16', 1210.86);
    bar('MPWR', '2026-10-16', 1239.395);
    quote('MPWR', '2026-10-20', 1300);
    bar('MPWR', '2026-10-20', 1300);
    openFinding('QC-302', 'quotes', 'MPWR', ['2026-10-16']);
    const e = QC302_CLOSE_DISAGREEMENT.run(ctx('2026-10-20')).find((x) => x.key === 'MPWR');
    expect(e).toMatchObject({ fired: false });
    expect(e?.closesAs).toBeUndefined();
  });

  it('leaves open a finding whose date has no pair to judge', () => {
    quote('GONE', '2026-10-20', 10);
    bar('GONE', '2026-10-20', 10);
    openFinding('QC-302', 'quotes', 'GONE', ['2026-10-16']);
    expect(QC302_CLOSE_DISAGREEMENT.run(ctx('2026-10-20')).find((x) => x.key === 'GONE')?.closesAs).toBeUndefined();
  });
});

describe('QC-804 — the option leg of an assignment has no execution price', () => {
  /** Order 606 as stored on 2026-09-14: BUY_CLOSE TSLA 350C at 0, SELL 100 TSLA at 350. */
  function assignment(runId: number, orderId = '606', orderType = 'OPTION_ASSIGNMENT') {
    const o = insert('raw_executed_order', { run_id: runId, order_id: orderId, order_type: orderType });
    insert('raw_executed_order_leg', {
      run_id: runId, order_row_id: o, leg_index: 0, symbol: 'TSLA', security_type: 'OPTN', order_action: 'BUY_CLOSE',
      filled_quantity: 1, average_execution_price: 0
    });
    insert('raw_executed_order_leg', {
      run_id: runId, order_row_id: o, leg_index: 1, symbol: 'TSLA', security_type: 'EQ', order_action: 'SELL',
      filled_quantity: 100, average_execution_price: 350
    });
  }

  it('does not fire on an assignment', () => {
    assignment(8);
    const evals = QC804_FILLS_WITHOUT_PRICE.run(ctx('2026-09-14', 8));
    expect(evals.filter((e) => e.fired)).toEqual([]);
  });

  it('still fires on a priceless option leg of an ordinary order', () => {
    assignment(8, '700', 'OPTN');
    expect(QC804_FILLS_WITHOUT_PRICE.run(ctx('2026-09-14', 8))).toEqual([
      expect.objectContaining({ key: '700:TSLA', fired: true })
    ]);
  });

  it('closes the open finding on an assignment from a run that did not capture the order again', () => {
    assignment(8);
    openFinding('QC-804', 'account', '606:TSLA', ['2026-09-14']);
    const e = QC804_FILLS_WITHOUT_PRICE.run(ctx('2026-10-20', 97)).find((x) => x.key === '606:TSLA');
    expect(e).toMatchObject({ fired: false, closesAs: { kind: 'rule_changed' } });
  });

  it('leaves open a finding on an ordinary order', () => {
    assignment(8, '700', 'OPTN');
    openFinding('QC-804', 'account', '700:TSLA', ['2026-09-14']);
    expect(QC804_FILLS_WITHOUT_PRICE.run(ctx('2026-10-20', 97)).find((x) => x.key === '700:TSLA')).toBeUndefined();
  });
});
