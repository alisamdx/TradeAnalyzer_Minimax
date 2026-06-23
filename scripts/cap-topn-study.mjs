// Daily-entry-cap top-N study (max_new_entries_per_day).
// Question: if we raise the daily cap from 1 to 2 or 3, does the 2nd/3rd-best pick of the day
// degrade return / win rate vs the single best? The engine ranks the day's eligible picks by
// compositeScore DESC and fills to the cap (entry-policy.ts generateEntries), so "top-N/day" = the
// N highest-composite passing picks of each brief day.
//
// Method mirrors fr-budget-width-study.mjs exactly: faithful simSpread replica (BS pricing, 30 DTE,
// 0.30Δ short, budget-width wing [shipped default], 50% profit-target / 200% stop), run per pick.
// Picks are inflection UP-breakouts only (the live default — inflectionDirection='up'; the down side
// is a known net loser and is filtered at the strategy layer). Grouped by brief (one per as_of_date),
// ranked by composite within the day, bucketed by per-day rank.
//
// Caveats: (1) inflection-only — the real daily cap is GLOBAL across inflection+wheel+income, so the
// full-book effect of raising it is larger (more strategies fill the deeper slots). (2) Applies the
// composite floor (50) but not the critic/liquidity/earnings filters (not in replay data) — same
// limitation as the prior FR studies. (3) No weekly-cap (3/week) modeling — this isolates per-day
// pick quality, not the weekly portfolio.
import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const BUDGET = Number(process.argv[2] ?? 500);    // per-trade risk budget $ (5% of $10k)
const FLOOR  = Number(process.argv[3] ?? 50);     // min_composite_score (current default)
const MAX_WIDTH_PTS = 25;

