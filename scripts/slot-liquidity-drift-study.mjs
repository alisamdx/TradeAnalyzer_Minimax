// Does the SAME candidate read differently in the morning batch than in the after-close one?
//
// WHY THIS EXISTS. The brief runs twice a trading day (~10:15 ET and ~17:00 ET) and the dice
// emails BOTH, so the operator acts on a morning pick. Until v1.1.185 only the after-close row
// survived — `saveBrief` deletes the same-ET-day rows and `brief_candidates` was keyed without a
// slot — so nothing about the morning reading was ever measurable.
//
// What prompted it: DINO scored liquidity 9/15 in the 2026-09-03 evening run and 6/15 in the
// 2026-09-04 morning run. Decomposed, the spread (8 of the 15 points, and the only component that
// sets fill cost) did not move a point; the drop was two step-function counters, one of which —
// same-day VOLUME — is a cumulative counter that is monotonic within the session. A gate at 8/15
// then sits in the densest part of the score distribution (mode exactly 7 across 250 stored
// picks), so a single cliff crossing decides pass/fail.
//
// This script does NOT propose a change. It reports the paired drift so a change could be argued
// under FR-SEY-5, and it says plainly when there is not yet enough data to say anything.
//
// Usage: node scripts/slot-liquidity-drift-study.mjs [--db <path>] [--strategy wheel]

import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DB_PATH = arg('--db', path.join(os.homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));
const STRATEGY = arg('--strategy', 'wheel');
const GATE = 8;   // MIN_TRADABLE_LIQUIDITY_SCORE

const db = new Database(DB_PATH);

// The column arrives with migration 079, which runs when the APP next starts — a script pointed
// at a database the new build has not opened yet must say so rather than throw a SQL error.
const hasSlot = db.prepare(`PRAGMA table_info(brief_candidates)`).all().some(c => c.name === 'slot');
if (!hasSlot) {
  console.log(`
${DB_PATH}
  has no brief_candidates.slot column — migration 079 has not run on it yet.`);
  console.log('  Start the app once (migrations run at boot), then re-run this script.');
  db.close();
  process.exit(0);
}

const rows = db.prepare(`
  SELECT as_of_date, ticker, slot, liquidity_score, volume, open_interest, bid, ask, strike,
         expiration, composite_score, disposition
    FROM brief_candidates
   WHERE strategy = ? AND slot IS NOT NULL
   ORDER BY as_of_date, ticker, slot
`).all(STRATEGY);

// Pair the two phases of the same (date, ticker). A candidate present in only one phase is NOT a
// missing measurement — it can mean the ticker did not reach Stage 4 in that run at all, which is
// itself a form of drift, so it is counted separately rather than dropped silently.
const byKey = new Map();
for (const r of rows) {
  const k = `${r.as_of_date}|${r.ticker}`;
  if (!byKey.has(k)) byKey.set(k, {});
  byKey.get(k)[r.slot] = r;
}

const paired = [], onlyMorning = [], onlyEvening = [];
for (const [k, v] of byKey) {
  if (v.intraday && v.after_close) paired.push({ k, m: v.intraday, e: v.after_close });
  else if (v.intraday) onlyMorning.push(k);
  else onlyEvening.push(k);
}

const dates = [...new Set(rows.map(r => r.as_of_date))];
console.log(`\nSlot drift — ${STRATEGY} — ${dates.length} date(s): ${dates.join(', ')}`);
console.log(`${rows.length} candidate rows · ${paired.length} paired · ${onlyMorning.length} morning-only · ${onlyEvening.length} evening-only\n`);

if (paired.length === 0) {
  console.log('Nothing to compare yet. Both phases of at least one day must be captured, which');
  console.log('starts from the first FULL trading day after v1.1.185 shipped. Re-run then.\n');
  db.close();
  process.exit(0);
}

const spreadPct = r => (r.bid != null && r.ask != null && r.bid + r.ask > 0)
  ? ((r.ask - r.bid) / ((r.bid + r.ask) / 2)) * 100 : null;
