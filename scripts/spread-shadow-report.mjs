#!/usr/bin/env node
// Bull put spread mode — shadow picks settled forward, and progress against the 08 §4 enable gate.
//
//   node scripts/spread-shadow-report.mjs [--all]
//
// Reads GET /api/v1/diagnostics/spread-shadow from the RUNNING app, so nothing opens a SQLite file
// from this shell. Settlement rules: src/main/services/spread-mode-settle.ts. --all lists every
// position (default: settled and unsettleable ones, plus the 15 most recent open ones).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ALL = process.argv.includes('--all');
const DATA_DIR = join(homedir(), '.tradeanalyzer');
const TOKEN = readFileSync(join(DATA_DIR, 'agent.token'), 'utf8').trim();
let PORT = '7432';
try { PORT = readFileSync(join(DATA_DIR, 'api.port'), 'utf8').trim() || PORT; } catch { /* default */ }

const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/diagnostics/spread-shadow`, { headers: { 'X-Agent-Token': TOKEN } })
  .catch((err) => {
    console.error(`API server not reachable on 127.0.0.1:${PORT} — the app must be RUNNING. (${err.message})`);
    process.exit(1);
  });
const body = await res.json().catch(() => null);
if (!res.ok || !body?.ok) {
  console.error(`diagnostics/spread-shadow failed: HTTP ${res.status} ${body?.error ?? ''}`);
  if (res.status === 404) console.error('This app build predates the route (v1.1.290). Install the new build.');
  process.exit(1);
}
const r = body.data;
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const mark = (ok) => (ok === null ? '·' : ok ? '✓' : '✗');
const g = r.gate;

console.log(`# Bull put spread — shadow report, ${r.asOf}\n`);
console.log('## Enable gate (08 §4)\n');
console.log(`  ${mark(g.captureDaysMet)} intraday capture days     ${g.intradayCaptureDays} / ${g.intradayCaptureDaysNeeded}   (then re-run the study: fr-bull-put-spread-study.mjs --slip-model quoted)`);
console.log(`  ${mark(g.settledMet)} settled positions         ${g.settledPositions} / ${g.settledPositionsNeeded}`);
console.log(`  ${mark(g.meanPositive)} mean return on max loss   ${pct(g.meanReturnOnMaxLoss)}   (must be > 0)`);
console.log(`\n  win rate ${pct(r.winRate)} · median days held ${r.medianDaysHeld ?? '—'}`);

const c = r.counts;
console.log(`\n## Positions\n\n  ${c.pickRows} pick rows → ${c.positions} positions (repeat picks of one position collapsed)`);
console.log(`  open ${c.open} · target ${c.target} · expired ${c.expired} · unsettleable ${c.unsettleable}\n`);

const rows = r.positions
  .filter((p) => ALL || p.settlement.status !== 'open')
  .concat(ALL ? [] : r.positions.filter((p) => p.settlement.status === 'open').slice(-15));
if (rows.length) {
  console.log('  entry       slot        ticker  expiry      short/long     credit  maxloss  status        exit        ret      marks/gaps');
  for (const p of rows) {
    const s = p.settlement;
    const exit = s.exitDate ?? s.lastMarkDate ?? '';
    const ret = s.returnOnMaxLoss != null ? pct(s.returnOnMaxLoss) : s.lastMidDebit != null ? `mid ${s.lastMidDebit.toFixed(2)}` : '';
    console.log(
      `  ${p.asOfDate}  ${p.slot.padEnd(11)} ${p.ticker.padEnd(7)} ${p.expiration}  ${`${p.shortStrike}/${p.longStrike}`.padEnd(13)} ` +
      `${p.netCredit.toFixed(2).padStart(6)}  ${p.maxLoss.toFixed(2).padStart(7)}  ${s.status.padEnd(12)}  ${exit.padEnd(10)}  ` +
      `${ret.padStart(7)}  ${s.marks}/${s.gaps}${p.repeats ? `  (+${p.repeats} repeat)` : ''}`,
    );
    if (s.status === 'unsettleable') console.log(`      ↳ ${s.reason}`);
  }
}

console.log('\n## Runs\n');
for (const run of r.runs) console.log(`  ${run.asOfDate} ${run.slot.padEnd(11)} picks ${String(run.picks).padStart(2)} · rejected ${run.rejected}`);

console.log('\n## Rejection reasons (all runs)\n');
for (const x of r.rejectionReasons) console.log(`  ${String(x.n).padStart(4)}  ${x.reason}`);
