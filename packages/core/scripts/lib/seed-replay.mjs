/**
 * The `universe_seed` replay itself, shared by both runners.
 *
 * There are two arms — `replay-seed-locally.mjs` (plain Node) and
 * `replay-seed-in-electron.mjs` (Electron main process) — and they exist to
 * answer one question: **does the corruption need the Electron runtime?** That
 * question is only answerable if the two arms run the *same* replay, so the
 * replay lives here and each runner supplies nothing but a `Database` and a
 * label. Two copies would drift, and a divergence between them would then be
 * indistinguishable from the finding.
 *
 * Everything else is the real thing: the real dictionary, the real capture
 * contract, the real archive writer, real `runUniverseSeed`. Only the transport
 * is stubbed, because the network is not a suspect and 1,089 live calls cost
 * five minutes per run.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Loads `better-sqlite3`, or explains the ABI flip in terms of the runtime that
 * is actually asking.
 *
 * The binary is swapped between the Node and Electron ABIs by
 * `scripts/rebuild-better-sqlite3.mjs`, so each arm needs a different rebuild
 * script — and the failure is a `NODE_MODULE_VERSION` mismatch that says nothing
 * about which command fixes it.
 */
export function loadBetterSqlite3(runtime) {
  const fix = runtime === 'electron' ? 'npm run rebuild:electron' : 'npm run rebuild:node';
  try {
    const Database = require('better-sqlite3');
    new Database(':memory:').close();
    return Database;
  } catch (err) {
    const abi =
      err?.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(String(err?.message));
    console.error(
      abi
        ? `better-sqlite3 is not built for ${runtime} right now. Run \`${fix}\` first.`
        : `Could not load better-sqlite3: ${err?.message ?? String(err)}`
    );
    process.exit(6);
  }
}

