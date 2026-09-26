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

// BPS-3 — does the upstream 0-15 gate predict the spread's own round-trip cost?
const lv = r.liquidityVsCost;
if (lv) {
  console.log(`\n## Liquidity gate vs actual cost (BPS-3)\n`);
  if (lv.paired < 3) {
    console.log(`  ${lv.paired} paired row(s) — too few to say anything. NOT a weak signal, no signal yet.`);
  } else {
    const dir = lv.spearman == null ? 'n/a'
      : lv.spearman < -0.3 ? 'the proxy TRACKS cost (more liquid = cheaper)'
      : lv.spearman > 0.3 ? 'the proxy is INVERTED'
      : 'FLAT — the score does not predict the spread’s cost where it operates';
    console.log(`  ${lv.paired} paired · Spearman ${lv.spearman == null ? '—' : lv.spearman.toFixed(2)} — ${dir}`);
    for (const b of lv.bands) {
      if (!b.n) continue;
      console.log(`    liquidity ${b.label.padEnd(6)} n=${String(b.n).padStart(4)}  median cost share ${pct(b.medianCostShare).padStart(7)}  over the 25% gate: ${b.overGate}`);
    }
  }
  if (lv.unpaired) console.log(`  ${lv.unpaired} row(s) have a cost but no score (the premium pool has no brief_candidates row)`);
  console.log(`  CENSORED: everything here already cleared the bar, so no score below it is observable.`);
}

const pl = r.pools;
if (pl) {
  const book = (b) => `${b.positions} positions · ${b.settled} settled · mean ${pct(b.meanReturnOnMaxLoss)} · win ${pct(b.winRate)}`;
  console.log(`\n## Candidate pools (08 S11 — both run in shadow)\n`);
  if (!pl.pairedDays) {
    console.log('  NO PAIRED DAYS YET — the arms have not both run on any date, so there is nothing to compare.');
    console.log('  This is not a weak result, it is no result. The income arm starts on the next brief run.');
  } else {
    console.log(`  paired window: ${pl.pairedDays} day(s) from ${pl.pairedFrom} — both arms ran; earlier wheel-only days are excluded\n`);
    for (const b of pl.books) {
      const tag = b.pool === pl.gatePool ? '  ← §4 gate' : '';
      console.log(`  ${b.pool.padEnd(8)}      ${book(b)}${tag}`);
    }
    console.log(`\n  ${pl.overlap} ticker+expiry pair(s) picked by every pool — if that is most of the book, the screens agree`);
  }
}

const bg = r.budget;
if (bg) {
  const book = (b) => `${b.positions} positions · ${b.settled} settled · mean ${pct(b.meanReturnOnMaxLoss)} · win ${pct(b.winRate)}`;
  console.log(`\n## Per-position budget ($${Number(bg.maxLossPerPosition).toLocaleString('en-US')} — shadow records what it cannot afford)\n`);
  console.log(`  all positions   ${book(r.sectorCap.all)}   (both pools; return on max loss is a ratio, so an unaffordable pick still counts)`);
  console.log(`  affordable      ${book(bg.affordable)}   (${bg.unaffordable} could not be opened at this budget)`);
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
  console.log('  entry       slot        pool    ticker  expiry      short/long     credit  maxloss  status        exit        ret      marks/gaps');
  for (const p of rows) {
    const s = p.settlement;
    const exit = s.exitDate ?? s.lastMarkDate ?? '';
    const ret = s.returnOnMaxLoss != null ? pct(s.returnOnMaxLoss) : s.lastMidDebit != null ? `mid ${s.lastMidDebit.toFixed(2)}` : '';
    console.log(
      `  ${p.asOfDate}  ${p.slot.padEnd(11)} ${String(p.pool ?? "").padEnd(7)} ${p.ticker.padEnd(7)} ${p.expiration}  ${`${p.shortStrike}/${p.longStrike}`.padEnd(13)} ` +
      `${p.netCredit.toFixed(2).padStart(6)}  ${p.maxLoss.toFixed(2).padStart(7)}  ${s.status.padEnd(12)}  ${exit.padEnd(10)}  ` +
      `${ret.padStart(7)}  ${s.marks}/${s.gaps}${p.repeats ? `  (+${p.repeats} repeat)` : ''}` +
      `${p.sectorCapSkipped ? '  [cap: skipped]' : ''}${p.sector ? `  ${p.sector}` : ''}`,
    );
    if (s.status === 'unsettleable') console.log(`      ↳ ${s.reason}`);
  }
}

