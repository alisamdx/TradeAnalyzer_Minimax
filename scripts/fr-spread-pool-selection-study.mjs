// BPS-2 (FR-SEY-5) — does the wheel composite's top-N cut earn its place as the spread's pool?
//
// THE QUESTION. The bull put spread's pool is the wheel composite's top 15 (08 §3.1), and then §3.1
// DISCARDS the composite's rank, because v1.1.173 measured its top end anti-predictive. BPS-2 asks
// whether that is coherent: the cut and the rank are the same number off the same signal.
//
// WHAT IS ALREADY KNOWN, so this study does not re-measure it:
//   T2/F7  a minimum-composite FLOOR is actively harmful — every threshold made the book monotonically
//          worse while emptying 14 of 35 dates. Rejected, closed.
//   T5     ranking the whole universe on premium richness BEATS no selection (+1.03 mean / +2.67
//          median); ranking on the lowest premium is the worst rule tested. So selection is not the
//          problem — this composite may simply dilute the one signal that carries it.
//   T6     the three price-derived signals (technicalNeutral 11, recentVolatility 10, notDowntrend 8)
//          weighted as the composite does add +0.14 mean / −0.18 median over no selection at all, and
//          INVERTING them beats that on both.
//
// WHAT NOBODY HAS RUN, and what this does: the composite ITSELF as a selection rule over the whole
// universe, against premium richness and against a random draw of the same size. T5 tested the
// composite's ingredients; T6 tested three of them; neither tested the cut the pool actually uses.
//
// THE 21 POINTS THAT CAN NEVER BE TESTED. `fundamentalScore` (17) + `leverageQuality` (4) come from
// `fundamentals_cache`, which has no history, so this reconstructs 70 of the composite's 91 ranking
// points. That is a real limitation and it is also part of the answer: a fifth of the rule that picks
// the pool is permanently unverifiable. Everything below says "composite-70" for that reason.
//
// TWO MEASURES, and the second is the one that matters for a spread:
//   • return on capital  — premium − max(0, strike − close@expiry), over strike. Comparable to T5/T6.
//   • ASSIGNED RATE      — close@expiry < strike. This is the spread's actual win condition
//     (stayed-above-strike), it is immune to the return tails, and the parked open thread in
//     [[project-scoring-replay-validation]] says retention is ~flat across composite quintiles. If the
//     composite cannot separate assignment, it cannot separate a bull put spread's outcome either.
//
// DE-BIASING, all three mandatory here (CLAUDE.md):
//   • SCALE GUARD — a split repair fixes `historical_prices` but not a stored strike, and four CRWD
//     rows once inverted a study's headline. Rows whose strike disagrees with spot are EXCLUDED and
//     PRINTED, never dropped silently.
//   • EPISODE COLLAPSE — a rule that picks NVDA on eight consecutive days has made one bet, not eight.
//     Repeats within --episode-days of that ticker's last kept entry are folded in. T5 and T6 did not
//     do this; it is reported both ways so the difference is visible rather than assumed.
//   • RANDOM BASELINE — "beats the universe mean" is the wrong null for a top-N rule, because a small
//     N has sampling noise a whole-universe mean does not. Each rule is compared against repeated
//     random draws of the SAME size on the SAME dates.
//
// Needs the NODE better-sqlite3 ABI. `npm run package` leaves it set to ELECTRON, so if you have just
// built, run `npm run rebuild:node` first or this dies with NODE_MODULE_VERSION 128 vs 137.
//
// Run from a NORMAL terminal (not a Claude session — that shell is MSIX-redirected and reads a shadow
// copy of the database; see CLAUDE.md). The app may be running: this only reads.
//
//   node scripts/fr-spread-pool-selection-study.mjs [--top 15] [--min-liq 5] [--episode-days 14]
//                                                   [--draws 400] [--out FILE]
//
// see docs/wheel-parameters.md (F7, F8, T5, T6), NewApp/TODO-bull-put-spread.md BPS-2

import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d; };
const strOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const TOP_N = argOf('--top', 15);            // the pool cut (picked + capped_out); 5 = the brief's picks
const MIN_LIQ = argOf('--min-liq', 5);       // optionLiquidityScore 0–10, the brief's gate
const EPISODE_DAYS = argOf('--episode-days', 14);
const DRAWS = argOf('--draws', 400);
const OUT = strOf('--out', null);
const SCALE_TOLERANCE = 0.35;

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

// --db exists so the harness can be exercised end-to-end against a synthetic fixture before it is
// trusted on real data (scripts/selftest-spread-pool-selection.mjs). It is NOT for pointing at a copy
// of the live database: a copy read while the app is running is a stale shadow (CLAUDE.md).
const db = new Database(strOf('--db', join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite')));
const maxPx = db.prepare('SELECT MAX(date) d FROM historical_prices').get().d;

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const trimMean = a => {
  if (a.length < 20) return mean(a);
  const s = [...a].sort((x, y) => x - y), k = Math.floor(s.length * 0.05);
  return mean(s.slice(k, s.length - k));
};
const f = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));
const clamp = x => Math.max(0, Math.min(100, x));

