// T8 follow-up — would the own-at-strike x swing-low annotation have said anything true about the
// picks the DICE actually produced?
//
// WHY THIS IS A SEPARATE RUN FROM T8. `fr-wheel-entry-quality-study.mjs` measured the 2x2 on the
// whole SCANNED universe (4,917 settled rows, 1,585 episodes) and found it separates strongly. That
// is not the same claim as "it separates on the dice's picks". The dice population is what survives
// critic-pass + non-degraded + a constructible CSP + liquidity >= 8 + earnings clear + real credit,
// and v1.1.174 measured those gates doing essentially all the selecting — on 27 of 34 pick-days
// (79%) exactly ONE candidate is eligible. A signal can be real on the universe and vacuous here
// simply because the upstream gates already removed the rows it would have flagged.
//
// So this asks three questions the universe study cannot:
//   1. HOW OFTEN would the annotation fire on an actual dice pick? A warning that never fires is
//      indistinguishable from a warning nothing violates (the conviction band's failure mode).
//   2. WHEN it fired, was it right? Outcomes by cell, on the picks the operator actually got.
//   3. Does the brief's own top-5 cut already handle it? Same cells across all brief picks.
//
// THE GATES ARE REPLAYED, NOT APPROXIMATED. `qualityEligible` below mirrors
// scripts/dice-fit-demotion-study.mjs exactly, which in turn mirrors roll-the-dice.ts, so the
// population here is the dice's own.
//
// KNOWN LIMIT, inherited and unavoidable: `earnings_calendar` keeps ONE row per ticker with no
// history, so a replay sees today's next-report date rather than the one live on the brief date.
// The earnings gate is therefore not validly replayed. It is applied identically everywhere here,
// so it cannot bias a comparison BETWEEN cells — but it does mean the absolute pick count is not
// the count the operator really saw.  see CLAUDE.md "Known quirks"
//
// THE ANNOTATION UNDER TEST, stated once so it cannot drift:
//   own-at-strike  = effective cost basis (strike - premium) at or below the ticker's SMA200
//   support        = strike below the lowest LOW of the last 20 bars
//   Both point-in-time from bars on or before the brief date. Neither gates anything.
//
// Usage: node scripts/dice-entry-annotation-replay.mjs [--db <path>]
//
// see scripts/fr-wheel-entry-quality-study.mjs (T8), scripts/dice-fit-demotion-study.mjs,
//     docs/wheel-parameters.md F9/T8, docs/formulas.md#own-at-strike

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const argS = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const DB_PATH = argS('--db', join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));

// Write-capable on purpose: a readonly connection cannot attach the live WAL index on Windows and
// silently reads only to the last checkpoint.  see CLAUDE.md "Inspecting the production DB"
const db = new Database(DB_PATH);
const maxPx = db.prepare('SELECT MAX(date) d FROM historical_prices').get().d;

const MIN_LIQ = 8;
const SLUG = 'short-naked-put';
const SCALE_TOLERANCE = 0.35;

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const f = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));

const earnings = new Map();
for (const r of db.prepare('SELECT ticker, report_date FROM earnings_calendar').all()) {
  earnings.set(r.ticker, r.report_date);
}

// ── Price series ────────────────────────────────────────────────────────────
const seriesFor = new Map();
const barsStmt = db.prepare(
  'SELECT date, low, close FROM historical_prices WHERE ticker = ? ORDER BY date');
const series = t => {
  if (!seriesFor.has(t)) seriesFor.set(t, barsStmt.all(t));
  return seriesFor.get(t);
};
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
function swingLow20(rows, end, lookback = 20) {
  if (end < lookback - 1) return null;
  let min = Infinity;
  for (let i = end - lookback + 1; i <= end; i++) if (rows[i].low <= min) min = rows[i].low;
  return min === Infinity ? null : min;
}

/** The dice's trade-quality gates, mirroring roll-the-dice.ts via dice-fit-demotion-study.mjs. */
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
    out.push({ p, s, leg, strike: leg.strike });
  }
  return out.sort((a, b) => b.p.compositeScore - a.p.compositeScore);
}

