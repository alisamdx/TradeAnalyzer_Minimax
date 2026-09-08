#!/usr/bin/env node
/**
 * Runs a full `universe_seed` through the REAL collector code, offline.
 *
 *   node packages/core/scripts/replay-seed-locally.mjs "C:\\some\\dir" [tickers] [delayMs]
 *
 * Written 2026-09-07, after `meta_response` was corrupted three times and three
 * candidate causes were tested and cleared:
 *
 *  - the MSIX redirect (guarded; corruption recurred)
 *  - two SQLite libraries on one wal-index (fixed; corruption recurred)
 *  - the environment — `stress-sqlite.mjs` wrote 1,100 paced transactions into
 *    the generation's own directory over 285 s and came back CLEAN
 *
 * and two more were ruled out by inspection: `applyDictionary` is idempotent (no
 * rebuilds on re-apply), and the batch mutex genuinely prevents a second
 * collector job during a run. TradeAnalyzer 2 was closed for every corrupting
 * run, so it was never two processes either.
 *
 * What is left is the difference between the stress test and the real thing:
 * the actual schema with its foreign keys, CHECK constraints and append-only
 * triggers; parent and child rows inside one transaction; the archive file
 * written between transactions; and `captureResponse` itself.
 *
 * **So this runs exactly that** — `runUniverseSeed` over a stub host that serves
 * canned Polygon bodies. Real dictionary, real capture contract, real archive
 * writer, real ingestion. No Electron, no network, one process.
 *
 *  - **It corrupts** → the fault is in `core`, reproducible without the app, and
 *    can be bisected here in seconds instead of five-minute live runs.
 *  - **It stays clean** → the fault needs the Electron main process, and the
 *    next suspects are the runtime and the ABI-specific binary rather than the
 *    collection logic.
 *
 * Writes into a throwaway directory it creates; never touches a real generation.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const baseDir = process.argv[2] ?? tmpdir();
const tickerCount = Number(process.argv[3] ?? 1089);
const delayMs = Number(process.argv[4] ?? 0);

let Database;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  const abi = err?.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(String(err?.message));
  console.error(
    abi
      ? 'better-sqlite3 is built for Electron right now. Run `npm run rebuild:node` first.'
      : `Could not load better-sqlite3: ${err?.message ?? String(err)}`
  );
  process.exit(6);
}

const core = await import('../dist/index.js').catch(() => {
  console.error('packages/core is not built. Run: npm run build --prefix packages/core');
  process.exit(2);
});

mkdirSync(baseDir, { recursive: true });
const dir = mkdtempSync(join(baseDir, 'seed-replay-'));
const dbPath = join(dir, 'data.sqlite');

console.log(`directory : ${dir}`);
console.log(`tickers   : ${tickerCount}${delayMs ? ` (${delayMs}ms apart)` : ''}`);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
core.applyDictionary(db);

const tickers = Array.from({ length: tickerCount }, (_, i) => `SYM${String(i).padStart(4, '0')}`);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A Polygon ticker-reference body, shaped like the real one the ingester parses. */
function referenceBody(ticker) {
  return JSON.stringify({
    results: {
      ticker,
      name: `${ticker} Holdings Inc`,
      primary_exchange: 'XNAS',
      type: 'CS',
      market: 'stocks',
      active: true,
      currency_name: 'usd',
      cik: String(1000000 + tickers.indexOf(ticker)),
      composite_figi: `BBG000${ticker}`,
      share_class_shares_outstanding: 123456789,
      weighted_shares_outstanding: 123456789,
      market_cap: 9876543210,
      sic_code: '7372',
      sic_description: 'Prepackaged Software',
      total_employees: 4200,
      list_date: '2015-06-01',
      homepage_url: `https://example.com/${ticker}`
    },
    status: 'OK',
    request_id: `req-${ticker}`
  });
}

const host = {
  openGenerationDb: () => db,
  archiveRoot: () => join(dir, 'archive'),
  // A byte flip, not a cipher: the archive must round-trip through whatever the
  // host provides, and a real cipher here would be testing Node's crypto.
  encryptForArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
  decryptFromArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
  polygonGet: async (path) => {
    if (delayMs > 0) sleep(delayMs);
    const ticker = path.split('/').pop();
    return {
      status: 200,
      body: referenceBody(ticker),
      requestedAt: new Date().toISOString(),
      respondedAt: new Date().toISOString()
    };
  },
  etradeGet: async () => ({ status: 200, body: '{}', requestedAt: '', respondedAt: '' }),
  httpGet: async () => ({ status: 200, body: '{}', requestedAt: '', respondedAt: '' }),
  nowET: () => new Date().toISOString().replace('Z', '-04:00'),
  sendEmail: async () => undefined,
  progress: (phase, done, total) => {
    if (done % 200 === 0 && done > 0) process.stdout.write(`  ${phase} ${done}/${total}\r`);
  },
  signal: new AbortController().signal,
  hostApp: { name: 'replay-seed-locally', version: '0.0.0' }
};

