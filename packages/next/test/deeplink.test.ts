import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEEP_LINK_SCHEME,
  findDeepLink,
  isQueueableKind,
  parseDeepLink,
  QUEUEABLE_KINDS,
  type DeepLinkRoute
} from '../src/shared/deeplink.js';

/**
 * The deep-link grammar (05 §11.1), and the rule that a link can only navigate.
 */

const known = (t: string): boolean => t === 'raw_daily_bar' || t === 'qa_exception';
const parse = (url: string): DeepLinkRoute => parseDeepLink(url, known);

describe('the grammar', () => {
  it('opens the workbench filtered to a run — the status email\'s link', () => {
    expect(parse('tradeanalyzer-next://exceptions?run=42')).toEqual({ section: 'exceptions', runId: 42 });
  });

  it('opens one exception, one run, and one table', () => {
    expect(parse('tradeanalyzer-next://exceptions/17')).toEqual({ section: 'exceptions', exceptionId: 17 });
    expect(parse('tradeanalyzer-next://runs/9')).toEqual({ section: 'runs', runId: 9 });
    expect(parse('tradeanalyzer-next://table/raw_daily_bar?as_of=2026-09-04'))
      .toEqual({ section: 'data', table: 'raw_daily_bar', asOf: '2026-09-04' });
    expect(parse('tradeanalyzer-next://table/qa_exception')).toEqual({ section: 'data', table: 'qa_exception' });
  });

  it('forgives a trailing slash and the scheme\'s case', () => {
    expect(parse('tradeanalyzer-next://runs/9/')).toEqual({ section: 'runs', runId: 9 });
    expect(parse('TradeAnalyzer-Next://EXCEPTIONS/3')).toEqual({ section: 'exceptions', exceptionId: 3 });
  });

  it('matches what the status email actually writes', () => {
    // The email is in `core` and this grammar is in `next`. They were written
    // against the same spec section two build steps apart; this pins them to
    // each other rather than to the spec's prose.
    const email = readFileSync(
      fileURLToPath(new URL('../../core/src/qa/email.ts', import.meta.url)),
      'utf8'
    );
    expect(email).toContain(`${DEEP_LINK_SCHEME}://exceptions?run=\${`);
  });
});

describe('an unusable link lands on Overview with the reason, never silently', () => {
  const cases: [string, RegExp][] = [
    ['not a url', /not a well-formed link/],
    ['https://example.com/exceptions/1', /not a tradeanalyzer-next/],
    ['tradeanalyzer-next://settings', /not a screen/],
    ['tradeanalyzer-next://exceptions/abc', /not an exception id/],
    ['tradeanalyzer-next://exceptions/0', /not an exception id/],
    ['tradeanalyzer-next://exceptions?run=-1', /not a run id/],
    ['tradeanalyzer-next://runs/1/2', /more path/],
    ['tradeanalyzer-next://table/sqlite_master', /declares no table/],
    ['tradeanalyzer-next://table/raw_daily_bar?as_of=yesterday', /not a date/],
    ['tradeanalyzer-next://table', /names no table/]
  ];
  for (const [url, why] of cases) {
    it(url, () => {
      const route = parse(url);
      expect(route.section).toBe('overview');
      expect(route.section === 'overview' ? route.problem : '').toMatch(why);
    });
  }
});

describe('a link can only navigate (05 §11.1)', () => {
  it('ignores anything a link adds beyond where to go', () => {
    // An email can be made to carry any link. So the parser returns a place,
    // and nothing it returns can express "and then resolve / queue / reset".
    const route = parse('tradeanalyzer-next://exceptions/5?resolve=false_positive&note=x&run=3');
    expect(route).toEqual({ section: 'exceptions', exceptionId: 5 });
  });

  it('has no route for jobs or reset at all', () => {
    expect(parse('tradeanalyzer-next://jobs/reset').section).toBe('overview');
    expect(parse('tradeanalyzer-next://jobs?queue=backfill_bars').section).toBe('overview');
  });
});

describe('finding the link a second instance was started with', () => {
  it('picks the link out of the arguments Windows passes, whatever their order', () => {
    expect(findDeepLink(['C:\\app\\TradeAnalyzer2.exe', '--flag', 'tradeanalyzer-next://runs/4']))
      .toBe('tradeanalyzer-next://runs/4');
    expect(findDeepLink(['C:\\app\\TradeAnalyzer2.exe', 'TRADEANALYZER-NEXT://runs/4'])).toBe('TRADEANALYZER-NEXT://runs/4');
    expect(findDeepLink(['C:\\app\\TradeAnalyzer2.exe'])).toBeUndefined();
  });
});

describe('what the Jobs view may queue', () => {
  it('never queues reset (executed here) or replay (B9b)', () => {
    expect(QUEUEABLE_KINDS).not.toContain('reset');
    expect(QUEUEABLE_KINDS).not.toContain('replay');
    expect(isQueueableKind('reset')).toBe(false);
    expect(isQueueableKind('backfill_bars')).toBe(true);
  });
});
