// T8 — does the Validate view's ENTRY machinery say anything useful about a CSP strike?
//
// THE QUESTION, in the operator's words: "I can't wheel something I'm not comfortable owning, and
// to own it the strike has to be a reasonable price." The Validate view already computes an entry
// zone, a swing low, an ATR-based stop and an RSI read — none of which the wheel path consults.
// This asks whether any of them separates realised CSP outcomes.
//
// WHAT IS ALREADY KNOWN, so this does not re-litigate it:
//   RSI            -> IS `technicalNeutral` (weight 11-12). Measured FLAT at every level (v1.1.178).
//   SMA50/200 stack-> IS `notDowntrend` (weight 8-9). Measured ANTI-PREDICTIVE twice (v1.1.178,
//                     and v1.1.33 removed ADX on a full-year A/B for the same reason).
//   basis vs SMA200-> own-at-strike (v1.1.169), the one POSITIVE result — but on 12 episodes in a
//                     single ~4-week window, which is why it annotates and does not gate.
// Both known signals are carried below as CONTROLS. If they reproduce their prior results here, on
// a different and much larger base, that is evidence the harness is sound. If they do not, believe
// the harness less, not the new signals more.
//
// WHAT IS GENUINELY UNTESTED, and is the point of this script:
//   1. SWING LOW      — is the strike below the 20-bar low? Real support, not a recency anchor.
//   2. ATR DISTANCE   — (spot - strike) / ATR14. The same cushion expressed in units of how much
//                       the stock actually moves, rather than as a raw percentage. A 5% buffer on a
//                       stock with a 4% ATR is nothing; on a 1% ATR stock it is a lot. Raw % OTM is
//                       carried alongside so the comparison is head-to-head.
//   3. ENTRY ZONE     — analysis-service builds it as [min, max] of the 20-bar swing low and SMA50.
//                       BOTH BOUNDS ARE RECENCY ANCHORS, so the zone re-anchors as price moves and
//                       can never say "too expensive". Observed 2026-09-04 on AMD: zone
//                       $440.50-$499.18 against an SMA200 of $340.97 — "IN ENTRY ZONE" while the
//                       stock traded 39% above its own 200-day. This is the exact shape of the
//                       conviction band that was retired in v1.1.169 for firing on 0 of 39 picks.
//                       Tested anyway rather than dismissed on the mechanism: reading a conclusion
//                       off a formula is how this project has been wrong before.
//
// METHOD. Universe is `analysis_snapshots` mode='wheel' — the whole scanned universe on each date,
// not the 5 survivors the brief keeps, so the losers are present. Every technical is recomputed
// POINT-IN-TIME from bars on or before the snapshot date; nothing is read from a later state.
// Settled at intrinsic, held to expiry:
//
//     pnl/share = premium - max(0, strike - close@expiry)      return on capital = pnl / strike
//
// DE-BIASING, all three mandatory here (see CLAUDE.md):
//   * SPLIT SCALE GUARD — a stored strike more than 35% away from that day's spot is on a different
//     price scale than the settling series and would manufacture enormous fake losses. Excluded and
//     COUNTED, never silently dropped.
//   * EPISODE COLLAPSE — one ticker+expiry is ONE observation however many days it was recommended.
//     Without this a single move counted 13 times can set the headline.
//   * REGIME TELL — SPY's return over each band's own windows is printed beside the result. It is
//     NOT subtracted (a CSP's payoff is capped at the premium, so an excess-of-index figure would
//     be nonsense); it is there so a band that merely sampled a better market is visible as such.
//
// Assignment rate is reported next to return because it is immune to return tails, and for this
// question it is the more direct measure: "was the strike a price the stock stayed above".
//
// NOTHING HERE SHIPS A RULE. Under FR-SEY-5 a gate needs a replay showing it is at worst neutral;
// this is that replay's first half. A positive result earns a follow-up, not a gate.
//
// Usage: node scripts/fr-wheel-entry-quality-study.mjs [--top 5] [--min-liq 5] [--db <path>]
//
// see docs/formulas.md#own-at-strike, scripts/fr-wheel-price-signals-study.mjs (T6),
//     scripts/own-at-strike-study.mjs, docs/wheel-parameters.md

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d; };
const argS  = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const TOP_N = argOf('--top', 5);
const MIN_LIQ = argOf('--min-liq', 5);
const SCALE_TOLERANCE = 0.35;
const DB_PATH = argS('--db', join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));

