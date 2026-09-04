// Does premium-richness-based selection actually hurt? — F8 tested at universe scale.
//
// v1.1.173 found the wheel composite anti-predictive at the TOP of its picks (+1.91% mean return
// on capital in the 58-63 band, -4.99% at 73+), and attributed it to `ivRank` (22) + `premiumYield`
// (19) — 41 of 91 weight — both rewarding premium richness, which is compensation for RISK rather
// than edge. That was measured on 101 episodes drawn from the 5 survivors per day, so it could not
// separate "the composite is wrong" from "the survivors happen to be unlucky".
//
// `analysis_snapshots` allows the real test. It holds the whole wheel universe per date — every
// ticker's actual recommended CSP with a real strike, premium, delta, ivRank, liquidity and
// daysToEarnings — not just the ones that survived to a brief. So selection rules can be applied
// to the same universe and their outcomes compared directly.
//
// WHAT THIS CAN AND CANNOT DO. It cannot replay the composite: `analysis_snapshots` stores no
// compositeScore, and 21 of the composite's 91 weight (fundamentalScore + leverageQuality) comes
// from `fundamentals_cache`, which has no history. What it CAN do is test the mechanism directly —
// rank the universe by the premium-richness signals the composite leans on and see whether doing
// so beats or trails the universe itself.
//
// THE EARNINGS GATE STILL CANNOT BE APPLIED. `analysis_snapshots` rows carry a `daysToEarnings`
// FIELD, which looked like the first point-in-time earnings data in the project — but it is NULL
// on 100% of 23,722 settled rows. The column exists and is never populated. So this study, like
// every other one here, cannot evaluate the earnings gate; the difference is only that the reason
// is an unpopulated field rather than a missing table.
//
// Outcome, settled at intrinsic, no path or IV assumption:
//     pnl/share = premium − max(0, strike − close@expiry)     return on capital = pnl / strike
//
// see docs/wheel-parameters.md (F8), scripts/fr-wheel-composite-floor-study.mjs

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

const db = new Database(join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));
const maxPx = db.prepare('SELECT MAX(date) d FROM historical_prices').get().d;
const closeOnOrBefore = db.prepare(
  `SELECT close FROM historical_prices WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT 1`);

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d; };
const TOP_N = argOf('--top', 5);        // PICKS_PER_STRATEGY
const MIN_LIQ = argOf('--min-liq', 5);  // analysis-service optionLiquidityScore is 0–10
const SCALE_TOLERANCE = 0.35;

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
/** Mean with the worst and best 5% removed. Short-put returns are tail-dominated — the single
 *  worst outcome in this sample is -87.5% — so a raw mean can be set by two or three names. */
const trimMean = a => {
  if (a.length < 20) return mean(a);
  const s = [...a].sort((x, y) => x - y), k = Math.floor(s.length * 0.05);
  return mean(s.slice(k, s.length - k));
};
const f = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));

// ── Load the universe, one snapshot per date (the batch runs twice a day) ────
const perDate = new Map();
for (const r of db.prepare(
  `SELECT run_at, payload_json FROM analysis_snapshots WHERE mode='wheel' ORDER BY run_at`).all()) {
  perDate.set(r.run_at.slice(0, 10), r.payload_json);   // later run wins, as everywhere else
}

let rawRows = 0, noStructure = 0, unsettled = 0, scaleRejected = 0;
const byDate = new Map();
for (const [date, payload] of perDate) {
  let p; try { p = JSON.parse(payload); } catch { continue; }
  const rows = Array.isArray(p) ? p : p?.results ?? [];
  const kept = [];
  for (const x of rows) {
    rawRows++;
    const strike = x?.recommendedStrike, prem = x?.premium, exp = x?.expiration;
    if (!x?.ticker || strike == null || prem == null || !exp) { noStructure++; continue; }
    if (exp > maxPx) { unsettled++; continue; }
    const settle = closeOnOrBefore.get(x.ticker, exp)?.close;
    if (settle == null) { unsettled++; continue; }
    // Scale guard — a stored strike on a different price scale than the (repairable) series.
    const spot = x.lastPrice ?? closeOnOrBefore.get(x.ticker, date)?.close;
    if (spot == null || spot <= 0 || Math.abs(strike / spot - 1) > SCALE_TOLERANCE) { scaleRejected++; continue; }
    const pnl = prem - Math.max(0, strike - settle);
    kept.push({
      date, ticker: x.ticker, strike, premium: prem, expiration: exp, spot,
      ivRank: x.ivRank ?? null, annRet: x.annualizedReturn ?? null, iv: x.currentIv ?? null,
      delta: x.delta == null ? null : Math.abs(x.delta),
      liq: x.optionLiquidityScore ?? 0, suit: x.suitabilityScore ?? null,
      dte: x.dte ?? null, daysToEarnings: x.daysToEarnings ?? null,
      retPct: (pnl / strike) * 100, assigned: settle < strike,
    });
  }
  if (kept.length) byDate.set(date, kept);
}

