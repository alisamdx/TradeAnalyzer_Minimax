// Roll the Dice — is "highest composite wins" selecting the WORST of its eligible set?
//
// The question comes out of v1.1.173 (T2), which found the wheel composite anti-predictive at the
// top: mean return on capital ran +1.91% in the 58–63 band down to −4.99% at 73+. The dice sorts
// its eligible set by `compositeScore` and takes the highest. If a high composite is bad, that
// tiebreak could be picking the worst survivor.
//
// The answer turns out to be structural rather than statistical, so read section A before B.
//
// Outcome, settled at intrinsic with no path assumption:
//     pnl/share = premium − max(0, strike − close@expiry)     return on capital = pnl / strike
// Stored option legs get the mandatory split scale guard (see CLAUDE.md "Known quirks").
//
// see docs/wheel-parameters.md (T2/F8), src/main/services/roll-the-dice.ts

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

const db = new Database(join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));
const maxPx = db.prepare('SELECT MAX(date) d FROM historical_prices').get().d;
const closeOnOrBefore = db.prepare(
  `SELECT close FROM historical_prices WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT 1`);
const MIN_LIQ = 8, SLUG = 'short-naked-put', SCALE_TOLERANCE = 0.35;

const earnings = new Map();
for (const r of db.prepare('SELECT ticker, report_date FROM earnings_calendar').all()) {
  earnings.set(r.ticker, r.report_date);
}
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const f = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));

// Reconstruct the dice's eligible set per brief date — the v1.1.168 trade-quality gates only.
// Capital and conviction stopped excluding anything, so they play no part here.
const days = [];
for (const b of db.prepare(
  `SELECT generated_at, picks FROM daily_briefs WHERE strategy='wheel' ORDER BY generated_at`).all()) {
  const briefDate = b.generated_at.slice(0, 10);
  let arr; try { arr = JSON.parse(b.picks); } catch { continue; }
  const eligible = [];
  for (const p of arr ?? []) {
    const cv = p.criticVerdict;
    if (!cv || cv.verdict !== 'pass' || cv.degraded === true) continue;
    if (p.price == null) continue;
    const s = (p.strategyLabResult?.scores ?? []).find(x => x.slug === SLUG);
    if (!s?.setup || s.setup.unavailableReason) continue;
    const leg = s.setup.legs?.find(l => l.side === 'put' && String(l.action).toLowerCase().startsWith('sell'));
    if (!leg) continue;
    if (s.liquidityScore < MIN_LIQ) continue;
    const rd = earnings.get(p.ticker);
    if (rd === undefined || rd < briefDate || rd <= s.setup.expiration) continue;
    if (s.setup.netCredit == null || s.setup.netCredit <= 0) continue;
    eligible.push({
      ticker: p.ticker, composite: p.compositeScore, expiration: s.setup.expiration,
      strike: leg.strike, premium: leg.mid, liq: s.liquidityScore,
      pop: s.setup.popEstimate, annRet: s.setup.annualizedReturn,
    });
  }
  days.push({ briefDate, eligible });
}

// ── A. How often does the tiebreak even fire? ───────────────────────────────
const sizes = {};
for (const d of days) sizes[d.eligible.length] = (sizes[d.eligible.length] ?? 0) + 1;
const withPick = days.filter(d => d.eligible.length >= 1);
const withChoice = days.filter(d => d.eligible.length >= 2);

console.log(`\nRoll the Dice — does "highest composite wins" pick the worst survivor?`);
console.log(`${days.length} stored brief days\n`);
console.log('═══ A. HOW OFTEN IS THERE A CHOICE TO MAKE? ═══');
console.log(`  eligible-set size:  ${Object.entries(sizes).sort((a, b) => a[0] - b[0])
  .map(([n, c]) => `${n}→${c} day${c === 1 ? '' : 's'}`).join('   ')}`);
console.log(`  days with a pick at all      : ${withPick.length} / ${days.length}`);
console.log(`  days with >= 2 eligible      : ${withChoice.length}`);
console.log(`  => on ${withPick.length - withChoice.length} of ${withPick.length} pick-days `
  + `(${f(((withPick.length - withChoice.length) / withPick.length) * 100, 0)}%) there was exactly ONE`);
console.log(`     eligible candidate, so the tiebreak had nothing to choose between.`);

