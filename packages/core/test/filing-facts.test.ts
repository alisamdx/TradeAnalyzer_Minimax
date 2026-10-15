import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost, ProviderResponse } from '../src/collector/host.js';
import { resetOffsetCache } from '../src/collector/archive.js';
import { beginRun, captureRuleId, type RunHandle } from '../src/collector/run.js';
import { captureResponse } from '../src/collector/capture.js';
import { recipes } from '../src/ingest/recipes.js';
import { ensureTradingCalendar } from '../src/collector/trading-calendar.js';
import { filingInstanceName, makeFilingFactsIngest } from '../src/ingest/edgar.js';
import { runEdgarFilingFacts } from '../src/collector/phases/events.js';
import { factsQueue, filingFactsQueue } from '../src/collector/facts-queue.js';
import { QC701_FILING_FRESHNESS, QC704_COMPANYFACTS_OMISSION } from '../src/qa/checks/earnings-fundamentals.js';

/**
 * The filing-facts fallback (v1.1.360): when SEC's companyfacts aggregate omits a report filing,
 * read the filing's own XBRL instance instead.
 *
 * `AVTR_INSTANCE` is an EXCERPT of real provider bytes — Avantor's Q1 10-Q,
 * https://www.sec.gov/Archives/edgar/data/1722482/000162828026028141/avtr-20260331_htm.xml, fetched
 * 2026-10-14 — with every line kept verbatim and most contexts, units and facts left out. `AVTR_CF`
 * holds the companyfacts points SEC publishes for the same accession, copied verbatim from
 * data.sec.gov/api/xbrl/companyfacts/CIK0001722482.json the same day. A parser tested against a
 * fixture written from the parser proves nothing (CLAUDE.md, the OSI padding quirk); this one is
 * tested against what the provider's own aggregate says the same filing contains.
 *
 * The full instance matched companyfacts 244/244 when this was written, as did AEP 10-Q
 * 0000004904-26-000034 (348/348, a multi-registrant filing) and Citi 10-K 0000831001-26-000011
 * (923/923).
 */
const AVTR_INSTANCE = `<?xml version="1.0" encoding="utf-8"?>
<xbrl
  xml:lang="en-US"
  xmlns="http://www.xbrl.org/2003/instance"
  xmlns:avtr="http://us.avtr.com/20260331"
  xmlns:dei="http://xbrl.sec.gov/dei/2025"
  xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
  xmlns:link="http://www.xbrl.org/2003/linkbase"
  xmlns:srt="http://fasb.org/srt/2025"
  xmlns:us-gaap="http://fasb.org/us-gaap/2025"
  xmlns:xbrldi="http://xbrl.org/2006/xbrldi"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <link:schemaRef xlink:href="avtr-20260331.xsd" xlink:type="simple"/>
    <context id="c-1">
        <entity>
            <identifier scheme="http://www.sec.gov/CIK">0001722482</identifier>
        </entity>
        <period>
            <startDate>2026-01-01</startDate>
            <endDate>2026-03-31</endDate>
        </period>
    </context>
    <context id="c-2">
        <entity>
            <identifier scheme="http://www.sec.gov/CIK">0001722482</identifier>
        </entity>
        <period>
            <instant>2026-04-24</instant>
        </period>
    </context>
    <context id="c-3">
        <entity>
            <identifier scheme="http://www.sec.gov/CIK">0001722482</identifier>
        </entity>
        <period>
            <instant>2026-03-31</instant>
        </period>
    </context>
    <context id="c-6">
        <entity>
            <identifier scheme="http://www.sec.gov/CIK">0001722482</identifier>
            <segment>
                <xbrldi:explicitMember dimension="us-gaap:StatementEquityComponentsAxis">us-gaap:CommonStockIncludingAdditionalPaidInCapitalMember</xbrldi:explicitMember>
            </segment>
        </entity>
        <period>
            <instant>2025-12-31</instant>
        </period>
    </context>
    <unit id="shares">
        <measure>shares</measure>
    </unit>
    <unit id="usd">
        <measure>iso4217:USD</measure>
    </unit>
    <unit id="usdPerShare">
        <divide>
            <unitNumerator>
                <measure>iso4217:USD</measure>
            </unitNumerator>
            <unitDenominator>
                <measure>shares</measure>
            </unitDenominator>
        </divide>
    </unit>
    <dei:DocumentFiscalYearFocus contextRef="c-1" id="f-29">2026</dei:DocumentFiscalYearFocus>
    <dei:DocumentFiscalPeriodFocus contextRef="c-1" id="f-30">Q1</dei:DocumentFiscalPeriodFocus>
    <dei:DocumentType contextRef="c-1" id="f-1">10-Q</dei:DocumentType>
    <dei:EntityCommonStockSharesOutstanding contextRef="c-2" decimals="INF" id="f-25" unitRef="shares">682755402</dei:EntityCommonStockSharesOutstanding>
    <us-gaap:Assets contextRef="c-3" decimals="-5" id="f-53" unitRef="usd">11663000000</us-gaap:Assets>
    <us-gaap:CommitmentsAndContingencies contextRef="c-3" id="f-75" unitRef="usd" xsi:nil="true"/>
    <us-gaap:Revenues contextRef="c-1" decimals="-5" id="f-98" unitRef="usd">1581400000</us-gaap:Revenues>
    <us-gaap:EarningsPerShareDiluted
      contextRef="c-1"
      decimals="2"
      id="f-122"
      unitRef="usdPerShare">0.06</us-gaap:EarningsPerShareDiluted>
    <us-gaap:SharesOutstanding contextRef="c-6" decimals="-5" id="f-150" unitRef="shares">682000000.0</us-gaap:SharesOutstanding>
    <avtr:NumberOfStockOptionExcisedAndOtherCommonStockTransactions contextRef="c-12" decimals="-5" id="f-162" unitRef="shares">900000</avtr:NumberOfStockOptionExcisedAndOtherCommonStockTransactions>
    <us-gaap:OrganizationConsolidationAndPresentationOfFinancialStatementsDisclosureTextBlock contextRef="c-1" id="f-250">&lt;div style="margin-top:12pt"&gt;&lt;span&gt;Avantor&lt;/span&gt;&lt;/div&gt;</us-gaap:OrganizationConsolidationAndPresentationOfFinancialStatementsDisclosureTextBlock>
    <dei:DocumentFiscalYearFocus contextRef="c-1" id="f-686">2026</dei:DocumentFiscalYearFocus>
    <us-gaap:Revenues contextRef="c-1" decimals="-5" id="f-401" unitRef="usd">1581400000</us-gaap:Revenues>
</xbrl>
`;

