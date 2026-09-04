// T2 (FR-SEY-5) — should the wheel strategy have a minimum composite gate?
//
// `MIN_COMPOSITE_BY_STRATEGY` gates bearish at 70 and nothing else. That gate was earned: a
// full-year replay showed sub-70 bearish picks carry ~0 alpha and lose money in aggregate. Wheel
// has never been tested for an equivalent floor, so on a weak day the dice pick can be whatever
// happened to be least-bad.
//
// WHY THIS CANNOT USE BRIEF REPLAY. Replay is blind to `premiumYield` (weight 19 of wheel's 91),
// which compresses and shifts the composite scale — `brief-replay-service.ts` says explicitly:
// "Never carry an absolute composite threshold between the two for wheel/income." A gate is an
// absolute threshold, so it must be derived on LIVE composites. (Bearish's 70 was safe to take
// from replay precisely because bearish has no options-derived signal.)
//
// So this runs on the live `daily_briefs` wheel picks, settling each stored CSP at intrinsic
// against the real close on its expiration:
//     pnl/share = premium − max(0, strike − close@expiry)     return on capital = pnl / strike
//
// SCALE GUARD (mandatory here). A split repair fixes `historical_prices` but NOT the option legs
// frozen in `daily_briefs.picks`, leaving the two on different price scales — 4 CRWD rows once
// manufactured −$168,516 of fiction and inverted a study's headline. Any harness reading stored
// legs must compare the strike to the underlying's close on the pick date and EXCLUDE rows that
// disagree, printing them rather than dropping them silently.
//
// see docs/wheel-parameters.md (T2), CLAUDE.md "Known quirks"

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

const db = new Database(join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));
const maxPx = db.prepare('SELECT MAX(date) d FROM historical_prices').get().d;
const SCALE_TOLERANCE = 0.35;   // same bar as scripts/backtest-lizard-vs-spread.mjs

const closeOnOrBefore = db.prepare(
  `SELECT close FROM historical_prices WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT 1`);

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const f = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));

const picks = [];
const excluded = [];
for (const b of db.prepare(
  `SELECT generated_at, picks FROM daily_briefs WHERE strategy='wheel' ORDER BY generated_at`).all()) {
  const briefDate = b.generated_at.slice(0, 10);
  let arr; try { arr = JSON.parse(b.picks); } catch { continue; }
  for (const p of arr ?? []) {
    const s = (p.strategyLabResult?.scores ?? []).find(x => x.slug === 'short-naked-put');
    const leg = s?.setup?.legs?.find(l => l.side === 'put' && String(l.action).toLowerCase().startsWith('sell'));
    if (!leg || !s?.setup?.expiration || typeof p.compositeScore !== 'number') continue;
    const exp = s.setup.expiration;
    if (exp > maxPx) continue;                                   // not settled yet
    const settle = closeOnOrBefore.get(p.ticker, exp)?.close;
    const spot = closeOnOrBefore.get(p.ticker, briefDate)?.close;
    if (settle == null || spot == null || spot <= 0) continue;

    // Scale guard — a stored leg on a different price scale than the repaired series.
    const ratio = leg.strike / spot;
    if (Math.abs(ratio - 1) > SCALE_TOLERANCE) {
      excluded.push({ ticker: p.ticker, briefDate, strike: leg.strike, spot, ratio });
      continue;
    }
    const pnl = leg.mid - Math.max(0, leg.strike - settle);
    picks.push({
      ticker: p.ticker, briefDate, expiration: exp, composite: p.compositeScore,
      strike: leg.strike, premium: leg.mid, liq: s.liquidityScore, dte: s.setup.dte,
      retPct: (pnl / leg.strike) * 100, assigned: settle < leg.strike,
      pop: s.setup.popEstimate, annRet: s.setup.annualizedReturn,
    });
  }
}

console.log(`\nT2 — does the wheel composite predict outcomes well enough to gate on?`);
console.log(`${picks.length} settled live wheel picks · ${new Set(picks.map(p => p.ticker)).size} tickers · `
  + `${new Set(picks.map(p => p.briefDate)).size} brief dates`);
if (excluded.length) {
  console.log(`\n  SCALE GUARD excluded ${excluded.length} row(s) whose stored strike disagrees with the`);
  console.log(`  repaired price series (likely a post-hoc split repair):`);
  for (const e of excluded) console.log(`    ${e.briefDate} ${e.ticker} strike ${e.strike} vs spot ${f(e.spot)} (${f(e.ratio)}x)`);
} else {
  console.log(`  scale guard: 0 rows excluded — stored legs agree with the price series.`);
}

// Episodes: re-picking the same position on consecutive days is not independent evidence.
const epMap = new Map();
for (const p of picks) {
  const k = `${p.ticker}|${p.expiration}`;
  if (!epMap.has(k)) epMap.set(k, []);
  epMap.get(k).push(p);
}
const episodes = [...epMap.values()].map(g => ({
  ticker: g[0].ticker, expiration: g[0].expiration, n: g.length,
  composite: mean(g.map(x => x.composite)), retPct: mean(g.map(x => x.retPct)),
  assigned: mean(g.map(x => x.assigned ? 1 : 0)), liq: mean(g.map(x => x.liq)),
  pop: mean(g.map(x => x.pop ?? NaN)), annRet: mean(g.map(x => x.annRet ?? NaN)),
}));
console.log(`  -> ${episodes.length} independent episodes (ticker + expiry)\n`);

