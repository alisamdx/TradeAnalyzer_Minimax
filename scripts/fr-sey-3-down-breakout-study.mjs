// Investigate the weak down-breakout (bear call) side of inflection.
//
// Stock-direction HR understates credit-spread P&L (a bear call still wins if the stock
// stays below the short strike). With no stored strikes for inflection, approximate the
// OTM-expiry outcome with a buffer B on the 21d close move:
//   bull put  (dir=+1): wins if ret_21d >= -B   (stock stayed above the short put buffer)
//   bear call (dir=-1): wins if ret_21d <= +B   (stock stayed below the short call buffer)
// Compare up vs down sides, and slice the down side by conviction (composite quintile)
// and by 50/200 regime, to decide: gate harder or drop down-breakout inflection.

import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const picks = db.prepare(`
  SELECT ro.ticker t, rb.as_of_date asOf, ro.direction dir, ro.composite_score cs,
         ro.ret_21d r21
  FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id = ro.replay_brief_id
  WHERE rb.strategy='inflection' AND ro.direction IS NOT NULL AND ro.ret_21d IS NOT NULL
`).all();

const closesStmt = db.prepare(`SELECT close FROM historical_prices WHERE ticker=? AND date<=? AND close IS NOT NULL ORDER BY date DESC LIMIT ?`);
function regimeUp(t, asOf) {
  const c = closesStmt.all(t, asOf, 200);
  if (c.length < 200) return null;
  const s50 = c.slice(0, 50).reduce((s, r) => s + r.close, 0) / 50;
  const s200 = c.reduce((s, r) => s + r.close, 0) / 200;
  return s50 > s200;
}
const otmWin = (p, B) => p.dir > 0 ? p.r21 >= -B : p.r21 <= B;
const pct = (k, n) => n ? (k / n * 100).toFixed(1) : '--';

function line(label, rows, B) {
  const wins = rows.filter(p => otmWin(p, B)).length;
  console.log(`${label.padEnd(28)} n=${String(rows.length).padStart(4)}  OTM-win(±${B}%)=${pct(wins, rows.length).padStart(5)}%`);
}

const up = picks.filter(p => p.dir > 0);
const down = picks.filter(p => p.dir < 0);

for (const B of [5, 7.5, 10]) {
  console.log(`\n===== OTM-expiry proxy, buffer ±${B}% =====`);
  line('ALL inflection', picks, B);
  line('  up-breakout (bull put)', up, B);
  line('  down-breakout (bear call)', down, B);
}

// Conviction slice on the down side (B=7.5%)
const B = 7.5;
console.log(`\n===== down-breakout by composite-score quintile (buffer ±${B}%) =====`);
const sorted = [...down].sort((a, b) => a.cs - b.cs);
const q = Math.ceil(sorted.length / 5);
for (let i = 0; i < 5; i++) {
  const seg = sorted.slice(i * q, (i + 1) * q);
  if (!seg.length) continue;
  const lo = seg[0].cs.toFixed(0), hi = seg[seg.length - 1].cs.toFixed(0);
  line(`  Q${i + 1} score ${lo}-${hi}`, seg, B);
}

console.log(`\n===== down-breakout by 50/200 regime (buffer ±${B}%) =====`);
const dr = down.map(p => ({ ...p, reg: regimeUp(p.t, p.asOf) })).filter(p => p.reg !== null);
line('  regime DOWN (50<200, agrees)', dr.filter(p => !p.reg), B);
line('  regime UP (50>200, counter)', dr.filter(p => p.reg), B);

console.log(`\n===== composite gate sensitivity on the down side (buffer ±${B}%) =====`);
for (const g of [0, 70, 75, 80, 85]) {
  line(`  down picks with score ≥ ${g}`, down.filter(p => p.cs >= g), B);
}
db.close();