console.log('\n## Runs\n');
console.log('  eligible = what the top-5 cut chose between (picks + cut). Everything else was refused earlier.\n');
for (const run of r.runs) {
  const el = run.eligible == null ? '' : `  ·  eligible ${String(run.eligible).padStart(2)}${run.rankedBelow ? ` (cut ${run.rankedBelow})` : ''}`;
  console.log(`  ${run.asOfDate} ${run.slot.padEnd(11)} ${String(run.pool ?? "").padEnd(7)} picks ${String(run.picks).padStart(2)} · rejected ${String(run.rejected).padStart(2)}${el}`);
}

if (r.eligibility?.length) {
  console.log('\n## Does the ranking face a choice? (BPS-10)\n');
  for (const e of r.eligibility) {
    if (e.runs === 0) { console.log(`  ${e.pool.padEnd(8)} no runs yet`); continue; }
    const hist = e.histogram.map((h) => `${h.size}:${h.runs}`).join('  ');
    console.log(
      `  ${e.pool.padEnd(8)} binding on ${e.binding}/${e.runs} runs · ${e.droppedTotal} name(s) dropped · ` +
      `median eligible ${e.medianEligible ?? '—'} · max ${e.maxEligible}`,
    );
    console.log(`  ${''.padEnd(8)} sizes  ${hist}`);
  }
  console.log('\n  A cut that never fires cannot be right or wrong — it is not selecting. Binding on most');
  console.log('  runs means an UNVALIDATED rule (08 §3.6) is choosing the §4 sample.');
}

if (r.rankingTest?.length) {
  console.log('\n## Does the ranking pick better than what it cut? (BPS-10, real quotes, from v1.1.327)\n');
  const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
  const book = (b) => `${String(b.positions).padStart(3)} positions · ${String(b.settled).padStart(3)} settled · mean ${pct(b.meanReturnOnMaxLoss).padStart(6)} · win ${pct(b.winRate)}`;
  for (const t of r.rankingTest) {
    if (t.bindingRuns === 0) { console.log(`  ${t.pool.padEnd(8)} no binding runs`); continue; }
    console.log(`  ${t.pool.padEnd(8)} ${t.bindingRuns} binding run(s)`);
    console.log(`           top  ${book(t.top)}   entry return on risk ${t.medianReturnOnRiskTop?.toFixed(2) ?? '—'}`);
    console.log(`           cut  ${book(t.cut)}   entry return on risk ${t.medianReturnOnRiskCut?.toFixed(2) ?? '—'}`);
    if (t.cutAlsoPicked) console.log(`           ${t.cutAlsoPicked} cut name(s) picked by the same pool within 14 days — one bet, left out of both sides`);
  }
  console.log('\n  Counterfactual only — never part of the §4 gate. Names cut before v1.1.327 were stored without');
  console.log('  legs and cannot be settled. The ranking earns its place only if top beats cut once both are settled.');
}

console.log('\n## Rejection reasons (all runs)\n');
for (const x of r.rejectionReasons) {
  const pools = (x.pools ?? []).map((p) => `${p.pool} ${p.n}`).join(' · ');
  console.log(`  ${String(x.n).padStart(4)}  ${x.reason}${pools ? `   [${pools}]` : ''}`);
  const tickers = (x.tickers ?? []).map((t) => (t.n > 1 ? `${t.ticker}×${t.n}` : t.ticker)).join(', ');
  if (tickers) console.log(`        ${tickers}`);
  for (const c of x.causes ?? []) console.log(`        ↳ ${String(c.n).padStart(3)}  ${c.cause}`);
}
