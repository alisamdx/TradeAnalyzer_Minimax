import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { QC904_SHORT_INTEREST_FRESHNESS, SHORT_INTEREST_MAX_DAYS } from '../src/qa/checks/macro.js';

// QC-904 counted days since SETTLEMENT against 21, as if FINRA published instantly. The
// 2026-08-31 settlement read 22-25 days old on 2026-09-22..25 while the next one (2026-09-15)
// was not yet published and not yet due to be fetched — a domain exactly on schedule, reported
// as blocking after three runs (v1.1.316).

function run(newestSettlement: string | null, tradingDate: string) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE raw_short_interest (settlement_date TEXT NOT NULL)');
  if (newestSettlement) db.prepare('INSERT INTO raw_short_interest VALUES (?)').run(newestSettlement);
  const [e] = QC904_SHORT_INTEREST_FRESHNESS.run({ db, runId: 1, tradingDate, observedAt: `${tradingDate}T21:00:00Z` });
  db.close();
  return e!;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => Date.UTC(y, m, d);
const weekday = (ms: number) => ![0, 6].includes(new Date(ms).getUTCDay());
const back = (ms: number) => { while (!weekday(ms)) ms -= 86_400_000; return ms; };
const addBusinessDays = (ms: number, n: number) => {
  while (n > 0) { ms += 86_400_000; if (weekday(ms)) n--; }
  return ms;
};

describe('QC-904 short-interest freshness', () => {
  it('does not fire on the 2026-09-22..28 window that fired under the old 21-day rule', () => {
    for (const d of ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28']) {
      const e = run('2026-08-31', d);
      expect(e.fired, d).toBe(false);
      expect(e.closesAs?.kind, d).toBe('rule_changed');
    }
  });

  it('closes as data_corrected when the reading is fresh under either rule', () => {
    expect(run('2026-09-15', '2026-09-28').closesAs?.kind).toBe('data_corrected');
  });

  it('fires once a whole publication has been missed', () => {
    const e = run('2026-08-31', '2026-10-15');
    expect(e.fired).toBe(true);
    expect(e.closesAs).toBeUndefined();
  });

  it('fires when nothing has ever been stored', () => {
    expect(run(null, '2026-09-23').fired).toBe(true);
  });

  // Sweep a year of FINRA's schedule: settlements mid-month and month end (moved back to a
  // weekday), published after the close on the 7th business day, fetched on the next Monday
  // sweep. The previous settlement's age on the day its successor arrives is the largest a
  // healthy domain ever reads, and must never fire.
  it('never fires on a year of on-schedule settlements', () => {
    const settlements: number[] = [];
    for (let m = 0; m < 13; m++) {
      settlements.push(back(utc(2026, m, 15)));
      settlements.push(back(utc(2026, m + 1, 0)));
    }
    for (let i = 1; i < settlements.length; i++) {
      let fetched = addBusinessDays(settlements[i]!, 7) + 86_400_000;
      while (new Date(fetched).getUTCDay() !== 1) fetched += 86_400_000;
      const age = Math.round((fetched - settlements[i - 1]!) / 86_400_000);
      expect(age, `${iso(settlements[i - 1]!)} until ${iso(fetched)}`).toBeLessThanOrEqual(SHORT_INTEREST_MAX_DAYS);
      expect(run(iso(settlements[i - 1]!), iso(fetched)).fired).toBe(false);
    }
  });
});