// ── Price series, cached ────────────────────────────────────────────────────
const seriesCache = new Map();
const seriesStmt = db.prepare('SELECT date, close FROM historical_prices WHERE ticker = ? ORDER BY date');
const series = t => {
  if (!seriesCache.has(t)) seriesCache.set(t, seriesStmt.all(t));
  return seriesCache.get(t);
};
function upTo(rows, date) {
  let lo = 0, hi = rows.length - 1, res = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m].date <= date) { res = m; lo = m + 1; } else hi = m - 1; }
  return res;
}

// ── Signals, replicated from scoring-service.ts BASELINE_WHEEL ──────────────
// Hardcoded weights, as T6 does. If the operator has edited the weights in Settings → Scoring, this
// study measures the BASELINE composite and not the live one — stated rather than silently assumed.
const W = { ivRank: 22, premiumYield: 19, technicalNeutral: 11, recentVolatility: 10, notDowntrend: 8 };
const W_TOTAL = Object.values(W).reduce((a, b) => a + b, 0);   // 70 of 91
// BASELINE_INCOME, the BPS-1 challenger pool. `trendNeutral` (15) is omitted: USE_ADX_IN_SCORING is
// false, so it is always missing live and income really runs on 85 points, of which these are 72.
const WI = { ivRank: 30, premiumRiskRatio: 22, recentVolatility: 20 };

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
function realizedVol(rows, end) {
  if (end < 21) return null;
  const lr = [];
  for (let i = end - 19; i <= end; i++) if (rows[i - 1].close > 0) lr.push(Math.log(rows[i].close / rows[i - 1].close));
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
  if (price == null || price <= 0) return null;
  const s50 = sma(rows, end, 50), s200 = sma(rows, end, 200);
  if (s50 != null && s200 != null) {
    if (price > s50 && s50 > s200) return 100;
    if (price < s50 && s50 < s200) return 10;
    return 75;
  }
  if (s200 != null) return price > s200 ? 100 : 10;
  return null;
}
function normTargetRange(raw, lo = 40, hi = 60) {
  if (raw == null) return null;
  const w = hi - lo;
  if (raw < lo) return clamp(100 - ((lo - raw) / w) * 100);
  if (raw > hi) return clamp(100 - ((raw - hi) / w) * 100);
  return 100;
}
const normHigher = (raw, max) => (raw == null ? null : clamp((raw / max) * 100));
const normLower = (raw, max) => (raw == null ? null : clamp((1 - raw / max) * 100));

/**
 * The composite as ScoringService computes it, over the signals that can be reconstructed.
 * A MISSING signal keeps its weight in the denominator — that is what the live service does, and it
 * is why `recentVolatility`'s normMax pins some medians low (docs/wheel-parameters.md F10).
 */
function composite70(r) {
  let num = 0;
  num += (r.nIvRank ?? 0) * W.ivRank;
  num += (r.nPremiumYield ?? 0) * W.premiumYield;
  num += (r.nTechnicalNeutral ?? 0) * W.technicalNeutral;
  num += (r.nRecentVolatility ?? 0) * W.recentVolatility;
  num += (r.nNotDowntrend ?? 0) * W.notDowntrend;
  return num / W_TOTAL;
}

// ── Universe, one snapshot per date (the batch runs twice a day; later wins) ─
const perDate = new Map();
for (const r of db.prepare(
  `SELECT run_at, payload_json FROM analysis_snapshots WHERE mode='wheel' ORDER BY run_at`).all()) {
  perDate.set(r.run_at.slice(0, 10), r.payload_json);
}