/** A Polygon ticker-reference body, shaped like the real one the ingester parses. */
function referenceBody(ticker, index) {
  return JSON.stringify({
    results: {
      ticker,
      name: `${ticker} Holdings Inc`,
      primary_exchange: 'XNAS',
      type: 'CS',
      market: 'stocks',
      active: true,
      currency_name: 'usd',
      cik: String(1000000 + index),
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

/**
 * Blocks the calling thread for `ms`.
 *
 * Deliberately synchronous: the delay exists to stretch the run over minutes so
 * a slow external agent (a scanner, a sync client) has a window to interfere,
 * and an `await` would hand the loop back and change the shape of what is being
 * tested. `Atomics.wait` is unavailable on some main threads, so a spin is kept
 * as the fallback rather than silently skipping the delay — an arm that ran at
 * full speed while reporting a pace would be worthless.
 */
function sleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* spin */
    }
  }
}

/** What each arm reports about itself, so two runs can be compared as evidence. */
export function runtimeLine(Database) {
  const probe = new Database(':memory:');
  const sqlite = probe.prepare('select sqlite_version() as v').get().v;
  probe.close();
  const electron = process.versions.electron
    ? `electron ${process.versions.electron}`
    : 'no electron';
  return `node ${process.versions.node} | ${electron} | abi ${process.versions.modules} | sqlite ${sqlite} | pid ${process.pid}`;
}

/**
 * Runs the seed, then the collector's repeating tick, and verifies both on a
 * cold handle.
 *
 * Returns `{ ok, dir, seedVerdict, tickVerdict }`. The directory is removed on a
 * clean run and **left in place** otherwise: a reproduction is the only artefact
 * worth having here, and deleting it would throw away the one thing three
 * evenings failed to produce.
 */
export async function runSeedReplay({
  Database,
  baseDir,
  tickerCount = 1089,
  delayMs = 0,
  ticks = 60,
  label = 'node',
  encryptForArchive,
  decryptFromArchive
}) {
  const core = await import('../../dist/index.js').catch(() => {
    console.error('packages/core is not built. Run: npm run build --prefix packages/core');
    process.exit(2);
  });

  mkdirSync(baseDir, { recursive: true });
  const dir = mkdtempSync(join(baseDir, `seed-replay-${label}-`));
  const dbPath = join(dir, 'data.sqlite');

  console.log(`arm       : ${label}`);
  console.log(`runtime   : ${runtimeLine(Database)}`);
  console.log(`directory : ${dir}`);
  console.log(`tickers   : ${tickerCount}${delayMs ? ` (${delayMs}ms apart)` : ''}`);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  core.applyDictionary(db);

  const tickers = Array.from({ length: tickerCount }, (_, i) => `SYM${String(i).padStart(4, '0')}`);
  const indexOf = new Map(tickers.map((t, i) => [t, i]));

  const host = {
    openGenerationDb: () => db,
    archiveRoot: () => join(dir, 'archive'),
    // A byte flip by default, not a cipher: the archive must round-trip through
    // whatever the host provides, and a real cipher here would be testing Node's
    // crypto. The Electron arm can pass real `safeStorage` instead — a second
    // variable, so only ever one at a time.
    encryptForArchive: encryptForArchive ?? ((b) => Buffer.from(b.map((x) => x ^ 0x5a))),
    decryptFromArchive: decryptFromArchive ?? ((b) => Buffer.from(b.map((x) => x ^ 0x5a))),
    polygonGet: async (path) => {
      if (delayMs > 0) sleep(delayMs);
      const ticker = path.split('/').pop();
      return {
        status: 200,
        body: referenceBody(ticker, indexOf.get(ticker) ?? 0),
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
    hostApp: { name: `seed-replay-${label}`, version: '0.0.0' }
  };

  // Host-supplied lists, exactly as `newAppUniverseSources` builds them from the
  // existing app's `constituents` table.
  const listResponse = (list) => ({
    status: 200,
    body: JSON.stringify({
      list,
      tickers:
        list === 'sp500'
          ? tickers.slice(0, 503)
          : list === 'russell1000'
            ? tickers
            : tickers.slice(0, 60)
    }),
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

  // The WAL's peak size, read before the checkpoint empties it. A checkpoint
  // reporting `{busy:0, log:0, checkpointed:0}` was once read as "the WAL was
  // empty" and carried into a diagnosis; it is simply what a successful TRUNCATE
  // looks like, and a healthy run reports it with a multi-megabyte WAL. Printing
  // the size means that never has to be inferred again.
  const walBytes = (() => {
    try {
      return statSync(`${dbPath}-wal`).size;
    } catch {
      return 0;
    }
  })();

  const [ck] = db.pragma('wal_checkpoint(TRUNCATE)');
  console.log(`wal peak  : ${walBytes} bytes before checkpoint`);
  console.log(`checkpoint: ${JSON.stringify(ck)}`);
  console.log(
    `integrity : ${String(Object.values(db.prepare('PRAGMA integrity_check').get())[0]).slice(0, 300)}`
  );
  db.close();

  // Cold, on a fresh handle: the check above shares a page cache with the
  // connection that did the writing. Every corruption was found on a cold read,
  // so the cold read is the one that counts.
  const cold = new Database(dbPath);
  const seedVerdict = String(Object.values(cold.prepare('PRAGMA integrity_check').get())[0]);
  const counts = ['meta_response', 'ref_universe_membership', 'raw_ticker_reference'].map(
    (t) => `${t}=${cold.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n}`
  );
  console.log(`cold read : ${counts.join(' ')}`);
  console.log(`cold integ: ${seedVerdict.slice(0, 300)}`);
  cold.close();

  // Phase 2: the collector's 2-minute tick, which the seed above does ONCE and
  // the real app does for as long as it is left running.
  //
  // Every `openGenerationDb()` runs `applyDictionary`, and that DELETEs and
  // re-INSERTs 760 `meta_dictionary` rows before the connection closes and
  // checkpoints. That is a lot of page churn repeated indefinitely, and freed
  // pages are reused by whatever allocates next — which in this schema is
  // `meta_response`, the table all three corruptions landed in.
  const seedOk = seedVerdict === 'ok';
  let tickVerdict = 'ok';
  if (seedOk && ticks > 0) {
    console.log(
      `\nsimulating ${ticks} collector ticks (open -> applyDictionary -> close+checkpoint)`
    );
    for (let i = 0; i < ticks; i++) {
      const tick = new Database(dbPath);
      tick.pragma('journal_mode = WAL');
      tick.pragma('foreign_keys = ON');
      core.applyDictionary(tick);
      tick.prepare('SELECT COUNT(*) AS n FROM meta_job_request').get();
      tick.close();
      if (i % 10 === 0 && i > 0) process.stdout.write(`  tick ${i}\n`);
    }
    const after = new Database(dbPath);
    tickVerdict = String(Object.values(after.prepare('PRAGMA integrity_check').get())[0]);
    const n = after.prepare('SELECT COUNT(*) AS n FROM meta_response').get().n;
    after.close();
    console.log(`\nafter ticks: meta_response=${n} integrity ${tickVerdict.slice(0, 300)}`);
  }

  const ok = seedOk && tickVerdict === 'ok';
  if (ok) rmSync(dir, { recursive: true, force: true });
  else console.log(`\nLEFT IN PLACE for post-mortem: ${dir}`);
  console.log(
    `\nVERDICT   : ${ok ? 'CLEAN' : '*** REPRODUCED — bisect from here, not from five-minute live runs ***'}`
  );

  return { ok, dir, seedVerdict, tickVerdict };
}
