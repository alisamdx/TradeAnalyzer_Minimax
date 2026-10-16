// The existing app's fundamentals read SEC companyfacts only, and companyfacts drops filings:
// most 10-Qs filed 2026-07-28/29 (AEP, CTSH, HCA, CLH, KO, Citi, …) were still absent 70+ days
// later, so every TTM figure, growth rate and balance-sheet line for those filers silently stayed a
// quarter old. Since v1.1.365 a filer that looks a filing behind is checked against its submissions
// and the missing filing is read from its own XBRL instance, with core's parser.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseFilingInstance } from '@tradeanalyzer/core';
import {
  getEdgarFundamentals,
  mergeFilingFacts,
  newestReport,
  reportFilingsAfter,
  FILING_CHECK_AFTER_DAYS,
  type EdgarEntry,
} from '../src/main/services/sec-edgar-provider.js';
import { edgarLimiter } from '../src/main/services/edgar-identity.js';

const CIK = '0001058290';

/** A minimal instance in the shape of a real one: dei block, one duration and one instant context. */
const INSTANCE = `<?xml version="1.0" encoding="utf-8"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance" xmlns:dei="http://xbrl.sec.gov/dei/2025"
  xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:us-gaap="http://fasb.org/us-gaap/2025">
  <context id="d"><entity><identifier scheme="http://www.sec.gov/CIK">${CIK}</identifier></entity>
    <period><startDate>2026-04-01</startDate><endDate>2026-06-30</endDate></period></context>
  <context id="i"><entity><identifier scheme="http://www.sec.gov/CIK">${CIK}</identifier></entity>
    <period><instant>2026-06-30</instant></period></context>
  <unit id="usd"><measure>iso4217:USD</measure></unit>
  <dei:DocumentFiscalYearFocus contextRef="d">2026</dei:DocumentFiscalYearFocus>
  <dei:DocumentFiscalPeriodFocus contextRef="d">Q2</dei:DocumentFiscalPeriodFocus>
  <us-gaap:StockholdersEquity contextRef="i" unitRef="usd" decimals="-6">250000000</us-gaap:StockholdersEquity>
  <us-gaap:Revenues contextRef="d" unitRef="usd" decimals="-6">5000000000</us-gaap:Revenues>
</xbrl>`;

type Facts = Record<string, { units: Record<string, EdgarEntry[]> }>;

describe('newestReport', () => {
  it('reads the newest 10-Q/10-K period end and filing date, ignoring other forms', () => {
    const gaap: Facts = {
      Revenues: { units: { USD: [
        { start: '2025-01-01', end: '2025-12-31', val: 1, fp: 'FY', form: '10-K', filed: '2026-02-20' },
        { start: '2026-01-01', end: '2026-03-31', val: 1, fp: 'Q1', form: '10-Q', filed: '2026-04-29' },
        { start: '2026-01-01', end: '2026-06-30', val: 1, fp: 'Q2', form: '8-K', filed: '2026-07-30' },
      ] } },
    };
    expect(newestReport(gaap)).toEqual({ end: '2026-03-31', filed: '2026-04-29' });
    expect(newestReport({})).toEqual({ end: null, filed: null });
  });
});

describe('mergeFilingFacts', () => {
  it('adds a filing\'s us-gaap facts as companyfacts entries, once', () => {
    const gaap: Facts = {};
    const facts = parseFilingInstance(INSTANCE);
    expect(mergeFilingFacts(gaap, facts, { form: '10-Q', filed: '2026-07-29' })).toBe(2);
    expect(gaap['StockholdersEquity']?.units['USD']).toEqual([
      { end: '2026-06-30', val: 250000000, fp: 'Q2', form: '10-Q', filed: '2026-07-29' },
    ]);
    expect(gaap['Revenues']?.units['USD']?.[0]).toMatchObject({ start: '2026-04-01', end: '2026-06-30', fp: 'Q2' });
    // dei facts are not us-gaap and this provider reads us-gaap only.
    expect(Object.keys(gaap).sort()).toEqual(['Revenues', 'StockholdersEquity']);
    // Merging the same filing again adds nothing.
    expect(mergeFilingFacts(gaap, facts, { form: '10-Q', filed: '2026-07-29' })).toBe(0);
  });
});

