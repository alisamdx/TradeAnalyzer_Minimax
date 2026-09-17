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
import { bsDelta, impliedSpotFromDelta, normCdf, paritySpot } from '../src/qa/black-scholes.js';
import {
  QC407_UNDERLYING_DISAGREEMENT,
  QC410_GREEK_REPRODUCTION,
  QC414_GREEK_SCALE
} from '../src/qa/checks/chains.js';

/**
 * QC-410, QC-414 and QC-407 as rebuilt in v1.1.252.
 *
 * The finding that drove it (qc410-study.mjs, 2026-09-15/16): E*Trade's option
 * QUOTES agree with the session close by put-call parity, but on 50-70 tickers a
 * day its Greeks were computed off a different price — PCTY's deltas implied
 * 113.6 on a 147.3 close on both days. The old QC-410 fired on the share of all
 * ATM contracts and named nobody.
 *
 * Chains here are built from Black-Scholes so every quantity is known: the quotes
 * are priced at `spot`, and the Greeks can be computed at a different
 * `greekSpot`, which is exactly the provider fault being tested.
 */

let dir: string;
let raw: Database.Database;
const DATE = '2026-09-07';
const EXPIRY = '2026-10-16';
const RATE = 0.0391;

function db(): SqliteLike {
  return raw as unknown as SqliteLike;
}

function response(body: string): ProviderResponse {
  return { status: 200, body, requestedAt: '2026-09-07T17:05:00-04:00', respondedAt: '2026-09-07T17:05:01-04:00' };
}

function makeHost(): CollectorHost {
  return {
    openGenerationDb: () => db(),
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    decryptFromArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    polygonGet: async () => response('{"results":[]}'),
    etradeGet: async () => response('{}'),
    httpGet: async () => response('{}'),
    nowET: () => '2026-09-07T17:05:00-04:00',
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test-host', version: '0.0.0' }
  };
}

function bsPrice(spot: number, strike: number, dteDays: number, iv: number, right: 'call' | 'put'): number {
  const t = dteDays / 365;
  const d1 = (Math.log(spot / strike) + (RATE + (iv * iv) / 2) * t) / (iv * Math.sqrt(t));
  const d2 = d1 - iv * Math.sqrt(t);
  const disc = strike * Math.exp(-RATE * t);
  return right === 'call'
    ? spot * normCdf(d1) - disc * normCdf(d2)
    : disc * normCdf(-d2) - spot * normCdf(-d1);
}