// ── BS + sim helpers (copied verbatim from fr-budget-width-study.mjs) ──
function cdfNorm(x){const s=x<0?-1:1;const a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429];const p=0.3275911,ax=Math.abs(x)/Math.SQRT2,t=1/(1+p*ax);const poly=((((a[4]*t+a[3])*t+a[2])*t+a[1])*t+a[0])*t;return 0.5*(1+s*(1-poly*Math.exp(-ax*ax)));}
function bsPrice(S,K,T,r,sig,side){if(T<=0||sig<=0)return Math.max(0,side==='call'?S-K:K-S);const d1=(Math.log(S/K)+(r+0.5*sig*sig)*T)/(sig*Math.sqrt(T)),d2=d1-sig*Math.sqrt(T);return side==='call'?S*cdfNorm(d1)-K*Math.exp(-r*T)*cdfNorm(d2):K*Math.exp(-r*T)*cdfNorm(-d2)-S*cdfNorm(-d1);}
function bsDelta(S,K,T,r,sig,side){if(T<=0||sig<=0)return side==='call'?(S>K?1:0):(S<K?-1:0);const d1=(Math.log(S/K)+(r+0.5*sig*sig)*T)/(sig*Math.sqrt(T));return side==='call'?cdfNorm(d1):cdfNorm(d1)-1;}
function findStrikeForDelta(S,T,sig,td,side,r=0.02){let best=S,bd=Infinity;for(let i=0;i<=160;i++){const k=Math.round(S*(0.60+(i/160)*0.80)*2)/2;const diff=Math.abs(Math.abs(bsDelta(S,k,T,r,sig,side))-td);if(diff<bd){bd=diff;best=k;}}return best;}
function rollingVol(closes,w=20){const s=closes.slice(-Math.min(w+1,closes.length));if(s.length<3)return 0.30;const r=[];for(let i=1;i<s.length;i++)r.push(Math.log(s[i]/s[i-1]));const m=r.reduce((a,b)=>a+b,0)/r.length;return Math.max(0.05,Math.sqrt(r.reduce((q,x)=>q+(x-m)**2,0)/(r.length-1)*252));}
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
const daysBetween=(a,b)=>(new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000;
const strikeInc=(S)=>S>=200?5:S>=50?2.5:S>=25?1:0.5;

const P={deltaTarget:0.30,dteTarget:30,profitTargetPct:50,stopLossPct:200};
const barRange=db.prepare(`SELECT date,close FROM historical_prices WHERE ticker=? AND date>=? AND date<=? ORDER BY date ASC`);
const ivAll=db.prepare(`SELECT date,atm_iv FROM iv_history WHERE ticker=? AND atm_iv>0 ORDER BY date ASC`);

function chooseWing(S0,T,sigma0,shortK,side){
  const creditFor=(L)=>(bsPrice(S0,shortK,T,0.02,sigma0,side)-bsPrice(S0,L,T,0.02,sigma0,side))*100;
  const inc=strikeInc(S0); let best=null;
  for(let w=inc;w<=MAX_WIDTH_PTS+1e-9;w+=inc){
    const L=side==='put'?shortK-w:shortK+w; if(L<=0)break;
    const credit=creditFor(L), maxLoss=w*100-credit;
    if(maxLoss<=0)continue; if(credit<5)continue;
    if(maxLoss<=BUDGET)best={longK:L,credit,maxLoss}; else break;
  }
  return best;
}
function simSpread(ticker,entryDate,direction){
  const R=0.02, side=direction>0?'put':'call';
  const bars=barRange.all(ticker,addDays(entryDate,-60),addDays(entryDate,P.dteTarget+10));
  if(bars.length<5)return null;
  const ei=bars.findIndex(b=>b.date>=entryDate); if(ei<0)return null;
  const ivRows=ivAll.all(ticker);
  const ivAsOf=d=>{let lo=0,hi=ivRows.length-1,a=-1;while(lo<=hi){const m=(lo+hi)>>1;if(ivRows[m].date<=d){a=m;lo=m+1;}else hi=m-1;}return a>=0?ivRows[a].atm_iv/100:null;};
  const S0=bars[ei].close; if(!(S0>0))return null;
  const sigma0=ivAsOf(entryDate)??rollingVol(bars.slice(0,ei+1).map(b=>b.close),20);
  const T=P.dteTarget/365;
  const shortK=findStrikeForDelta(S0,T,sigma0,P.deltaTarget,side,R);
  const wing=chooseWing(S0,T,sigma0,shortK,side);
  if(!wing)return null;
  const {longK,credit,maxLoss}=wing;
  const exp=addDays(entryDate,P.dteTarget);
  for(let i=ei+1;i<bars.length;i++){
    const bar=bars[i]; const out=pnl=>({pnl,returnPct:pnl/maxLoss*100,maxLoss});
    if(bar.date>=exp){
      const intr=side==='put'
        ?(Math.max(0,shortK-bar.close)-Math.max(0,longK-bar.close))*100
        :(Math.max(0,bar.close-shortK)-Math.max(0,bar.close-longK))*100;
      return out(credit-intr);
    }
    const sig=ivAsOf(bar.date)??sigma0;
    const val=(bsPrice(bar.close,shortK,Math.max(0,daysBetween(bar.date,exp))/365,R,sig,side)
             -bsPrice(bar.close,longK,Math.max(0,daysBetween(bar.date,exp))/365,R,sig,side))*100;
    const pnlSoFar=credit-val;
    if(pnlSoFar>=credit*(P.profitTargetPct/100))return out(pnlSoFar);
    if(val>=credit*(P.stopLossPct/100))return out(pnlSoFar);
  }
  return null;
}

// ── load inflection UP picks, grouped by brief day, ranked by composite DESC ──
const rows=db.prepare(`
  SELECT rb.id briefId, rb.as_of_date asOf, ro.ticker t, ro.direction dir, ro.composite_score comp
  FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
  WHERE rb.strategy='inflection' AND ro.direction > 0 AND ro.composite_score >= ?
  ORDER BY rb.as_of_date ASC, ro.composite_score DESC, ro.rank ASC
`).all(FLOOR);

// assign per-day rank (1 = best composite that day) and simulate
const byDay=new Map();
for(const r of rows){ if(!byDay.has(r.briefId))byDay.set(r.briefId,[]); byDay.get(r.briefId).push(r); }
const sims=[]; let resolved=0, skipped=0;
const dayCounts=[];
for(const [,picks] of byDay){
  dayCounts.push(picks.length);
  picks.forEach((p,idx)=>{
    const sim=simSpread(p.t,p.asOf,p.dir>0?1:-1);
    if(!sim){skipped++;return;}
    resolved++;
    sims.push({...p,dayRank:idx+1,...sim});
  });
}

const dates=rows.map(r=>r.asOf).sort();
const spanDays=dates.length?daysBetween(dates[0],dates[dates.length-1]):0;
const years=Math.max(spanDays/365,0.01);
const tradingDays=Math.round(spanDays*5/7);

console.log(`\nDaily-cap top-N study — inflection UP only, composite≥${FLOOR}, budget-width $${BUDGET}`);
console.log(`Span ${dates[0]} → ${dates[dates.length-1]}  (~${tradingDays} trading days, ${years.toFixed(2)} yr)`);
console.log(`${byDay.size} brief days, ${rows.length} eligible picks, ${resolved} resolved (skipped ${skipped} no-data)\n`);

// how often a higher cap would even bind (enough picks/day)
const ge=(n)=>dayCounts.filter(c=>c>=n).length;
console.log(`Days with ≥1 pick: ${ge(1)}   ≥2: ${ge(2)} (${(ge(2)/byDay.size*100).toFixed(0)}%)   ≥3: ${ge(3)} (${(ge(3)/byDay.size*100).toFixed(0)}%)`);
console.log(`(a higher cap only deploys more on days that have that many qualifying picks)\n`);

function stat(label,set){
  if(!set.length){console.log(`  ${label.padEnd(22)} n=   0`);return;}
  const wins=set.filter(s=>s.pnl>0).length;
  const avgRet=set.reduce((s,r)=>s+r.returnPct,0)/set.length;
  const avgML=set.reduce((s,r)=>s+r.maxLoss,0)/set.length;
  const totPnl=set.reduce((s,r)=>s+r.pnl,0);
  const perYr=set.length/years;
  console.log(`  ${label.padEnd(22)} n=${String(set.length).padStart(4)}  win=${(wins/set.length*100).toFixed(1).padStart(5)}%  avgRet/maxLoss=${avgRet.toFixed(1).padStart(6)}%  avgMaxLoss=$${avgML.toFixed(0).padStart(4)}  Σpnl=$${totPnl.toFixed(0).padStart(6)}  ~${perYr.toFixed(0)}/yr`);
}

console.log('=== MARGINAL: picks at each per-day rank (is the 2nd/3rd worse than the 1st?) ===');
stat('rank 1 (the best)',  sims.filter(s=>s.dayRank===1));
stat('rank 2',             sims.filter(s=>s.dayRank===2));
stat('rank 3',             sims.filter(s=>s.dayRank===3));
stat('rank 4+',            sims.filter(s=>s.dayRank>=4));

console.log('\n=== CUMULATIVE: what each daily cap takes (top-N/day) ===');
stat('cap=1 (rank≤1)',     sims.filter(s=>s.dayRank<=1));
stat('cap=2 (rank≤2)',     sims.filter(s=>s.dayRank<=2));
stat('cap=3 (rank≤3)',     sims.filter(s=>s.dayRank<=3));
stat('uncapped (all)',     sims);

console.log('\n(Σpnl scales with # trades = the capital-deployment upside; avgRet/win = quality. If');
console.log(' rank 2/3 hold up vs rank 1, raising the cap adds deployment without diluting quality.)');
db.close();
