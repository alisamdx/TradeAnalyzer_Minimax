// FR-SEY-3 validation: does a per-name trend-alignment filter improve inflection?
//
// For each inflection replay pick, reconstruct the underlying's point-in-time trend at the
// pick's as_of_date (close vs its own 50-day SMA from historical_prices), then compare
// direction-aware outcomes for picks where the trend AGREES with the breakout direction vs
// where it DISAGREES. Bull-put (dir=+1) wants an uptrend; bear-call (dir=-1) wants a downtrend.
//
// Yardstick: HR21 (did the stock move the thesis way over 21d) + direction-adjusted avg
// return (dir * ret). Credit spreads cap upside, so HR is the honest metric.

import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const picks = db.prepare(`
  SELECT ro.ticker AS ticker, rb.as_of_date AS asOf, ro.direction AS dir,
         ro.ret_5d AS r5, ro.ret_21d AS r21
  FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id = ro.replay_brief_id
  WHERE rb.strategy = 'inflection' AND ro.direction IS NOT NULL
`).all();

// Last `n` closes on/before a date for a ticker (most recent first).
const closesStmt = db.prepare(`
  SELECT close FROM historical_prices
  WHERE ticker = ? AND date <= ? AND close IS NOT NULL
  ORDER BY date DESC LIMIT ?
`);

function trendUp(ticker, asOf, win) {
  const rows = closesStmt.all(ticker, asOf, win);
  if (rows.length < win) return null; // insufficient history
  const closeNow = rows[0].close;
  const sma = rows.reduce((s, r) => s + r.close, 0) / rows.length;
  return closeNow > sma;
}

function stats(rows) {
  const n21 = rows.filter(r => r.r21 != null).length;
  const win21 = rows.filter(r => r.r21 != null && ((r.dir > 0 && r.r21 > 0) || (r.dir < 0 && r.r21 < 0))).length;
  const adj21 = avg(rows.filter(r => r.r21 != null).map(r => r.dir * r.r21));
  const adj5 = avg(rows.filter(r => r.r5 != null).map(r => r.dir * r.r5));
  return { n: rows.length, n21, hr21: n21 ? (win21 / n21 * 100) : null, adj21, adj5 };
}
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const f = (v, d = 1) => v == null ? '  --' : v.toFixed(d);

function report(label, rows) {
  const s = stats(rows);
  console.log(
    `${label.padEnd(22)} n=${String(s.n).padStart(4)}  n21=${String(s.n21).padStart(4)}  ` +
    `HR21=${f(s.hr21).padStart(5)}%  dirAdjAvg21=${f(s.adj21, 2).padStart(6)}%  dirAdjAvg5=${f(s.adj5, 2).padStart(6)}%`
  );
}

for (const win of [50, 20]) {
  console.log(`\n================  trend = close vs ${win}-day SMA  ================`);
  const tagged = picks.map(p => ({ ...p, up: trendUp(p.ticker, p.asOf, win) }));
  const usable = tagged.filter(p => p.up !== null);
  const agree = usable.filter(p => (p.dir > 0 && p.up) || (p.dir < 0 && !p.up));
  const disagree = usable.filter(p => (p.dir > 0 && !p.up) || (p.dir < 0 && p.up));

  console.log(`(${usable.length}/${picks.length} picks have ≥${win}d history)`);
  report('ALL inflection', usable);
  report('  trend AGREES', agree);
  report('  trend DISAGREES', disagree);

  for (const d of [1, -1]) {
    const dl = d > 0 ? 'up-breakout (bull put)' : 'down-breakout (bear call)';
    console.log(`  -- ${dl} --`);
    report('    all', usable.filter(p => p.dir === d));
    report('    agrees', agree.filter(p => p.dir === d));
    report('    disagrees', disagree.filter(p => p.dir === d));
  }
}

// ── Stronger filter: the 50/200 SMA stack (broader regime), per name ──
function sma(ticker, asOf, win) {
  const rows = closesStmt.all(ticker, asOf, win);
  if (rows.length < win) return null;
  return rows.reduce((s, r) => s + r.close, 0) / rows.length;
}
console.log(`\n================  trend = 50/200 SMA stack (broader regime)  ================`);
const stacked = picks.map(p => {
  const s50 = sma(p.ticker, p.asOf, 50), s200 = sma(p.ticker, p.asOf, 200);
  return { ...p, regimeUp: s50 != null && s200 != null ? s50 > s200 : null };
});
const usable = stacked.filter(p => p.regimeUp !== null);
const agree = usable.filter(p => (p.dir > 0 && p.regimeUp) || (p.dir < 0 && !p.regimeUp));
const disagree = usable.filter(p => (p.dir > 0 && !p.regimeUp) || (p.dir < 0 && p.regimeUp));
console.log(`(${usable.length}/${picks.length} picks have ≥200d history)`);
report('ALL (≥200d hist)', usable);
report('  regime AGREES', agree);
report('  regime DISAGREES', disagree);
for (const d of [1, -1]) {
  const dl = d > 0 ? 'up-breakout (bull put)' : 'down-breakout (bear call)';
  console.log(`  -- ${dl} --`);
  report('    all', usable.filter(p => p.dir === d));
  report('    agrees', agree.filter(p => p.dir === d));
  report('    disagrees', disagree.filter(p => p.dir === d));
}
db.close();
