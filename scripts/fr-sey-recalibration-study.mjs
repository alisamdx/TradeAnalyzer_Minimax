// Recalibration validation (FR-SEY-5): can ANY alternative ranking of down-breakout
// (bear-call) inflection picks produce a profitable book on real spread P&L? If even the
// best top-bucket is ~breakeven, the bear-call side is unsalvageable and recalibration is
// declined. Uses the faithful simulateSingleSpread replica + reconstructed features.

import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

// ── BS / spread sim (verbatim from backtest-engine.ts) ──
function cdfNorm(x){const s=x<0?-1:1,a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429],p=0.3275911,ax=Math.abs(x)/Math.SQRT2,t=1/(1+p*ax);return 0.5*(1+s*(1-(((((a[4]*t+a[3])*t+a[2])*t+a[1])*t+a[0])*t)*Math.exp(-ax*ax)));}
function bsPrice(S,K,T,r,sig,side){if(T<=0||sig<=0)return Math.max(0,side==='call'?S-K:K-S);const d1=(Math.log(S/K)+(r+0.5*sig*sig)*T)/(sig*Math.sqrt(T)),d2=d1-sig*Math.sqrt(T);return side==='call'?S*cdfNorm(d1)-K*Math.exp(-r*T)*cdfNorm(d2):K*Math.exp(-r*T)*cdfNorm(-d2)-S*cdfNorm(-d1);}
function bsDelta(S,K,T,r,sig,side){if(T<=0||sig<=0)return side==='call'?(S>K?1:0):(S<K?-1:0);const d1=(Math.log(S/K)+(r+0.5*sig*sig)*T)/(sig*Math.sqrt(T));return side==='call'?cdfNorm(d1):cdfNorm(d1)-1;}
function findStrike(S,T,sig,td,side,r=0.02){let b=S,bd=Infinity;for(let i=0;i<=160;i++){const k=Math.round(S*(0.6+(i/160)*0.8)*2)/2,d=Math.abs(Math.abs(bsDelta(S,k,T,r,sig,side))-td);if(d<bd){bd=d;b=k;}}return b;}
function rollVol(c,w=20){const s=c.slice(-Math.min(w+1,c.length));if(s.length<3)return 0.3;const r=[];for(let i=1;i<s.length;i++)r.push(Math.log(s[i]/s[i-1]));const m=r.reduce((a,b)=>a+b,0)/r.length;return Math.max(0.05,Math.sqrt(r.reduce((q,x)=>q+(x-m)**2,0)/(r.length-1)*252));}
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
const dbetween=(a,b)=>(new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000;
const P={deltaTarget:0.30,dteTarget:30,profitTargetPct:50,stopLossPct:200};
const barRange=db.prepare(`SELECT date,close FROM historical_prices WHERE ticker=? AND date>=? AND date<=? ORDER BY date ASC`);
const ivAll=db.prepare(`SELECT date,atm_iv FROM iv_history WHERE ticker=? AND atm_iv>0 ORDER BY date ASC`);
function simSpread(t,entry,dir){
  const R=0.02,side=dir>0?'put':'call';
  const bars=barRange.all(t,addDays(entry,-60),addDays(entry,P.dteTarget+10));
  if(bars.length<5)return null;
  const ei=bars.findIndex(b=>b.date>=entry);if(ei<0)return null;
  const iv=ivAll.all(t);const ivAsOf=d=>{let lo=0,hi=iv.length-1,a=-1;while(lo<=hi){const m=(lo+hi)>>1;if(iv[m].date<=d){a=m;lo=m+1;}else hi=m-1;}return a>=0?iv[a].atm_iv/100:null;};
  const S0=bars[ei].close;if(!(S0>0))return null;
  const s0=ivAsOf(entry)??rollVol(bars.slice(0,ei+1).map(b=>b.close),20),T=P.dteTarget/365;
  const sk=findStrike(S0,T,s0,P.deltaTarget,side,R),lk=findStrike(S0,T,s0,0.15,side,R);if(sk===lk)return null;
  const credit=(bsPrice(S0,sk,T,R,s0,side)-bsPrice(S0,lk,T,R,s0,side))*100;if(credit<5)return null;
  const width=Math.abs(sk-lk)*100,maxLoss=width-credit;if(!(maxLoss>0))return null;
  const exp=addDays(entry,P.dteTarget);
  for(let i=ei+1;i<bars.length;i++){const bar=bars[i];const out=pnl=>({pnl,returnPct:pnl/maxLoss*100});
    if(bar.date>=exp){const intr=side==='put'?(Math.max(0,sk-bar.close)-Math.max(0,lk-bar.close))*100:(Math.max(0,bar.close-sk)-Math.max(0,bar.close-lk))*100;return out(credit-intr);}
    const sg=ivAsOf(bar.date)??s0;const val=(bsPrice(bar.close,sk,Math.max(0,dbetween(bar.date,exp))/365,R,sg,side)-bsPrice(bar.close,lk,Math.max(0,dbetween(bar.date,exp))/365,R,sg,side))*100;
    const pnl=credit-val;if(pnl>=credit*(P.profitTargetPct/100))return out(pnl);if(val>=credit*(P.stopLossPct/100))return out(pnl);}
  return null;
}
const barsDesc=db.prepare(`SELECT date,high,low,close FROM historical_prices WHERE ticker=? AND date<=? ORDER BY date DESC LIMIT 60`);
const ivOne=db.prepare(`SELECT atm_iv FROM iv_history WHERE ticker=? AND date<=? AND atm_iv>0 ORDER BY date DESC LIMIT 1`);
function feats(t,asOf){const b=barsDesc.all(t,asOf);if(b.length<20)return null;const close=b[0].close;let tr=0,k=0;for(let i=0;i<14&&i+1<b.length;i++){const c=b[i],pc=b[i+1].close;tr+=Math.max(c.high-c.low,Math.abs(c.high-pc),Math.abs(c.low-pc));k++;}return{atrPct:(tr/k)/close*100,iv:(ivOne.get(t,asOf)||{}).atm_iv??null};}

const down = db.prepare(`
  SELECT ro.ticker t, rb.as_of_date asOf, ro.composite_score cs
  FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
  WHERE rb.strategy='inflection' AND ro.direction = -1
`).all();

const rows = [];
for (const p of down) { const r = simSpread(p.t, p.asOf, -1); if (!r) continue; const f = feats(p.t, p.asOf); rows.push({ ...p, ...r, atrPct: f?.atrPct ?? null, iv: f?.iv ?? null }); }

function stat(rs) {
  if (!rs.length) return '  n=0';
  const w = rs.filter(r => r.pnl > 0).length;
  const ar = rs.reduce((s, r) => s + r.returnPct, 0) / rs.length;
  const ap = rs.reduce((s, r) => s + r.pnl, 0) / rs.length;
  return `n=${String(rs.length).padStart(4)}  win=${(w / rs.length * 100).toFixed(1).padStart(5)}%  avgRet/maxloss=${ar.toFixed(1).padStart(6)}%  avg$=${ap.toFixed(0).padStart(5)}`;
}
function topByRank(rs, keyFn, asc, frac) {
  const v = rs.filter(r => keyFn(r) != null).sort((a, b) => asc ? keyFn(a) - keyFn(b) : keyFn(b) - keyFn(a));
  return v.slice(0, Math.max(1, Math.floor(v.length * frac)));
}

console.log(`down-breakout resolved trades: ${rows.length}\n`);
console.log('BAR TO BEAT: up-breakout (bull put) book = +6.1%/trade, 76% win\n');
console.log('baseline (all down)             ', stat(rows));
for (const frac of [0.2, 0.33]) {
  console.log(`\n--- top ${Math.round(frac*100)}% by each ranking (does any select a profitable bear-call book?) ---`);
  console.log(`by composite DESC (current sel) `, stat(topByRank(rows, r => r.cs, false, frac)));
  console.log(`by composite ASC (low score)    `, stat(topByRank(rows, r => r.cs, true, frac)));
  console.log(`by ATR% ASC (prefer calm)       `, stat(topByRank(rows, r => r.atrPct, true, frac)));
  console.log(`by IV ASC (prefer low IV)       `, stat(topByRank(rows, r => r.iv, true, frac)));
  // combined "safe" rank: average of ATR% and IV percentile ranks (both ascending)
  const withRank = rows.filter(r => r.atrPct != null && r.iv != null);
  const byAtr = [...withRank].sort((a, b) => a.atrPct - b.atrPct); const atrRank = new Map(byAtr.map((r, i) => [r, i]));
  const byIv = [...withRank].sort((a, b) => a.iv - b.iv); const ivRank = new Map(byIv.map((r, i) => [r, i]));
  const safe = [...withRank].sort((a, b) => (atrRank.get(a) + ivRank.get(a)) - (atrRank.get(b) + ivRank.get(b)));
  console.log(`by SAFE (low ATR% + low IV)      `, stat(safe.slice(0, Math.floor(safe.length * frac))));
}
db.close();
