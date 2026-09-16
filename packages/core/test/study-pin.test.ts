import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost } from '../src/collector/host.js';
import { beginRun, captureRuleId } from '../src/collector/run.js';
import { captureResponse } from '../src/collector/capture.js';
import { readArchivedResponse, resetOffsetCache } from '../src/collector/archive.js';
import { pinForStudy, unpinStudy, openPins, type ArchivingOperatorHost } from '../src/collector/study-pin.js';
import { recipes } from '../src/ingest/recipes.js';

/**
 * Study pins (05 §4.2, B9c). The operator's way into the sticky set — with its
 * provenance recorded rather than waived.
 */

let dir: string;
let raw: Database.Database;
const db = (): SqliteLike => raw as unknown as SqliteLike;
const NOW = '2026-09-09T18:00:00-04:00';
const OSI = 'SPY---260918P00600000';

function collectorHost(): CollectorHost {
  const ok = { status: 200, body: '{}', requestedAt: 't', respondedAt: 't' };
  return {
    openGenerationDb: () => db(), archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => b, decryptFromArchive: (b) => b,
    polygonGet: async () => ok, etradeGet: async () => ok, httpGet: async () => ok,
    nowET: () => NOW, sendEmail: async () => undefined, progress: () => undefined,
    signal: new AbortController().signal, hostApp: { name: 'test-host', version: '0' }
  };
}

/** Exactly what the new exe hands over: a clock, a name, and where the archive is. */
function operator(): ArchivingOperatorHost {
  return {
    nowET: () => NOW,
    hostApp: { name: 'TradeAnalyzer 2', version: 'test' },
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: () => { throw new Error('no account lines from here'); }
  };
}

/** One captured contract, stored the way phase 7 stores it. */
function captureContract(expirationDate: string, osi = OSI): void {
  const host = collectorHost();
  const run = beginRun(db(), host, { kind: 'daily', tradingDate: '2026-09-09' });
  const rule = captureRuleId(db(), host, 'chain', { maxDte: 90 }, 'chain');
  captureResponse({
    host, db: db(), runId: run.runId, asOfDate: '2026-09-09', provider: 'etrade',
    endpoint: '/v1/market/optionchains', slug: 'optionchains', params: { osi }, captureRuleId: rule,
    response: {
      status: 200, requestedAt: NOW, respondedAt: NOW,
      body: JSON.stringify({ OptionChainResponse: { nearPrice: 600, OptionPair: [{ Put: {
        osiKey: osi, strikePrice: 600, bid: 1, ask: 1.1, bidSize: 1, askSize: 1, volume: 5, openInterest: 10,
        inTheMoney: 'n', timeStamp: 1_788_552_898, OptionGreeks: { iv: 0.2, delta: -0.5, gamma: 0.01, theta: -0.1, vega: 0.3, rho: -0.1 }
      } }] } })
    },
    recipe: recipes.chain({ ticker: 'SPY', expirationDate })
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-pin-'));
  resetOffsetCache();
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('pinning a contract for study', () => {
  it('writes a sticky row that points at the archived request which caused it', () => {
    captureContract('2026-09-18');
    const pin = pinForStudy(db(), operator(), { osiSymbol: OSI, note: 'watch the skew into expiry' });
    expect(pin).toMatchObject({ osiSymbol: OSI, ticker: 'SPY', expirationDate: '2026-09-18', reason: 'study_flag', validFrom: '2026-09-09' });

    const row = raw
      .prepare("SELECT run_id, source_response_id, origin_ref, valid_to FROM ref_sticky_contract WHERE reason = 'study_flag'")
      .get() as { run_id: number; source_response_id: number; origin_ref: string; valid_to: string | null };
    expect(row.valid_to).toBeNull();
    expect(row.origin_ref).toBe(`meta_response.source_response_id=${row.source_response_id}`);

    // The run is the operator's own, complete, and never shared with a seed.
    expect(raw.prepare('SELECT run_kind, status, host_app FROM meta_run WHERE run_id = ?').get(row.run_id))
      .toEqual({ run_kind: 'manual', status: 'complete', host_app: 'TradeAnalyzer 2' });

    // The response is the request itself — archived, readable, and carrying no
    // recipe, because nothing was parsed.
    const resp = raw
      .prepare('SELECT provider, archive_file, archive_offset, ingest_recipe_id FROM meta_response WHERE source_response_id = ?')
      .get(row.source_response_id) as { provider: string; archive_file: string; archive_offset: number; ingest_recipe_id: number | null };
    expect(resp.provider).toBe('host_app');
    expect(resp.ingest_recipe_id).toBeNull();
    const line = readArchivedResponse(collectorHost(), resp.archive_file, resp.archive_offset);
    expect(JSON.parse(line.body)).toMatchObject({ osiSymbol: OSI, note: 'watch the skew into expiry' });
  });

  it('is what the chain phase reads as sticky, alongside any other reason', () => {
    captureContract('2026-09-18');
    pinForStudy(db(), operator(), { osiSymbol: OSI, note: 'study' });
    expect(openPins(db(), OSI).map((p) => p.reason)).toEqual(['study_flag']);
  });

  it('refuses without a note, for a contract never captured, for an expired one, and twice', () => {
    captureContract('2026-09-18');
    expect(() => pinForStudy(db(), operator(), { osiSymbol: OSI, note: '  ' })).toThrow(/needs a note/);
    expect(() => pinForStudy(db(), operator(), { osiSymbol: 'QQQ   260918C00500000', note: 'x' })).toThrow(/never been captured/);

    captureContract('2026-09-05', 'SPY---260905P00600000');
    expect(() => pinForStudy(db(), operator(), { osiSymbol: 'SPY---260905P00600000', note: 'x' })).toThrow(/expired on 2026-09-05/);

    pinForStudy(db(), operator(), { osiSymbol: OSI, note: 'first' });
    expect(() => pinForStudy(db(), operator(), { osiSymbol: OSI, note: 'again' })).toThrow(/already pinned for study since 2026-09-09/);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM ref_sticky_contract WHERE reason = 'study_flag'").get()).toEqual({ n: 1 });
  });
});

describe('ending a study pin', () => {
  it('closes the range today and archives why, deleting nothing', () => {
    captureContract('2026-09-18');
    pinForStudy(db(), operator(), { osiSymbol: OSI, note: 'study' });
    unpinStudy(db(), operator(), { osiSymbol: OSI, note: 'got what I needed' });

    expect(raw.prepare("SELECT valid_to FROM ref_sticky_contract WHERE reason = 'study_flag'").get()).toEqual({ valid_to: '2026-09-09' });
    expect(openPins(db(), OSI)).toEqual([]);
    const archived = raw
      .prepare("SELECT COUNT(*) AS n FROM meta_response WHERE endpoint = 'operator/study-unpin'")
      .get() as { n: number };
    expect(archived.n).toBe(1);
  });

  it('refuses a contract that is not pinned for study', () => {
    captureContract('2026-09-18');
    expect(() => unpinStudy(db(), operator(), { osiSymbol: OSI, note: 'x' })).toThrow(/not pinned for study/);
  });
});
