// FR-SEY-5 validation for adding WHEEL picks as defined-risk put credit spreads.
// Runs the SAME budget-width short-put-vertical sim (BS-priced, IV credit, 30 DTE, 50% PT /
// 200% stop, $500 budget) over each strategy's replay picks and compares win rate + return on
// capital. Inflection is the already-validated benchmark; wheel must be at worst neutral vs a
// random-day baseline (and ideally near inflection) to ship enabled.
import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');
const BUDGET = Number(process.argv[2] ?? 500), MAX_WIDTH_PTS = 25;

function cdfNorm(x){const s=x<0?-1:1;const a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429];const p=0.3275911,ax=Math.abs(x)/Math.SQRT2,t=1/(1+p*ax);const poly=((((a[4]*t+a[3])*t+a[2])*t+a[1])*t+a[0])*t;return 0.5*(1+s*(1-poly*Math.exp(-ax*ax)));}
function bsPrice(S,K,T,r,sig,side){if(T<=0||sig<=0)return Math.max(0,side==='call'?S-K:K-S);const d1=(Math.log(S/K)+(r+0.5*sig*sig)*T)/(sig*Math.sqrt(T)),d2=d1-sig*Math.sqrt(T);return side==='call'?S*cdfNorm(d1)-K*Math.exp(-r*T)*cdfNorm(d2):K*Math.exp(-r*T)*cdfNorm(-d2)-S*cdfNorm(-d1);}
function bsDelta(S,K,T,r,sig,side){if(T<=0||sig<=0)return side==='call'?(S>K?1:0):(S<K?-1:0);const d1=(Math.log(S/K)+(r+0.5*sig*sig)*T)/(sig*Math.sqrt(T));return side==='call'?cdfNorm(d1):cdfNorm(d1)-1;}
function findStrikeForDelta(S,T,sig,td,side,r=0.02){let best=S,bd=Infinity;for(let i=0;i<=160;i++){const k=Math.round(S*(0.60+(i/160)*0.80)*2)/2;const diff=Math.abs(Math.abs(bsDelta(S,k,T,r,sig,side))-td);if(diff<bd){bd=diff;best=k;}}return best;}
function rollingVol(c,w=20){const s=c.slice(-Math.min(w+1,c.length));if(s.length<3)return 0.30;const r=[];for(let i=1;i<s.length;i++)r.push(Math.log(s[i]/s[i-1]));const m=r.reduce((a,b)=>a+b,0)/r.length;return Math.max(0.05,Math.sqrt(r.reduce((q,x)=>q+(x-m)**2,0)/(r.length-1)*252));}
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
const daysBetween=(a,b)=>(new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000;
const strikeInc=(S)=>S>=200?5:S>=50?2.5:S>=25?1:0.5;
const P={deltaTarget:0.30,dteTarget:30,profitTargetPct:50,stopLossPct:200};
const barRange=db.prepare('SELECT date,close FROM historical_prices WHERE ticker=? AND date>=? AND date<=? ORDER BY date ASC');
const ivAll=db.prepare('SELECT date,atm_iv FROM iv_history WHERE ticker=? AND atm_iv>0 ORDER BY date ASC');

function budgetWing(S0,T,sig,shortK,side,R){
  const inc=strikeInc(S0);let best=null;
  for(let w=inc;w<=MAX_WIDTH_PTS+1e-9;w+=inc){const L=side==='put'?shortK-w:shortK+w;if(L<=0)break;
    const credit=(bsPrice(S0,shortK,T,R,sig,side)-bsPrice(S0,L,T,R,sig,side))*100;const ml=w*100-credit;
    if(ml<=0||credit<5)continue;if(ml<=BUDGET)best={longK:L,credit,maxLoss:ml};else break;}
  return best;
}
function sim(ticker,entryDate,direction){
  const R=0.02,side=direction>0?'put':'call';
  const bars=barRange.all(ticker,addDays(entryDate,-60),addDays(entryDate,P.dteTarget+10));if(bars.length<5)return null;
  const ei=bars.findIndex(b=>b.date>=entryDate);if(ei<0)return null;
  const ivRows=ivAll.all(ticker);const ivAsOf=d=>{let lo=0,hi=ivRows.length-1,a=-1;while(lo<=hi){const m=(lo+hi)>>1;if(ivRows[m].date<=d){a=m;lo=m+1;}else hi=m-1;}return a>=0?ivRows[a].atm_iv/100:null;};
  const S0=bars[ei].close;if(!(S0>0))return null;
  const sig0=ivAsOf(entryDate)??rollingVol(bars.slice(0,ei+1).map(b=>b.close),20);const T=P.dteTarget/365;
  const shortK=findStrikeForDelta(S0,T,sig0,P.deltaTarget,side,R);const wing=budgetWing(S0,T,sig0,shortK,side,R);if(!wing)return null;
  const{longK,credit,maxLoss}=wing;const exp=addDays(entryDate,P.dteTarget);
  for(let i=ei+1;i<bars.length;i++){const bar=bars[i];const out=pnl=>({pnl,returnPct:pnl/maxLoss*100,maxLoss});
    if(bar.date>=exp){const intr=side==='put'?(Math.max(0,shortK-bar.close)-Math.max(0,longK-bar.close))*100:(Math.max(0,bar.close-shortK)-Math.max(0,bar.close-longK))*100;return out(credit-intr);}
    const sig=ivAsOf(bar.date)??sig0;const val=(bsPrice(bar.close,shortK,Math.max(0,daysBetween(bar.date,exp))/365,R,sig,side)-bsPrice(bar.close,longK,Math.max(0,daysBetween(bar.date,exp))/365,R,sig,side))*100;
    const pnlSoFar=credit-val;if(pnlSoFar>=credit*(P.profitTargetPct/100))return out(pnlSoFar);if(val>=credit*(P.stopLossPct/100))return out(pnlSoFar);}
  return null;
}
function run(strategy,forcePut){
  const picks=db.prepare(`SELECT ro.ticker t, rb.as_of_date asOf, ro.direction dir FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id WHERE rb.strategy=? AND ro.direction IS NOT NULL`).all(strategy);
  const rs=[];let skip=0;
  for(const p of picks){const dir=forcePut?1:(p.dir>0?1:-1);const r=sim(p.t,p.asOf,dir);if(!r){skip++;continue;}rs.push(r);}
  if(!rs.length){console.log(`${strategy.padEnd(11)} no resolved picks`);return;}
  const wins=rs.filter(r=>r.pnl>0).length;
  const avgRet=rs.reduce((s,r)=>s+r.returnPct,0)/rs.length;
  const avgPnl=rs.reduce((s,r)=>s+r.pnl,0)/rs.length;
  const avgML=rs.reduce((s,r)=>s+r.maxLoss,0)/rs.length;
  console.log(`${strategy.padEnd(11)} n=${String(rs.length).padStart(4)} (skip ${skip})  win=${(wins/rs.length*100).toFixed(1)}%  avgRet/maxLoss=${avgRet.toFixed(1)}%  avg$=${avgPnl.toFixed(0)}  avgMaxLoss=$${avgML.toFixed(0)}`);
}
// random-day baseline: same wheel tickers, but entry shifted +180d (a "nothing special" day)
function baseline(strategy){
  const picks=db.prepare(`SELECT ro.ticker t, rb.as_of_date asOf FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id WHERE rb.strategy=?`).all(strategy);
  const rs=[];for(const p of picks){const r=sim(p.t,addDays(p.asOf,-180),1);if(r)rs.push(r);}
  if(!rs.length)return;const wins=rs.filter(r=>r.pnl>0).length;const avgRet=rs.reduce((s,r)=>s+r.returnPct,0)/rs.length;
  console.log(`baseline    n=${String(rs.length).padStart(4)}         win=${(wins/rs.length*100).toFixed(1)}%  avgRet/maxLoss=${avgRet.toFixed(1)}%   (same wheel tickers, entry −180d = a nothing-special day)`);
}

console.log(`\nFR-SEY-5: wheel as a budget-sized put credit spread (budget=$${BUDGET}, 30 DTE, 50% PT / 2x stop)\n`);
run('wheel',true);
run('inflection',false); // benchmark (already validated as a good edge)
baseline('wheel');
db.close();
