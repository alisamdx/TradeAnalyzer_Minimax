import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const spy = db.prepare(`SELECT date, close FROM historical_prices WHERE ticker='SPY' ORDER BY date`).all();
function spyFwd(d,h=21){let i=spy.findIndex(r=>r.date>=d);if(i<0)return null;const j=i+h;if(j>=spy.length)return null;return (spy[j].close-spy[i].close)/spy[i].close*100;}
function spySma(d){ // 50d SMA vs close at as_of -> regime
  let i=spy.findIndex(r=>r.date>=d); if(i<50) return null;
  const sma=spy.slice(i-50,i).reduce((p,c)=>p+c.close,0)/50;
  return spy[i].close < sma ? 'down' : 'up';
}

const rows = db.prepare(`
  SELECT rb.as_of_date d, ro.rank, ro.composite_score sc, ro.ret_21d r
  FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
  WHERE rb.strategy='bearish' AND ro.ret_21d IS NOT NULL
`).all().map(x=>{const s=spyFwd(x.d);return s==null?null:{...x,spy:s,alpha:x.r-s,regime:spySma(x.d)};}).filter(Boolean);

const mean=a=>a.length?a.reduce((p,c)=>p+c,0)/a.length:NaN;
const shortPnl=a=>mean(a.map(x=>-x.r));
const win=a=>a.length?a.filter(x=>x.r<0).length/a.length*100:NaN;

console.log('Composite score range:',Math.min(...rows.map(x=>x.sc)).toFixed(1),'->',Math.max(...rows.map(x=>x.sc)).toFixed(1));

console.log('\n── BY SCORE BUCKET (all regimes) ──');
console.log('bucket        n    shortP&L   alpha    win%');
const buckets=[[0,40],[40,50],[50,60],[60,70],[70,80],[80,200]];
for(const [lo,hi] of buckets){
  const g=rows.filter(x=>x.sc>=lo&&x.sc<hi);
  if(!g.length)continue;
  console.log(`${(lo+'-'+hi).padEnd(10)} ${String(g.length).padStart(4)}  ${shortPnl(g).toFixed(2).padStart(7)}%  ${mean(g.map(x=>x.alpha)).toFixed(2).padStart(6)}%  ${win(g).toFixed(1).padStart(5)}%`);
}

console.log('\n── BY SCORE BUCKET, SPY-DOWN REGIME ONLY (gate #1 applied) ──');
console.log('bucket        n    shortP&L   alpha    win%');
for(const [lo,hi] of buckets){
  const g=rows.filter(x=>x.sc>=lo&&x.sc<hi&&x.regime==='down');
  if(!g.length)continue;
  console.log(`${(lo+'-'+hi).padEnd(10)} ${String(g.length).padStart(4)}  ${shortPnl(g).toFixed(2).padStart(7)}%  ${mean(g.map(x=>x.alpha)).toFixed(2).padStart(6)}%  ${win(g).toFixed(1).padStart(5)}%`);
}

// What rank do high-score picks tend to be? (does score>=X mostly = rank1, or does it admit rank2+?)
console.log('\n── RANK MIX among score>=60 picks ──');
const hi60=rows.filter(x=>x.sc>=60);
for(let rk=1;rk<=5;rk++){const c=hi60.filter(x=>x.rank===rk).length;if(c)console.log(`  R${rk}: ${c} (${(c/hi60.length*100).toFixed(0)}%)`);}
console.log(`  total score>=60: ${hi60.length} picks across ${new Set(hi60.map(x=>x.d)).size} dates`);

// Combined gate: score>=60 AND SPY down
const combo=rows.filter(x=>x.sc>=60&&x.regime==='down');
const all=rows;
console.log('\n── COMBINED GATE vs BASELINE ──');
console.log(`  baseline (all bearish):        n=${all.length}  shortP&L=${shortPnl(all).toFixed(2)}%  win=${win(all).toFixed(1)}%`);
console.log(`  score>=60 + SPY-down:          n=${combo.length}  shortP&L=${shortPnl(combo).toFixed(2)}%  win=${win(combo).toFixed(1)}%`);

db.close();
