#!/usr/bin/env node
/**
 * Runs chosen gate checks against the current generation and prints what they WOULD report.
 *
 *   node packages/core/scripts/gate-preview.mjs 2026-09-16 QC-410 QC-414 QC-407 QC-008 QC-009
 *
 * READ ONLY: calls each check's `run()` (which only reads) and writes nothing — no exception rows,
 * no report, no email. Built for validating a changed check on real data before it ships, which
 * is where every check rewritten in v1.1.252 had only ever been tested on synthetic chains.
 * Same refusals as every script that opens a generation: both applications closed, a normal
 * (non-containerised) terminal, `npm run rebuild:node` first. Needs `npm run build:core` so
 * `dist/` holds the checks being previewed.
 */
import {
  checkpointAndClose,
  openGenerationExclusively,
  resolveGenerationPointer
} from './lib/generation-access.mjs';

const [date, ...ids] = process.argv.slice(2);
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || ids.length === 0) {
  console.error('Usage: node packages/core/scripts/gate-preview.mjs YYYY-MM-DD QC-410 [QC-414 ...]');
  process.exit(2);
}

const { ALL_CHECKS } = await import('../dist/index.js');
const checks = ids.map((id) => {
  const def = ALL_CHECKS.find((c) => c.id === id);
  if (!def) {
    console.error(`No check ${id} in this build of core.`);
    process.exit(2);
  }
  return def;
});

const { dbPath } = await resolveGenerationPointer();
const db = await openGenerationExclusively(dbPath, 'gate-preview.mjs');
try {
  const runRow = db
    .prepare(`SELECT run_id FROM meta_run WHERE trading_date = ? AND run_kind = 'daily' ORDER BY run_id DESC LIMIT 1`)
    .get(date);
  if (!runRow) throw new Error(`No daily run for ${date}; run-scoped checks would read nothing.`);
  const ctx = { db, runId: runRow.run_id, tradingDate: date, observedAt: new Date().toISOString() };

  for (const def of checks) {
    const started = Date.now();
    const evals = def.run(ctx);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const fired = evals.filter((e) => e.fired);
    console.log(`\n## ${def.id} (${def.severity}) — ${fired.length} of ${evals.length} evaluations fire, ${seconds}s`);
    for (const e of fired.slice(0, 40)) console.log(`  ${e.key}  ${e.detail ?? ''}`);
    if (fired.length > 40) console.log(`  … and ${fired.length - 40} more`);
    const values = evals.map((e) => e.value).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    if (values.length) {
      const q = (p) => values[Math.min(values.length - 1, Math.floor(p * values.length))].toFixed(4);
      console.log(`  distribution n=${values.length} p5 ${q(0.05)} median ${q(0.5)} p95 ${q(0.95)} max ${q(1)}`);
    }
  }
} finally {
  checkpointAndClose(db);
}
