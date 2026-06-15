// Track A — robustness re-cut of the two "scoring is anti-predictive / rank is inverted" findings.
// Tests whether they survive: direction-aware edge, medians + dispersion, bootstrap CIs,
// Spearman (outlier-robust) correlation, sub-period stability, and the CORRECT win metric
// for wheel/income (stayed-above-strike, not raw stock return).
import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

// ── helpers ───────────────────────────────────────────────────────────────────
const avg = (a) => a.length ? a.reduce((s,v)=>s+v,0)/a.length : null;
const med = (a) => { if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const std = (a) => { if(a.length<2) return null; const m=avg(a); return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/(a.length-1)); };
const pctile = (a,p) => { if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); const i=(s.length-1)*p; const lo=Math.floor(i),hi=Math.ceil(i); return s[lo]+(s[hi]-s[lo])*(i-lo); };
const fmt = (v) => v===null ? '   — ' : (v>=0?'+':'')+v.toFixed(1);
const fmtp= (v) => v===null ? '  — ' : (v*100).toFixed(0)+'%';
const W=78, line=()=>console.log('='.repeat(W)), dline=()=>console.log('-'.repeat(W));
const hdr=(s)=>{ line(); console.log('  '+s); dline(); };

// Pearson and Spearman
function pearson(x,y){ const n=x.length; if(n<3) return null; const mx=avg(x),my=avg(y);
  let cov=0,sx=0,sy=0; for(let i=0;i<n;i++){cov+=(x[i]-mx)*(y[i]-my);sx+=(x[i]-mx)**2;sy+=(y[i]-my)**2;}
  return sx>0&&sy>0 ? cov/Math.sqrt(sx*sy) : null; }
function rankArr(a){ const idx=a.map((v,i)=>[v,i]).sort((p,q)=>p[0]-q[0]); const r=new Array(a.length);
  let i=0; while(i<idx.length){ let j=i; while(j+1<idx.length&&idx[j+1][0]===idx[i][0])j++;
    const rk=(i+j)/2+1; for(let k=i;k<=j;k++)r[idx[k][1]]=rk; i=j+1; } return r; }
const spearman=(x,y)=>pearson(rankArr(x),rankArr(y));

// Bootstrap 95% CI of mean(B) - mean(A)
function bootSpread(A,B,iters=2000){
  if(!A.length||!B.length) return [null,null];
  const spreads=new Array(iters);
  for(let t=0;t<iters;t++){
    let sa=0; for(let i=0;i<A.length;i++) sa+=A[(Math.random()*A.length)|0];
    let sb=0; for(let i=0;i<B.length;i++) sb+=B[(Math.random()*B.length)|0];
    spreads[t]=sb/B.length - sa/A.length;
  }
  spreads.sort((a,b)=>a-b);
  return [pctile(spreads,0.025), pctile(spreads,0.975)];
}

// ── load ──────────────────────────────────────────────────────────────────────
const rows = db.prepare(`
  SELECT rb.as_of_date, rb.strategy, ro.ticker, ro.rank, ro.composite_score,
    ro.ret_21d, ro.max_drawdown_21d, ro.synth_strike, ro.stayed_above_strike
  FROM replay_briefs rb JOIN replay_outcomes ro ON ro.replay_brief_id = rb.id
  ORDER BY rb.as_of_date, rb.strategy, ro.rank
`).all();

const allDates=[...new Set(rows.map(r=>r.as_of_date))].sort();
const strategies=['buy','bullish','income','wheel','bearish'];
const strats={}; for(const s of strategies) strats[s]=rows.filter(r=>r.strategy===s);

// Direction-aware edge: for bearish, a falling stock is a WIN, so flip the sign.
// edge>0 always means "the trade worked". Lets us read correlation consistently.
const DIRECTIONAL = new Set(['buy','bullish','bearish']);
const edgeOf = (r) => r.ret_21d===null ? null : (r.strategy==='bearish' ? -r.ret_21d : r.ret_21d);

console.log('\nTRACK A — ROBUSTNESS RE-CUT  ('+allDates.length+' dates, '+allDates[0]+' → '+allDates[allDates.length-1]+')');
console.log('edge = directional P&L sign (bearish flipped so + = trade worked)\n');