// Host-supplied lists, exactly as `newAppUniverseSources` builds them from the
// existing app's `constituents` table.
const listResponse = (list) => ({
  status: 200,
  body: JSON.stringify({ list, tickers: list === 'sp500' ? tickers.slice(0, 503) : list === 'russell1000' ? tickers : tickers.slice(0, 60) }),
  requestedAt: new Date().toISOString(),
  respondedAt: new Date().toISOString()
});

const sources = ['sp500', 'russell1000', 'etf_list'].map((listSource) => ({
  listSource,
  endpoint: `host://constituents/${listSource}`,
  params: { list: listSource },
  provider: 'host_app',
  fetch: async () => listResponse(listSource),
  parse: (body) => JSON.parse(body).tickers
}));

const started = Date.now();
const report = await core.runUniverseSeed(host, { tradingDate: '2026-09-07', sources });
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\nseed      : ${JSON.stringify(report)}`);
console.log(`elapsed   : ${elapsed}s`);

const [ck] = db.pragma('wal_checkpoint(TRUNCATE)');
console.log(`checkpoint: ${JSON.stringify(ck)}`);
console.log(`integrity : ${String(Object.values(db.prepare('PRAGMA integrity_check').get())[0]).slice(0, 300)}`);
db.close();

// Cold, on a fresh handle: the check above shares a page cache with the
// connection that did the writing. Every corruption tonight was found on a cold
// read, so the cold read is the one that counts.
const cold = new Database(dbPath);
const coldVerdict = String(Object.values(cold.prepare('PRAGMA integrity_check').get())[0]);
const counts = ['meta_response', 'ref_universe_membership', 'raw_ticker_reference'].map(
  (t) => `${t}=${cold.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n}`
);
console.log(`cold read : ${counts.join(' ')}`);
console.log(`cold integ: ${coldVerdict.slice(0, 300)}`);
cold.close();

// Phase 2: the collector's 2-minute tick, which the replay above does ONCE and
// the real app does for as long as it is left running.
//
// Every `openGenerationDb()` runs `applyDictionary`, and that DELETEs and
// re-INSERTs 760 `meta_dictionary` rows before the connection closes and
// checkpoints. That is a lot of page churn repeated indefinitely, and freed
// pages are reused by whatever allocates next — which in this schema is
// `meta_response`, the table all three corruptions landed in. Nothing else in
// the system repeats like this, and the replay above cannot see it.
const seedOk = coldVerdict === 'ok';
const ticks = Number(process.env.REPLAY_TICKS ?? 60);
let tickVerdict = 'ok';
if (seedOk && ticks > 0) {
  console.log(`
simulating ${ticks} collector ticks (open -> applyDictionary -> close+checkpoint)`);
  for (let i = 0; i < ticks; i++) {
    const tick = new Database(dbPath);
    tick.pragma('journal_mode = WAL');
    tick.pragma('foreign_keys = ON');
    core.applyDictionary(tick);
    tick.prepare('SELECT COUNT(*) AS n FROM meta_job_request').get();
    tick.close();
    if (i % 10 === 0 && i > 0) process.stdout.write(`  tick ${i}
`);
  }
  const after = new Database(dbPath);
  tickVerdict = String(Object.values(after.prepare('PRAGMA integrity_check').get())[0]);
  const n = after.prepare('SELECT COUNT(*) AS n FROM meta_response').get().n;
  after.close();
  console.log(`
after ticks: meta_response=${n} integrity ${tickVerdict.slice(0, 300)}`);
}

const allOk = seedOk && tickVerdict === 'ok';
if (allOk) rmSync(dir, { recursive: true, force: true });
else console.log(`\nLEFT IN PLACE for post-mortem: ${dir}`);
console.log(`\nVERDICT   : ${allOk ? 'CLEAN' : '*** REPRODUCED — bisect from here, not from live five-minute runs ***'}`);
process.exit(allOk ? 0 : 1);
