// Track B validation (overlay, no engine change yet).
// Question: would penalizing short-term-overbought names have improved buy/bullish selection?
// Method: recompute each existing replay pick's "overbought severity" point-in-time
// (RSI14 + % above 20-day SMA at as_of_date), then test whether severity predicts
// underperformance and whether a score - λ·severity guard improves the score→edge link.
import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const avg=(a)=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
const med=(a)=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const fmt=(v)=>v===null?'  — ':(v>=0?'+':'')+v.toFixed(1);
function pearson(x,y){const n=x.length;if(n<3)return null;const mx=avg(x),my=avg(y);let c=0,sx=0,sy=0;for(let i=0;i<n;i++){c+=(x[i]-mx)*(y[i]-my);sx+=(x[i]-mx)**2;sy+=(y[i]-my)**2;}return sx>0&&sy>0?c/Math.sqrt(sx*sy):null;}
function rankArr(a){const idx=a.map((v,i)=>[v,i]).sort((p,q)=>p[0]-q[0]);const r=new Array(a.length);let i=0;while(i<idx.length){let j=i;while(j+1<idx.length&&idx[j+1][0]===idx[i][0])j++;const rk=(i+j)/2+1;for(let k=i;k<=j;k++)r[idx[k][1]]=rk;i=j+1;}return r;}
const spearman=(x,y)=>pearson(rankArr(x),rankArr(y));
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const W=78,line=()=>console.log('='.repeat(W)),dline=()=>console.log('-'.repeat(W)),hdr=(s)=>{line();console.log('  '+s);dline();};

// Wilder RSI-14 on a close array (ASC). Returns last value or null.
function rsi14(closes){
  if(closes.length<15) return null;
  let gain=0,loss=0;
  for(let i=1;i<=14;i++){const d=closes[i]-closes[i-1]; if(d>=0)gain+=d; else loss-=d;}
  let ag=gain/14, al=loss/14;
  for(let i=15;i<closes.length;i++){const d=closes[i]-closes[i-1]; const g=d>0?d:0,l=d<0?-d:0; ag=(ag*13+g)/14; al=(al*13+l)/14;}
  if(al===0) return 100;
  const rs=ag/al; return 100-100/(1+rs);
}

// Overbought severity 0..100: 0 = not overbought, 100 = RSI≥90 AND ≥30% above 20MA.
function severity(rsi, price, sma20){
  let sev=0, have=false;
  if(rsi!==null){ sev+=clamp((rsi-70)/20*50,0,50); have=true; }
  if(sma20!==null && sma20>0){ const ext=(price-sma20)/sma20*100; sev+=clamp((ext-10)/20*50,0,50); have=true; }
  return have?sev:null;
}

// ── load replay picks (buy + bullish) ──────────────────────────────────────────
const picks = db.prepare(`
  SELECT rb.as_of_date, rb.strategy, ro.ticker, ro.rank, ro.composite_score, ro.ret_21d
  FROM replay_briefs rb JOIN replay_outcomes ro ON ro.replay_brief_id = rb.id
  WHERE rb.strategy IN ('buy','bullish') AND ro.ret_21d IS NOT NULL
  ORDER BY rb.as_of_date, rb.strategy, ro.rank
`).all();

const tickers=[...new Set(picks.map(p=>p.ticker))];
const ph=tickers.map(()=>'?').join(',');
const prows=db.prepare(`SELECT ticker,date,close FROM historical_prices WHERE ticker IN (${ph}) ORDER BY ticker,date`).all(...tickers);
const priceCache=new Map();
for(const r of prows){ if(!priceCache.has(r.ticker))priceCache.set(r.ticker,[]); priceCache.get(r.ticker).push(r); }

// compute severity per pick
for(const p of picks){
  const arr=priceCache.get(p.ticker); if(!arr){p.sev=null;continue;}
  // prices up to and including as_of_date
  let end=-1; for(let i=arr.length-1;i>=0;i--){ if(arr[i].date<=p.as_of_date){end=i;break;} }
  if(end<20){p.sev=null;continue;}
  const closes=arr.slice(0,end+1).map(x=>x.close);
  const price=closes[closes.length-1];
  const sma20=avg(closes.slice(-20));
  const rsi=rsi14(closes.slice(-60)); // last ~60 closes enough for stable RSI14
  p.sev=severity(rsi,price,sma20);
  p.edge=p.ret_21d; // buy/bullish are long → edge = stock return
}
const valid=picks.filter(p=>p.sev!==null);

console.log('\nTRACK B OVERLAY — would an overbought guard have helped buy/bullish?');
console.log(valid.length+'/'+picks.length+' picks have computable severity\n');

// ── TEST 1: does severity predict underperformance? ────────────────────────────
hdr('TEST 1  Overbought severity → forward edge  (the core premise)');
console.log('  severity bucket      n     mean    median');
const buckets=[['0 (clean)',p=>p.sev===0],['1–25',p=>p.sev>0&&p.sev<=25],['26–50',p=>p.sev>25&&p.sev<=50],['51–75',p=>p.sev>50&&p.sev<=75],['76–100',p=>p.sev>75]];
for(const[label,f]of buckets){const r=valid.filter(f);if(!r.length){console.log('  '+label.padEnd(18)+'   0');continue;}
  console.log('  '+label.padEnd(18)+String(r.length).padStart(4)+'  '+fmt(avg(r.map(x=>x.edge))).padStart(6)+'  '+fmt(med(r.map(x=>x.edge))).padStart(6));}
const sevAll=valid.map(p=>p.sev),edgeAll=valid.map(p=>p.edge);
console.log('\n  Spearman(severity, edge) = '+spearman(sevAll,edgeAll).toFixed(3)+'  (negative ⇒ overbought underperforms = premise holds)');