// ── §1  DIRECTION-AWARE QUINTILE: mean, MEDIAN, dispersion, n, bootstrap CI ─────
hdr('§1  SCORE QUINTILE → EDGE  (direction-aware; median + dispersion + 95% CI)');
console.log('  For each: split picks into score quintiles Q1(low)..Q5(high).');
console.log('  "anti-predictive" is only REAL if Q5-Q1 spread is negative AND its CI excludes 0.\n');
for(const s of DIRECTIONAL){
  const r=strats[s].filter(x=>x.composite_score!==null && edgeOf(x)!==null);
  if(r.length<25){ console.log('  '+s+': insufficient\n'); continue; }
  r.sort((a,b)=>a.composite_score-b.composite_score);
  const ch=Math.floor(r.length/5);
  const Q=[0,1,2,3,4].map(i=>r.slice(i*ch, i===4?r.length:(i+1)*ch).map(edgeOf));
  console.log('  '+s.toUpperCase()+'  (n='+r.length+')');
  console.log('    quintile   n   mean   median   IQR(p25..p75)');
  for(let i=0;i<5;i++){
    const q=Q[i];
    console.log('    Q'+(i+1)+(i===0?'(lo)':i===4?'(hi)':'   ')+'  '+String(q.length).padStart(3)+
      '  '+fmt(avg(q)).padStart(5)+'  '+fmt(med(q)).padStart(6)+'   ['+fmt(pctile(q,0.25)).trim()+' .. '+fmt(pctile(q,0.75)).trim()+']');
  }
  const meanSpread=avg(Q[4])-avg(Q[0]);
  const medSpread=med(Q[4])-med(Q[0]);
  const [lo,hi]=bootSpread(Q[0],Q[4]);
  const allEdge=r.map(edgeOf), allScore=r.map(x=>x.composite_score);
  const pr=pearson(allScore,allEdge), sp=spearman(allScore,allEdge);
  const ciCross = lo<0 && hi>0;
  console.log('    Q5-Q1 mean spread: '+fmt(meanSpread)+'   median spread: '+fmt(medSpread));
  console.log('    bootstrap 95% CI of mean spread: ['+fmt(lo).trim()+', '+fmt(hi).trim()+']  '+
    (ciCross?'⟵ CROSSES 0 = not distinguishable from noise':(meanSpread<0?'⟵ real negative edge':'⟵ real positive edge')));
  console.log('    Pearson r='+(pr===null?'—':pr.toFixed(3))+'  Spearman r='+(sp===null?'—':sp.toFixed(3))+
    '  (r²='+(sp===null?'—':(sp*sp*100).toFixed(1)+'%')+' of variance)\n');
}

// ── §2  RANK POSITION: mean + median + n + bootstrap CI of rank1 vs rank4 ───────
hdr('§2  PICK RANK → EDGE  (is rank-1 really worse than rank-4? n + median + CI)');
for(const s of strategies){
  const dir = DIRECTIONAL.has(s);
  const tag = dir ? 'edge' : 'stock-ret (NOT win metric — see §4)';
  console.log('  '+s.toUpperCase()+'  ['+tag+']');
  console.log('    rank   n    mean   median');
  const byRank={};
  for(const x of strats[s]){ const e=dir?edgeOf(x):(x.ret_21d); if(e===null)continue;
    const rk=x.rank>=5?5:x.rank; (byRank[rk]=byRank[rk]||[]).push(e); }
  for(const rk of [1,2,3,4,5]){ const a=byRank[rk]||[];
    console.log('    '+(rk===5?'5+':String(rk))+'     '+String(a.length).padStart(3)+'   '+fmt(avg(a)).padStart(5)+'  '+fmt(med(a)).padStart(6)); }
  if(byRank[1]&&byRank[4]){
    const [lo,hi]=bootSpread(byRank[1],byRank[4]);
    const sp=avg(byRank[4])-avg(byRank[1]);
    console.log('    rank4-rank1 mean spread: '+fmt(sp)+'   95% CI ['+fmt(lo).trim()+', '+fmt(hi).trim()+']  '+
      (lo<0&&hi>0?'⟵ CROSSES 0 = inversion not significant':'⟵ significant'));
  }
  console.log();
}

// ── §3  SUB-PERIOD STABILITY — is the buy anti-correlation just one stretch? ────
hdr('§3  SUB-PERIOD STABILITY  (Q5-Q1 edge spread by period — concentrated or persistent?)');
function quintSpread(r){ if(r.length<15) return null; const rr=[...r].sort((a,b)=>a.composite_score-b.composite_score);
  const ch=Math.floor(rr.length/5); const q1=rr.slice(0,ch).map(edgeOf); const q5=rr.slice(4*ch).map(edgeOf);
  return avg(q5)-avg(q1); }
