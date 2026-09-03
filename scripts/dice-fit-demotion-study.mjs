// How much does demoting the operator-fit gates widen Roll the Dice?  (v1.1.168)
//
// The capital ceiling and the conviction list stopped EXCLUDING candidates and became reported
// annotations. That is a deliberate widening, requested by the operator — this measures it rather
// than assuming it, so the change ships with its cost known.
//
// Replays every stored wheel brief under BOTH rule sets. The trade-quality gates are identical in
// each, so any difference is attributable solely to the demotion.
//
// KNOWN LIMIT OF THIS REPLAY (unchanged from the feature's original study): `earnings_calendar`
// keeps ONE row per ticker with no history, so a replay sees today's next-report date, not the
// date that was known on the brief date. The earnings gate is therefore not validly replayed —
// it is applied identically to both arms, so the DELTA stays sound even though the absolute
// hit rate does not.  see CLAUDE.md "Known quirks" and docs/formulas.md#roll-the-dice

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Write-capable on purpose: a readonly connection cannot attach the live WAL index on Windows and
// silently reads only to the last checkpoint.  see CLAUDE.md "Inspecting the production DB"
const db = new Database(join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));

const MAX_CAPITAL = 30_000;
const STRETCH_CAPITAL = 50_000;      // the removed exception ceiling
const STRETCH_MIN_SCORE = 70;        // the removed exception score bar
const STRETCH_MIN_LIQUIDITY = 11;    // the removed exception liquidity bar
const MIN_LIQ = 8;
const SLUG = 'short-naked-put';

const earnings = new Map();
for (const r of db.prepare('SELECT ticker, report_date FROM earnings_calendar').all()) {
  earnings.set(r.ticker, r.report_date);
}
const conviction = new Map();
for (const r of db.prepare('SELECT ticker, price_high FROM conviction_stocks').all()) {
  conviction.set(r.ticker, r.price_high);
}

const briefs = db.prepare(
  `SELECT generated_at, picks FROM daily_briefs WHERE strategy = 'wheel' ORDER BY generated_at`,
).all();

/** The trade-quality gates — IDENTICAL in both arms, so they cancel out of the delta. */
function qualityEligible(picks, today) {
  const out = [];
  for (const p of picks) {
    const cv = p.criticVerdict;
    if (!cv || cv.verdict !== 'pass' || cv.degraded === true) continue;
    if (p.price == null) continue;
    const s = (p.strategyLabResult?.scores ?? []).find(x => x.slug === SLUG);
    if (!s?.setup || s.setup.unavailableReason) continue;
    const leg = s.setup.legs.find(l => l.side === 'put' && String(l.action).toLowerCase().startsWith('sell'));
    if (!leg) continue;
    if (s.liquidityScore < MIN_LIQ) continue;
    const rd = earnings.get(p.ticker);
    if (rd === undefined || rd < today || rd <= s.setup.expiration) continue;
    if (s.setup.netCredit == null || s.setup.netCredit <= 0) continue;
    out.push({ p, s, strike: leg.strike, capital: leg.strike * 100 * (leg.qty ?? 1) });
  }
  return out.sort((a, b) => b.p.compositeScore - a.p.compositeScore);
}

/** The OLD arm: capital excluded, with the conviction-anchored stretch tier as the only escape. */
function oldPick(cands) {
  for (const c of cands) {
    if (c.capital <= MAX_CAPITAL) return { ...c, tier: 'base' };
    if (c.capital > STRETCH_CAPITAL) continue;
    const high = conviction.get(c.p.ticker);
    if (high == null) continue;                       // not listed, or no never-above band
    if (c.strike > high) continue;
    if (c.p.compositeScore < STRETCH_MIN_SCORE) continue;
    if (c.s.liquidityScore < STRETCH_MIN_LIQUIDITY) continue;
    return { ...c, tier: 'stretch' };
  }
  return null;
}

let oldDays = 0, newDays = 0, overBudget = 0, offList = 0, breachedBand = 0, altOffered = 0;
let scoreOld = [], scoreNew = [];
const gained = [];

for (const b of briefs) {
  const today = b.generated_at.slice(0, 10);
  let picks;
  try { picks = JSON.parse(b.picks); } catch { continue; }
  if (!Array.isArray(picks) || picks.length === 0) continue;

  const cands = qualityEligible(picks, today);
  const oldP = oldPick(cands);
  const newP = cands[0] ?? null;                      // merit only — nothing else removes

  if (oldP) { oldDays++; scoreOld.push(oldP.p.compositeScore); }
  if (newP) {
    newDays++;
    scoreNew.push(newP.p.compositeScore);
    if (newP.capital > MAX_CAPITAL) {
      overBudget++;
      if (cands.some(c => c.capital <= MAX_CAPITAL)) altOffered++;
    }
    const high = conviction.get(newP.p.ticker);
    if (high === undefined) offList++;
    else if (high != null && newP.strike > high) breachedBand++;
  }
  if (newP && !oldP) {
    gained.push(`${today}  ${newP.p.ticker.padEnd(6)} $${String(newP.capital).padStart(7)}  `
      + `score ${newP.p.compositeScore.toFixed(1)}  liq ${newP.s.liquidityScore.toFixed(0)}/15  `
      + (conviction.has(newP.p.ticker) ? 'on list' : 'OFF list'));
  }
}

const med = a => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0');

console.log(`\nRoll the Dice — operator-fit gate demotion (v1.1.168)`);
console.log(`Briefs replayed: ${briefs.length}\n`);
console.log(`  days with a pick, OLD (capital + conviction gated) : ${oldDays}  (${pct(oldDays, briefs.length)}%)`);
console.log(`  days with a pick, NEW (merit only)                 : ${newDays}  (${pct(newDays, briefs.length)}%)`);
console.log(`  days gained                                        : ${newDays - oldDays}\n`);
console.log(`  median composite of the pick, OLD : ${med(scoreOld)?.toFixed(1) ?? '—'}`);
console.log(`  median composite of the pick, NEW : ${med(scoreNew)?.toFixed(1) ?? '—'}`);
console.log(`     (NEW should be >= OLD: removing a non-merit filter can only raise the merit`);
console.log(`      of the winner, never lower it. A drop would mean a bug.)\n`);
console.log(`  NEW picks needing more than $${MAX_CAPITAL.toLocaleString()} : ${overBudget}  (${pct(overBudget, newDays)}% of pick-days)`);
console.log(`     ...of which a within-budget alternative exists : ${altOffered}`);
console.log(`  NEW picks NOT on the conviction list              : ${offList}  (${pct(offList, newDays)}%)`);
console.log(`  NEW picks breaching a never-above band            : ${breachedBand}  <- flagged loudly, not blocked\n`);

if (gained.length) {
  console.log(`Days that now produce a pick and did not before (${gained.length}):`);
  for (const g of gained) console.log('  ' + g);
}
db.close();