let rawRows = 0, noStructure = 0, unsettled = 0, illiquidDropped = 0, noSignals = 0;
const scaleRejects = [];
const byDate = new Map();
for (const [date, payload] of perDate) {
  let p; try { p = JSON.parse(payload); } catch { continue; }
  const kept = [];
  for (const x of (Array.isArray(p) ? p : p?.results ?? [])) {
    rawRows++;
    const strike = x?.recommendedStrike, prem = x?.premium, exp = x?.expiration;
    if (!x?.ticker || strike == null || prem == null || !exp) { noStructure++; continue; }
    if (exp > maxPx) { unsettled++; continue; }
    const rows = series(x.ticker);
    const iEnd = upTo(rows, date), iExp = upTo(rows, exp);
    if (iEnd < 0 || iExp < 0) { unsettled++; continue; }
    const settle = rows[iExp].close;
    const spot = x.lastPrice ?? rows[iEnd].close;
    if (!spot || spot <= 0) { noStructure++; continue; }
    if (Math.abs(strike / spot - 1) > SCALE_TOLERANCE) {
      scaleRejects.push(`${date} ${x.ticker} strike ${strike} vs spot ${f(spot)} (${f(strike / spot, 3)}×)`);
      continue;
    }
    if ((x.optionLiquidityScore ?? 0) < MIN_LIQ) { illiquidDropped++; continue; }

    const rsi = rsi14(rows, iEnd), rv = realizedVol(rows, iEnd), nd = notDowntrend(rows, iEnd);
    if (rsi == null && rv == null && nd == null) { noSignals++; continue; }

    const pnl = prem - Math.max(0, strike - settle);
    const row = {
      date, ticker: x.ticker, strike, expiration: exp,
      retPct: (pnl / strike) * 100,
      assigned: settle < strike,
      ivRank: x.ivRank ?? null, annRet: x.annualizedReturn ?? null,
      nIvRank: normHigher(x.ivRank ?? null, 100),
      nPremiumYield: normHigher(x.annualizedReturn ?? null, 60),
      nTechnicalNeutral: normTargetRange(rsi),
      nRecentVolatility: normLower(rv, 60),
      nNotDowntrend: nd,
    };
    row.composite = composite70(row);
    kept.push(row);
  }
  if (kept.length) byDate.set(date, kept);
}

const all = [...byDate.values()].flat();
say(`# BPS-2 — does the composite's top-${TOP_N} cut earn its place as the spread's pool?\n`);
say(`snapshot rows ${rawRows} · usable ${all.length} across ${byDate.size} dates · liquidity gate >= ${MIN_LIQ}/10`);
say(`dropped: no structure ${noStructure} · not settled ${unsettled} · illiquid ${illiquidDropped} · no signals ${noSignals} · scale guard ${scaleRejects.length}`);
if (scaleRejects.length) {
  say(`\nSCALE-GUARD EXCLUSIONS (printed, not dropped silently — a stored strike on a different price scale):`);
  for (const s of scaleRejects.slice(0, 12)) say(`  ${s}`);
  if (scaleRejects.length > 12) say(`  … and ${scaleRejects.length - 12} more`);
}
say(`\ncomposite reconstructed from ${W_TOTAL} of 91 ranking points — fundamentalScore (17) and`);
say(`leverageQuality (4) draw on fundamentals_cache, which has no history and never can be replayed.`);
say(`outcome = premium − max(0, strike − close@expiry), as % of strike; assigned = close < strike.\n`);

const eligible = [...byDate.entries()].filter(([, rows]) => rows.length >= TOP_N);
say(`dates with at least ${TOP_N} candidates: ${eligible.length} of ${byDate.size}` +
    (eligible.length < byDate.size ? `  (the rest cannot exercise a top-${TOP_N} cut at all)` : ''));

// ── Episode collapse ────────────────────────────────────────────────────────
// A rule picking one ticker on consecutive days has made ONE bet. Kept rows only; the first entry wins.
function collapse(rows) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
  const lastKept = new Map();
  const keep = [];
  for (const r of sorted) {
    const prev = lastKept.get(r.ticker);
    const days = prev ? Math.round((Date.parse(`${r.date}T00:00:00Z`) - Date.parse(`${prev}T00:00:00Z`)) / 86_400_000) : Infinity;
    if (days <= EPISODE_DAYS) continue;
    keep.push(r);
    lastKept.set(r.ticker, r.date);
  }
  return keep;
}

const summarise = rows => ({
  n: rows.length,
  mean: mean(rows.map(r => r.retPct)),
  median: med(rows.map(r => r.retPct)),
  trimmed: trimMean(rows.map(r => r.retPct)),
  assigned: rows.length ? (rows.filter(r => r.assigned).length / rows.length) * 100 : null,
});
const line = (label, s) => `  ${label.padEnd(30)} n=${String(s.n).padStart(5)}  mean ${(f(s.mean) + '%').padStart(8)}`
  + `  median ${(f(s.median) + '%').padStart(8)}  trimmed ${(f(s.trimmed) + '%').padStart(8)}  assigned ${(f(s.assigned, 1) + '%').padStart(7)}`;

