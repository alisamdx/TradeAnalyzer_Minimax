#!/usr/bin/env node
// How many stored brief picks were chosen on an E*Trade delta computed off the wrong price.
//
//   node scripts/pick-greek-audit.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//
// Reads GET /api/v1/diagnostics/pick-greeks from the RUNNING app, so nothing opens a SQLite file
// from this shell. The measurement behind src/main/services/greek-consistency.ts: on 2026-09-15/16
// E*Trade's deltas implied a different underlying than its own option prices on 50-70 tickers a
// day. This answers whether that ever reached a recommendation.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const from = argOf('--from');
const to = argOf('--to');
for (const [name, v] of [['--from', from], ['--to', to]]) {
  if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    console.error(`${name} expects YYYY-MM-DD, got "${v}".`);
    process.exit(2);
  }
}

const DATA_DIR = join(homedir(), '.tradeanalyzer');
const TOKEN = readFileSync(join(DATA_DIR, 'agent.token'), 'utf8').trim();
let PORT = '7432';
try { PORT = readFileSync(join(DATA_DIR, 'api.port'), 'utf8').trim() || PORT; } catch { /* default */ }

const qs = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/diagnostics/pick-greeks?${qs}`, { headers: { 'X-Agent-Token': TOKEN } })
  .catch((err) => {
    console.error(`API server not reachable on 127.0.0.1:${PORT} — the app must be RUNNING. (${err.message})`);
    process.exit(1);
  });
const body = await res.json().catch(() => null);
if (!res.ok || !body?.ok) {
  console.error(`diagnostics/pick-greeks failed: HTTP ${res.status} ${body?.error ?? ''}`);
  if (res.status === 404) console.error('This app build predates the route (v1.1.252). Install the new build.');
  process.exit(1);
}
const a = body.data;
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');

console.log(`# Stored picks chosen on a stale delta — ${a.from} .. ${a.to}\n`);
console.log(`candidates with every input: ${a.measured}; delta invertible (not pinned at 0/1): ${a.invertible}\n`);
console.log('disposition          stale / invertible');
for (const [d, v] of Object.entries(a.staleByDisposition)) {
  console.log(`  ${d.padEnd(18)} ${String(v.stale).padStart(5)} / ${String(v.invertible).padEnd(6)} ${pct(v.stale, v.invertible)}`);
}
console.log(`\npicked rows whose delta implies a spot more than 1% from the stored spot: ${a.stalePicks.length}\n`);
for (const p of a.stalePicks.slice(0, 40)) {
  console.log(
    `  ${p.asOfDate} ${String(p.slot ?? '—').padEnd(11)} ${p.strategy.padEnd(8)} ${p.ticker.padEnd(6)} ` +
    `strike ${p.strike} spot ${p.spot} delta ${p.delta.toFixed(3)} → implies ${p.impliedSpot.toFixed(2)} ` +
    `(${(p.deviation * 100).toFixed(1)}% off)`
  );
}
if (a.stalePicks.length > 40) console.log(`  … and ${a.stalePicks.length - 40} more`);