/** The 2x2 cell plus the settled outcome, or null when it cannot be computed honestly. */
function annotate(c, date) {
  const rows = series(c.p.ticker);
  const iEnd = upTo(rows, date);
  if (iEnd < 0) return null;
  const s200 = sma(rows, iEnd, 200), swing = swingLow20(rows, iEnd);
  if (s200 == null || swing == null) return null;

  const spot = c.p.price ?? rows[iEnd].close;
  // Split scale guard — a stored strike on a different price scale than the settling series
  // manufactures enormous fake losses.  see CLAUDE.md
  if (!spot || spot <= 0 || Math.abs(c.strike / spot - 1) > SCALE_TOLERANCE) return { scaleBad: true };

  const prem = c.leg.mid ?? ((c.leg.bid + c.leg.ask) / 2);
  const basis = c.strike - prem;
  const own = basis <= s200;
  const sup = c.strike < swing;

  const exp = c.s.setup.expiration;
  let retPct = null, assigned = null;
  if (exp && exp <= maxPx) {
    const iExp = upTo(rows, exp);
    if (iExp >= 0) {
      const settle = rows[iExp].close;
      retPct = ((prem - Math.max(0, c.strike - settle)) / c.strike) * 100;
      assigned = settle < c.strike;
    }
  }
  return {
    ticker: c.p.ticker, date, strike: c.strike, basis, s200, swing, own, sup, retPct, assigned,
    cell: own ? (sup ? 'A both' : 'B own-at-strike only')
              : (sup ? 'C support only' : 'D NEITHER'),
    basisVsSma200Pct: (basis / s200 - 1) * 100,
  };
}

// ── Replay ──────────────────────────────────────────────────────────────────
const briefs = db.prepare(
  `SELECT generated_at, picks FROM daily_briefs WHERE strategy = 'wheel' ORDER BY generated_at`).all();

const dicePicks = [], allBriefPicks = [], eligibleAll = [];
let days = 0, pickDays = 0, scaleBad = 0, noHistory = 0;
const eligibleSizes = [];

for (const b of briefs) {
  const date = b.generated_at.slice(0, 10);
  let picks; try { picks = JSON.parse(b.picks); } catch { continue; }
  if (!Array.isArray(picks) || picks.length === 0) continue;
  days++;

  for (const p of picks) {
    const s = (p.strategyLabResult?.scores ?? []).find(x => x.slug === SLUG);
    const leg = s?.setup?.legs?.find(l => l.side === 'put' && String(l.action).toLowerCase().startsWith('sell'));
    if (!leg) continue;
    const a = annotate({ p, s, leg, strike: leg.strike }, date);
    if (!a) { noHistory++; continue; }
    if (a.scaleBad) { scaleBad++; continue; }
    allBriefPicks.push(a);
  }

  const cands = qualityEligible(picks, date);
  eligibleSizes.push(cands.length);
  for (const c of cands) {
    const a = annotate(c, date);
    if (a && !a.scaleBad) eligibleAll.push(a);
  }
  const winner = cands[0];
  if (!winner) continue;
  pickDays++;
  const a = annotate(winner, date);
  if (a && !a.scaleBad) dicePicks.push({ ...a, composite: winner.p.compositeScore });
}

console.log(`\nT8 follow-up — the own-at-strike x support annotation, on the DICE's own picks`);
console.log(`${days} stored wheel briefs · ${pickDays} produced a pick · ${dicePicks.length} annotatable`);
console.log(`  (${scaleBad} excluded by the split scale guard, ${noHistory} with <200 sessions of history)`);
const sizeHist = {};
for (const n of eligibleSizes) sizeHist[n] = (sizeHist[n] ?? 0) + 1;
console.log(`  eligible-set sizes: ${Object.entries(sizeHist).sort((a, b) => a[0] - b[0])
  .map(([k, v]) => `${k}→${v}d`).join(' ')}   (v1.1.174: the gates do most of the selecting)`);