// ── Selection rules ─────────────────────────────────────────────────────────
const RULES = [
  ['composite-70 (the live cut)', r => r.composite],
  // BPS-1's challenger pool, and it can be reconstructed MORE completely than wheel's: income carries no
  // fundamentals weight at all, so 72 of its 85 live points are here (the missing 13 is optionLiquidity,
  // already applied above as a gate). `trendNeutral` (15) is excluded because USE_ADX_IN_SCORING is false
  // and it is always missing live — including it here would measure a composite the app never computes.
  ['income-72 (BPS-1 challenger)', r => (r.nIvRank ?? 0) * WI.ivRank
    + (r.nPremiumYield ?? 0) * WI.premiumRiskRatio + (r.nRecentVolatility ?? 0) * WI.recentVolatility],
  ['premium richness (annRet)', r => r.annRet ?? -1],
  ['ivRank only', r => r.ivRank ?? -1],
  ['ivRank + premiumYield (41pts)', r => (r.nIvRank ?? 0) * W.ivRank + (r.nPremiumYield ?? 0) * W.premiumYield],
  ['the 29 dead points only', r => (r.nTechnicalNeutral ?? 0) * W.technicalNeutral
    + (r.nRecentVolatility ?? 0) * W.recentVolatility + (r.nNotDowntrend ?? 0) * W.notDowntrend],
  ['INVERTED composite-70', r => -r.composite],
];

const pick = (rows, keyFn) => [...rows].sort((a, b) => keyFn(b) - keyFn(a)).slice(0, TOP_N);

say(`\n## Selection rules at top-${TOP_N}, every eligible date\n`);
say(`  (raw = every selected ticker-day; episodes = repeats within ${EPISODE_DAYS} days folded into one bet)\n`);

const results = [];
for (const [label, keyFn] of RULES) {
  const raw = eligible.flatMap(([, rows]) => pick(rows, keyFn));
  const eps = collapse(raw);
  results.push({ label, raw: summarise(raw), eps: summarise(eps) });
}
say(`RAW`);
for (const r of results) say(line(r.label, r.raw));
say(`\nEPISODE-COLLAPSED  (the honest n)`);
for (const r of results) say(line(r.label, r.eps));

// ── Baselines ───────────────────────────────────────────────────────────────
// "beats the universe mean" is the wrong null for a top-N rule: a small N carries sampling noise the
// whole-universe mean does not. Random draws of the SAME size on the SAME dates are the right one.
const universe = summarise(eligible.flatMap(([, rows]) => rows));
const universeEps = summarise(collapse(eligible.flatMap(([, rows]) => rows)));

let rngState = 20260920;
const rnd = () => { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState / 0x7fffffff; };
const drawMeans = [], drawAssigned = [], drawMedians = [], drawTrimmed = [];
for (let d = 0; d < DRAWS; d++) {
  const picked = eligible.flatMap(([, rows]) => {
    const pool = [...rows];
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    return pool.slice(0, TOP_N);
  });
  const s = summarise(collapse(picked));
  drawMeans.push(s.mean); drawMedians.push(s.median); drawAssigned.push(s.assigned); drawTrimmed.push(s.trimmed);
}
const pctl = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)]; };

say(`\n## Baselines\n`);
say(line('whole universe (raw)', universe));
say(line('whole universe (episodes)', universeEps));
say(`  ${`random ${TOP_N}/date × ${DRAWS} draws`.padEnd(30)}        mean ${(f(mean(drawMeans)) + '%').padStart(8)}`
  + `  median ${(f(mean(drawMedians)) + '%').padStart(8)}  trimmed ${(f(mean(drawTrimmed)) + '%').padStart(8)}`
  + `  assigned ${(f(mean(drawAssigned), 1) + '%').padStart(7)}`);
// Every reported statistic gets its own band. Without one, a rule that wins on the trimmed mean has no
// null to be judged against, and the reader supplies an imaginary one.
say(`  random 5th–95th pct:  mean ${f(pctl(drawMeans, 0.05))}% … ${f(pctl(drawMeans, 0.95))}%` +
    `   median ${f(pctl(drawMedians, 0.05))}% … ${f(pctl(drawMedians, 0.95))}%` +
    `   trimmed ${f(pctl(drawTrimmed, 0.05))}% … ${f(pctl(drawTrimmed, 0.95))}%` +
    `   assigned ${f(pctl(drawAssigned, 0.05), 1)}% … ${f(pctl(drawAssigned, 0.95), 1)}%`);

say(`\n## Read this as\n`);
say(`  A rule EARNS the cut only if its episode-collapsed result sits OUTSIDE the random band above.`);
say(`  Inside the band means the cut is picking no better than chance — which is the BPS-2 question,`);
say(`  and would make "the composite selects but does not rank" incoherent in the direction of`);
say(`  dropping the composite from the pool rather than restoring it to the ranking.`);
say(`  ASSIGNED RATE is the measure that matters for a bull put spread: it is the spread's own win`);
say(`  condition (stayed above the short strike) and is immune to the return tails.`);
say(`\n  Sample: ${byDate.size} dates, one regime. A rule that wins here has not been shown to`);
say(`  generalise — see the hold_days sweep, which was monotone on one month and inverted on six.`);

if (OUT) { writeFileSync(OUT, out.join('\n') + '\n', 'utf8'); console.error(`\nwritten to ${OUT}`); }
db.close();
