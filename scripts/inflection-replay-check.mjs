// Compare strategies in the re-run Brief Replay: hit rate (direction-aware) vs avg return.
// Inflection is a credit-spread strategy, so avg STOCK return understates it — the hit
// rate (did the stock move the thesis way / not reverse) is the honest yardstick here.
import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const dir = `COALESCE(ro.direction, CASE WHEN rb.strategy='bearish' THEN -1 ELSE 1 END)`;
const rows = db.prepare(`
  SELECT rb.strategy AS s,
    COUNT(CASE WHEN ro.ret_21d IS NOT NULL THEN 1 END) AS n21,
    SUM(CASE WHEN (${dir}>0 AND ro.ret_21d>0) OR (${dir}<0 AND ro.ret_21d<0) THEN 1 ELSE 0 END) AS win21,
    AVG(CASE WHEN ro.ret_21d IS NOT NULL THEN ${dir}*ro.ret_21d END) AS adjAvg21,
    AVG(CASE WHEN ro.ret_5d  IS NOT NULL THEN ${dir}*ro.ret_5d  END) AS adjAvg5,
    SUM(CASE WHEN (${dir}>0 AND ro.ret_5d>0) OR (${dir}<0 AND ro.ret_5d<0) THEN 1 ELSE 0 END) AS win5,
    COUNT(CASE WHEN ro.ret_5d IS NOT NULL THEN 1 END) AS n5
  FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
  GROUP BY rb.strategy
`).all();

console.log('strategy     n21   HR21    HR5   dirAdjAvg21   dirAdjAvg5');
for (const r of rows.sort((a,b)=>b.n21-a.n21)) {
  const hr21 = r.n21 ? (r.win21/r.n21*100).toFixed(1) : '--';
  const hr5  = r.n5  ? (r.win5/r.n5*100).toFixed(1) : '--';
  console.log(`${r.s.padEnd(11)} ${String(r.n21).padStart(4)}  ${hr21.padStart(5)}%  ${hr5.padStart(5)}%   ${(r.adjAvg21??0).toFixed(2).padStart(7)}%   ${(r.adjAvg5??0).toFixed(2).padStart(7)}%`);
}

// Inflection split by direction
console.log('\nInflection by direction:');
const split = db.prepare(`
  SELECT ro.direction AS d, COUNT(*) n,
    AVG(ro.ret_21d) avg21,
    SUM(CASE WHEN (ro.direction>0 AND ro.ret_21d>0) OR (ro.direction<0 AND ro.ret_21d<0) THEN 1 ELSE 0 END) win21,
    COUNT(CASE WHEN ro.ret_21d IS NOT NULL THEN 1 END) n21
  FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
  WHERE rb.strategy='inflection' GROUP BY ro.direction
`).all();
for (const r of split) {
  console.log(`  dir=${r.d}: n=${r.n}  HR21=${r.n21?(r.win21/r.n21*100).toFixed(1):'--'}%  rawAvg21=${(r.avg21??0).toFixed(2)}%`);
}
db.close();
