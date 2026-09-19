// ListedExpirationFilter — chains are requested only for guessed Fridays the ticker actually lists.
//
// getNearTermExpirations guesses a fixed run of Fridays for every ticker, and on 2026-09-18 the
// existing app spent 5,295 E*Trade calls on dates a ticker never listed (400, code 10031 "There
// are no options for the given month") — 2,644 for Oct 30 and 2,643 for Oct 23, the weeklies of
// tickers that list only monthlies. The filter may only REMOVE unlisted dates: every chain fetched
// before must still be fetched, in the same order, or the picked contract could change (FR-SEY-5).
import { describe, it, expect } from 'vitest';
import { ListedExpirationFilter } from '../src/main/services/analysis-service.js';

// The guesses from 2026-09-18 (7 Fridays from the upcoming one).
const GUESSED = ['2026-09-18', '2026-09-25', '2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23', '2026-10-30'];
// A monthly-only ticker's listing, as E*Trade returns it (includes dates beyond the guesses).
const MONTHLY_ONLY = ['2026-09-18', '2026-10-16', '2026-11-20', '2026-12-18', '2027-01-15'];

function counting(result: string[] | (() => never)) {
  const calls: string[] = [];
  const fetch = (t: string) => async () => {
    calls.push(t);
    if (typeof result === 'function') return result();
    return result;
  };
  return { calls, fetch };
}

describe('ListedExpirationFilter', () => {
  it('drops the guessed weeklies a monthly-only ticker does not list, keeping order', async () => {
    const f = new ListedExpirationFilter(() => '2026-09-18');
    const { fetch } = counting(MONTHLY_ONLY);
    expect(await f.filter('CNA', GUESSED, fetch('CNA'))).toEqual(['2026-09-18', '2026-10-16']);
  });

  it('keeps every guess a weekly-listing ticker lists — nothing fetched before is lost', async () => {
    const f = new ListedExpirationFilter(() => '2026-09-18');
    const { fetch } = counting([...GUESSED, '2026-09-21', '2026-11-20']); // plus a Monday and a far monthly
    // Only guessed dates come back: the filter never ADDS a date the old path would not have tried.
    expect(await f.filter('SPY', GUESSED, fetch('SPY'))).toEqual(GUESSED);
  });

  it('keeps a holiday-shifted Thursday the ticker lists', async () => {
    const guessed = ['2026-06-18', '2026-06-26'];
    const f = new ListedExpirationFilter(() => '2026-06-15');
    const { fetch } = counting(['2026-06-18', '2026-07-17']);
    expect(await f.filter('AAPL', guessed, fetch('AAPL'))).toEqual(['2026-06-18']);
  });

  it('falls back to the guesses when the listing call throws, and does not cache the failure', async () => {
    const f = new ListedExpirationFilter(() => '2026-09-18');
    const failing = counting(() => { throw new Error('HTTP 401 token_rejected'); });
    expect(await f.filter('NVDA', GUESSED, failing.fetch('NVDA'))).toEqual(GUESSED);
    const ok = counting(MONTHLY_ONLY);
    expect(await f.filter('NVDA', GUESSED, ok.fetch('NVDA'))).toEqual(['2026-09-18', '2026-10-16']);
    expect(ok.calls).toHaveLength(1);
  });

  it('falls back to the guesses on an EMPTY listing — a transient 204 looks identical to "none"', async () => {
    const f = new ListedExpirationFilter(() => '2026-09-18');
    const empty = counting([]);
    expect(await f.filter('AMD', GUESSED, empty.fetch('AMD'))).toEqual(GUESSED);
    await f.filter('AMD', GUESSED, empty.fetch('AMD'));
    expect(empty.calls).toHaveLength(2); // not cached
  });

  it('asks once per ticker per ET day, and again the next day', async () => {
    let day = '2026-09-18';
    const f = new ListedExpirationFilter(() => day);
    const { calls, fetch } = counting(MONTHLY_ONLY);
    await f.filter('cna', GUESSED, fetch('CNA'));
    await f.filter('CNA', GUESSED, fetch('CNA'));
    expect(calls).toHaveLength(1);
    day = '2026-09-21';
    await f.filter('CNA', GUESSED, fetch('CNA'));
    expect(calls).toHaveLength(2);
  });
});