const all = [...byDate.values()].flat();
console.log(`\nDoes premium-richness selection hurt? — F8 at universe scale`);
console.log(`snapshot rows: ${rawRows}   usable: ${all.length}   across ${byDate.size} dates`);
console.log(`  dropped: no structure ${noStructure} · not settled ${unsettled} · scale guard ${scaleRejected}`);
console.log(`outcome = premium − max(0, strike − close@expiry), as % of strike\n`);

// ── Gates, so the comparison is against tradeable candidates, not junk ───────
const withEarnings = all.filter(r => r.daysToEarnings != null).length;
const tradeable = all.filter(r => r.liq >= MIN_LIQ);
const illiquid = all.filter(r => r.liq < MIN_LIQ);
const noEarnings = tradeable;   // the earnings gate is a no-op here; see below

const stat = rows => `n=${String(rows.length).padStart(6)}  mean ${(f(mean(rows.map(r => r.retPct))) + '%').padStart(7)}`
  + `  median ${(f(med(rows.map(r => r.retPct))) + '%').padStart(7)}  trimmed ${(f(trimMean(rows.map(r => r.retPct))) + '%').padStart(7)}`;

console.log(`gating:`);
console.log(`  all usable          ${stat(all)}`);
console.log(`  liquidity >= ${MIN_LIQ}/10    ${stat(tradeable)}`);
console.log(`  liquidity <  ${MIN_LIQ}/10    ${stat(illiquid)}`);
console.log(`\n  NOTE — the LIQUID subset does worse on all three measures. That independently`);
console.log(`  reproduces v1.1.170's finding (liquidity tracks attention, attention tracks names`);
console.log(`  that are moving, moving names breach short puts) on ${illiquid.length + tradeable.length} rows rather than 6,777.`);
console.log(`\n  EARNINGS GATE NOT APPLIED: daysToEarnings is populated on ${withEarnings} of ${all.length} rows.`);
console.log(`  The field exists and is always null, so this study cannot evaluate it either.`);

const pool = new Map();
for (const r of noEarnings) {
  if (!pool.has(r.date)) pool.set(r.date, []);
  pool.get(r.date).push(r);
}

// ── Selection rules ─────────────────────────────────────────────────────────
// The composite leans 41/91 on premium richness (ivRank 22 + premiumYield 19). These rules
// isolate that, plus the obvious alternatives, so the comparison is against the universe itself.
const RULES = [
  ['top ivRank',              (a, b) => (b.ivRank ?? -1) - (a.ivRank ?? -1)],
  ['top annualized return',   (a, b) => (b.annRet ?? -1) - (a.annRet ?? -1)],
  ['top ivRank + annRet',     (a, b) => ((b.ivRank ?? 0) + (b.annRet ?? 0)) - ((a.ivRank ?? 0) + (a.annRet ?? 0))],
  ['top suitabilityScore',    (a, b) => (b.suit ?? -1) - (a.suit ?? -1)],
  ['top liquidity',           (a, b) => b.liq - a.liq],
  ['LOWEST ivRank',           (a, b) => (a.ivRank ?? 1e9) - (b.ivRank ?? 1e9)],
  ['lowest annualized return',(a, b) => (a.annRet ?? 1e9) - (b.annRet ?? 1e9)],
];

