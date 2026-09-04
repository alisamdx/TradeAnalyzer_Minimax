// T6 — do the wheel composite's PRICE-DERIVED signals help or hurt as ranking inputs?
//
// The trail so far: v1.1.173 found the composite anti-predictive at the top of the brief's picks
// (+1.91% mean return on capital in the 58-63 band, -4.99% at 73+) and blamed premium richness.
// v1.1.176 refuted that — ranking the whole universe on `ivRank` / `premiumYield` BEATS no
// selection. So the remaining suspicion falls on the other 50 of 91 weight:
//
//   fundamentalScore  17  <- fundamentals_cache, NO HISTORY -> permanently unvalidatable
//   technicalNeutral  11  <- RSI, target range 40-60          -> computable from prices
//   recentVolatility  10  <- 20d annualized realized vol      -> computable from prices
//   notDowntrend       8  <- SMA stack direction              -> computable from prices
//   leverageQuality    4  <- fundamentals_cache, NO HISTORY   -> permanently unvalidatable
//
// This tests the 29 points that CAN be tested, the same way v1.1.176 tested premium richness:
// apply each signal as a selection rule to the whole wheel universe from `analysis_snapshots`,
// on the same dates, and compare against no selection at all.
//
// The signal replicas below mirror scoring-service.ts exactly — extractSignalRaw +
// normalizeSignal + computeTrendDirectionScore(mode='wheel') — so a rule here ranks candidates
// the way the composite's corresponding term does, not merely something similar.
//
// Outcome, settled at intrinsic:
//     pnl/share = premium − max(0, strike − close@expiry)     return on capital = pnl / strike
//
// see docs/wheel-parameters.md (F8, T5), scripts/fr-wheel-selection-study.mjs

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

const db = new Database(join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));
const maxPx = db.prepare('SELECT MAX(date) d FROM historical_prices').get().d;
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d; };
const TOP_N = argOf('--top', 5);
const MIN_LIQ = argOf('--min-liq', 5);
const SCALE_TOLERANCE = 0.35;

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const trimMean = a => {
  if (a.length < 20) return mean(a);
  const s = [...a].sort((x, y) => x - y), k = Math.floor(s.length * 0.05);
  return mean(s.slice(k, s.length - k));
};
const f = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));
const clamp = x => Math.max(0, Math.min(100, x));

// ── Price series, once per ticker ───────────────────────────────────────────
const seriesFor = new Map();
const barsStmt = db.prepare(
  'SELECT date, close FROM historical_prices WHERE ticker = ? ORDER BY date');
function series(t) {
  if (!seriesFor.has(t)) seriesFor.set(t, barsStmt.all(t));
  return seriesFor.get(t);
}
/** Index of the last bar on or before `date` — everything after it is the future. */
function upTo(rows, date) {
  let lo = 0, hi = rows.length - 1, res = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m].date <= date) { res = m; lo = m + 1; } else hi = m - 1; }
  return res;
}

