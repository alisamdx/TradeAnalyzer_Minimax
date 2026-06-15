import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');
const spy = db.prepare(`SELECT date, close FROM historical_prices WHERE ticker='SPY' ORDER BY date`).all();
function spyFwd(d,h=21){let i=spy.findIndex(r=>r.date>=d);if(i<0)return null;const j=i+h;if(j>=spy.length)return null;return (spy[j].close-spy[i].close)/spy[i].close*100;}
function spyReg(d){let i=spy.findIndex(r=>r.date>=d);if(i<50)return null;const sma=spy.slice(i-50,i).reduce((p,c)=>p+c.close,0)/50;return spy[i].close<sma?'down':'up';}
const rows=db.prepare(`SELECT rb.as_of_date d,ro.composite_score sc,ro.ret_21d r FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id WHERE rb.strategy='bearish' AND ro.ret_21d IS NOT NULL`).all().map(x=>{const s=spyFwd(x.d);return s==null?null:{...x,spy:s,alpha:x.r-s,regime:spyReg(x.d)};}).filter(Boolean);
const mean=a=>a.length?a.reduce((p,c)=>p+c,0)/a.length:NaN;
const sp=a=>mean(a.map(x=>-x.r)),win=a=>a.length?a.filter(x=>x.r<0).length/a.length*100:NaN,al=a=>mean(a.map(x=>x.alpha));

console.log('── FINE THRESHOLD SWEEP (score >= T, all regimes) ──');
console.log('  T     n   shortP&L  alpha   win%');
for(const T of [60,64,66,68,70,72,74]){const g=rows.filter(x=>x.sc>=T);console.log(`  ${T}  ${String(g.length).padStart(4)}  ${sp(g).toFixed(2).padStart(7)}%  ${al(g).toFixed(2).padStart(6)}%  ${win(g).toFixed(1).padStart(5)}%`);}

console.log('\n── TEMPORAL STABILITY of score>=70 cohort (quarterly) ──');
const q=x=>x.d.slice(0,7);
const hi=rows.filter(x=>x.sc>=70);
const byMo={};for(const x of hi){(byMo[q(x)]=byMo[q(x)]||[]).push(x);}
for(const m of Object.keys(byMo).sort()){const g=byMo[m];console.log(`  ${m}  n=${String(g.length).padStart(3)}  shortP&L=${sp(g).toFixed(1).padStart(6)}%  alpha=${al(g).toFixed(1).padStart(6)}%  win=${win(g).toFixed(0)}%`);}

console.log('\n── picks/date yield: how many bearish survive score>=70? ──');
const dates=[...new Set(rows.map(x=>x.d))];
const perDate=dates.map(d=>rows.filter(x=>x.d===d&&x.sc>=70).length);
const zero=perDate.filter(n=>n===0).length;
console.log(`  ${dates.length} brief dates | dates with >=1 pick>=70: ${dates.length-zero} | dates with 0: ${zero}`);
console.log(`  avg picks>=70 per date: ${(hi.length/dates.length).toFixed(2)}  (vs 5 currently)`);

db.close();