describe('reportFilingsAfter', () => {
  it('lists the newest 10-Q/10-K filed after a date, newest first, two at most', () => {
    const subs = { filings: { recent: {
      accessionNumber: ['A-8K', 'A-Q2', 'A-Q1', 'A-K', 'A-QA'],
      form: ['8-K', '10-Q', '10-Q', '10-K', '10-Q/A'],
      filingDate: ['2026-08-01', '2026-07-29', '2026-04-29', '2026-02-20', '2026-05-10'],
    } } };
    expect(reportFilingsAfter(subs, '2026-04-29')).toEqual([{ accession: 'A-Q2', form: '10-Q', filed: '2026-07-29' }]);
    expect(reportFilingsAfter(subs, '2026-01-01').map((f) => f.accession)).toEqual(['A-Q2', 'A-Q1']);
    expect(reportFilingsAfter({}, '2026-01-01')).toEqual([]);
  });

  it('does not misalign a short companion array — the accession array sets the row count', () => {
    const subs = { filings: { recent: { accessionNumber: ['A-1', 'A-2'], form: ['10-Q'], filingDate: ['2026-07-29', '2026-04-29'] } } };
    expect(reportFilingsAfter(subs, '2026-01-01')).toEqual([{ accession: 'A-1', form: '10-Q', filed: '2026-07-29' }]);
  });
});

describe('getEdgarFundamentals with a filing companyfacts omitted (CTSH, 2026-10-15)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubSec(companyfactsEquityEnd: string): string[] {
    // The shared sec.gov bucket refills on Date.now(), which a frozen fake clock never advances.
    vi.spyOn(edgarLimiter, 'acquire').mockResolvedValue(undefined);
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      asked.push(url);
      const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
      if (url.endsWith('company_tickers.json')) return json({ 0: { cik_str: 1058290, ticker: 'CTSH', title: 'Cognizant' } });
      if (url.includes('/api/xbrl/companyfacts/')) {
        // A concept needs an annual (10-K) point to be selected at all (`pickBestConcept`).
        return json({ facts: { 'us-gaap': { StockholdersEquity: { units: { USD: [
          { end: '2025-12-31', val: 90000000, fp: 'FY', form: '10-K', filed: '2026-02-20' },
          { end: companyfactsEquityEnd, val: 100000000, fp: 'Q1', form: '10-Q', filed: '2026-04-29' },
        ] } } } } });
      }
      if (url.includes('/submissions/')) {
        return json({ filings: { recent: { accessionNumber: ['0001058290-26-000031'], form: ['10-Q'], filingDate: ['2026-07-29'] } } });
      }
      if (url.endsWith('/index.json')) return json({ directory: { item: [{ name: 'ctsh-20260630.htm' }, { name: 'ctsh-20260630_htm.xml' }] } });
      if (url.endsWith('_htm.xml')) return new Response(INSTANCE, { status: 200 });
      return new Response('', { status: 404 });
    }));
    return asked;
  }

  it('reads the omitted 10-Q from its own instance, so the balance sheet is the June one, not March', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    const asked = stubSec('2026-03-31'); // 198 days old: companyfacts is a filing behind

    const result = await getEdgarFundamentals('CTSH');

    expect(asked).toContain('https://www.sec.gov/Archives/edgar/data/1058290/000105829026000031/ctsh-20260630_htm.xml');
    expect(result.filings?.[0]?.financials?.balance_sheet?.equity?.value).toBe(250000000);
  });

  it(`does not look for a missing filing while companyfacts is current (newest period < ${FILING_CHECK_AFTER_DAYS} days)`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-15T12:00:00Z'));
    const asked = stubSec('2026-03-31'); // 45 days old: current

    const result = await getEdgarFundamentals('CTSH');

    expect(asked.some((u) => u.includes('/submissions/'))).toBe(false);
    expect(result.filings?.[0]?.financials?.balance_sheet?.equity?.value).toBe(100000000);
  });
});