const ACCESSION = '0001628280-26-028141';

/** companyfacts' points for ACCESSION whose contexts the excerpt keeps — verbatim, frame and all. */
const AVTR_CF = [
  { taxonomy: 'us-gaap', concept: 'Revenues', unit: 'USD', p: { start: '2026-01-01', end: '2026-03-31', val: 1581400000, accn: ACCESSION, fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-04-29', frame: 'CY2026Q1' } },
  { taxonomy: 'us-gaap', concept: 'EarningsPerShareDiluted', unit: 'USD/shares', p: { start: '2026-01-01', end: '2026-03-31', val: 0.06, accn: ACCESSION, fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-04-29', frame: 'CY2026Q1' } },
  { taxonomy: 'dei', concept: 'EntityCommonStockSharesOutstanding', unit: 'shares', p: { end: '2026-04-24', val: 682755402, accn: ACCESSION, fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-04-29', frame: 'CY2026Q1I' } },
  { taxonomy: 'us-gaap', concept: 'Assets', unit: 'USD', p: { end: '2026-03-31', val: 11663000000, accn: ACCESSION, fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-04-29', frame: 'CY2026Q1I' } }
] as const;

let dir: string;
let raw: Database.Database;
let run: RunHandle;
const DATE = '2026-10-14';

const db = (): SqliteLike => raw as unknown as SqliteLike;
const response = (body: string, status: number | null = 200, on = DATE): ProviderResponse => ({
  status, body, requestedAt: `${on}T22:00:00Z`, respondedAt: status === null ? null : `${on}T22:00:01Z`
});

function makeHost(overrides: Partial<CollectorHost> = {}): CollectorHost {
  return {
    openGenerationDb: () => db(),
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    decryptFromArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    polygonGet: async () => response('{"results":[]}'),
    etradeGet: async () => response('{}'),
    httpGet: async () => response('{}'),
    nowET: () => `${DATE}T18:00:00-04:00`,
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test-host', version: '0.0.0' },
    ...overrides
  };
}

const ctx = () => ({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: 't' });
const rule = () => captureRuleId(db(), makeHost(), 'edgar', { v: 1 }, 'test');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-filing-facts-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
  raw.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) " +
      "VALUES (2, '2026-09-11T00:00:00-04:00', 'pilot', 'x', 'y')"
  );
  resetOffsetCache();
  ensureTradingCalendar(db(), makeHost(), DATE);
  run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

const ingestCtx = () => ({ runId: run.runId, asOfDate: DATE, observedAt: 't', captureRuleId: null, sourceResponseId: 1 });
const parseAvtr = () =>
  makeFilingFactsIngest({ cik: '0001722482', accessionNo: ACCESSION, form: '10-Q', filedDate: '2026-04-29' })(
    AVTR_INSTANCE, ingestCtx()
  );

describe('reading a filing\'s own XBRL instance', () => {
  it('produces exactly the rows companyfacts publishes for the same accession', () => {
    const rows = parseAvtr().map((r) => r.values);
    const key = (t: unknown, c: unknown, u: unknown, s: unknown, e: unknown) => [t, c, u, s ?? '', e].join('|');
    const got = new Map(rows.map((v) => [key(v['taxonomy'], v['concept'], v['unit'], v['period_start'], v['period_end']), v]));
    const want = new Map(AVTR_CF.map((f) => [key(f.taxonomy, f.concept, f.unit, 'start' in f.p ? f.p.start : null, f.p.end), f.p]));

    // Same set: no dimensional fact (SharesOutstanding on c-6), no nil, no text block, no
    // extension-taxonomy fact, and the repeated Revenues and DocumentFiscalYearFocus counted once.
    expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
    for (const [k, p] of want) {
      const v = got.get(k)!;
      expect(v['value']).toBe(p.val);
      expect(v['fiscal_year']).toBe(p.fy);
      expect(v['fiscal_period']).toBe(p.fp);
      expect(v['form']).toBe(p.form);
      expect(v['filed_date']).toBe(p.filed);
      expect(v['accession_no']).toBe(p.accn);
      // frame is SEC's cross-filing deduplication and exists only in the aggregate.
      expect(v['frame']).toBeNull();
    }
  });

  it('stores an instant with a null period_start, as companyfacts does', () => {
    const assets = parseAvtr().find((r) => r.values['concept'] === 'Assets');
    expect(assets?.values['period_start']).toBeNull();
    expect(assets?.values['period_end']).toBe('2026-03-31');
  });

  it('identifies a taxonomy by its namespace, not by the prefix the filer chose', () => {
    // Every element prefixed, and us-gaap bound to `gaap`: the same fact, the same row.
    const prefixed = `<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:gaap="http://fasb.org/us-gaap/2024"
        xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:co="http://example.com/2024">
      <xbrli:context id="D"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">1</xbrli:identifier></xbrli:entity>
        <xbrli:period><xbrli:startDate>2024-01-01</xbrli:startDate><xbrli:endDate>2024-12-31</xbrli:endDate></xbrli:period></xbrli:context>
      <xbrli:unit id="U"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
      <gaap:NetIncomeLoss contextRef="D" unitRef="U" decimals="-6">-5000000</gaap:NetIncomeLoss>
      <co:Custom contextRef="D" unitRef="U">7</co:Custom>
    </xbrli:xbrl>`;
    const rows = makeFilingFactsIngest({ cik: '0000000001', accessionNo: 'A', form: '10-K', filedDate: '2025-02-01' })(prefixed, ingestCtx());
    expect(rows.map((r) => [r.values['taxonomy'], r.values['concept'], r.values['value'], r.values['unit']])).toEqual([
      ['us-gaap', 'NetIncomeLoss', -5000000, 'USD']
    ]);
    // No dei block: the filing's fy/fp are unknown, stored as companyfacts' own defaults would read.
    expect(rows[0]?.values['fiscal_period']).toBe('');
  });

  it('refuses a 200 that is not an XBRL instance, so it lands as a parse failure', () => {
    expect(() =>
      makeFilingFactsIngest({ cik: '1', accessionNo: 'A', form: '10-Q', filedDate: '2026-01-01' })(
        '<!DOCTYPE html><html><title>Your Request Originates from an Undeclared Automated Tool</title></html>', ingestCtx()
      )
    ).toThrow(/not an XBRL instance/);
  });

  it('finds the instance in a filing directory listing', () => {
    const listing = (...names: string[]) => JSON.stringify({ directory: { item: names.map((name) => ({ name })) } });
    // The real AEP Q2 directory carries R-files, linkbases, exhibits and the inline instance.
    expect(filingInstanceName(listing('aep-20260630.htm', 'aep-20260630.xsd', 'aep-20260630_cal.xml', 'aep-20260630_def.xml',
      'aep-20260630_htm.xml', 'aep-20260630_lab.xml', 'aep-20260630_pre.xml', 'FilingSummary.xml', 'R1.htm'))).toBe('aep-20260630_htm.xml');
    // A plain-XBRL filing: its one non-linkbase .xml.
    expect(filingInstanceName(listing('x-20101231.xml', 'x-20101231_lab.xml', 'x-20101231.xsd', 'FilingSummary.xml'))).toBe('x-20101231.xml');
    // No XBRL at all, or an ambiguous pair: nothing to read, which is not a parse failure.
    expect(filingInstanceName(listing('doc.htm', 'ex31.htm'))).toBeNull();
    expect(filingInstanceName(listing('a.xml', 'b.xml'))).toBeNull();
  });
});

describe('the fallback in the collector', () => {
  /** A submissions response listing one report filing for `cik`. */
  function filing(cik: string, ticker: string, accession: string, filed: string) {
    const r = captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'edgar',
      endpoint: '/submissions/CIK{cik}.json', slug: 'edgar-submissions', params: { cik, n: accession },
      response: response(JSON.stringify({ filings: { recent: {
        accessionNumber: [accession], form: ['10-Q'], filingDate: [filed], reportDate: ['2026-03-31'],
        primaryDocument: ['q.htm']
      } } })),
      captureRuleId: rule(), recipe: recipes.submissions({ cik, ticker })
    });
    expect(r.parseStatus).toBe('ok');
  }

  /** A companyfacts response fetched on `fetchedOn` holding one fact from an OLDER accession. */
  function companyfacts(cik: string, olderAccession: string, end: string, fetchedOn: string) {
    const r = captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'edgar',
      endpoint: '/api/xbrl/companyfacts/CIK{cik}.json', slug: 'edgar-companyfacts', params: { cik },
      response: response(JSON.stringify({ facts: { 'us-gaap': { Revenues: { units: { USD: [
        { end, val: 1, accn: olderAccession, fy: 2025, fp: 'FY', form: '10-K', filed: '2026-02-11' }
      ] } } } } }), 200, fetchedOn),
      captureRuleId: rule(), recipe: recipes.companyFacts({ cik })
    });
    expect(r.parseStatus).toBe('ok');
  }

  /** In the chain subset with a ticker reference, which is what QC-701 reads. */
  function listed(ticker: string, cik: string) {
    captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'polygon',
      endpoint: `/v3/reference/tickers/${ticker}`, slug: 'ref', params: { ticker },
      response: response(JSON.stringify({ results: { ticker, name: ticker, type: 'CS', cik } })),
      captureRuleId: rule(), recipe: recipes.tickerReference()
    });
    raw.prepare(
      `INSERT INTO ref_chain_subset_membership (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
         ticker, valid_from, membership_reason, rule_capture_rule_id, rule_inputs_json)
       VALUES (?, ?, ?, ?, (SELECT MAX(source_response_id) FROM meta_response), ?, '2026-09-01', 'rule_pass', ?, '{}')`
    ).run(run.runId, DATE, `${DATE}T17:00:00-04:00`, rule(), ticker, rule());
  }

  /** SEC as the fallback sees it: a listing naming the instance, then the instance. */
  function sec(asked: string[], over: { index?: ProviderResponse; instance?: ProviderResponse } = {}) {
    return makeHost({
      httpGet: async (url: string) => {
        asked.push(url);
        if (url.endsWith('/index.json')) {
          return over.index ?? response(JSON.stringify({ directory: { item: [{ name: 'avtr-20260331.htm' }, { name: 'avtr-20260331_htm.xml' }] } }));
        }
        return over.instance ?? response(AVTR_INSTANCE);
      }
    });
  }

  /** AVTR's shape: companyfacts read 2026-10-08, long after the filing, and still without it. */
  function omittedFiling() {
    listed('AVTR', '0001722482');
    filing('0001722482', 'AVTR', ACCESSION, '2026-04-29');
    companyfacts('0001722482', '0001722482-26-000010', '2025-12-31', '2026-10-08');
  }

  it('reads an omitted filing\'s instance, which clears QC-701 and closes QC-704 as data_corrected', async () => {
    omittedFiling();
    expect(QC704_COMPANYFACTS_OMISSION.run(ctx()).find((e) => e.key === ACCESSION)?.fired).toBe(true);
    expect(QC701_FILING_FRESHNESS.run(ctx()).find((e) => e.key === 'AVTR')?.evidence?.['cause']).toBe('sec_companyfacts_missing');

    const asked: string[] = [];
    const result = await runEdgarFilingFacts(sec(asked), db(), run);
    expect(asked).toEqual([
      'https://www.sec.gov/Archives/edgar/data/1722482/000162828026028141/index.json',
      'https://www.sec.gov/Archives/edgar/data/1722482/000162828026028141/avtr-20260331_htm.xml'
    ]);
    expect(result).toEqual({ stored: 4, calls: 2, failed: 0 });

    const qc704 = QC704_COMPANYFACTS_OMISSION.run(ctx()).find((e) => e.key === ACCESSION);
    expect(qc704).toMatchObject({ fired: false, closesAs: { kind: 'data_corrected' } });
    expect(qc704?.detail).toContain("read from the filing's own XBRL instance");
    // QC-701 now reads the 10-Q's own facts — its newest is the 2026-04-24 cover date, where the
    // companyfacts fact alone said 2025-12-31 — and no longer has an omitted filing to blame SEC for.
    // (The fixture is the Q1 report, so on this date it is old for its own reasons; a live Q2 recovery
    // brings the newest period to 06-30 and the finding closes.)
    const qc701 = QC701_FILING_FRESHNESS.run(ctx()).find((e) => e.key === 'AVTR');
    expect(qc701?.evidence?.['newestPeriodEnd']).toBe('2026-04-24');
    expect(qc701?.evidence?.['cause']).not.toBe('sec_companyfacts_missing');

    // Harvested now, so neither queue asks for it again.
    expect(filingFactsQueue(db(), DATE)).toEqual([]);
    expect(factsQueue(db(), '2026-12-31')).toEqual([]);
  });

  it('leaves alone a filing companyfacts has not had two weeks to hold', () => {
    filing('0001722482', 'AVTR', ACCESSION, '2026-10-01');
    companyfacts('0001722482', '0001722482-26-000010', '2025-12-31', '2026-10-08');   // 7 days after filing
    expect(filingFactsQueue(db(), DATE)).toEqual([]);
  });

  it('records a filing with no XBRL and waits the weekly cadence before asking again', async () => {
    omittedFiling();
    const asked: string[] = [];
    const host = sec(asked, { index: response(JSON.stringify({ directory: { item: [{ name: 'q.htm' }] } })) });
    expect(await runEdgarFilingFacts(host, db(), run)).toEqual({ stored: 0, calls: 1, failed: 0 });
    // The listing is on record, so the attempt is too.
    expect(filingFactsQueue(db(), DATE)).toEqual([]);
    expect(filingFactsQueue(db(), '2026-10-20')).toEqual([]);
    expect(filingFactsQueue(db(), '2026-10-21').map((f) => f.accessionNo)).toEqual([ACCESSION]);
    // And QC-704 still fires: the facts are still missing.
    expect(QC704_COMPANYFACTS_OMISSION.run(ctx()).find((e) => e.key === ACCESSION)?.fired).toBe(true);
  });

  it('counts a refused listing and an unparseable instance as failures, both retried next week', async () => {
    omittedFiling();
    const refused = await runEdgarFilingFacts(sec([], { index: response('<html>Access Denied</html>', 403) }), db(), run);
    expect(refused).toEqual({ stored: 0, calls: 1, failed: 1 });

    const later = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: '2026-10-21' });
    const html = await runEdgarFilingFacts(sec([], { instance: response('<!DOCTYPE html><html></html>', 200, '2026-10-21') }), db(), later);
    expect(html).toEqual({ stored: 0, calls: 2, failed: 1 });
    const failures = raw
      .prepare("SELECT endpoint, parse_error FROM meta_response WHERE endpoint LIKE '/Archives/edgar/data/%' AND parse_status = 'failed' ORDER BY source_response_id")
      .all() as { endpoint: string; parse_error: string }[];
    expect(failures.map((f) => f.endpoint)).toEqual([
      '/Archives/edgar/data/{cik}/{accession}/index.json',
      '/Archives/edgar/data/{cik}/{accession}/{instance}'
    ]);
    expect(failures[1]?.parse_error).toMatch(/not an XBRL instance/);
  });

  it('closes QC-704 as provider_fixed, not data_corrected, when SEC itself adds the filing', () => {
    omittedFiling();
    // companyfacts read again a week later, now holding the 10-Q.
    const r = captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'edgar',
      endpoint: '/api/xbrl/companyfacts/CIK{cik}.json', slug: 'edgar-companyfacts', params: { cik: '0001722482', again: 1 },
      response: response(JSON.stringify({ facts: { 'us-gaap': { Assets: { units: { USD: [AVTR_CF[3].p] } } } } }), 200, '2026-10-14'),
      captureRuleId: rule(), recipe: recipes.companyFacts({ cik: '0001722482' })
    });
    expect(r.parseStatus).toBe('ok');
    expect(QC704_COMPANYFACTS_OMISSION.run(ctx()).find((e) => e.key === ACCESSION)).toMatchObject({
      fired: false, closesAs: { kind: 'provider_fixed' }
    });
  });
});