// ── TEST 1b: within the high-score bucket, does severity still bite? ────────────
hdr('TEST 1b  WITHIN top-score quintile (Q5) — is severity the culprit?');
for(const s of ['buy','bullish']){
  const r=valid.filter(p=>p.strategy===s).sort((a,b)=>a.composite_score-b.composite_score);
  const q5=r.slice(Math.floor(r.length*0.8));
  const hi=q5.filter(p=>p.sev>40), lo=q5.filter(p=>p.sev<=40);
  console.log('  '+s.toUpperCase()+'  Q5 picks (n='+q5.length+'):');
  console.log('    overbought (sev>40):  n='+hi.length+'  edge '+fmt(avg(hi.map(x=>x.edge)))+'  (median '+fmt(med(hi.map(x=>x.edge)))+')');
  console.log('    calm       (sev≤40):  n='+lo.length+'  edge '+fmt(avg(lo.map(x=>x.edge)))+'  (median '+fmt(med(lo.map(x=>x.edge)))+')');
}

// ── TEST 2: does score - λ·severity improve the score→edge correlation? ─────────
hdr('TEST 2  Guarded score = composite − λ·severity → score→edge Spearman');
console.log('  (anti-predictive correlation should move toward 0 / positive as guard is applied)');
console.log('  strategy   λ=0.00   λ=0.08   λ=0.12   λ=0.16   λ=0.20');
for(const s of ['buy','bullish']){
  const r=valid.filter(p=>p.strategy===s);
  const edge=r.map(p=>p.edge);
  const cells=[0,0.08,0.12,0.16,0.20].map(lam=>{
    const adj=r.map(p=>p.composite_score-lam*p.sev);
    return spearman(adj,edge).toFixed(3).padStart(7);
  });
  console.log('  '+s.padEnd(9)+cells.join('  '));
}

// ── TEST 3: re-rank WITHIN each brief by guarded score; compare top picks ───────
hdr('TEST 3  In-brief selection — top picks by original score vs guarded score');
console.log('  For each date×strategy, take the engine\'s top-1 and top-3 by each ranking.');
console.log('  If the guard helps, guarded top picks should out-edge original top picks.\n');
const LAM=0.12;
for(const s of ['buy','bullish']){
  const byDate=new Map();
  for(const p of valid.filter(x=>x.strategy===s)){ if(!byDate.has(p.as_of_date))byDate.set(p.as_of_date,[]); byDate.get(p.as_of_date).push(p); }
  const top1o=[],top1g=[],top3o=[],top3g=[];
  for(const[,arr]of byDate){
    if(arr.length<3)continue;
    const byOrig=[...arr].sort((a,b)=>b.composite_score-a.composite_score);
    const byGuard=[...arr].sort((a,b)=>(b.composite_score-LAM*b.sev)-(a.composite_score-LAM*a.sev));
    top1o.push(byOrig[0].edge); top1g.push(byGuard[0].edge);
    top3o.push(avg(byOrig.slice(0,3).map(x=>x.edge))); top3g.push(avg(byGuard.slice(0,3).map(x=>x.edge)));
  }
  console.log('  '+s.toUpperCase()+'  ('+top1o.length+' briefs, λ=0.12):');
  console.log('    top-1  original '+fmt(avg(top1o))+' (med '+fmt(med(top1o))+')   guarded '+fmt(avg(top1g))+' (med '+fmt(med(top1g))+')   Δ '+fmt(avg(top1g)-avg(top1o)));
  console.log('    top-3  original '+fmt(avg(top3o))+' (med '+fmt(med(top3o))+')   guarded '+fmt(avg(top3g))+' (med '+fmt(med(top3g))+')   Δ '+fmt(avg(top3g)-avg(top3o)));
}

// ── TEST 4: sub-period — does the guard help in the calm late period too? ───────
hdr('TEST 4  Guard effect by sub-period (does it hurt when not in a crash?)');
const dates=[...new Set(valid.map(p=>p.as_of_date))].sort();
const third=Math.ceil(dates.length/3);
const periods=[['early',new Set(dates.slice(0,third))],['mid',new Set(dates.slice(third,2*third))],['late',new Set(dates.slice(2*third))]];
console.log('  top-3 edge Δ (guarded − original), λ=0.12:');
console.log('  strategy     early     mid     late');
for(const s of ['buy','bullish']){
  const cells=periods.map(([,set])=>{
    const byDate=new Map();
    for(const p of valid.filter(x=>x.strategy===s&&set.has(x.as_of_date))){ if(!byDate.has(p.as_of_date))byDate.set(p.as_of_date,[]); byDate.get(p.as_of_date).push(p); }
    const o=[],g=[];
    for(const[,arr]of byDate){ if(arr.length<3)continue;
      const bo=[...arr].sort((a,b)=>b.composite_score-a.composite_score);
      const bg=[...arr].sort((a,b)=>(b.composite_score-LAM*b.sev)-(a.composite_score-LAM*a.sev));
      o.push(avg(bo.slice(0,3).map(x=>x.edge))); g.push(avg(bg.slice(0,3).map(x=>x.edge))); }
    return (o.length?fmt(avg(g)-avg(o)):'  —').padStart(8);
  });
  console.log('  '+s.padEnd(9)+'  '+cells.join(''));
}
line();
console.log('  Decision rule: ship the guard only if Test 1 shows overbought underperforms,');
console.log('  Test 3 shows positive top-3 Δ, and Test 4 shows it is not harmful in the late period.');
line();
db.close();