/** Wilder RSI(14) on closes ending at `end`. Mirrors the analysis service's period. */
function rsi14(rows, end) {
  if (end < 15) return null;
  let gain = 0, loss = 0;
  for (let i = end - 13; i <= end; i++) {
    const ch = rows[i].close - rows[i - 1].close;
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  gain /= 14; loss /= 14;
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}
/** 20-day annualized realized vol (%). see docs/formulas.md#recent-volatility */
function realizedVol(rows, end) {
  if (end < 21) return null;
  const lr = [];
  for (let i = end - 19; i <= end; i++) {
    if (rows[i - 1].close > 0) lr.push(Math.log(rows[i].close / rows[i - 1].close));
  }
  if (lr.length < 10) return null;
  const m = mean(lr);
  const sd = Math.sqrt(lr.reduce((a, b) => a + (b - m) ** 2, 0) / (lr.length - 1));
  return sd * Math.sqrt(252) * 100;
}
const sma = (rows, end, n) => {
  if (end < n - 1) return null;
  let s = 0; for (let i = end - n + 1; i <= end; i++) s += rows[i].close;
  return s / n;
};
/** computeTrendDirectionScore(mode='wheel'): bullish 100 / sideways 75 / bearish 10. */
function notDowntrend(rows, end) {
  const price = rows[end]?.close;
  const s50 = sma(rows, end, 50), s200 = sma(rows, end, 200);
  if (price == null || price <= 0) return null;
  if (s50 != null && s200 != null) {
    if (price > s50 && s50 > s200) return 100;
    if (price < s50 && s50 < s200) return 10;
    return 75;
  }
  if (s200 != null) return price > s200 ? 100 : 10;
  return null;
}
/** normalizeSignal, target_range 40–60: 100 inside, linear decay to 0 one width outside. */
function normTargetRange(raw, lo = 40, hi = 60) {
  if (raw == null) return null;
  const w = hi - lo;
  if (raw < lo) return clamp(100 - ((lo - raw) / w) * 100);
  if (raw > hi) return clamp(100 - ((raw - hi) / w) * 100);
  return 100;
}
const normLower = (raw, max) => (raw == null ? null : clamp((1 - raw / max) * 100));

// ── Universe, one snapshot per date ─────────────────────────────────────────
const perDate = new Map();
for (const r of db.prepare(
  `SELECT run_at, payload_json FROM analysis_snapshots WHERE mode='wheel' ORDER BY run_at`).all()) {
  perDate.set(r.run_at.slice(0, 10), r.payload_json);
}

const byDate = new Map();
let usable = 0, noSignals = 0;
for (const [date, payload] of perDate) {
  let p; try { p = JSON.parse(payload); } catch { continue; }
  const kept = [];
  for (const x of (Array.isArray(p) ? p : p?.results ?? [])) {
    const strike = x?.recommendedStrike, prem = x?.premium, exp = x?.expiration;
    if (!x?.ticker || strike == null || prem == null || !exp || exp > maxPx) continue;
    const rows = series(x.ticker);
    const iEnd = upTo(rows, date);
    const iExp = upTo(rows, exp);
    if (iEnd < 0 || iExp < 0) continue;
    const settle = rows[iExp].close;
    const spot = x.lastPrice ?? rows[iEnd].close;
    if (!spot || spot <= 0 || Math.abs(strike / spot - 1) > SCALE_TOLERANCE) continue;
    if ((x.optionLiquidityScore ?? 0) < MIN_LIQ) continue;   // same gate as the v1.1.176 study

    // Point-in-time signal values, from bars <= the snapshot date only.
    const rsi = rsi14(rows, iEnd);
    const rv = realizedVol(rows, iEnd);
    const nd = notDowntrend(rows, iEnd);
    if (rsi == null && rv == null && nd == null) { noSignals++; continue; }

    const pnl = prem - Math.max(0, strike - settle);
    kept.push({
      date, ticker: x.ticker, expiration: exp, strike,
      retPct: (pnl / strike) * 100, assigned: settle < strike,
      rsi, rv, nd,
      technicalNeutral: normTargetRange(rsi),
      recentVolatility: normLower(rv, 60),
      notDowntrendScore: nd,
    });
    usable++;
  }
  if (kept.length) byDate.set(date, kept);
}

const all = [...byDate.values()].flat();
console.log(`\nT6 — do the composite's PRICE-DERIVED signals help or hurt as ranking inputs?`);
console.log(`${all.length} settled, liquidity-gated rows across ${byDate.size} dates`);
console.log(`  (dropped ${noSignals} with no computable signal — too little price history)`);
console.log(`signals replicate scoring-service.ts exactly: technicalNeutral = RSI(14) in a 40–60`);
console.log(`target range, recentVolatility = 20d annualized vol (lower better, normMax 60),`);
console.log(`notDowntrend = SMA stack (bullish 100 / sideways 75 / bearish 10)\n`);

/** One ticker+expiry counts once. */
function episodes(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = `${r.ticker}|${r.expiration}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.values()].map(g => ({
    ret: mean(g.map(x => x.retPct)), assigned: mean(g.map(x => x.assigned ? 1 : 0)),
  }));
}

const RULES = [
  ['top technicalNeutral',  r => r.technicalNeutral],
  ['top recentVolatility',  r => r.recentVolatility],
  ['top notDowntrend',      r => r.notDowntrendScore],
  ['all three combined',    r => (r.technicalNeutral ?? 0) * 11 + (r.recentVolatility ?? 0) * 10 + (r.notDowntrendScore ?? 0) * 8],
  ['INVERTED: worst of all three', r => -((r.technicalNeutral ?? 0) * 11 + (r.recentVolatility ?? 0) * 10 + (r.notDowntrendScore ?? 0) * 8)],
];

const base = episodes(all);
const line = (label, eps) => console.log(`  ${label.padEnd(30)} ${String(eps.length).padStart(5)} `
  + `${(f(mean(eps.map(e => e.ret))) + '%').padStart(8)} `
  + `${(f(med(eps.map(e => e.ret))) + '%').padStart(8)} `
  + `${(f(trimMean(eps.map(e => e.ret))) + '%').padStart(8)} `
  + `${(f(mean(eps.map(e => e.assigned * 100)), 1) + '%').padStart(9)}`);

console.log(`═══ SELECTION RULES — top ${TOP_N} per date ═══`);
console.log(`  ${'rule'.padEnd(30)} ${'eps'.padStart(5)} ${'mean'.padStart(8)} ${'median'.padStart(8)} `
  + `${'trimmed'.padStart(8)} ${'assigned'.padStart(9)}`);
line('UNIVERSE (no selection)', base);
console.log('  ' + '-'.repeat(72));
const results = [];
for (const [name, key] of RULES) {
  const picked = [];
  for (const [, rows] of byDate) {
    picked.push(...[...rows].sort((a, b) => (key(b) ?? -1e9) - (key(a) ?? -1e9)).slice(0, TOP_N));
  }
  const eps = episodes(picked);
  results.push({ name, eps });
  line(name, eps);
}

const bm = mean(base.map(e => e.ret)), bd = med(base.map(e => e.ret));
console.log(`\n═══ VALUE ADDED OVER NO SELECTION ═══`);
console.log(`  ${'rule'.padEnd(30)} ${'d mean'.padStart(9)} ${'d median'.padStart(10)}   verdict`);
for (const { name, eps } of results) {
  const dm = mean(eps.map(e => e.ret)) - bm, dd = med(eps.map(e => e.ret)) - bd;
  const v = (dm > 0.15 && dd > 0.15) ? 'better' : (dm < -0.15 && dd < -0.15) ? 'WORSE' : 'mixed / no different';
  console.log(`  ${name.padEnd(30)} ${((dm >= 0 ? '+' : '') + f(dm)).padStart(9)} `
    + `${((dd >= 0 ? '+' : '') + f(dd)).padStart(10)}   ${v}`);
}

// Banded view — a rule can be flat at the top yet still order outcomes across the range.
console.log(`\n═══ OUTCOME BY SIGNAL BAND (all rows, not just the top ${TOP_N}) ═══`);
for (const [label, key] of [['technicalNeutral', r => r.technicalNeutral],
                            ['recentVolatility', r => r.recentVolatility],
                            ['notDowntrend', r => r.notDowntrendScore]]) {
  const withVal = all.filter(r => key(r) != null);
  const sorted = [...withVal].sort((a, b) => key(a) - key(b));
  const q = Math.floor(sorted.length / 4);
  const bands = [['bottom 25%', sorted.slice(0, q)], ['mid 50%', sorted.slice(q, sorted.length - q)],
                 ['top 25%', sorted.slice(sorted.length - q)]];
  console.log(`\n  ${label}`);
  for (const [bl, rows] of bands) {
    const eps = episodes(rows);
    console.log(`    ${bl.padEnd(11)} n=${String(eps.length).padStart(5)}  mean ${(f(mean(eps.map(e => e.ret))) + '%').padStart(7)}`
      + `  median ${(f(med(eps.map(e => e.ret))) + '%').padStart(7)}  assigned ${(f(mean(eps.map(e => e.assigned * 100)), 1) + '%').padStart(6)}`
      + `  signal ${f(mean(rows.map(key)), 0).padStart(4)}`);
  }
}

console.log(`\n═══ READ THIS BEFORE ACTING ═══`);
console.log(`• Tests these three signals AS RANKING INPUTS, on the universe. It does not replay the`);
console.log(`  composite — 21 of its 91 weight (fundamentalScore + leverageQuality) draws on`);
console.log(`  fundamentals_cache, which has no history and can never be replayed.`);
console.log(`• The CSP is the ANALYSIS service's (delta band 0.20–0.30), not the Strategy Lab's.`);
console.log(`• Earnings gate not applied — no point-in-time earnings data exists for this period.`);
console.log(`  brief_candidates starts capturing it from v1.1.177 forward.`);
console.log(`• Held to expiry at intrinsic; no roll, early close or post-assignment covered call.`);
console.log(`• One regime, settled through ${maxPx}. Medians are reported alongside means because`);
console.log(`  short-put returns are tail-dominated.`);
db.close();
