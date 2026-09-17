#!/usr/bin/env node
/**
 * Rehearse a day's gate with the CURRENT code, on a snapshot of the generation, in minutes.
 *
 *   node packages/core/scripts/rehearse-gate.mjs [--date YYYY-MM-DD] [--snapshot PATH | --latest]
 *
 * Without --snapshot/--latest it asks the RUNNING app for a fresh copy
 * (POST /api/v1/diagnostics/generation-snapshot), so both apps can stay open.
 *
 * Why: until now the only way to see what a gate fix did was the next nightly run, and every
 * night found the next thing, so each round cost 24 hours. This runs that night's whole gate and
 * renders its email against the day's stored data, and prints every check's firing count beside
 * what the real run reported. What it cannot rehearse is collection itself — a change to what is
 * FETCHED still needs a live run; a change to how responses are PARSED is covered by replay.
 *
 * Safe by construction: it opens only a snapshot file under ~/.tradeanalyzer/rehearsal, which no
 * application ever opens, and refuses anything under AppData or named like a live generation. The
 * gate writes its exceptions into the snapshot, so a rehearsal can never escalate the real ones.
 * Needs `npm run build:core` for the code being rehearsed and `npm run rebuild:node`.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const core = await import('../dist/index.js');
const DATE = argOf('--date') ?? core.etDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error(`--date expects YYYY-MM-DD, got "${DATE}".`);
  process.exit(2);
}

const DATA_DIR = join(homedir(), '.tradeanalyzer');
const SNAP_DIR = join(DATA_DIR, 'rehearsal');

async function takeSnapshot() {
  const token = readFileSync(join(DATA_DIR, 'agent.token'), 'utf8').trim();
  let port = '7432';
  try { port = readFileSync(join(DATA_DIR, 'api.port'), 'utf8').trim() || port; } catch { /* default */ }
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/diagnostics/generation-snapshot`, {
    method: 'POST', headers: { 'X-Agent-Token': token }
  }).catch((err) => {
    console.error(`API server not reachable on 127.0.0.1:${port} — start the app, or pass --latest. (${err.message})`);
    process.exit(1);
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    console.error(`generation-snapshot failed: HTTP ${res.status} ${body?.error ?? ''}`);
    if (res.status === 404) console.error('This app build predates the route (v1.1.256). Install the new build.');
    process.exit(1);
  }
  return body.data;
}

let snapshotPath;
if (argOf('--snapshot')) {
  snapshotPath = argOf('--snapshot');
} else if (args.includes('--latest')) {
  const files = existsSync(SNAP_DIR) ? readdirSync(SNAP_DIR).filter((f) => /^gen-\d{3}-.*\.sqlite$/.test(f)).sort() : [];
  if (files.length === 0) {
    console.error(`No snapshot in ${SNAP_DIR}. Run without --latest to take one.`);
    process.exit(1);
  }
  snapshotPath = join(SNAP_DIR, files[files.length - 1]);
} else {
  const snap = await takeSnapshot();
  snapshotPath = snap.path;
  console.log(`snapshot ${snap.path} (${(snap.bytes / 1e6).toFixed(1)} MB, gen-${String(snap.generation).padStart(3, '0')}, ${snap.takenAt})`);
}

// Never the live generation. A rehearsal writes, and a live generation has other writers.
if (/[\\/]AppData[\\/]/i.test(snapshotPath) || basename(snapshotPath) === 'data.sqlite') {
  console.error(`Refusing ${snapshotPath}: that looks like a live generation. Rehearse only a snapshot.`);
  process.exit(2);
}
if (!existsSync(snapshotPath)) {
  console.error(`No file at ${snapshotPath}.`);
  process.exit(1);
}

let db;
try {
  const Database = createRequire(import.meta.url)('better-sqlite3');
  db = new Database(snapshotPath, { fileMustExist: true });
} catch (err) {
  if (/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED/.test(String(err?.message ?? err))) {
    console.error('better-sqlite3 is built for Electron right now. Run `npm run rebuild:node`, then this again.');
    process.exit(6);
  }
  throw err;
}

try {
  const run = db
    .prepare(`SELECT run_id, started_at, finished_at FROM meta_run WHERE trading_date = ? AND run_kind = 'daily' ORDER BY run_id DESC LIMIT 1`)
    .get(DATE);
  if (!run) throw new Error(`No daily run for ${DATE} in this snapshot.`);

  // What the real run reported, captured before the rehearsal adds rows of its own.
  const actual = new Map(
    db.prepare(
      `SELECT check_id, fired_count, evaluated_count, duration_ms FROM qa_check_result
        WHERE row_id IN (SELECT MAX(row_id) FROM qa_check_result WHERE run_id = ? GROUP BY check_id)`
    ).all(run.run_id).map((r) => [r.check_id, r])
  );
  const actualReport = db.prepare('SELECT overall, domains_json FROM qa_quality_report WHERE run_id = ? ORDER BY report_id DESC LIMIT 1').get(run.run_id);
  const generation = db.prepare('SELECT generation_no, status FROM meta_generation ORDER BY generation_no DESC LIMIT 1').get();

  // The current dictionary, exactly as the app applies it on open (keys, indexes).
  core.applyDictionary(db);

  // qa_check_result holds one row per (run, check) and is append-only, so a gate cannot run twice
  // for one run — right for the generation, and it stopped the first rehearsal. On this copy, and
  // only here, the run's results are cleared after the real counts were read above. The trigger is
  // dropped AFTER applyDictionary, which would otherwise recreate it.
  for (const t of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'qa_check_result'`).all()) {
    db.exec(`DROP TRIGGER "${t.name}"`);
  }
  db.prepare('DELETE FROM qa_check_result WHERE run_id = ?').run(run.run_id);

  const host = { nowET: () => core.etTimestamp(), hostApp: { name: 'rehearse-gate.mjs', version: core.COLLECTOR_VERSION } };
  const started = Date.now();
  const gate = core.runGate(db, host, {
    runId: run.run_id, tradingDate: DATE, checks: core.checksFor(db),
    domainsExpected: actualReport ? JSON.parse(actualReport.domains_json) : {}
  });
  const gateSeconds = ((Date.now() - started) / 1000).toFixed(1);

  const email = core.buildStatusEmail(db, {
    runId: run.run_id, tradingDate: DATE, slot: 'after_close', verdict: gate.verdict,
    generationNo: generation?.generation_no ?? 0, generationStatus: generation?.status ?? 'unknown',
    collectorVersion: `${core.COLLECTOR_VERSION} (rehearsal)`, startedAt: run.started_at, finishedAt: run.finished_at ?? run.started_at,
    domains: actualReport ? JSON.parse(actualReport.domains_json) : {}
  });

  // Every row for the run is the rehearsal's: the real ones were cleared above. Selecting by
  // row_id would miss them, because SQLite reuses the ids a DELETE frees.
  const rehearsed = db.prepare(
    `SELECT check_id, fired_count, evaluated_count, duration_ms FROM qa_check_result WHERE run_id = ?`
  ).all(run.run_id);

  console.log(`\n# Gate rehearsal — ${DATE}, run ${run.run_id}, core ${core.COLLECTOR_VERSION}\n`);
  console.log(`real run:   ${actualReport?.overall ?? '—'}`);
  console.log(`rehearsal:  ${gate.verdict} — ${gate.blocking} blocking, ${gate.warnings} warnings, ${gate.checksRun} checks in ${gateSeconds}s`);
  if (gate.checksVacuous.length) console.log(`evaluated nothing: ${gate.checksVacuous.join(', ')}`);
  console.log(`\nemail subject: ${email.subject}`);
  console.log(`email size: ${Buffer.byteLength(email.html)} bytes html, ${Buffer.byteLength(email.text)} bytes text\n`);

  console.log('## Checks that changed (fired / evaluated), real → rehearsal\n');
  const changed = rehearsed
    .map((r) => ({ r, a: actual.get(r.check_id) }))
    .filter(({ r, a }) => !a || a.fired_count !== r.fired_count || a.evaluated_count !== r.evaluated_count)
    .sort((x, y) => x.r.check_id.localeCompare(y.r.check_id));
  if (changed.length === 0) console.log('  none');
  for (const { r, a } of changed) {
    console.log(
      `  ${r.check_id.padEnd(8)} ${a ? `${a.fired_count}/${a.evaluated_count}` : 'new'} → ${r.fired_count}/${r.evaluated_count}`
    );
  }

  console.log('\n## Still firing\n');
  for (const r of rehearsed.filter((x) => x.fired_count > 0).sort((a, b) => b.fired_count - a.fired_count)) {
    console.log(`  ${r.check_id.padEnd(8)} ${String(r.fired_count).padStart(6)} of ${r.evaluated_count}`);
  }

  console.log('\n## Slowest checks, real → rehearsal (seconds)\n');
  for (const r of [...rehearsed].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 8)) {
    const a = actual.get(r.check_id);
    console.log(`  ${r.check_id.padEnd(8)} ${a ? (a.duration_ms / 1000).toFixed(1).padStart(7) : '      —'} → ${(r.duration_ms / 1000).toFixed(1)}`);
  }

  const out = `${snapshotPath}.${DATE}.email.txt`;
  writeFileSync(out, `${email.subject}\n\n${email.text}`);
  console.log(`\nfull email text: ${out}`);
} finally {
  db.close();
}