const db = new Database(DB_PATH);
const maxPx = db.prepare('SELECT MAX(date) d FROM historical_prices').get().d;

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const trimMean = a => {
  if (a.length < 20) return mean(a);
  const s = [...a].sort((x, y) => x - y), k = Math.floor(s.length * 0.05);
  return mean(s.slice(k, s.length - k));
};
const f = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));

// ── Price series, once per ticker ───────────────────────────────────────────
const seriesFor = new Map();
const barsStmt = db.prepare(
  'SELECT date, open, high, low, close FROM historical_prices WHERE ticker = ? ORDER BY date');
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

const sma = (rows, end, n) => {
  if (end < n - 1) return null;
  let s = 0; for (let i = end - n + 1; i <= end; i++) s += rows[i].close;
  return s / n;
};

/** Wilder RSI(14). Mirrors analysis-service computeRSI's period. Control signal. */
function rsi14(rows, end) {
  if (end < 15) return null;
  let gain = 0, loss = 0;
  for (let i = end - 13; i <= end; i++) {
    const ch = rows[i].close - rows[i - 1].close;
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  gain /= 14; loss /= 14;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Wilder ATR(14) at `end`, replicating analysis-service computeATR exactly. */
function atr14(rows, end, period = 14) {
  if (end < period) return null;
  const trs = [];
  for (let i = 0; i <= end; i++) {
    const h = rows[i].high, l = rows[i].low, pc = i > 0 ? rows[i - 1].close : rows[i].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i <= end; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

/** findSwingHighLow(bars, 20).low — the lowest LOW of the last 20 bars, as the service computes it. */
function swingLow20(rows, end, lookback = 20) {
  if (end < lookback - 1) return null;
  let min = Infinity;
  for (let i = end - lookback + 1; i <= end; i++) if (rows[i].low <= min) min = rows[i].low;
  return min === Infinity ? null : min;
}

/** computeTrendDirectionScore(mode='wheel'): bullish 100 / sideways 75 / bearish 10. Control. */
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

// ── SPY, for the regime tell ────────────────────────────────────────────────
const spy = series('SPY');
function spyReturn(fromDate, toDate) {
  const a = upTo(spy, fromDate), b = upTo(spy, toDate);
  if (a < 0 || b < 0 || spy[a].close <= 0) return null;
  return (spy[b].close / spy[a].close - 1) * 100;
}

// ── Build the settled panel ─────────────────────────────────────────────────
const perDate = new Map();
for (const r of db.prepare(
  `SELECT run_at, payload_json FROM analysis_snapshots WHERE mode='wheel' ORDER BY run_at`).all()) {
  perDate.set(r.run_at.slice(0, 10), r.payload_json);   // last run of a date wins
}

const rowsOut = [];
let seen = 0, unsettled = 0, scaleExcluded = 0, illiquid = 0, shortHistory = 0;
const scaleExamples = [];

for (const [date, payload] of perDate) {
  let p; try { p = JSON.parse(payload); } catch { continue; }
  for (const x of (Array.isArray(p) ? p : p?.results ?? [])) {
    const strike = x?.recommendedStrike, prem = x?.premium, exp = x?.expiration;
    if (!x?.ticker || strike == null || prem == null || !exp) continue;
    seen++;
    if (exp > maxPx) { unsettled++; continue; }

    const rows = series(x.ticker);
    const iEnd = upTo(rows, date), iExp = upTo(rows, exp);
    if (iEnd < 0 || iExp < 0) { unsettled++; continue; }

    const spot = x.lastPrice ?? rows[iEnd].close;
    if (!spot || spot <= 0) { unsettled++; continue; }
    // Split scale guard — printed, not silently dropped. A repaired price series makes a stored
    // leg MORE wrong, not less, so this can never be assumed unnecessary.
    if (Math.abs(strike / spot - 1) > SCALE_TOLERANCE) {
      scaleExcluded++;
      if (scaleExamples.length < 5) scaleExamples.push(`${date} ${x.ticker} K=${strike} spot=${f(spot)}`);
      continue;
    }
    if ((x.optionLiquidityScore ?? 0) < MIN_LIQ) { illiquid++; continue; }

    const s50 = sma(rows, iEnd, 50), s200 = sma(rows, iEnd, 200);
    const swing = swingLow20(rows, iEnd);
    const atr = atr14(rows, iEnd);
    if (s200 == null || swing == null || atr == null || atr <= 0) { shortHistory++; continue; }

    const settle = rows[iExp].close;
    const pnl = prem - Math.max(0, strike - settle);
    const basis = strike - prem;                       // what assignment actually costs per share
    const ezLow = Math.min(swing, s50 ?? swing);
    const ezHigh = Math.max(swing, s50 ?? swing);

    rowsOut.push({
      date, ticker: x.ticker, expiration: exp, strike, spot, basis,
      retPct: (pnl / strike) * 100,
      assigned: settle < strike,
      spyRet: spyReturn(date, exp),

      // ── the three untested measures ──
      strikeBelowSwing: strike < swing,
      swingDistPct: ((swing - strike) / swing) * 100,   // + = strike is below support
      atrDist: (spot - strike) / atr,                   // cushion in units of daily true range
      otmPct: ((spot - strike) / spot) * 100,           // the same cushion, raw — head-to-head
      strikeBelowZone: strike < ezLow,
      strikeInZone: strike >= ezLow && strike <= ezHigh,

      // ── controls with known prior results ──
      basisVsSma200Pct: (basis / s200 - 1) * 100,
      atOrBelowSma200: basis <= s200,
      rsi: rsi14(rows, iEnd),
      nd: notDowntrend(rows, iEnd),
      dte: x.dte ?? null,
    });
  }
}

/** One ticker+expiry is ONE observation, however many days it was recommended. */
function episodes(rs) {
  const m = new Map();
  for (const r of rs) {
    const k = `${r.ticker}|${r.expiration}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.values()].map(g => ({
    ret: mean(g.map(x => x.retPct)),
    assigned: mean(g.map(x => (x.assigned ? 1 : 0))),
    spy: mean(g.map(x => x.spyRet).filter(v => v != null)),
    picks: g.length,
  }));
}

const dates = new Set(rowsOut.map(r => r.date));
console.log(`\nT8 — does the Validate view's entry machinery say anything about a CSP strike?`);
console.log(`${rowsOut.length} settled, liquidity-gated rows (optionLiquidityScore >= ${MIN_LIQ}) across ${dates.size} dates`);
console.log(`  of ${seen} scanned rows: ${unsettled} not yet settled, ${illiquid} below the liquidity gate,`);
console.log(`  ${shortHistory} with too little price history, ${scaleExcluded} excluded by the SPLIT SCALE GUARD`);
for (const e of scaleExamples) console.log(`     scale-excluded: ${e}`);
if (rowsOut.length === 0) { console.log('\nNothing settled to measure.\n'); db.close(); process.exit(0); }

const allEps = episodes(rowsOut);
const hdr = () => console.log(`  ${'band'.padEnd(34)} ${'eps'.padStart(5)} ${'mean'.padStart(8)} ${'median'.padStart(8)} `
  + `${'trimmed'.padStart(8)} ${'assigned'.padStart(9)} ${'SPY'.padStart(7)}`);
const line = (label, eps) => console.log(`  ${label.padEnd(34)} ${String(eps.length).padStart(5)} `
  + `${(f(mean(eps.map(e => e.ret))) + '%').padStart(8)} `
  + `${(f(med(eps.map(e => e.ret))) + '%').padStart(8)} `
  + `${(f(trimMean(eps.map(e => e.ret))) + '%').padStart(8)} `
  + `${(f(mean(eps.map(e => e.assigned * 100)), 1) + '%').padStart(9)} `
  + `${(f(mean(eps.map(e => e.spy).filter(v => v != null)), 1) + '%').padStart(7)}`);

const quartilesOf = (key) => {
  const vals = rowsOut.map(r => r[key]).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (vals.length < 8) return null;
  return [0.25, 0.5, 0.75].map(q => vals[Math.floor(vals.length * q)]);
};

// ── 1. Binary splits: does the measure separate at all? ─────────────────────
console.log(`\n═══ BINARY SPLITS — one ticker+expiry = one episode ═══`);
console.log(`  (SPY is the regime tell, NOT subtracted: a CSP's payoff is capped at the premium,`);
console.log(`   so an excess-of-index figure would be meaningless. If two bands differ on SPY,`);
console.log(`   they sampled different markets and the return gap is not the signal.)\n`);
hdr();
line('UNIVERSE (no selection)', allEps);
console.log('');
const split = (label, pred) => {
  line(`${label} — YES`, episodes(rowsOut.filter(pred)));
  line(`${label} — no`,  episodes(rowsOut.filter(r => !pred(r))));
};
split('1. strike below 20-bar swing low', r => r.strikeBelowSwing);
console.log('');
split('3. strike below the entry zone', r => r.strikeBelowZone);
line('3. strike INSIDE the entry zone', episodes(rowsOut.filter(r => r.strikeInZone)));
console.log('');
split('C. basis at/below SMA200 (v1.1.169)', r => r.atOrBelowSma200);

// ── 1b. Does the swing low add anything AFTER own-at-strike? ───────────────
// Every measure here is a distance between the strike and some anchor, so they are correlated by
// construction — the entry-zone and swing-low splits above are nearly the same partition (858 vs
// 869 episodes) because `entryZoneLow = min(swingLow, SMA50)` and the swing low is usually the
// min. The question that decides whether anything NEW has been found is conditional: inside each
// SMA200 band, does the swing low still separate? If it collapses, it is the same information.
console.log(`
═══ 1b. CONDITIONAL — does the swing low survive controlling for own-at-strike? ═══`);
console.log(`  All these measures are strike-to-anchor distances and are collinear by construction.`);
console.log(`  A measure only ADDS if it still separates INSIDE a band of the measure we already have.
`);
hdr();
for (const [bandLabel, bandPred] of [
  ['basis AT/BELOW SMA200', r => r.atOrBelowSma200],
  ['basis ABOVE SMA200',    r => !r.atOrBelowSma200],
]) {
  line(`${bandLabel} · below swing`, episodes(rowsOut.filter(r => bandPred(r) && r.strikeBelowSwing)));
  line(`${bandLabel} · not below`,   episodes(rowsOut.filter(r => bandPred(r) && !r.strikeBelowSwing)));
}

// The obvious objection to 1b: "below the swing low" might just BE "deeper OTM". If the two
// splits differ in cushion, the swing low is only re-expressing distance and adds nothing.
{
  const a = rowsOut.filter(r => r.strikeBelowSwing), b = rowsOut.filter(r => !r.strikeBelowSwing);
  console.log(`
  Is "below swing" just "deeper OTM"?  mean cushion — below: `
    + `${f(mean(a.map(r => r.otmPct)))}% OTM / ${f(mean(a.map(r => r.atrDist)))} ATR   vs   not below: `
    + `${f(mean(b.map(r => r.otmPct)))}% OTM / ${f(mean(b.map(r => r.atrDist)))} ATR`);
  console.log(`  (if these are close, the swing low is carrying information that raw distance is not)`);
}

// ...and they are NOT close (8.46% vs 3.28% OTM), so the objection stands and has to be settled
// properly: hold the cushion roughly constant and see whether the swing low still separates
// inside it. If it does not, "below the swing low" is just "further OTM" and adds nothing that
// (spot - strike) does not already say.
console.log(`
═══ 1d. DECISIVE — swing low WITHIN a fixed cushion band ═══`);
console.log(`  Below-swing strikes sit 2.6x further OTM, so the 1b result may be the distance`);
console.log(`  effect in disguise. Inside an ATR-cushion quartile the distance is roughly held,`);
console.log(`  so anything left is the swing low's own contribution.
`);
{
  const cuts = quartilesOf('atrDist');
  const bands = [
    ['Q1 cushion', r => r.atrDist <= cuts[0]],
    ['Q2 cushion', r => r.atrDist > cuts[0] && r.atrDist <= cuts[1]],
    ['Q3 cushion', r => r.atrDist > cuts[1] && r.atrDist <= cuts[2]],
    ['Q4 cushion', r => r.atrDist > cuts[2]],
  ];
  hdr();
  for (const [label, pred] of bands) {
    const inBand = rowsOut.filter(r => Number.isFinite(r.atrDist) && pred(r));
    line(`${label} · below swing`, episodes(inBand.filter(r => r.strikeBelowSwing)));
    line(`${label} · not below`,   episodes(inBand.filter(r => !r.strikeBelowSwing)));
  }
  console.log(`
  Same test for own-at-strike, so the two are judged on identical terms:
`);
  hdr();
  for (const [label, pred] of bands) {
    const inBand = rowsOut.filter(r => Number.isFinite(r.atrDist) && pred(r));
    line(`${label} · basis <= SMA200`, episodes(inBand.filter(r => r.atOrBelowSma200)));
    line(`${label} · basis > SMA200`,  episodes(inBand.filter(r => !r.atOrBelowSma200)));
  }
}

// ── 1c. Harness check: RSI must reproduce its published null result ────────
// v1.1.178 measured `technicalNeutral` (= RSI) FLAT at every level. If it separates here, this
// harness is measuring something other than what that study measured, and every number above
// should be distrusted before any of them is believed.
console.log(`
═══ 1c. HARNESS CHECK — RSI(14), which v1.1.178 measured FLAT ═══`);
console.log(`  This is not a question about RSI. It is a check that this panel reproduces a known`);
console.log(`  null. A large separation here would mean the harness, not the signal, is interesting.
`);
hdr();
for (const [label, pred] of [
  ['RSI < 40 (oversold)',    r => r.rsi != null && r.rsi < 40],
  ['RSI 40-60 (the target)', r => r.rsi != null && r.rsi >= 40 && r.rsi <= 60],
  ['RSI > 60 (extended)',    r => r.rsi != null && r.rsi > 60],
]) line(label, episodes(rowsOut.filter(pred)));

// ── 2. ATR distance vs raw % OTM, head to head ─────────────────────────────
console.log(`\n═══ 2. ATR-NORMALISED CUSHION vs RAW % OTM ═══`);
console.log(`  The same distance expressed two ways. If ATR units beat raw percent, the wheel is`);
console.log(`  mispricing its buffer on high-volatility names — which is where it gets assigned.\n`);
for (const key of ['atrDist', 'otmPct']) {
  const cuts = quartilesOf(key);
  if (!cuts) continue;
  console.log(`  ${key === 'atrDist' ? 'ATR cushion (spot-strike)/ATR14' : 'raw % OTM (spot-strike)/spot'}` +
    `   quartile cuts: ${cuts.map(c => f(c)).join(' / ')}`);
  hdr();
  const bands = [
    ['Q1 (thinnest cushion)', r => r[key] <= cuts[0]],
    ['Q2',                    r => r[key] > cuts[0] && r[key] <= cuts[1]],
    ['Q3',                    r => r[key] > cuts[1] && r[key] <= cuts[2]],
    ['Q4 (widest cushion)',   r => r[key] > cuts[2]],
  ];
  for (const [label, pred] of bands) line(label, episodes(rowsOut.filter(r => Number.isFinite(r[key]) && pred(r))));
  console.log('');
}

// ── 3. As selection rules, against no selection ────────────────────────────
console.log(`═══ SELECTION RULES — top ${TOP_N} per date, vs taking the universe ═══`);
console.log(`  A measure can separate in bands and still fail here, which is the test that matters`);
console.log(`  for a ranking input. Ties are broken arbitrarily, so small gaps mean nothing.\n`);
hdr();
line('UNIVERSE (no selection)', allEps);
const RULES = [
  ['widest ATR cushion',        r => r.atrDist],
  ['widest raw % OTM',          r => r.otmPct],
  ['deepest below swing low',   r => r.swingDistPct],
  ['lowest basis vs SMA200',    r => -r.basisVsSma200Pct],
  ['INVERTED: thinnest ATR',    r => -r.atrDist],
];
for (const [label, score] of RULES) {
  const picked = [];
  for (const d of dates) {
    const day = rowsOut.filter(r => r.date === d && Number.isFinite(score(r)));
    picked.push(...day.sort((a, b) => score(b) - score(a)).slice(0, TOP_N));
  }
  line(label, episodes(picked));
}

console.log(`\nCaveats`);
console.log(`• Held to expiry at intrinsic. No roll, no early close, no post-assignment covered call —`);
console.log(`  so "assigned" is an outcome here, not the start of the next leg of the wheel.`);
console.log(`• RSI and the SMA stack are CONTROLS with published prior results (flat, anti-predictive).`);
console.log(`  If they do not reproduce, distrust this harness before trusting the new measures.`);
console.log(`• The entry zone is bounded by the 20-bar swing low and SMA50 — both recency anchors —`);
console.log(`  so it re-anchors as price moves. A positive result for it would need explaining, not`);
console.log(`  just accepting; that is the shape that killed the conviction band.`);
console.log(`• One regime, settled through ${maxPx}. Medians and trimmed means are reported alongside`);
console.log(`  means because short-put returns are tail-dominated.`);
console.log(`• Nothing here ships a rule. FR-SEY-5 needs a replay showing at-worst-neutral first.\n`);
db.close();
