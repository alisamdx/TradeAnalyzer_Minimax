import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

// ── Date range ────────────────────────────────────────────────────────────────
const range = db.prepare(`SELECT MIN(as_of_date) as from_d, MAX(as_of_date) as to_d, COUNT(DISTINCT as_of_date) as days FROM replay_briefs`).get();
console.log('REPLAY RANGE:', JSON.stringify(range));
const totalBriefs = db.prepare(`SELECT COUNT(*) as n FROM replay_briefs`).get();
const totalOutcomes = db.prepare(`SELECT COUNT(*) as n FROM replay_outcomes`).get();
console.log(`Total briefs: ${totalBriefs.n}  Total outcome rows: ${totalOutcomes.n}`);

// ── Per-strategy summary ──────────────────────────────────────────────────────
const strategies = ['bullish','bearish','buy','income','wheel'];
for (const s of strategies) {
  const r = db.prepare(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN ro.ret_5d  IS NOT NULL THEN 1 END) as n5,
      COUNT(CASE WHEN ro.ret_10d IS NOT NULL THEN 1 END) as n10,
      COUNT(CASE WHEN ro.ret_21d IS NOT NULL THEN 1 END) as n21,
      AVG(ro.ret_5d)  as avg5,  AVG(ro.ret_10d) as avg10, AVG(ro.ret_21d) as avg21,
      SUM(CASE WHEN ro.ret_5d  IS NOT NULL AND ((rb.strategy='bearish' AND ro.ret_5d <0 ) OR (rb.strategy!='bearish' AND ro.ret_5d >0 )) THEN 1 ELSE 0 END) as win5,
      SUM(CASE WHEN ro.ret_10d IS NOT NULL AND ((rb.strategy='bearish' AND ro.ret_10d<0 ) OR (rb.strategy!='bearish' AND ro.ret_10d>0 )) THEN 1 ELSE 0 END) as win10,
      SUM(CASE WHEN ro.ret_21d IS NOT NULL AND ((rb.strategy='bearish' AND ro.ret_21d<0 ) OR (rb.strategy!='bearish' AND ro.ret_21d>0 )) THEN 1 ELSE 0 END) as win21,
      AVG(ro.max_drawdown_21d) as avg_dd,
      MIN(ro.ret_21d) as worst21, MAX(ro.ret_21d) as best21
    FROM replay_outcomes ro
    JOIN replay_briefs rb ON rb.id = ro.replay_brief_id
    WHERE rb.strategy = ?
  `).get(s);
  const hr5  = r.n5  ? (r.win5 /r.n5 *100).toFixed(1) : '--';
  const hr10 = r.n10 ? (r.win10/r.n10*100).toFixed(1) : '--';
  const hr21 = r.n21 ? (r.win21/r.n21*100).toFixed(1) : '--';
  console.log(`\n── ${s.toUpperCase()} ──`);
  console.log(`  Picks: ${r.total} | n5: ${r.n5}  n10: ${r.n10}  n21: ${r.n21}`);
  console.log(`  HR:   5d=${hr5}%   10d=${hr10}%   21d=${hr21}%`);
  console.log(`  Avg:  5d=${r.avg5?.toFixed(2)??'--'}%  10d=${r.avg10?.toFixed(2)??'--'}%  21d=${r.avg21?.toFixed(2)??'--'}%`);
  console.log(`  Best21=${r.best21?.toFixed(1)??'--'}%  Worst21=${r.worst21?.toFixed(1)??'--'}%  AvgDD=${r.avg_dd?.toFixed(2)??'--'}%`);
}

// ── Monthly breakdown ─────────────────────────────────────────────────────────
console.log('\n\n── MONTHLY AVG 21d RETURN & HIT RATE BY STRATEGY ──');
const monthly = db.prepare(`
  SELECT rb.strategy, substr(rb.as_of_date,1,7) as month,
    COUNT(*) as n,
    AVG(ro.ret_21d) as avg21,
    SUM(CASE WHEN (rb.strategy='bearish' AND ro.ret_21d<0) OR (rb.strategy!='bearish' AND ro.ret_21d>0) THEN 1 ELSE 0 END)*100.0/
      NULLIF(COUNT(CASE WHEN ro.ret_21d IS NOT NULL THEN 1 END),0) as hr21
  FROM replay_outcomes ro
  JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
  WHERE ro.ret_21d IS NOT NULL
  GROUP BY rb.strategy, month
  ORDER BY rb.strategy, month
`).all();
let curStrat = '';
monthly.forEach(r => {
  if (r.strategy !== curStrat) { console.log(`\n  ${r.strategy.toUpperCase()}`); curStrat = r.strategy; }
  const avg = r.avg21 != null ? r.avg21.toFixed(1).padStart(6) : '  --  ';
  const hr  = r.hr21  != null ? r.hr21.toFixed(0).padStart(3)  : ' --';
  console.log(`    ${r.month}  n=${String(r.n).padStart(4)}  avg21=${avg}%  HR21=${hr}%`);
});

// ── Rank correlation ──────────────────────────────────────────────────────────
console.log('\n\n── RANK PERFORMANCE (all strategies, 21d) ──');
for (const s of strategies) {
  const rows = db.prepare(`
    SELECT ro.rank,
      COUNT(*) as n,
      AVG(ro.ret_21d) as avg21,
      SUM(CASE WHEN (rb.strategy='bearish' AND ro.ret_21d<0) OR (rb.strategy!='bearish' AND ro.ret_21d>0) THEN 1 ELSE 0 END)*100.0/NULLIF(COUNT(CASE WHEN ro.ret_21d IS NOT NULL THEN 1 END),0) as hr21
    FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
    WHERE rb.strategy=? AND ro.ret_21d IS NOT NULL
    GROUP BY ro.rank ORDER BY ro.rank LIMIT 10
  `).all(s);
  process.stdout.write(`  ${s.toUpperCase().padEnd(8)}: `);
  rows.forEach(r => process.stdout.write(`R${r.rank}=${r.avg21?.toFixed(1)??'--'}%(${Math.round(r.hr21??0)}%)  `));
  console.log();
}

// ── Top 15 tickers (bullish+buy, min 5 appearances) ──────────────────────────
console.log('\n\n── TOP 15 TICKERS (bullish+buy combined, min 5 appearances, best avg21) ──');
const top = db.prepare(`
  SELECT ro.ticker,
    COUNT(*) as n,
    AVG(ro.ret_21d) as avg21,
    SUM(CASE WHEN ro.ret_21d>0 THEN 1 ELSE 0 END)*100.0/COUNT(CASE WHEN ro.ret_21d IS NOT NULL THEN 1 END) as hr21,
    MIN(ro.ret_21d) as worst21, MAX(ro.ret_21d) as best21
  FROM replay_outcomes ro
  JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
  WHERE rb.strategy IN ('bullish','buy') AND ro.ret_21d IS NOT NULL
  GROUP BY ro.ticker HAVING COUNT(*)>=5
  ORDER BY avg21 DESC LIMIT 15
`).all();
top.forEach(r => console.log(`  ${r.ticker.padEnd(6)} n=${String(r.n).padStart(3)}  avg21=${r.avg21.toFixed(1).padStart(6)}%  HR=${String(Math.round(r.hr21)).padStart(3)}%  range=[${r.worst21.toFixed(1)}, ${r.best21.toFixed(1)}]`));

// ── Bottom 15 tickers ─────────────────────────────────────────────────────────
console.log('\n── BOTTOM 15 TICKERS (bullish+buy combined, min 5 appearances, worst avg21) ──');
const bot = db.prepare(`
  SELECT ro.ticker,
    COUNT(*) as n,
    AVG(ro.ret_21d) as avg21,
    SUM(CASE WHEN ro.ret_21d>0 THEN 1 ELSE 0 END)*100.0/COUNT(CASE WHEN ro.ret_21d IS NOT NULL THEN 1 END) as hr21,
    MIN(ro.ret_21d) as worst21, MAX(ro.ret_21d) as best21
  FROM replay_outcomes ro
  JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
  WHERE rb.strategy IN ('bullish','buy') AND ro.ret_21d IS NOT NULL
  GROUP BY ro.ticker HAVING COUNT(*)>=5
  ORDER BY avg21 ASC LIMIT 15
`).all();
bot.forEach(r => console.log(`  ${r.ticker.padEnd(6)} n=${String(r.n).padStart(3)}  avg21=${r.avg21.toFixed(1).padStart(6)}%  HR=${String(Math.round(r.hr21)).padStart(3)}%  range=[${r.worst21.toFixed(1)}, ${r.best21.toFixed(1)}]`));

// ── Income / Wheel: stayed_above_strike rate ──────────────────────────────────
console.log('\n\n── INCOME/WHEEL: Stayed-Above-Strike Rate by Month ──');
for (const s of ['income','wheel']) {
  const rows = db.prepare(`
    SELECT substr(rb.as_of_date,1,7) as month,
      COUNT(*) as total,
      SUM(CASE WHEN stayed_above_strike=1 THEN 1 ELSE 0 END) as stayed,
      COUNT(CASE WHEN stayed_above_strike IS NOT NULL THEN 1 END) as n
    FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
    WHERE rb.strategy=?
    GROUP BY month ORDER BY month
  `).all(s);
  console.log(`\n  ${s.toUpperCase()}`);
  rows.forEach(r => {
    const rate = r.n ? (r.stayed/r.n*100).toFixed(0) : '--';
    console.log(`    ${r.month}  stayed_above=${rate}%  (n=${r.n})`);
  });
}

// ── Best bearish tickers ──────────────────────────────────────────────────────
console.log('\n\n── BEARISH: Top 15 tickers (min 3, best avg21 = most down) ──');
const bearTop = db.prepare(`
  SELECT ro.ticker,
    COUNT(*) as n,
    AVG(ro.ret_21d) as avg21,
    SUM(CASE WHEN ro.ret_21d<0 THEN 1 ELSE 0 END)*100.0/COUNT(CASE WHEN ro.ret_21d IS NOT NULL THEN 1 END) as hr21
  FROM replay_outcomes ro
  JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
  WHERE rb.strategy='bearish' AND ro.ret_21d IS NOT NULL
  GROUP BY ro.ticker HAVING COUNT(*)>=3
  ORDER BY avg21 ASC LIMIT 15
`).all();
bearTop.forEach(r => console.log(`  ${r.ticker.padEnd(6)} n=${String(r.n).padStart(3)}  avg21=${r.avg21.toFixed(1).padStart(6)}%  HR=${String(Math.round(r.hr21)).padStart(3)}%`));

db.close();
console.log('\nDone.');
