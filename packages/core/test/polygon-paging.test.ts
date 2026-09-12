import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost, ProviderResponse } from '../src/collector/host.js';
import { beginRun, captureRuleId } from '../src/collector/run.js';
import { runBackfillBars } from '../src/collector/backfill.js';
import { runActionsPhase } from '../src/collector/phases/market.js';
import {
  sweepPolygonPages, nextPolygonPage, type PolygonPage
} from '../src/collector/paged.js';

/**
 * The defect these tests pin, measured 2026-09-11 on the first real backfill:
 * the five-year split sweep returned **exactly 1,000 splits**, which is the
 * `limit` parameter rather than a count of corporate actions. `next_url` was
 * ignored and no `atProviderCap` was passed, so QC-008 — blocking, and written
 * for precisely this — could not fire. QC-204 marks a discontinuity `explained`
 * only when a matching split sits in the gap, so the run opened 512 findings
 * against a list that was missing an unknown number of rows.
 */

let dir: string;
let raw: Database.Database;
let db: SqliteLike;

function makeHost(polygonGet?: CollectorHost['polygonGet']): CollectorHost {
  return {
    openGenerationDb: () => db,
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => b,
    decryptFromArchive: (b) => b,
    polygonGet:
      polygonGet ?? (async () => ({ status: 200, body: '{"results":[]}', requestedAt: 't', respondedAt: 't' })),
    etradeGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    httpGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    nowET: () => '2026-09-06T18:00:00-04:00',
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test', version: '0' }
  };
}

function res(body: string): ProviderResponse {
  return { status: 200, body, requestedAt: 't', respondedAt: 't' };
}

function splitPage(tickers: readonly string[], nextUrl?: string): string {
  return JSON.stringify({
    results: tickers.map((t) => ({
      id: `split-${t}`, ticker: t, execution_date: '2026-06-15', split_from: 1, split_to: 4
    })),
    ...(nextUrl !== undefined ? { next_url: nextUrl } : {})
  });
}

function dividendPage(tickers: readonly string[], nextUrl?: string): string {
  return JSON.stringify({
    results: tickers.map((t) => ({
      id: `div-${t}`, ticker: t, ex_dividend_date: '2026-09-04', cash_amount: 0.25,
      currency: 'USD', frequency: 4, dividend_type: 'CD'
    })),
    ...(nextUrl !== undefined ? { next_url: nextUrl } : {})
  });
}

function cleanSeries(base = 100): string {
  const day = 86_400_000;
  const start = Date.parse('2026-06-01T00:00:00Z');
  return JSON.stringify({
    results: Array.from({ length: 50 }, (_, i) => ({
      t: start + i * day, o: base, h: base + 1, l: base - 1, c: base + (i % 3) * 0.1, v: 1_000_000 + i
    }))
  });
}

function seedUniverse(tickers: readonly string[]): void {
  const host = makeHost();
  const run = beginRun(db, host, { kind: 'manual', tradingDate: '2026-09-06' });
  const ruleId = captureRuleId(db, host, 'universe', { lists: ['sp500'] }, 'test');
  raw.exec(
    'INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) ' +
      `VALUES (9001, ${run.runId}, 'polygon', '/x', '{}', 't', 'a', 0, 'seed-hash', 0, 0, 'ok')`
  );
  for (const t of tickers) {
    raw
      .prepare(
        `INSERT INTO ref_universe_membership (
           run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
           ticker, list_source, valid_from, valid_to, change_reason
         ) VALUES (?,?,?,?,?,?, 'sp500', '2021-01-01', NULL, 'initial')`
      )
      .run(run.runId, '2026-09-06', 't', ruleId, 9001, t);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-paging-'));
  raw = new Database(join(dir, 'data.sqlite'));
  db = raw as unknown as SqliteLike;
  applyDictionary(db);
  raw.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) VALUES (1,'t','pilot','x','y')"
  );
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('nextPolygonPage', () => {
  it('returns none when the body carries no cursor', () => {
    expect(nextPolygonPage(res(splitPage(['AAA'])))).toEqual({ kind: 'none' });
  });

  it('returns none when the body will not parse, leaving the capture to report it', () => {
    expect(nextPolygonPage(res('<html>404 page not found</html>'))).toEqual({ kind: 'none' });
  });

  it('decomposes a next_url into the path and params the transport takes', () => {
    const next = nextPolygonPage(
      res(splitPage(['AAA'], 'https://api.polygon.io/v3/reference/splits?cursor=abc&limit=1000'))
    );
    expect(next.kind).toBe('follow');
    if (next.kind !== 'follow') return;
    expect(next.path).toBe('/v3/reference/splits');
    expect(next.params).toEqual({ cursor: 'abc', limit: '1000' });
  });

  it('drops an apiKey echoed back inside the cursor URL', () => {
    // `params` is stored in `meta_response.params_json` and printed by the Runs
    // view. A credential arriving in a response body must not be written back out
    // because the provider happened to include it.
    const next = nextPolygonPage(
      res(splitPage(['AAA'], 'https://api.polygon.io/v3/reference/splits?cursor=abc&apiKey=SECRET'))
    );
    expect(next.kind).toBe('follow');
    if (next.kind !== 'follow') return;
    expect(next.params['apiKey']).toBeUndefined();
    expect(JSON.stringify(next)).not.toContain('SECRET');
  });

  it('refuses a next_url pointing anywhere but Polygon', () => {
    // The origin is discarded regardless — `polygonGet` builds the host itself, so
    // a body cannot redirect a request. The refusal is about the PATH: one meant
    // for another service, issued against Polygon, is a request nobody intended.
    const next = nextPolygonPage(
      res(splitPage(['AAA'], 'https://evil.example.com/v3/reference/splits?cursor=abc'))
    );
    expect(next.kind).toBe('refused');
    if (next.kind !== 'refused') return;
    expect(next.reason).toContain('evil.example.com');
  });
});