// ── A. Does composite rank outcomes at all? ─────────────────────────────────
console.log('═══ A. OUTCOME BY COMPOSITE BAND (episodes) ═══');
console.log('  A gate is only justified if the BOTTOM band is materially worse than the rest.\n');
const BANDS = [[0, 58], [58, 63], [63, 68], [68, 73], [73, 200]];
console.log(`  ${'composite'.padEnd(12)} ${'n'.padStart(4)} ${'mean ret'.padStart(9)} ${'median'.padStart(8)} `
  + `${'assigned'.padStart(9)} ${'losers'.padStart(7)} ${'liq'.padStart(5)} ${'PoP'.padStart(5)}`);
for (const [lo, hi] of BANDS) {
  const b = episodes.filter(e => e.composite >= lo && e.composite < hi);
  if (!b.length) continue;
  const label = hi === 200 ? `${lo}+` : `${lo}–${hi}`;
  console.log(`  ${label.padEnd(12)} ${String(b.length).padStart(4)} `
    + `${(f(mean(b.map(e => e.retPct))) + '%').padStart(9)} `
    + `${(f(med(b.map(e => e.retPct))) + '%').padStart(8)} `
    + `${(f(mean(b.map(e => e.assigned * 100)), 1) + '%').padStart(9)} `
    + `${(f((b.filter(e => e.retPct < 0).length / b.length) * 100, 0) + '%').padStart(7)} `
    + `${f(mean(b.map(e => e.liq)), 1).padStart(5)} `
    + `${f(mean(b.map(e => e.pop).filter(x => !Number.isNaN(x))), 0).padStart(5)}`);
}

// Rank correlation — does composite order outcomes monotonically?
function spearman(x, y) {
  const rank = arr => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    for (let i = 0; i < idx.length;) {
      let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(x), ry = rank(y), mx = mean(rx), my = mean(ry);
  let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) { const a = rx[i] - mx, b = ry[i] - my; n += a * b; dx += a * a; dy += b * b; }
  return (dx > 0 && dy > 0) ? n / Math.sqrt(dx * dy) : 0;
}
console.log(`\n  Spearman(composite, return on capital) = ${f(spearman(episodes.map(e => e.composite), episodes.map(e => e.retPct)), 3)}`);
console.log(`  (bearish's 70 gate was earned on a clear negative-to-positive split; a value near`);
console.log(`   zero means the composite does not order wheel outcomes and no threshold can help.)`);

// ── B. What would each threshold actually do? ───────────────────────────────
console.log('\n═══ B. THRESHOLD SWEEP — kept vs removed, and the coverage cost ═══');
const dates = [...new Set(picks.map(p => p.briefDate))];
console.log(`\n  ${'gate'.padStart(5)} ${'kept'.padStart(5)} ${'removed'.padStart(8)} ${'kept ret'.padStart(9)} `
  + `${'removed ret'.padStart(12)} ${'delta'.padStart(8)} ${'days emptied'.padStart(13)}`);
for (const T of [0, 55, 58, 60, 62, 65, 68, 70]) {
  const kept = episodes.filter(e => e.composite >= T);
  const removed = episodes.filter(e => e.composite < T);
  // Coverage cost: brief dates left with no wheel pick at all.
  const emptied = dates.filter(d => !picks.some(p => p.briefDate === d && p.composite >= T)).length;
  console.log(`  ${String(T).padStart(5)} ${String(kept.length).padStart(5)} ${String(removed.length).padStart(8)} `
    + `${(f(mean(kept.map(e => e.retPct))) + '%').padStart(9)} `
    + `${(removed.length ? f(mean(removed.map(e => e.retPct))) + '%' : '—').padStart(12)} `
    + `${(removed.length ? f(mean(kept.map(e => e.retPct)) - mean(episodes.map(e => e.retPct))) : '—').padStart(8)} `
    + `${(`${emptied}/${dates.length}`).padStart(13)}`);
}
console.log(`\n  "delta" = how much the gate improves the mean return of what survives, vs no gate.`);
console.log(`  "days emptied" = brief dates left with NO wheel pick — for Roll the Dice that is a`);
console.log(`  no-dice day, on top of the gates it already applies.`);

console.log(`\n═══ READ THIS BEFORE ACTING ═══`);
console.log(`• Population is TOP-5 picks only. A gate can only remove picks that were already`);
console.log(`  selected, so this is the right population — but it is pre-filtered and its`);
console.log(`  composite range (43.8–82.3) is far narrower than the full candidate set.`);
console.log(`• One regime: brief dates from 2026-06-06, settling through ${maxPx}.`);
console.log(`• Held to expiry at intrinsic — no roll, no early close, no post-assignment covered`);
console.log(`  call. All three cushion the assigned cases, which are concentrated in whichever`);
console.log(`  band assigns most.`);
console.log(`• A gate's cost is asymmetric: it removes picks on the WEAKEST days, which are`);
console.log(`  exactly the days the operator has least else to do.`);
db.close();
