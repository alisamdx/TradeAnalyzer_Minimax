import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';
const db=new Database(join(homedir(),'AppData','Roaming','trade-analyzer','trade-analyzer.sqlite'));
const T='DINO';
const bars=db.prepare(`SELECT date,close,high,low,volume FROM historical_prices WHERE ticker=? ORDER BY date`).all(T);
console.log(`bars: ${bars.length}  ${bars[0]?.date} .. ${bars.at(-1)?.date}  last close ${bars.at(-1)?.close}`);
const n=bars.length-1;
const sma=k=>bars.slice(n-k+1,n+1).reduce((a,b)=>a+b.close,0)/k;
const s50=sma(50), s200=sma(200);
const hi52=Math.max(...bars.slice(-252).map(b=>b.high)), lo52=Math.min(...bars.slice(-252).map(b=>b.low));
const px=bars.at(-1).close, basis=95.85;
console.log(`\nprice ${px.toFixed(2)}  SMA50 ${s50.toFixed(2)}  SMA200 ${s200.toFixed(2)}`);
console.log(`52w range ${lo52.toFixed(2)} .. ${hi52.toFixed(2)}`);
console.log(`\nOWN-AT-STRIKE (v1.1.169 read):`);
console.log(`  cost basis ${basis} vs SMA200 ${s200.toFixed(2)} -> ${((basis/s200-1)*100).toFixed(1)}%  ${basis<=s200?'BELOW':'ABOVE'}`);
console.log(`  52w range percentile: ${(((basis-lo52)/(hi52-lo52))*100).toFixed(0)}th`);
console.log(`\nnotDowntrend (T6: bullish band assigned 31.9% vs bearish 20.5%):`);
const dir = (px>s50&&s50>s200)?'BULLISH (100)':(px<s50&&s50<s200)?'BEARISH (10)':'SIDEWAYS (75)';
console.log(`  ${dir}   price>${'SMA50'} ${px>s50}  SMA50>SMA200 ${s50>s200}`);
// realized vol
const lr=[];for(let i=n-19;i<=n;i++) if(bars[i-1].close>0) lr.push(Math.log(bars[i].close/bars[i-1].close));
const m=lr.reduce((a,b)=>a+b,0)/lr.length;
const rv=Math.sqrt(lr.reduce((a,b)=>a+(b-m)**2,0)/(lr.length-1))*Math.sqrt(252)*100;
console.log(`\n20d realized vol: ${rv.toFixed(1)}%   (wheel-universe median ~31%, ETF ~17%)`);
// discontinuity check
let disc=0;
for(let i=1;i<bars.length;i++){const ch=bars[i].close/bars[i-1].close-1; if(Math.abs(ch)>0.20) {disc++; console.log(`  !! ${bars[i].date} ${(ch*100).toFixed(1)}%`);}}
console.log(`discontinuities >20%: ${disc}`);
// earnings
const e=db.prepare(`SELECT * FROM earnings_calendar WHERE ticker=?`).get(T);
console.log(`\nearnings_calendar: ${JSON.stringify(e)}`);
// iv history
const iv=db.prepare(`SELECT date,atm_iv FROM iv_history WHERE ticker=? ORDER BY date DESC LIMIT 260`).all(T);
if(iv.length){const w=iv.map(x=>x.atm_iv);const cur=w[0],mn=Math.min(...w),mx=Math.max(...w);
console.log(`IV: current ${cur?.toFixed(1)}  52w ${mn.toFixed(1)}..${mx.toFixed(1)}  rank ${(((cur-mn)/(mx-mn))*100).toFixed(0)}  (n=${w.length})`);}
// fundamentals
const f=db.prepare(`SELECT payload_json FROM fundamentals_cache WHERE ticker=?`).get(T);
if(f){const p=JSON.parse(f.payload_json);
console.log(`\nfundamentals: sector ${p.sector} | PE ${p.peRatio} | EPS ${p.eps} | div ${p.dividendYield}% | beta ${p.beta}`);
console.log(`  ND/EBITDA ${p.netDebtToEbitda} | ROIC ${p.roic} | margin ${p.profitMargin}% | revGrowth ${p.revenueGrowth}%`);
console.log(`  valueScore ${p.valueScore} growthScore ${p.growthScore} grade ${p.stockGrade}`);}
// history of DINO in briefs
const picks=db.prepare(`SELECT generated_at, picks FROM daily_briefs WHERE strategy='wheel' ORDER BY generated_at DESC LIMIT 62`).all();
let seen=0; for(const b of picks){try{for(const p of JSON.parse(b.picks)) if(p.ticker===T) seen++;}catch{}}
console.log(`\nDINO appearances in stored wheel briefs: ${seen}`);
db.close();