describe('sweepPolygonPages', () => {
  it('follows the cursor to the end of the list and flags nothing', async () => {
    const bodies = [
      splitPage(['AAA'], 'https://api.polygon.io/v3/reference/splits?cursor=c2'),
      splitPage(['BBB'], 'https://api.polygon.io/v3/reference/splits?cursor=c3'),
      splitPage(['CCC'])
    ];
    const calls: { path: string; params: Record<string, string> }[] = [];
    const host = makeHost(async (path, params) => {
      calls.push({ path, params: { ...params } });
      return res(bodies[calls.length - 1]!);
    });

    const pages: PolygonPage[] = [];
    const sweep = await sweepPolygonPages(host, {
      path: '/v3/reference/splits',
      params: { limit: '1000' },
      onPage: (p) => pages.push(p)
    });

    expect(sweep.pages).toBe(3);
    expect(sweep.truncated).toBe(false);
    expect(pages.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(pages.some((p) => p.atProviderCap)).toBe(false);
    expect(calls[1]!.params['cursor']).toBe('c2');
    expect(calls[2]!.params['cursor']).toBe('c3');
  });

  it('flags the last page when the page budget is spent with more available', async () => {
    // The replacement for the silent truncation: stopping early is still allowed,
    // but it is now RECORDED, and QC-008 is blocking.
    //
    // Each page carries a DISTINCT cursor, so the budget is what stops the sweep.
    // An unchanging cursor trips the loop guard first — which is correct, and is
    // a different assertion, made by the test below.
    let n = 0;
    const host = makeHost(async () => {
      n++;
      return res(splitPage([`T${n}`], `https://api.polygon.io/v3/reference/splits?cursor=c${n}`));
    });

    const pages: PolygonPage[] = [];
    const sweep = await sweepPolygonPages(host, {
      path: '/v3/reference/splits',
      params: { limit: '1000' },
      maxPages: 2,
      onPage: (p) => pages.push(p)
    });

    expect(sweep.pages).toBe(2);
    expect(sweep.truncated).toBe(true);
    expect(pages[0]!.atProviderCap).toBe(false);
    expect(pages[1]!.atProviderCap).toBe(true);
    expect(pages[1]!.capReason).toContain('page budget');
  });

  it('stops when the cursor stops advancing, rather than looping forever', async () => {
    let n = 0;
    const host = makeHost(async () => {
      n++;
      return res(splitPage([`T${n}`], 'https://api.polygon.io/v3/reference/splits?cursor=same'));
    });

    const pages: PolygonPage[] = [];
    const sweep = await sweepPolygonPages(host, {
      path: '/v3/reference/splits',
      params: { limit: '1000' },
      onPage: (p) => pages.push(p)
    });

    expect(sweep.pages).toBe(2);
    expect(sweep.truncated).toBe(true);
    expect(pages[1]!.capReason).toContain('repeated');
    expect(n).toBe(2);
  });

  it('stops and flags rather than following a cursor off Polygon', async () => {
    let n = 0;
    const host = makeHost(async () => {
      n++;
      return res(splitPage(['AAA'], 'https://evil.example.com/v3/reference/splits?cursor=x'));
    });

    const pages: PolygonPage[] = [];
    const sweep = await sweepPolygonPages(host, {
      path: '/v3/reference/splits',
      params: { limit: '1000' },
      onPage: (p) => pages.push(p)
    });

    expect(n).toBe(1);
    expect(sweep.truncated).toBe(true);
    expect(pages[0]!.atProviderCap).toBe(true);
  });
});

describe('the call sites that were truncating', () => {
  it('sums every split page in the backfill, and flags none of them', async () => {
    seedUniverse(['AAPL']);
    let splitCalls = 0;
    const host = makeHost(async (path) => {
      if (!path.includes('/splits')) return res(cleanSeries());
      splitCalls++;
      return res(
        splitCalls === 1
          ? splitPage(['AAA'], 'https://api.polygon.io/v3/reference/splits?cursor=p2')
          : splitPage(['BBB'])
      );
    });

    const report = await runBackfillBars(host, { tradingDate: '2026-09-06' });

    expect(report.splitPages).toBe(2);
    expect(report.splitsStored).toBe(2);
    expect(report.splitsTruncated).toBe(false);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM raw_split').get()).toEqual({ n: 2 });
    // A complete sweep must leave QC-008 with nothing to say, or the check that
    // exists for truncation becomes noise on every healthy run.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM meta_response WHERE at_provider_cap = 1').get())
      .toEqual({ n: 0 });
  });

  it('records at_provider_cap when the backfill split list is left incomplete', async () => {
    seedUniverse(['AAPL']);
    const host = makeHost(async (path) =>
      path.includes('/splits')
        ? res(splitPage(['AAA'], 'https://evil.example.com/v3/reference/splits?cursor=x'))
        : res(cleanSeries())
    );

    const report = await runBackfillBars(host, { tradingDate: '2026-09-06' });

    expect(report.splitsTruncated).toBe(true);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM meta_response WHERE at_provider_cap = 1').get())
      .toEqual({ n: 1 });
  });

  it('pages the daily splits AND dividends, which had the same defect twice more', async () => {
    // The cursor arrives as a PARAM, not in the path, so pages are distinguished
    // by call count rather than by inspecting the path.
    let splitCalls = 0;
    let divCalls = 0;
    const host = makeHost(async (path) => {
      if (path.includes('/splits')) {
        splitCalls++;
        return res(
          splitCalls === 1
            ? splitPage(['SPA'], 'https://api.polygon.io/v3/reference/splits?cursor=s2')
            : splitPage(['SPB'])
        );
      }
      divCalls++;
      return res(
        divCalls === 1
          ? dividendPage(['DVA'], 'https://api.polygon.io/v3/reference/dividends?cursor=d2')
          : dividendPage(['DVB'])
      );
    });

    const handle = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    const counts = await runActionsPhase(host, db, handle);

    expect(splitCalls).toBe(2);
    expect(divCalls).toBe(2);
    expect(counts.splits.stored).toBe(2);
    expect(counts.dividends.stored).toBe(2);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM raw_dividend').get()).toEqual({ n: 2 });
  });
});

describe('no Polygon list call escapes the sweep', () => {
  /**
   * The rule, rather than the three call sites that broke it. This is the fourth
   * instance of one mistake in this repository — Finnhub's 1,500-row calendar, the
   * universe seed's 2,000 alphabetical tickers, and then splits, dividends and
   * short interest — so the guard belongs on the shape, not on the instances.
   *
   * Deliberately FILE-level and therefore coarse: a file that pages one list and
   * truncates another would pass. It is still worth having, because every instance
   * so far arrived as a brand-new call site in a file that paged nothing, and that
   * is exactly what this catches.
   */
  const COLLECTOR_SRC = fileURLToPath(new URL('../src/collector', import.meta.url));

  function tsFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
    );
  }

  /** Comments are stripped first — the documented trap: a guard that fires on its own prose. */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  function callsLimitedPolygonGet(src: string): boolean {
    return src.includes('polygonGet') && /\blimit\b\s*:/.test(src);
  }

  it('fires on a direct polygonGet that passes a limit', () => {
    expect(callsLimitedPolygonGet("await host.polygonGet('/v3/reference/x', { limit: '1000' });")).toBe(true);
  });

  it('stays clean on a polygonGet with no limit, and on a limit that is not a polygonGet', () => {
    // The `clean` half matters as much as the `fires` half: a detector that
    // matches everything is as useless as one that matches nothing, and only the
    // pair proves the rule is actually discriminating.
    expect(callsLimitedPolygonGet("await host.polygonGet('/v3/reference/x', {});")).toBe(false);
    expect(callsLimitedPolygonGet("const q = { limit: '1000' }; await host.httpGet(url);")).toBe(false);
  });

  it('requires every file that calls polygonGet with a limit to use sweepPolygonPages', () => {
    const offenders: string[] = [];
    let examined = 0;

    for (const file of tsFiles(COLLECTOR_SRC)) {
      const src = stripComments(readFileSync(file, 'utf8'));
      if (!callsLimitedPolygonGet(src)) continue;
      examined++;
      if (!src.includes('sweepPolygonPages')) offenders.push(file);
    }

    // Verified 2026-09-11: `backfill.ts` and `phases/market.ts` are the two files
    // that still call `polygonGet` directly AND pass a limit. `events.ts` dropped
    // out legitimately when short interest moved onto the sweep — a file that
    // routes everything through `sweepPolygonPages` stops naming `polygonGet`,
    // which is the outcome this rule wants. `host.ts` only declares the interface;
    // `universe-seed.ts` names it in a comment, which is stripped.
    //
    // The floor is a floor, not the non-vacuity guard: the two fixtures above are,
    // because a count is a number you can quietly tune until the suite goes green.
    expect(examined).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });
});