// thirds of the timeline
const third=Math.ceil(allDates.length/3);
const periods=[['early',allDates.slice(0,third)],['mid',allDates.slice(third,2*third)],['late',allDates.slice(2*third)]];
console.log('  Strategy   '+periods.map(([n])=>n.padStart(8)).join('')+'    full');
for(const s of DIRECTIONAL){
  const cells=periods.map(([,ds])=>{ const set=new Set(ds);
    const r=strats[s].filter(x=>set.has(x.as_of_date)&&x.composite_score!==null&&edgeOf(x)!==null);
    return fmt(quintSpread(r)).padStart(8); });
  const full=strats[s].filter(x=>x.composite_score!==null&&edgeOf(x)!==null);
  console.log('  '+s.padEnd(9)+'  '+cells.join('')+'  '+fmt(quintSpread(full)).padStart(6));
}
console.log('\n  Per-month Q5-Q1 edge spread (buy + bullish) — find concentration:');
const months=[...new Set(allDates.map(d=>d.slice(0,7)))].sort();
for(const s of ['buy','bullish']){
  const cells=months.map(ym=>{ const r=strats[s].filter(x=>x.as_of_date.startsWith(ym)&&x.composite_score!==null&&edgeOf(x)!==null);
    return ym.slice(2)+':'+fmt(quintSpread(r)).trim(); });
  console.log('  '+s+':  '+cells.join('  '));
}
// drop worst single month, recompute full-period spread + correlation
console.log('\n  Sensitivity: drop the worst month for each strategy, recompute:');
for(const s of DIRECTIONAL){
  const full=strats[s].filter(x=>x.composite_score!==null&&edgeOf(x)!==null);
  const monthSpread=months.map(ym=>({ym,sp:quintSpread(full.filter(x=>x.as_of_date.startsWith(ym)))})).filter(m=>m.sp!==null);
  const worst=monthSpread.sort((a,b)=>a.sp-b.sp)[0];
  const without=full.filter(x=>!x.as_of_date.startsWith(worst.ym));
  const sp=spearman(without.map(x=>x.composite_score),without.map(edgeOf));
  console.log('    '+s.padEnd(8)+' worst month '+worst.ym+' (spread '+fmt(worst.sp).trim()+')  →  full Spearman drops from '+
    fmt2(spearman(full.map(x=>x.composite_score),full.map(edgeOf)))+' to '+fmt2(sp)+' without it');
}
function fmt2(v){ return v===null?'—':(v>=0?'+':'')+v.toFixed(3); }

// ── §4  WHEEL/INCOME — CORRECT WIN METRIC (stayed above strike), not stock ret ──
hdr('§4  WHEEL/INCOME — score → STAYED-ABOVE-STRIKE rate  (the actual win condition)');
console.log('  Premium strategies win on the stock NOT breaching the strike — stock direction');
console.log('  is the wrong yardstick. Re-test the quintiles against strike retention.\n');
for(const s of ['wheel','income']){
  const r=strats[s].filter(x=>x.composite_score!==null && x.stayed_above_strike!==null);
  if(r.length<25){ console.log('  '+s+': only '+r.length+' rows with strike data — insufficient\n'); continue; }
  r.sort((a,b)=>a.composite_score-b.composite_score);
  const ch=Math.floor(r.length/5);
  console.log('  '+s.toUpperCase()+'  (n='+r.length+' with strike data)');
  console.log('    quintile   n    stayed-above-strike');
  const Q=[0,1,2,3,4].map(i=>r.slice(i*ch,i===4?r.length:(i+1)*ch));
  for(let i=0;i<5;i++){ const q=Q[i]; const safe=q.filter(x=>x.stayed_above_strike===1).length;
    console.log('    Q'+(i+1)+(i===0?'(lo)':i===4?'(hi)':'   ')+'  '+String(q.length).padStart(3)+'    '+fmtp(safe/q.length).padStart(5)+
      '  ('+safe+'/'+q.length+')'); }
  const q1=Q[0].map(x=>x.stayed_above_strike), q5=Q[4].map(x=>x.stayed_above_strike);
  const sp=spearman(r.map(x=>x.composite_score),r.map(x=>x.stayed_above_strike));
  console.log('    Q5-Q1 retention spread: '+fmtp(avg(q5)-avg(q1))+'   Spearman(score, stayed): '+fmt2(sp)+'\n');
}

// ── §5  VERDICT SUMMARY ────────────────────────────────────────────────────────
hdr('§5  VERDICT — does each finding survive?');
for(const s of DIRECTIONAL){
  const r=strats[s].filter(x=>x.composite_score!==null&&edgeOf(x)!==null).sort((a,b)=>a.composite_score-b.composite_score);
  const ch=Math.floor(r.length/5);
  const q1=r.slice(0,ch).map(edgeOf), q5=r.slice(4*ch).map(edgeOf);
  const [lo,hi]=bootSpread(q1,q5);
  const sp=spearman(r.map(x=>x.composite_score),r.map(edgeOf));
  const real = !(lo<0&&hi>0) && (avg(q5)-avg(q1))<0;
  console.log('  '+s.padEnd(8)+': Q5-Q1 edge '+fmt(avg(q5)-avg(q1)).trim()+', CI ['+fmt(lo).trim()+','+fmt(hi).trim()+'], Spearman '+fmt2(sp)+
    '  →  '+(real?'ANTI-PREDICTIVE confirmed':(lo<0&&hi>0)?'NOISE (CI crosses 0)':'engine OK / positive'));
}
line();
db.close();