// ── 1. Does it ever fire? ───────────────────────────────────────────────────
const CELLS = ['A both', 'B own-at-strike only', 'C support only', 'D NEITHER'];
const tally = rows => {
  const m = Object.fromEntries(CELLS.map(c => [c, []]));
  for (const r of rows) m[r.cell].push(r);
  return m;
};
const hdr = () => console.log(`  ${'cell'.padEnd(24)} ${'n'.padStart(5)} ${'share'.padStart(7)} `
  + `${'settled'.padStart(8)} ${'mean'.padStart(8)} ${'median'.padStart(8)} ${'assigned'.padStart(9)}`);
const line = (label, rows, total) => {
  const st = rows.filter(r => r.retPct != null);
  console.log(`  ${label.padEnd(24)} ${String(rows.length).padStart(5)} `
    + `${((total ? (100 * rows.length / total).toFixed(0) : '—') + '%').padStart(7)} `
    + `${String(st.length).padStart(8)} `
    + `${(f(mean(st.map(r => r.retPct))) + '%').padStart(8)} `
    + `${(f(med(st.map(r => r.retPct))) + '%').padStart(8)} `
    + `${(st.length ? f(100 * mean(st.map(r => (r.assigned ? 1 : 0))), 0) + '%' : '—').padStart(9)}`);
};

console.log(`\n═══ 1. ON THE DICE'S ACTUAL PICKS ═══`);
console.log(`  "D NEITHER" is the cell the annotation would warn about. On the universe it was`);
console.log(`  562 of 1,585 episodes at -3.06% mean / 48.4% assigned.\n`);
hdr();
{
  const t = tally(dicePicks);
  for (const c of CELLS) line(c, t[c], dicePicks.length);
  line('ALL DICE PICKS', dicePicks, null);
}

console.log(`\n═══ 2. ON EVERY ELIGIBLE CANDIDATE (what the dice chose FROM) ═══`);
hdr();
{
  const t = tally(eligibleAll);
  for (const c of CELLS) line(c, t[c], eligibleAll.length);
  line('ALL ELIGIBLE', eligibleAll, null);
}

console.log(`\n═══ 3. ON EVERY BRIEF PICK (pre-dice-gate, the top-5 per day) ═══`);
console.log(`  If the cells separate here but not in 1-2, the dice's gates are already removing`);
console.log(`  the rows the annotation would flag, and it has nothing left to add.\n`);
hdr();
{
  const t = tally(allBriefPicks);
  for (const c of CELLS) line(c, t[c], allBriefPicks.length);
  line('ALL BRIEF PICKS', allBriefPicks, null);
}

// ── 4. What it would have said, most recent first ──────────────────────────
console.log(`\n═══ 4. WHAT THE OPERATOR WOULD HAVE SEEN, most recent dice picks ═══`);
console.log(`  date        ticker  strike    basis   SMA200  20d low   cell                    outcome`);
for (const r of dicePicks.slice(-12).reverse()) {
  const out = r.retPct == null ? 'open'
    : `${f(r.retPct)}%${r.assigned ? ' ASSIGNED' : ''}`;
  console.log(`  ${r.date}  ${r.ticker.padEnd(6)} ${String(r.strike).padStart(6)} `
    + `${f(r.basis).padStart(8)} ${f(r.s200).padStart(8)} ${f(r.swing).padStart(8)}   `
    + `${r.cell.padEnd(22)}  ${out}`);
}

console.log(`\nReading this`);
console.log(`• An annotation changes nothing about which trades are taken, so this is not an`);
console.log(`  FR-SEY-5 gate test — it asks whether the sentence would be TRUE and USEFUL.`);
console.log(`• The number that decides it is the "D NEITHER" share in panel 1. A warning that`);
console.log(`  never fires cannot be told apart from one nothing violates — that is exactly how`);
console.log(`  the conviction band survived unexamined on 0 of 39 picks.`);
console.log(`• Settled counts are small by construction: only picks whose expiry has passed can`);
console.log(`  be scored, which truncates the most recent weeks. Treat per-cell returns here as`);
console.log(`  descriptive; the universe study is where the effect size lives.`);
console.log(`• Earnings gate is not validly replayed (one row per ticker, no history), so the`);
console.log(`  pick count is not exactly what the operator saw. It cannot bias cell-vs-cell.\n`);
db.close();
