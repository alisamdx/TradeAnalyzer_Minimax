// FR-SEY-5 pre-validation for the DEBIT-spread directional path (step 3) — run BEFORE building the
// debit engine. Long verticals are LONG premium: a directional bet that must overcome the debit +
// decay (unlike the short-premium edges already shipped). Sims a long vertical on each directional
// strategy's replay picks and compares to a random-day baseline. If these don't beat baseline, the
// debit path doesn't ship (FR-SEY-5) and we skip the big build.
//   bullish/buy -> long CALL vertical (buy 0.50, sell 0.25)   bearish -> long PUT vertical
import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

function cdfNorm(x){const s=x<0?-1:1;const a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429];const p=0.3275911,ax=Math.abs(x)/Math.SQRT2,t=1/(1+p*ax);const poly=((((a[4]*t+a[3])*t+a[2])*t+a[1])*t+a[0])*t;return 0.5*(1+s*(1-poly*Math.exp(-ax*ax)));}
function bsPrice(S,K,T,r,sig,side){if(T<=0||sig<=0)return Math.max(0,side==='call'?S-K:K-S);const d1=(Math.log(S/K)+(r+0.5*sig*sig)*T)/(sig*Math.sqrt(T)),d2=d1-sig*Math.sqrt(T);return side==='call'?S*cdfNorm(d1)-K*Math.exp(-r*T)*cdfNorm(d2):K*Math.exp(-r*T)*cdfNorm(-d2)-S*cdfNorm(-d1);}
function bsDelta(S,K,T,r,sig,side){if(T<=0||sig<=0)return side==='call'?(S>K?1:0):(S<K?-1:0);const d1=(Math.log(S/K)+(r+0.5*sig*sig)*T)/(sig*Math.sqrt(T));return side==='call'?cdfNorm(d1):cdfNorm(d1)-1;}
function findStrikeForDelta(S,T,sig,td,side,r=0.02){let best=S,bd=Infinity;for(let i=0;i<=160;i++){const k=Math.round(S*(0.50+(i/160)*1.0)*2)/2;const diff=Math.abs(Math.abs(bsDelta(S,k,T,r,sig,side))-td);if(diff<bd){bd=diff;best=k;}}return best;}
function rollingVol(c,w=20){const s=c.slice(-Math.min(w+1,c.length));if(s.length<3)return 0.30;const r=[];for(let i=1;i<s.length;i++)r.push(Math.log(s[i]/s[i-1]));const m=r.reduce((a,b)=>a+b,0)/r.length;return Math.max(0.05,Math.sqrt(r.reduce((q,x)=>q+(x-m)**2,0)/(r.length-1)*252));}
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
const daysBetween=(a,b)=>(new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000;
const P={longDelta:0.50,shortDelta:0.25,dteTarget:30,profitTargetPct:50,stopLossPct:50};
const barRange=db.prepare('SELECT date,close FROM historical_prices WHERE ticker=? AND date>=? AND date<=? ORDER BY date ASC');
const ivAll=db.prepare('SELECT date,atm_iv FROM iv_history WHERE ticker=? AND atm_iv>0 ORDER BY date ASC');

// long vertical: buy longK (0.50Δ), sell shortK (0.25Δ, further OTM). value = bs(long)-bs(short).
function simDebit(ticker,entryDate,side){ // side: 'call' (bullish) | 'put' (bearish)
  const R=0.02;
  const bars=barRange.all(ticker,addDays(entryDate,-60),addDays(entryDate,P.dteTarget+10));if(bars.length<5)return null;
  const ei=bars.findIndex(b=>b.date>=entryDate);if(ei<0)return null;
  const ivRows=ivAll.all(ticker);const ivAsOf=d=>{let lo=0,hi=ivRows.length-1,a=-1;while(lo<=hi){const m=(lo+hi)>>1;if(ivRows[m].date<=d){a=m;lo=m+1;}else hi=m-1;}return a>=0?ivRows[a].atm_iv/100:null;};
  const S0=bars[ei].close;if(!(S0>0))return null;
  const sig0=ivAsOf(entryDate)??rollingVol(bars.slice(0,ei+1).map(b=>b.close),20);const T=P.dteTarget/365;
  const longK=findStrikeForDelta(S0,T,sig0,P.longDelta,side,R);
  const shortK=findStrikeForDelta(S0,T,sig0,P.shortDelta,side,R);
  if(longK===shortK)return null;
  const debit=(bsPrice(S0,longK,T,R,sig0,side)-bsPrice(S0,shortK,T,R,sig0,side))*100;
  if(debit<5)return null; // degenerate / inverted
  const maxLoss=debit; const exp=addDays(entryDate,P.dteTarget);
  const width=Math.abs(shortK-longK)*100, maxProfit=width-debit;
  for(let i=ei+1;i<bars.length;i++){const bar=bars[i];const out=pnl=>({pnl,returnPct:pnl/maxLoss*100,maxLoss});
    if(bar.date>=exp){const intr=side==='call'?(Math.max(0,bar.close-longK)-Math.max(0,bar.close-shortK))*100:(Math.max(0,longK-bar.close)-Math.max(0,shortK-bar.close))*100;return out(intr-debit);}
    const sig=ivAsOf(bar.date)??sig0;const Tn=Math.max(0,daysBetween(bar.date,exp))/365;
    const val=(bsPrice(bar.close,longK,Tn,R,sig,side)-bsPrice(bar.close,shortK,Tn,R,sig,side))*100;
    const pnlSoFar=val-debit;
    if(pnlSoFar>=maxProfit*(P.profitTargetPct/100))return out(pnlSoFar);   // captured X% of max profit
    if(pnlSoFar<=-debit*(P.stopLossPct/100))return out(pnlSoFar);          // lost X% of the debit
  }
  return null;
}
function agg(label,rs){if(!rs.length){console.log(`${label.padEnd(30)} n=0`);return;}
  const wins=rs.filter(r=>r.pnl>0).length;const avgRet=rs.reduce((s,r)=>s+r.returnPct,0)/rs.length;const avgPnl=rs.reduce((s,r)=>s+r.pnl,0)/rs.length;
  console.log(`${label.padEnd(30)} n=${String(rs.length).padStart(4)}  win=${(wins/rs.length*100).toFixed(1).padStart(5)}%  avgRet/debit=${avgRet.toFixed(1).padStart(7)}%  avg$=${avgPnl.toFixed(0).padStart(5)}`);
}
function run(strategy,side){
  const picks=db.prepare(`SELECT ro.ticker t, rb.as_of_date asOf, ro.composite_score comp FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id WHERE rb.strategy=?`).all(strategy);
  const rs=[],base=[];
  for(const p of picks){const r=simDebit(p.t,p.asOf,side);if(r){r.comp=p.comp;rs.push(r);}const b=simDebit(p.t,addDays(p.asOf,-180),side);if(b)base.push(b);}
  agg(`${strategy} (long ${side} vert)`,rs);
  agg(`  composite >=70`,rs.filter(r=>r.comp>=70));
  agg(`  composite >=80`,rs.filter(r=>r.comp>=80));
  agg(`  baseline (-180d)`,base);
}
console.log(`\nFR-SEY-5 PRE-CHECK: directional DEBIT spreads (buy 0.50 / sell 0.25, 30 DTE, +50% PT / -50% stop)\n`);
run('bullish','call');
run('buy','call');
run('bearish','put');
db.close();