function osi(ticker: string, right: 'call' | 'put', strike: number): string {
  return `${ticker.padEnd(6, '-')}261016${right === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

/** An E*Trade-shaped chain: quotes priced at `spot`, Greeks computed at `greekSpot`, deltas multiplied by `deltaScale`. */
function chain(ticker: string, spot: number, opts: { greekSpot?: number; deltaScale?: number } = {}): string {
  const iv = 0.3;
  const dte = 39;
  const greekSpot = opts.greekSpot ?? spot;
  const deltaScale = opts.deltaScale ?? 1;
  const leg = (right: 'call' | 'put', strike: number) => {
    const price = bsPrice(spot, strike, dte, iv, right);
    return {
      osiKey: osi(ticker, right, strike),
      strikePrice: strike,
      bid: Number((price * 0.98).toFixed(2)),
      ask: Number((price * 1.02).toFixed(2)),
      volume: 10,
      openInterest: 100,
      inTheMoney: 'n',
      timeStamp: 1_788_552_898,
      OptionGreeks: {
        iv,
        delta: (bsDelta({ spot: greekSpot, strike, dteDays: dte, iv, rate: RATE, right }) as number) * deltaScale,
        gamma: 0.01, theta: -0.05, vega: 0.2, rho: 0.05
      }
    };
  };
  const strikes = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((k) => Math.round(spot) + k * Math.round(spot / 100));
  return JSON.stringify({
    OptionChainResponse: { nearPrice: spot, OptionPair: strikes.map((k) => ({ Call: leg('call', k), Put: leg('put', k) })) }
  });
}

let run: RunHandle;

function capture(provider: 'etrade' | 'polygon' | 'treasury', body: string, recipe: ReturnType<typeof recipes.chain>, endpoint: string) {
  const result = captureResponse({
    host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider, endpoint,
    slug: endpoint.replace(/\W+/g, '-'), params: { bytes: String(body.length) },
    response: response(body),
    captureRuleId: captureRuleId(db(), makeHost(), provider, { v: 1 }, 'test'),
    recipe
  });
  expect(result.parseStatus, JSON.stringify(result)).toBe('ok');
}

function captureChain(ticker: string, spot: number, opts: { greekSpot?: number; deltaScale?: number } = {}) {
  capture('etrade', chain(ticker, spot, opts), recipes.chain({ ticker, expirationDate: EXPIRY }), `/v1/market/optionchains/${ticker}`);
}

function captureRate() {
  capture(
    'treasury',
    'Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"\n' +
      '09/04/2026,3.79,3.83,3.90,3.91,4.00,3.98,4.13,4.37,4.45,4.54,4.65,4.78,5.25,5.24\n',
    recipes.treasury(),
    '/treasury'
  );
}

const ctx = () => ({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: 't' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-greeks-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
  raw.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) " +
      "VALUES (1, '2026-09-07T00:00:00-04:00', 'pilot', 'x', 'y')"
  );
  resetOffsetCache();
  run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the spot estimators', () => {
  it('inverts a delta back to the spot it was computed at', () => {
    const delta = bsDelta({ spot: 147.32, strike: 145, dteDays: 30, iv: 0.46, rate: RATE, right: 'put' }) as number;
    const spot = impliedSpotFromDelta({ delta, nearSpot: 150, strike: 145, dteDays: 30, iv: 0.46, rate: RATE, right: 'put' });
    expect(spot).toBeCloseTo(147.32, 4);
  });

  it('refuses a saturated delta rather than returning an arbitrary root', () => {
    // PCTY's $140 put read -1.000 two days out: flat in spot, any root is noise.
    expect(impliedSpotFromDelta({ delta: -1, nearSpot: 147.32, strike: 140, dteDays: 2, iv: 0.46, rate: RATE, right: 'put' })).toBeNull();
  });

  it('recovers spot from call and put prices by parity', () => {
    const c = bsPrice(100, 102, 39, 0.3, 'call');
    const p = bsPrice(100, 102, 39, 0.3, 'put');
    expect(paritySpot({ callMid: c, putMid: p, strike: 102, dteDays: 39, rate: RATE })).toBeCloseTo(100, 6);
  });
});

describe('QC-410, per-ticker Greek consistency', () => {
  it('is quiet when the Greeks were computed at the price the quotes imply', () => {
    captureRate();
    captureChain('AAA', 100);
    const evals = QC410_GREEK_REPRODUCTION.run(ctx());
    expect(evals).toHaveLength(1);
    expect(evals[0]!.key).toBe('AAA');
    expect(evals[0]!.fired).toBe(false);
    expect(evals[0]!.value as number).toBeLessThan(0.001);
  });

  it('names the ticker whose Greeks were computed off another price, and only that one', () => {
    captureRate();
    captureChain('AAA', 100);
    // Quotes at the close, Greeks at a price 4 % below it: every delta still invertible.
    captureChain('WSM', 147, { greekSpot: 141 });
    const fired = QC410_GREEK_REPRODUCTION.run(ctx()).filter((e) => e.fired);
    expect(fired.map((e) => e.key)).toEqual(['WSM']);
    const ev = fired[0]!.evidence as { deltaImpliedSpot: number; paritySpot: number };
    expect(ev.paritySpot).toBeCloseTo(147, 0);
    expect(ev.deltaImpliedSpot).toBeCloseTo(141, 0);
  });

  it('still fires when the Greeks are so far off that no delta can be inverted', () => {
    // The PCTY shape, 2026-09-15/16: Greeks at a price 20 % below the close pin every
    // near-the-money delta at 0 or 1. Judged on invertible contracts alone, the ticker
    // would drop out of the check at exactly the moment it is most wrong.
    captureRate();
    captureChain('PCTY', 147, { greekSpot: 117.6 });
    const [e] = QC410_GREEK_REPRODUCTION.run(ctx());
    expect(e!.key).toBe('PCTY');
    expect(e!.fired).toBe(true);
    const ev = e!.evidence as { deltaImpliedSpot: number | null; pinnedContracts: number };
    expect(ev.deltaImpliedSpot).toBeNull();
    expect(ev.pinnedContracts).toBeGreaterThanOrEqual(5);
  });

  it('does not fire when only parity is off — a dividend before expiry pulls parity low', () => {
    // EIX, 2026-09-16: Greeks implied 54.72 on a 54.81 chain; parity read 53.00. As the
    // reference, parity flagged a ticker whose Greeks were right. Modelled here as quotes
    // priced at a spot 3 % below the chain underlying while the Greeks use the chain's.
    captureRate();
    capture(
      'etrade',
      chain('EIX', 53, { greekSpot: 54.6 }).replace('"nearPrice":53', '"nearPrice":54.6'),
      recipes.chain({ ticker: 'EIX', expirationDate: EXPIRY }),
      '/v1/market/optionchains/EIX'
    );
    const [e] = QC410_GREEK_REPRODUCTION.run(ctx());
    expect(e!.fired).toBe(false);
    const ev = e!.evidence as { paritySpot: number; chainUnderlying: number };
    expect(ev.chainUnderlying).toBe(54.6);
    expect(ev.paritySpot).toBeLessThan(54);
  });

  it('does not fire when the Greeks follow parity rather than the chain — a dividend priced into the Greeks', () => {
    // BBY, 2026-09-16: Greeks implied 90.97, parity 91.17, chain 92.45. Against the chain
    // alone that is 1.6 % and fired; the Greeks agree with the quotes, so they are usable.
    captureRate();
    capture(
      'etrade',
      chain('BBY', 91.2, { greekSpot: 91.2 }).replace('"nearPrice":91.2', '"nearPrice":92.45'),
      recipes.chain({ ticker: 'BBY', expirationDate: EXPIRY }),
      '/v1/market/optionchains/BBY'
    );
    const [e] = QC410_GREEK_REPRODUCTION.run(ctx());
    expect(e!.key).toBe('BBY');
    expect(e!.fired).toBe(false);
  });

  it('counts a contract once when the same day was captured twice', () => {
    captureRate();
    captureChain('AAA', 100);
    run = beginRun(db(), makeHost(), { kind: 'manual', tradingDate: DATE });
    captureChain('AAA', 100);
    const ev = QC410_GREEK_REPRODUCTION.run(ctx())[0]!.evidence as { impliedContracts: number; parityPairs: number };
    expect(ev.parityPairs).toBeLessThanOrEqual(9);
  });

  it('skips without a 3M rate — a missing rate is QC-902\'s finding', () => {
    captureChain('AAA', 100);
    expect(QC410_GREEK_REPRODUCTION.run(ctx())).toEqual([]);
    expect(QC414_GREEK_SCALE.run(ctx())).toEqual([]);
  });
});

describe('QC-414, the scale verdict', () => {
  /** Enough tickers to clear the 100-contract minimum: 9 strikes x 2 rights = 18 per chain. */
  function captureMany(opts: { deltaScale?: number } = {}) {
    for (const t of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']) captureChain(t, 100, opts);
  }

  it('passes when the provider delta is reachable at a plausible spot', () => {
    captureRate();
    captureMany();
    const [e] = QC414_GREEK_SCALE.run(ctx());
    expect(e!.fired).toBe(false);
    expect(e!.value).toBe(1);
  });

  it('fires on delta sent per contract instead of per share, where QC-410 alone evaluates nothing', () => {
    captureRate();
    // A delta of 52 cannot be inverted, so no ticker reaches QC-410's minimum.
    captureMany({ deltaScale: 100 });
    const [e] = QC414_GREEK_SCALE.run(ctx());
    expect(e!.fired).toBe(true);
    expect(e!.value).toBe(0);
    expect(QC410_GREEK_REPRODUCTION.run(ctx()).filter((x) => x.fired)).toEqual([]);
  });

  it('fires on a sign flip', () => {
    captureRate();
    captureMany({ deltaScale: -1 });
    expect(QC414_GREEK_SCALE.run(ctx())[0]!.fired).toBe(true);
  });
});

describe('QC-407, chain underlying vs the Polygon close', () => {
  function snapshot(tickers: { ticker: string; close?: number; last?: number }[]): string {
    return JSON.stringify({
      tickers: tickers.map((t) => ({
        ticker: t.ticker,
        ...(t.close === undefined ? {} : { day: { o: t.close, h: t.close, l: t.close, c: t.close, v: 1000.5, vw: t.close } }),
        ...(t.last === undefined ? {} : { lastTrade: { p: t.last, s: 100, t: 1 } }),
        prevDay: { c: 99 },
        updated: 1_788_552_898_000_000_000
      }))
    });
  }

  it('compares against day_close, which Polygon sends, not lastTrade, which it does not on this plan', () => {
    captureChain('AAA', 100);
    capture('polygon', snapshot([{ ticker: 'AAA', close: 100 }]), recipes.snapshot(), '/v2/snapshot');
    const evals = QC407_UNDERLYING_DISAGREEMENT.run(ctx());
    expect(evals.map((e) => [e.key, e.fired])).toEqual([['AAA', false]]);
  });

  it('fires on a disagreement past 1 %', () => {
    captureChain('AAA', 100);
    capture('polygon', snapshot([{ ticker: 'AAA', close: 102 }]), recipes.snapshot(), '/v2/snapshot');
    expect(QC407_UNDERLYING_DISAGREEMENT.run(ctx()).filter((e) => e.fired).map((e) => e.key)).toEqual(['AAA']);
  });

  it('reports a coverage finding when both sides exist but nothing is comparable', () => {
    // 2026-09-14..16: ~13,000 quote rows a day, every one without a usable price
    // on the column the check read, and the check evaluated zero tickers silently.
    captureChain('AAA', 100);
    capture('polygon', snapshot([{ ticker: 'AAA' }]), recipes.snapshot(), '/v2/snapshot');
    const evals = QC407_UNDERLYING_DISAGREEMENT.run(ctx());
    expect(evals).toHaveLength(1);
    expect(evals[0]!.key).toBe(`coverage:${DATE}`);
    expect(evals[0]!.fired).toBe(true);
  });
});
