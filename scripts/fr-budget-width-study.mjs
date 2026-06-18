// FR-SEY-5 validation for the risk-budget spread width (migration 053).
// Faithful replica of BacktestEngine.simulateSingleSpread, run over every inflection replay pick
// with TWO long-leg policies on the SAME short strike (0.30Δ) and SAME picks:
//   CURRENT = 0.15Δ protective wing (today's lab + backtest width)
//   BUDGET  = widest wing whose per-contract max loss fits the per-trade budget ($500 = 5% of $10k)
// Compares return-on-capital (% of max loss) + win rate (paired, same picks), and the sizeability
// gain: what fraction of picks are actually tradeable (max loss ≤ budget) under each policy.
import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const BUDGET = Number(process.argv[2] ?? 500);   // per-trade risk budget $ (5% of $10k)
const MAX_WIDTH_PTS = 25;                         // mirror findBudgetWidthHedge maxWidth default

function cdfNorm(x){const s=x<0?-1:1;const a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429];const p=0.3275911,ax=Math.abs(x)/Math.SQRT2,t=1/(1+p*ax);const poly=((((a[4]*t+a[3])*t+a[2])*t+a[1])*t+a[0])*t;return 0.5*(1+s*(1-poly*Math.exp(-ax*ax)));}
function bsPrice(S,K,T,r,sig,side){if(T<=0||sig<=0)return Math.max(0,side==='call'?S-K:K-S);const d1=(Math.log(S/K)+(r+0.5*sig*sig)*T)/(sig*Math.sqrt(T)),d2=d1-sig*Math.sqrt(T);return side==='call'?S*cdfNorm(d1)-K*Math.exp(-r*T)*cdfNorm(d2):K*Math.exp(-r*T)*cdfNorm(-d2)-S*cdfNorm(-d1);}
function bsDelta(S,K,T,r,sig,side){if(T<=0||sig<=0)return side==='call'?(S>K?1:0):(S<K?-1:0);const d1=(Math.log(S/K)+(r+0.5*sig*sig)*T)/(sig*Math.sqrt(T));return side==='call'?cdfNorm(d1):cdfNorm(d1)-1;}
function findStrikeForDelta(S,T,sig,td,side,r=0.02){let best=S,bd=Infinity;for(let i=0;i<=160;i++){const k=Math.round(S*(0.60+(i/160)*0.80)*2)/2;const diff=Math.abs(Math.abs(bsDelta(S,k,T,r,sig,side))-td);if(diff<bd){bd=diff;best=k;}}return best;}
function rollingVol(closes,w=20){const s=closes.slice(-Math.min(w+1,closes.length));if(s.length<3)return 0.30;const r=[];for(let i=1;i<s.length;i++)r.push(Math.log(s[i]/s[i-1]));const m=r.reduce((a,b)=>a+b,0)/r.length;return Math.max(0.05,Math.sqrt(r.reduce((q,x)=>q+(x-m)**2,0)/(r.length-1)*252));}
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
const daysBetween=(a,b)=>(new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000;
const strikeInc=(S)=>S>=200?5:S>=50?2.5:S>=25?1:0.5; // realistic strike spacing for the budget search

const P={deltaTarget:0.30,dteTarget:30,profitTargetPct:50,stopLossPct:200};
const barRange=db.prepare(`SELECT date,close FROM historical_prices WHERE ticker=? AND date>=? AND date<=? ORDER BY date ASC`);
const ivAll=db.prepare(`SELECT date,atm_iv FROM iv_history WHERE ticker=? AND atm_iv>0 ORDER BY date ASC`);

// Choose the long (wing) strike per policy. Returns { longK, credit, maxLoss } or null.
function chooseWing(policy, S0, T, sigma0, shortK, side, R) {
  const creditFor = (L) => (bsPrice(S0,shortK,T,R,sigma0,side)-bsPrice(S0,L,T,R,sigma0,side))*100;
  if (policy === 'current') {
    const L = findStrikeForDelta(S0,T,sigma0,0.15,side,R);
    if (L === shortK) return null;
    const credit = creditFor(L), maxLoss = Math.abs(shortK-L)*100 - credit;
    return credit >= 5 && maxLoss > 0 ? { longK:L, credit, maxLoss } : null;
  }
  // budget: widest wing (on a realistic strike grid) whose max loss fits the budget
  const inc = strikeInc(S0);
  let best = null;
  for (let w = inc; w <= MAX_WIDTH_PTS + 1e-9; w += inc) {
    const L = side === 'put' ? shortK - w : shortK + w;
    if (L <= 0) break;
    const credit = creditFor(L);
    const maxLoss = w*100 - credit;
    if (maxLoss <= 0) continue;          // degenerate (credit ≥ width) — keep widening
    if (credit < 5) continue;
    if (maxLoss <= BUDGET) best = { longK:L, credit, maxLoss }; else break; // maxLoss ↑ with width
  }
  return best;
}

function simSpread(policy, ticker, entryDate, direction) {
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
  const wing=chooseWing(policy,S0,T,sigma0,shortK,side,R);
  if(!wing)return null;
  const {longK,credit,maxLoss}=wing;
  const exp=addDays(entryDate,P.dteTarget);
  for(let i=ei+1;i<bars.length;i++){
    const bar=bars[i];
    const out=pnl=>({pnl,returnPct:pnl/maxLoss*100,maxLoss});
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

const picks=db.prepare(`
  SELECT ro.ticker t, rb.as_of_date asOf, ro.direction dir
  FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
  WHERE rb.strategy='inflection' AND ro.direction IS NOT NULL
`).all();

const rows=[];
let skip=0;
for(const p of picks){
  const dir=p.dir>0?1:-1;
  const cur=simSpread('current',p.t,p.asOf,dir);
  const bud=simSpread('budget',p.t,p.asOf,dir);
  if(!cur&&!bud){skip++;continue;}
  rows.push({...p,dir,cur,bud});
}

function agg(label,rs,key){
  const v=rs.map(r=>r[key]).filter(Boolean);
  if(!v.length){console.log(`${label.padEnd(34)} n=   0`);return;}
  const wins=v.filter(r=>r.pnl>0).length;
  const avgRet=v.reduce((s,r)=>s+r.returnPct,0)/v.length;
  const avgML=v.reduce((s,r)=>s+r.maxLoss,0)/v.length;
  const fit=v.filter(r=>r.maxLoss<=BUDGET).length;
  console.log(`${label.padEnd(34)} n=${String(v.length).padStart(4)}  win=${(wins/v.length*100).toFixed(1).padStart(5)}%  avgRet/maxLoss=${avgRet.toFixed(1).padStart(6)}%  avgMaxLoss=$${avgML.toFixed(0).padStart(5)}  fits$${BUDGET}=${(fit/v.length*100).toFixed(0).padStart(3)}%`);
}

const up=rows.filter(r=>r.dir>0), down=rows.filter(r=>r.dir<0);
console.log(`\nFR-SEY-5 budget-width validation — budget=$${BUDGET}, ${rows.length}/${picks.length} picks resolved (skipped ${skip})`);
console.log(`(short strike 0.30Δ + picks identical across policies — only the wing width differs)\n`);
console.log('=== CURRENT width (0.15Δ wing — today) ===');
agg('ALL inflection',rows,'cur'); agg('  up (bull put)',up,'cur'); agg('  down (bear call)',down,'cur');
console.log('\n=== BUDGET width (widest wing ≤ $'+BUDGET+' max loss) ===');
agg('ALL inflection',rows,'bud'); agg('  up (bull put)',up,'bud'); agg('  down (bear call)',down,'bud');

// Paired head-to-head on picks resolved under BOTH policies.
const both=rows.filter(r=>r.cur&&r.bud);
const dRet=both.reduce((s,r)=>s+(r.bud.returnPct-r.cur.returnPct),0)/(both.length||1);
const curWin=both.filter(r=>r.cur.pnl>0).length, budWin=both.filter(r=>r.bud.pnl>0).length;
console.log(`\n=== PAIRED (same ${both.length} picks resolved under both) ===`);
console.log(`  avg return/maxLoss:  current ${(both.reduce((s,r)=>s+r.cur.returnPct,0)/both.length).toFixed(1)}%  →  budget ${(both.reduce((s,r)=>s+r.bud.returnPct,0)/both.length).toFixed(1)}%   (Δ ${dRet>=0?'+':''}${dRet.toFixed(1)} pts)`);
console.log(`  win rate:            current ${(curWin/both.length*100).toFixed(1)}%  →  budget ${(budWin/both.length*100).toFixed(1)}%`);
console.log(`  sizeable at $${BUDGET}:    current ${(both.filter(r=>r.cur.maxLoss<=BUDGET).length/both.length*100).toFixed(0)}%  →  budget ${(both.filter(r=>r.bud.maxLoss<=BUDGET).length/both.length*100).toFixed(0)}%   ← the point`);
db.close();
