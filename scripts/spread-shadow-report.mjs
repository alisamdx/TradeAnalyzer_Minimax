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

// What Settings → Strategies has stored, not the defaults — `GET /settings` does not carry these.
const st = r.settings;
if (st) {
  const usd = (x) => `$${Number(x).toLocaleString('en-US')}`;
  const full = usd(st.maxLossPerPosition * st.maxOpenPositions);
  console.log(`\n## Settings → Strategies (stored)\n`);
  console.log(`  mode ${st.mode} · max loss/position ${usd(st.maxLossPerPosition)} · max open ${st.maxOpenPositions} · max open/sector ${st.maxOpenPerSector}`);
  console.log(`  fully deployed that is ${full} at risk`);
}

const cq = r.captureQuality;
if (cq) {
  console.log(`\n## Capture quality (${cq.findings.length === 0 ? 'clean' : `${cq.findings.length} to look at`})\n`);
  console.log(`  ${cq.captureDays} capture day(s), last ${cq.lastCaptureDate ?? '—'} · marks ${cq.marks} · missing a leg ${cq.gaps} (${pct(cq.gapRate)}) · not re-quoted ${cq.missingMarks} of ${cq.expectedMarks} expected`);
  for (const f of cq.findings) {
    console.log(`  ! ${f.code}  ${f.detail}`);
    for (const s of f.subjects) console.log(`        ${s}`);
  }
}

const sc = r.sectorCap;
if (sc) {
  const book = (b) => `${b.positions} positions · ${b.settled} settled · mean ${pct(b.meanReturnOnMaxLoss)} · win ${pct(b.winRate)}`;
  console.log(`\n## Sector cap (${sc.cap} open per sector — simulated; shadow picks are not capped)\n`);
  console.log(`  all positions   ${book(sc.all)}`);
  console.log(`  capped book     ${book(sc.capped)}   (${sc.skipped} skipped by the cap)`);
  if (sc.unknownSector) console.log(`  ${sc.unknownSector} position(s) have no sector in constituents — each counted as its own sector`);
  const line = (xs) => xs.map((x) => `${x.key} ${x.n}`).join(' · ') || '—';
  console.log(`\n  open now by sector:  ${line(r.concentration.bySector)}`);
  console.log(`  open now by expiry:  ${line(r.concentration.byExpiry)}`);
}

const c = r.counts;
console.log(`\n## Positions\n\n  ${c.pickRows} pick rows → ${c.positions} positions (picks of a ticker within 14 days of its kept entry are one position)`);
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
      `${ret.padStart(7)}  ${s.marks}/${s.gaps}${p.repeats ? `  (+${p.repeats} repeat)` : ''}` +
      `${p.sectorCapSkipped ? '  [cap: skipped]' : ''}${p.sector ? `  ${p.sector}` : ''}`,
    );
    if (s.status === 'unsettleable') console.log(`      ↳ ${s.reason}`);
  }
}

console.log('\n## Runs\n');
for (const run of r.runs) console.log(`  ${run.asOfDate} ${run.slot.padEnd(11)} picks ${String(run.picks).padStart(2)} · rejected ${run.rejected}`);

console.log('\n## Rejection reasons (all runs)\n');
for (const x of r.rejectionReasons) {
  console.log(`  ${String(x.n).padStart(4)}  ${x.reason}`);
  const tickers = (x.tickers ?? []).map((t) => (t.n > 1 ? `${t.ticker}×${t.n}` : t.ticker)).join(', ');
  if (tickers) console.log(`        ${tickers}`);
  for (const c of x.causes ?? []) console.log(`        ↳ ${String(c.n).padStart(3)}  ${c.cause}`);
}
