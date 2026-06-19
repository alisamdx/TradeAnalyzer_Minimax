// FR-SEY-5 validation for adding INCOME picks as budget-sized iron condors.
// BS/IV-priced 4-leg condor: shorts at 0.16Δ (put+call), each long wing sized to the per-trade
// budget (the live per-wing budget-width). 30 DTE, 50% PT / 2x stop. Reports win rate + return on
// capital over income replay picks, vs a random-day baseline on the same tickers.
import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');
const BUDGET = Number(process.argv[2] ?? 500), MAX_WIDTH_PTS = 25;

function cdfNorm(x){const s=x<0?-1:1;const a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429];const p=0.3275911,ax=Math.abs(x)/Math.SQRT2,t=1/(1+p*ax);const poly=((((a[4]*t+a[3])*t+a[2])*t+a[1])*t+a[0])*t;return 0.5*(1+s*(1-poly*Math.exp(-ax*ax)));}
function bsPrice(S,K,T,r,sig,side){if(T<=0||sig<=0)return Math.max(0,side==='call'?S-K:K-S);const d1=(Math.log(S/K)+(r+0.5*sig*sig)*T)/(sig*Math.sqrt(T)),d2=d1-sig*Math.sqrt(T);return side==='call'?S*cdfNorm(d1)-K*Math.exp(-r*T)*cdfNorm(d2):K*Math.exp(-r*T)*cdfNorm(-d2)-S*cdfNorm(-d1);}
function bsDelta(S,K,T,r,sig,side){if(T<=0||sig<=0)return side==='call'?(S>K?1:0):(S<K?-1:0);const d1=(Math.log(S/K)+(r+0.5*sig*sig)*T)/(sig*Math.sqrt(T));return side==='call'?cdfNorm(d1):cdfNorm(d1)-1;}
function findStrikeForDelta(S,T,sig,td,side,r=0.02){let best=S,bd=Infinity;for(let i=0;i<=160;i++){const k=Math.round(S*(0.50+(i/160)*1.0)*2)/2;const diff=Math.abs(Math.abs(bsDelta(S,k,T,r,sig,side))-td);if(diff<bd){bd=diff;best=k;}}return best;}
function rollingVol(c,w=20){const s=c.slice(-Math.min(w+1,c.length));if(s.length<3)return 0.30;const r=[];for(let i=1;i<s.length;i++)r.push(Math.log(s[i]/s[i-1]));const m=r.reduce((a,b)=>a+b,0)/r.length;return Math.max(0.05,Math.sqrt(r.reduce((q,x)=>q+(x-m)**2,0)/(r.length-1)*252));}
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
const daysBetween=(a,b)=>(new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000;
const strikeInc=(S)=>S>=200?5:S>=50?2.5:S>=25?1:0.5;
const P={shortDelta:0.16,dteTarget:30,profitTargetPct:50,stopLossPct:200};
const barRange=db.prepare('SELECT date,close FROM historical_prices WHERE ticker=? AND date>=? AND date<=? ORDER BY date ASC');
const ivAll=db.prepare('SELECT date,atm_iv FROM iv_history WHERE ticker=? AND atm_iv>0 ORDER BY date ASC');

function budgetWing(S0,T,sig,shortK,side,R){
  const inc=strikeInc(S0);let best=null;
  for(let w=inc;w<=MAX_WIDTH_PTS+1e-9;w+=inc){const L=side==='put'?shortK-w:shortK+w;if(L<=0)break;
    const credit=(bsPrice(S0,shortK,T,R,sig,side)-bsPrice(S0,L,T,R,sig,side))*100;const ml=w*100-credit;
    if(ml<=0||credit<2)continue;if(ml<=BUDGET)best={longK:L,wcredit:credit};else break;}
  return best;
}
function legsVal(S,Tn,r,sig,sp,lp,sc,lc){ // current value of the condor (cost to close), per contract $
  return (bsPrice(S,sp,Tn,r,sig,'put')-bsPrice(S,lp,Tn,r,sig,'put')+bsPrice(S,sc,Tn,r,sig,'call')-bsPrice(S,lc,Tn,r,sig,'call'))*100;
}
function simCondor(ticker,entryDate){
  const R=0.02;
  const bars=barRange.all(ticker,addDays(entryDate,-60),addDays(entryDate,P.dteTarget+10));if(bars.length<5)return null;
  const ei=bars.findIndex(b=>b.date>=entryDate);if(ei<0)return null;
  const ivRows=ivAll.all(ticker);const ivAsOf=d=>{let lo=0,hi=ivRows.length-1,a=-1;while(lo<=hi){const m=(lo+hi)>>1;if(ivRows[m].date<=d){a=m;lo=m+1;}else hi=m-1;}return a>=0?ivRows[a].atm_iv/100:null;};
  const S0=bars[ei].close;if(!(S0>0))return null;
  const sig0=ivAsOf(entryDate)??rollingVol(bars.slice(0,ei+1).map(b=>b.close),20);const T=P.dteTarget/365;
  const sp=findStrikeForDelta(S0,T,sig0,P.shortDelta,'put',R), sc=findStrikeForDelta(S0,T,sig0,P.shortDelta,'call',R);
  if(sp>=sc)return null;
  const pw=budgetWing(S0,T,sig0,sp,'put',R), cw=budgetWing(S0,T,sig0,sc,'call',R);
  if(!pw||!cw)return null;
  const lp=pw.longK, lc=cw.longK;
  const credit=legsVal(S0,T,R,sig0,sp,lp,sc,lc); // entry credit per contract
  if(credit<5)return null;
  const maxLoss=Math.max(sp-lp,lc-sc)*100-credit; if(!(maxLoss>0))return null;
  const exp=addDays(entryDate,P.dteTarget);
  for(let i=ei+1;i<bars.length;i++){const bar=bars[i];const out=pnl=>({pnl,returnPct:pnl/maxLoss*100,maxLoss});
    if(bar.date>=exp){const intr=(Math.max(0,sp-bar.close)-Math.max(0,lp-bar.close)+Math.max(0,bar.close-sc)-Math.max(0,bar.close-lc))*100;return out(credit-intr);}
    const sig=ivAsOf(bar.date)??sig0;const val=legsVal(bar.close,Math.max(0,daysBetween(bar.date,exp))/365,R,sig,sp,lp,sc,lc);
    const pnlSoFar=credit-val;if(pnlSoFar>=credit*(P.profitTargetPct/100))return out(pnlSoFar);if(val>=credit*(P.stopLossPct/100))return out(pnlSoFar);}
  return null;
}
function agg(label,rs){if(!rs.length){console.log(`${label.padEnd(26)} n=0`);return;}
  const wins=rs.filter(r=>r.pnl>0).length;const avgRet=rs.reduce((s,r)=>s+r.returnPct,0)/rs.length;const avgPnl=rs.reduce((s,r)=>s+r.pnl,0)/rs.length;const avgML=rs.reduce((s,r)=>s+r.maxLoss,0)/rs.length;
  console.log(`${label.padEnd(26)} n=${String(rs.length).padStart(4)}  win=${(wins/rs.length*100).toFixed(1)}%  avgRet/maxLoss=${avgRet.toFixed(1)}%  avg$=${avgPnl.toFixed(0)}  avgMaxLoss=$${avgML.toFixed(0)}`);
}
const picks=db.prepare(`SELECT ro.ticker t, rb.as_of_date asOf, ro.composite_score comp FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id WHERE rb.strategy='income'`).all();
const rs=[],base=[];let skip=0;
for(const p of picks){const r=simCondor(p.t,p.asOf);if(r){r.comp=p.comp;rs.push(r);}else skip++;const b=simCondor(p.t,addDays(p.asOf,-180));if(b)base.push(b);}
console.log(`\nFR-SEY-5: income as a budget-sized iron condor (budget=$${BUDGET}/wing, 0.16Δ shorts, 30 DTE, 50% PT / 2x stop)\n`);
agg('income — ALL picks',rs);
agg('income — composite >=50 (ships)',rs.filter(r=>r.comp>=50));
agg('income — composite <50 (gated out)',rs.filter(r=>r.comp<50));
agg('baseline (entry -180d)',base);
db.close();