/** Collapse repeated selections of the same position into one episode. */
function episodes(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = `${r.ticker}|${r.expiration}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.values()].map(g => ({
    ret: mean(g.map(x => x.retPct)), assigned: mean(g.map(x => x.assigned ? 1 : 0)),
    ivRank: mean(g.map(x => x.ivRank ?? NaN)), n: g.length,
  }));
}

console.log(`\n═══ SELECTION RULES — top ${TOP_N} per date from the gated universe ═══`);
console.log(`  ${'rule'.padEnd(26)} ${'eps'.padStart(5)} ${'mean'.padStart(8)} ${'median'.padStart(8)} `
  + `${'trimmed'.padStart(8)} ${'assigned'.padStart(9)} ${'ivRank'.padStart(7)}`);

// Universe baseline: every gated candidate, i.e. "no selection at all".
const base = episodes(noEarnings);
const line = (label, eps) => console.log(`  ${label.padEnd(26)} ${String(eps.length).padStart(5)} `
  + `${(f(mean(eps.map(e => e.ret))) + '%').padStart(8)} `
  + `${(f(med(eps.map(e => e.ret))) + '%').padStart(8)} `
  + `${(f(trimMean(eps.map(e => e.ret))) + '%').padStart(8)} `
  + `${(f(mean(eps.map(e => e.assigned * 100)), 1) + '%').padStart(9)} `
  + `${f(mean(eps.map(e => e.ivRank).filter(x => !Number.isNaN(x))), 0).padStart(7)}`);

line('UNIVERSE (no selection)', base);
console.log('  ' + '-'.repeat(74));
const results = [];
for (const [name, cmp] of RULES) {
  const picked = [];
  for (const [, rows] of pool) picked.push(...[...rows].sort(cmp).slice(0, TOP_N));
  const eps = episodes(picked);
  results.push({ name, eps });
  line(name, eps);
}

console.log(`\n  Every rule is choosing from the SAME gated universe on the SAME dates, so the`);
console.log(`  difference between a rule and UNIVERSE is the value that rule's ranking adds.`);

const baseMean = mean(base.map(e => e.ret));
const baseMed = med(base.map(e => e.ret));
console.log(`\n═══ VALUE ADDED OVER NO SELECTION ═══`);
console.log(`  Judged on the MEDIAN as well as the mean: short-put returns are tail-dominated`);
console.log(`  (worst single outcome in this sample -87.5%), so a mean can be set by two names.`);
console.log(`\n  ${'rule'.padEnd(26)} ${'d mean'.padStart(9)} ${'d median'.padStart(10)}   verdict`);
for (const { name, eps } of results.sort((a, b) => med(b.eps.map(e => e.ret)) - med(a.eps.map(e => e.ret)))) {
  const dm = mean(eps.map(e => e.ret)) - baseMean;
  const dd = med(eps.map(e => e.ret)) - baseMed;
  const agree = (dm > 0.15 && dd > 0.15) ? 'better' : (dm < -0.15 && dd < -0.15) ? 'WORSE'
    : 'mixed / no different';
  console.log(`  ${name.padEnd(26)} ${((dm >= 0 ? '+' : '') + f(dm)).padStart(9)} `
    + `${((dd >= 0 ? '+' : '') + f(dd)).padStart(10)}   ${agree}`);
}

console.log(`\n═══ READ THIS BEFORE ACTING ═══`);
console.log(`• This tests the MECHANISM (does ranking on premium richness help?), not the composite.`);
console.log(`  analysis_snapshots stores no compositeScore and 21 of its 91 weight comes from`);
console.log(`  fundamentals_cache, which has no history — a faithful composite replay is impossible.`);
console.log(`• The recommended CSP here comes from the ANALYSIS service (delta band 0.20–0.30), not`);
console.log(`  the Strategy Lab profile the brief trades. Same structure, same findSuitableChain,`);
console.log(`  different selection band.`);
console.log(`• The earnings gate is NOT applied — daysToEarnings is null on every row — so these`);
console.log(`  returns include names that reported inside the hold, which the live brief excludes.`);
console.log(`• Held to expiry at intrinsic — no roll, no early close, no post-assignment covered`);
console.log(`  call. All three cushion assignment, which is concentrated in the high-IV rules.`);
console.log(`• One regime: ${[...byDate.keys()].sort()[0]} → ${[...byDate.keys()].sort().at(-1)}, settled through ${maxPx}.`);
db.close();