// ── B. The days where it did fire ───────────────────────────────────────────
function settle(e, briefDate) {
  if (e.expiration > maxPx) return null;
  const s = closeOnOrBefore.get(e.ticker, e.expiration)?.close;
  const spot = closeOnOrBefore.get(e.ticker, briefDate)?.close;
  if (s == null || spot == null || spot <= 0) return null;
  if (Math.abs(e.strike / spot - 1) > SCALE_TOLERANCE) return null;   // scale guard
  const pnl = e.premium - Math.max(0, e.strike - s);
  return { retPct: (pnl / e.strike) * 100, assigned: s < e.strike };
}

console.log(`\n═══ B. THE ${withChoice.length} DAYS WITH A REAL CHOICE ═══`);
const decided = [];
for (const d of withChoice) {
  const ranked = [...d.eligible].sort((a, b) => b.composite - a.composite);
  const outs = ranked.map(e => ({ e, o: settle(e, d.briefDate) }));
  const allSettled = outs.every(x => x.o);
  console.log(`\n  ${d.briefDate}${allSettled ? '' : '   (not fully settled — shown, not counted)'}`);
  for (let i = 0; i < outs.length; i++) {
    const { e, o } = outs[i];
    console.log(`    ${i === 0 ? 'CHOSEN ' : '  alt  '} ${e.ticker.padEnd(6)} comp ${f(e.composite, 1).padStart(5)} `
      + `liq ${String(e.liq).padStart(2)}  ${o ? `ret ${f(o.retPct).padStart(7)}%  ${o.assigned ? 'ASSIGNED' : 'expired'}` : 'ret       —'}`);
  }
  if (allSettled) decided.push({ chosen: outs[0], alts: outs.slice(1) });
}

console.log(`\n  fully settled choice-days: ${decided.length}`);
if (decided.length) {
  const chosenRet = decided.map(x => x.chosen.o.retPct);
  const altRet = decided.map(x => mean(x.alts.map(a => a.o.retPct)));
  const wins = decided.filter((x, i) => chosenRet[i] > altRet[i]).length;
  console.log(`    chosen        mean ${f(mean(chosenRet))}%`);
  console.log(`    alternatives  mean ${f(mean(altRet))}%`);
  console.log(`    chosen beat its own day's alternatives on ${wins} of ${decided.length} days`);
}
console.log(`\n  ${decided.length} observations is FAR below anything that can support a claim. This`);
console.log(`  section is an anecdote, printed for completeness, and must not be read as evidence.`);

// ── C. Where the composite exposure actually is ─────────────────────────────
console.log(`\n═══ C. VERDICT, AND WHERE THE REAL EXPOSURE SITS ═══`);
console.log(`  The dice tiebreak is very nearly VACUOUS: it fires on ${withChoice.length} of ${days.length} brief days,`);
console.log(`  and on ${f((1 - withChoice.length / withPick.length) * 100, 0)}% of pick-days there is only one survivor. Whatever F8 implies`);
console.log(`  about high composites, the dice's exposure to it AT SELECTION TIME is negligible.`);
console.log(`\n  The composite's real influence on the dice is UPSTREAM: the brief keeps only the`);
console.log(`  top PICKS_PER_STRATEGY = 5 by composite out of a STAGE4_POOL_SIZE = 15 candidate`);
console.log(`  pool, and the dice can only ever see those 5. That cut is where an anti-predictive`);
console.log(`  composite would do its damage — and it is NOT testable from daily_briefs, which`);
console.log(`  stores only the survivors.`);

// Size the upstream study: analysis_snapshots keeps the whole universe per date.
const snapDates = new Set(); let snapRows = 0;
for (const r of db.prepare(`SELECT run_at, payload_json FROM analysis_snapshots WHERE mode='wheel'`).all()) {
  snapDates.add(r.run_at.slice(0, 10));
  let p; try { p = JSON.parse(r.payload_json); } catch { continue; }
  snapRows += (Array.isArray(p) ? p : p?.results ?? []).length;
}
console.log(`\n  What COULD test it: analysis_snapshots holds the full wheel universe per date —`);
console.log(`  ${snapDates.size} dates, ~${Math.round(snapRows / Math.max(1, snapDates.size))} tickers each (${snapRows} rows), with a real`);
console.log(`  recommendedStrike / premium / delta / ivRank / optionLiquidityScore on every row.`);
console.log(`  It does NOT store compositeScore, so the composite would have to be reconstructed —`);
console.log(`  and 21 of its 91 weight (fundamentalScore + leverageQuality) comes from`);
console.log(`  fundamentals_cache, which has no history. A selection study using only the`);
console.log(`  reconstructable signals is possible; a faithful composite replay is not.`);
db.close();
