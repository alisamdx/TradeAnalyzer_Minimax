import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyDictionary } from '../src/dictionary/apply.js';
import { recordOpenHandle } from '../src/db/open-handle.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';

/**
 * `meta_open_handle` — the split detector.
 *
 * `assertNotRedirected` prevents the one split that is understood. This table
 * answers the more general question it cannot: **are the two applications
 * actually looking at the same file?** On 2026-09-07 that question was answered
 * by inference several times and wrongly every time, because a redirected
 * process reads every path back exactly as it wrote it. Two rows in one file,
 * each naming the app that wrote it, replace the inference with a reading.
 */

function open(): { db: SqliteLike; close: () => void } {
  const raw = new Database(':memory:');
  applyDictionary(raw as unknown as SqliteLike);
  return { db: raw as unknown as SqliteLike, close: () => raw.close() };
}

const HOST = {
  appName: 'TradeAnalyzer',
  appVersion: '1.1.202',
  dbPath: 'C:\\data\\gen-001\\data.sqlite',
  dictionaryVersion: 6,
  openedAt: '2026-09-07T20:00:00-04:00',
  processId: 1234
};

describe('meta_open_handle', () => {
  it('records the application that opened the generation', () => {
    const { db, close } = open();
    recordOpenHandle(db, HOST);

    const row = db.prepare('SELECT * FROM meta_open_handle').get() as Record<string, unknown>;
    expect(row['app_name']).toBe('TradeAnalyzer');
    expect(row['db_path']).toBe(HOST.dbPath);
    expect(row['process_id']).toBe(1234);
    close();
  });

  it('replaces its own row when the SAME path is re-opened', () => {
    // Re-opening the same file is not new information, so it updates in place.
    const { db, close } = open();
    recordOpenHandle(db, HOST);
    recordOpenHandle(db, { ...HOST, processId: 5678, openedAt: '2026-09-07T21:00:00-04:00' });

    const rows = db.prepare('SELECT process_id FROM meta_open_handle').all() as { process_id: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.process_id).toBe(5678);
    close();
  });

  it('keeps a SECOND row when the same app resolves a DIFFERENT path', () => {
    // The whole point, and it did not work until 2026-09-09. Keyed on `app_name`
    // alone, the upsert held only each application's latest open — so a
    // redirected open was overwritten by the next healthy one and the split
    // became unaskable.
    //
    // Measured on the real corrupt generation: both applications reported the
    // same `db_path`, which was true of their last opens and evidence of
    // nothing. A path this app once resolved must survive the next open.
    const { db, close } = open();
    recordOpenHandle(db, HOST);
    recordOpenHandle(db, {
      ...HOST,
      dbPath: 'C:\\Users\\x\\AppData\\Local\\Packages\\Some.App\\LocalCache\\Roaming\\gen-001\\data.sqlite',
      processId: 9999,
      openedAt: '2026-09-07T22:00:00-04:00'
    });

    const rows = db
      .prepare('SELECT db_path FROM meta_open_handle WHERE app_name = ? ORDER BY db_path')
      .all(HOST.appName) as { db_path: string }[];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.db_path)).size).toBe(2);
    close();
  });

  it('keeps both applications, so one missing is a visible fact', () => {
    const { db, close } = open();
    recordOpenHandle(db, HOST);
    recordOpenHandle(db, { ...HOST, appName: 'TradeAnalyzer 2', appVersion: '0.1.2', processId: 4321 });

    const names = (db.prepare('SELECT app_name FROM meta_open_handle ORDER BY app_name').all() as {
      app_name: string;
    }[]).map((r) => r.app_name);
    expect(names).toEqual(['TradeAnalyzer', 'TradeAnalyzer 2']);
    close();
  });

  it('lets a disagreement about the path be READ rather than inferred', () => {
    // The shape of the 2026-09-07 corruption: two applications, one logical
    // path, two files. Whichever file a reader opens, the rows in it say which
    // application resolved which path — so the disagreement is data, not a
    // deduction from symptoms.
    const { db, close } = open();
    recordOpenHandle(db, HOST);
    recordOpenHandle(db, {
      ...HOST,
      appName: 'TradeAnalyzer 2',
      dbPath: 'C:\\Users\\u\\AppData\\Local\\Packages\\Some.App\\LocalCache\\Roaming\\gen-001\\data.sqlite'
    });

    const paths = new Set(
      (db.prepare('SELECT db_path FROM meta_open_handle').all() as { db_path: string }[]).map(
        (r) => r.db_path
      )
    );
    expect(paths.size).toBe(2);
    close();
  });
});
