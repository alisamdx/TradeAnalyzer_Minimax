import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

// Build SPY forward 21-trading-day return per calendar date present in historical_prices.
const spy = db.prepare(`SELECT date, close FROM historical_prices WHERE ticker='SPY' ORDER BY date`).all();
const spyIdx = new Map(spy.map((r,i)=>[r.date,i]));
function spyFwd(dateStr, horizon=21){
  // find first SPY trading day on/after dateStr
  let i = spyIdx.get(dateStr);
  if (i==null){ i = spy.findIndex(r=>r.date>=dateStr); if(i<0) return null; }
  const j = i+horizon;
  if (j>=spy.length) return null;
  return (spy[j].close - spy[i].close)/spy[i].close*100;
}

const rows = db.prepare(`
  SELECT rb.as_of_date AS d, ro.rank, ro.ret_21d AS r
  FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
  WHERE rb.strategy='bearish' AND ro.ret_21d IS NOT NULL
`).all();

// Attach SPY forward return + regime
let withSpy = rows.map(x=>{
  const s = spyFwd(x.d);
  return s==null?null:{...x, spy:s, alpha:x.r - s};
}).filter(Boolean);

const n = withSpy.length;
const mean = a=>a.reduce((p,c)=>p+c,0)/a.length;
console.log(`Bearish picks with SPY-matched forward window: ${n}\n`);

// 1. Skill check: does the signal pick UNDERPERFORMERS? (alpha<0 = good for a short)
const avgPick = mean(withSpy.map(x=>x.r));
const avgSpy  = mean(withSpy.map(x=>x.spy));
const avgAlpha= mean(withSpy.map(x=>x.alpha));
const underperf = withSpy.filter(x=>x.alpha<0).length;
console.log('── SKILL: pick vs SPY (same 21d window) ──');
console.log(`  avg pick ret = ${avgPick.toFixed(2)}%   avg SPY ret = ${avgSpy.toFixed(2)}%   avg ALPHA = ${avgAlpha.toFixed(2)}%`);
console.log(`  picks that UNDERPERFORMED SPY (good for short) = ${(underperf/n*100).toFixed(1)}%`);
console.log(`  => short-vs-SPY (market-neutral) avg P&L = ${(-avgAlpha).toFixed(2)}% per pick\n`);

// 2. Regime split: was SPY rising or falling over the forward window?
const up   = withSpy.filter(x=>x.spy>0);
const down = withSpy.filter(x=>x.spy<=0);
const shortPnl = a=>mean(a.map(x=>-x.r));               // naked short P&L
const shortWin = a=>a.filter(x=>x.r<0).length/a.length*100;
console.log('── REGIME: naked-short P&L when market was... ──');
console.log(`  SPY UP   (n=${up.length},  ${(up.length/n*100).toFixed(0)}% of days): short P&L = ${shortPnl(up).toFixed(2)}%   win=${shortWin(up).toFixed(1)}%`);
console.log(`  SPY DOWN (n=${down.length}, ${(down.length/n*100).toFixed(0)}% of days): short P&L = ${shortPnl(down).toFixed(2)}%   win=${shortWin(down).toFixed(1)}%\n`);

// 3. Rank: do top-ranked bearish picks fall more / have better alpha?
console.log('── RANK: does the score rank the worst stocks first? ──');
for (let rk=1; rk<=5; rk++){
  const g = withSpy.filter(x=>x.rank===rk);
  if(!g.length) continue;
  console.log(`  R${rk}: n=${String(g.length).padStart(4)}  short P&L=${shortPnl(g).toFixed(2)}%  alpha=${mean(g.map(x=>x.alpha)).toFixed(2)}%  win=${shortWin(g).toFixed(1)}%`);
}

// 4. Tail risk: how often did a short blow up (stock ripped >+20%)?
const ripped = withSpy.filter(x=>x.r>20).length;
const ripped40 = withSpy.filter(x=>x.r>40).length;
console.log(`\n── TAIL: shorts that got squeezed ── >+20%: ${(ripped/n*100).toFixed(1)}%   >+40%: ${(ripped40/n*100).toFixed(1)}%`);
console.log(`  (a single +93% loser drags the whole book; symmetric stock short is unbounded loss)`);

db.close();
