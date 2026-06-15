import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const range = db.prepare(`SELECT MIN(as_of_date) f, MAX(as_of_date) t, COUNT(DISTINCT as_of_date) d FROM replay_briefs`).get();
console.log(`RANGE ${range.f} -> ${range.t}  (${range.d} brief dates)\n`);

// Return-on-capital per strategy.
// Directional (buy/bullish): ROC per pick over 21d = ret_21d (capital = stock notional).
// bearish: profit when stock falls => ROC = -ret_21d.
// income/wheel: capital = strike collateral; P&L = premium (NOT stored). Proxy below.
const strategies = ['buy', 'bullish', 'bearish', 'income', 'wheel'];

console.log('STRATEGY   picks  win%(21d)   avg ROC/pick(21d)   med    best    worst   sum-of-ROC   ann.(x12)');
for (const s of strategies) {
  const dirSign = s === 'bearish' ? -1 : 1;
  const rows = db.prepare(`
    SELECT ro.ret_21d AS r, ro.stayed_above_strike AS sas
    FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
    WHERE rb.strategy=? AND ro.ret_21d IS NOT NULL
  `).all(s);
  if (!rows.length) { console.log(`${s.padEnd(10)} no 21d data`); continue; }
  const rocs = rows.map(x => dirSign * x.r).sort((a,b)=>a-b);
  const n = rocs.length;
  const wins = rocs.filter(x => x > 0).length;
  const sum = rocs.reduce((a,b)=>a+b,0);
  const avg = sum / n;
  const med = rocs[Math.floor(n/2)];
  console.log(
    `${s.padEnd(10)} ${String(n).padStart(4)}  ${(wins/n*100).toFixed(1).padStart(7)}%  ` +
    `${avg.toFixed(2).padStart(14)}%   ${med.toFixed(1).padStart(5)}  ${rocs[n-1].toFixed(1).padStart(6)}  ${rocs[0].toFixed(1).padStart(6)}  ` +
    `${sum.toFixed(0).padStart(9)}%   ${(avg*12).toFixed(1).padStart(7)}%`
  );
}

// Income/Wheel: stayed-above-strike (premium-keep proxy)
console.log('\nINCOME/WHEEL premium-keep proxy (no premium stored, only assignment outcome):');
for (const s of ['income','wheel']) {
  const r = db.prepare(`
    SELECT COUNT(*) n, SUM(CASE WHEN stayed_above_strike=1 THEN 1 ELSE 0 END) kept,
           COUNT(stayed_above_strike) nn,
           AVG(CASE WHEN stayed_above_strike=0 THEN ro.ret_21d END) avg_assigned_move
    FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
    WHERE rb.strategy=?
  `).get(s);
  const keepRate = r.nn ? (r.kept/r.nn*100).toFixed(1) : '--';
  console.log(`  ${s.padEnd(7)} kept-premium(stayed-above-strike)=${keepRate}%  (n=${r.nn})  avg move when breached=${r.avg_assigned_move?.toFixed(1)??'--'}%`);
}

db.close();