const num = a => a.filter(x => Number.isFinite(x));
const mean = a => num(a).reduce((x, y) => x + y, 0) / (num(a).length || 1);
const med = a => { const s = num(a).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

const dLiq = paired.map(p => p.e.liquidity_score - p.m.liquidity_score);
const dVol = paired.map(p => (p.e.volume ?? NaN) - (p.m.volume ?? NaN));
const dOi  = paired.map(p => (p.e.open_interest ?? NaN) - (p.m.open_interest ?? NaN));
const dSpd = paired.map(p => { const a = spreadPct(p.e), b = spreadPct(p.m); return a != null && b != null ? a - b : NaN; });

// The number that decides trades: does the pair straddle the gate?
const flipToPass = paired.filter(p => p.m.liquidity_score < GATE && p.e.liquidity_score >= GATE);
const flipToFail = paired.filter(p => p.m.liquidity_score >= GATE && p.e.liquidity_score < GATE);
const strikeMoved = paired.filter(p => p.m.strike != null && p.e.strike != null && p.m.strike !== p.e.strike);

const f = (n, d = 2) => Number.isFinite(n) ? n.toFixed(d) : '—';
console.log(`liquidity score   evening − morning:  mean ${f(mean(dLiq))}   median ${f(med(dLiq), 1)}`);
console.log(`same-day volume   evening − morning:  mean ${f(mean(dVol), 0)}   median ${f(med(dVol), 0)}`);
console.log(`open interest     evening − morning:  mean ${f(mean(dOi), 0)}   median ${f(med(dOi), 0)}`);
console.log(`relative spread%  evening − morning:  mean ${f(mean(dSpd))}   median ${f(med(dSpd))}`);
console.log('');
console.log(`crosses the ${GATE}/15 gate between phases: ${flipToPass.length + flipToFail.length} of ${paired.length} pairs`);
console.log(`  fail in the morning -> pass in the evening: ${flipToPass.length}`);
console.log(`  pass in the morning -> fail in the evening: ${flipToFail.length}`);
console.log(`different STRIKE selected between phases: ${strikeMoved.length} of ${paired.length}`);
console.log('');

const worst = [...paired].sort((a, b) =>
  Math.abs(b.e.liquidity_score - b.m.liquidity_score) - Math.abs(a.e.liquidity_score - a.m.liquidity_score)).slice(0, 10);
console.log('largest score gaps:');
console.log('  date        ticker   morning -> evening   K m/e        vol m/e      OI m/e       spread% m/e');
for (const p of worst) {
  const [d, t] = p.k.split('|');
  console.log(`  ${d}  ${t.padEnd(6)}   ${String(p.m.liquidity_score).padStart(4)} -> ${String(p.e.liquidity_score).padEnd(4)}       `
    + `${String(p.m.strike ?? '—').padStart(6)}/${String(p.e.strike ?? '—').padEnd(6)} `
    + `${String(p.m.volume ?? '—').padStart(5)}/${String(p.e.volume ?? '—').padEnd(6)} `
    + `${String(p.m.open_interest ?? '—').padStart(5)}/${String(p.e.open_interest ?? '—').padEnd(6)} `
    + `${f(spreadPct(p.m), 1).padStart(5)}/${f(spreadPct(p.e), 1)}`);
}

console.log('\nCaveats');
console.log('• Volume is CUMULATIVE within the session, so an evening > morning reading is expected');
console.log('  by construction. The question is whether it moves the SCORE across the gate.');
console.log('• A different strike between phases is not drift in one contract — spot moved and the');
console.log('  delta-band walk selected another. Those pairs measure the pipeline, not the market.');
console.log(`• ${paired.length} pairs over ${dates.length} date(s). Under FR-SEY-5 a gate change needs a`);
console.log('  sample spanning regimes; this becomes one at roughly a quarter of capture.\n');
db.close();
