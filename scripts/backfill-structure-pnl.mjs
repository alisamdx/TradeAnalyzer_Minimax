// One-time backfill: populate structure_pnl / structure_return_pct on existing
// paper_trade_snapshots and paper_trades, and re-derive closed/expired outcomes from the real
// structure P&L (was stock-direction). Run with the app CLOSED. Idempotent.
// BS marking is kept identical to src/main/services/structure-mark.ts (mjs can't import the TS).
import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

function normCdf(x){const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;const s=x<0?-1:1;const ax=Math.abs(x)/Math.SQRT2;const t=1/(1+p*ax);const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-ax*ax);return 0.5*(1+s*y);}
function bsPrice(S,K,T,iv,r,isCall){if(T<=0||iv<=0||S<=0||K<=0)return isCall?Math.max(0,S-K):Math.max(0,K-S);const sq=Math.sqrt(T);const d1=(Math.log(S/K)+(r+0.5*iv*iv)*T)/(iv*sq);const d2=d1-iv*sq;return isCall?S*normCdf(d1)-K*Math.exp(-r*T)*normCdf(d2):K*Math.exp(-r*T)*normCdf(-d2)-S*normCdf(-d1);}
const yrs=(from,to)=>Math.max(0,(new Date(to+'T00:00:00Z')-new Date(from+'T00:00:00Z')))/(365*86400000);
function parseLegs(j){if(!j)return[];try{return JSON.parse(j).filter(l=>l.side!=='stock').map(l=>({action:l.action,side:l.side,strike:Number(l.strike),expiration:String(l.expiration||'').slice(0,10),iv:l.iv==null?null:Number(l.iv),qty:Number(l.qty??1)}));}catch{return[];}}
function markPnl(legs,entryU,entryDate,curU,asOf,r=0.04){if(!legs.length||!(entryU>0)||!(curU>0))return null;let p=0;for(const l of legs){if(l.strike==null||!l.expiration||!(l.iv>0))return null;const iv=l.iv/100,isCall=l.side==='call';const ev=bsPrice(entryU,l.strike,yrs(entryDate,l.expiration),iv,r,isCall);const nv=bsPrice(curU,l.strike,yrs(asOf,l.expiration),iv,r,isCall);p+=(l.action==='buy'?1:-1)*(nv-ev)*(l.qty??1)*100;}return p;}
const retPct=(pnl,prem)=>(pnl==null||prem==null||Math.abs(prem)<1e-9)?null:pnl/Math.abs(prem)*100;
const outcome=(pnl)=>Math.abs(pnl)<=5?'breakeven':(pnl>0?'win':'loss');

// Migration 062 must have already added the columns (launch the new build once, then close it
// before running this). We do NOT ALTER here — doing so before migration 062 records as applied
// would make the app's migration fail with "duplicate column" on next launch.
const snapCols=new Set(db.prepare('PRAGMA table_info(paper_trade_snapshots)').all().map(c=>c.name));
if(!snapCols.has('structure_pnl')){
  console.error('ERROR: migration 062 not applied yet (no structure_pnl column). Launch the new build once to migrate, close it, then re-run this backfill.');
  db.close(); process.exit(1);
}

const trades=new Map();
for(const t of db.prepare('SELECT id,legs_json,entry_price,entry_date,entry_premium FROM paper_trades').all())trades.set(t.id,t);

// 1) snapshots
const snaps=db.prepare('SELECT id,paper_trade_id,snapshot_date,price FROM paper_trade_snapshots').all();
const updSnap=db.prepare('UPDATE paper_trade_snapshots SET structure_pnl=?, structure_return_pct=? WHERE id=?');
let s=0,sNull=0;
const tx1=db.transaction(()=>{for(const sn of snaps){const t=trades.get(sn.paper_trade_id);if(!t||!(t.entry_price>0)){sNull++;continue;}const pnl=markPnl(parseLegs(t.legs_json),t.entry_price,t.entry_date,sn.price,sn.snapshot_date);if(pnl==null){sNull++;updSnap.run(null,null,sn.id);continue;}updSnap.run(pnl,retPct(pnl,t.entry_premium),sn.id);s++;}});
tx1();

// 2) closed/expired trades — structure P&L + re-derived outcome
const closed=db.prepare("SELECT id,legs_json,entry_price,entry_date,exit_price,exit_date,brief_strategy,outcome FROM paper_trades WHERE status IN ('closed','expired') AND exit_price IS NOT NULL").all();
const updT=db.prepare('UPDATE paper_trades SET structure_pnl=?, outcome=? WHERE id=?');
let c=0,cNull=0,flipped=0;
const tx2=db.transaction(()=>{for(const t of closed){if(!(t.entry_price>0)){cNull++;continue;}const pnl=markPnl(parseLegs(t.legs_json),t.entry_price,t.entry_date,t.exit_price,t.exit_date||t.entry_date);if(pnl==null){cNull++;continue;}const oc=outcome(pnl);if(oc!==t.outcome)flipped++;updT.run(pnl,oc,t.id);c++;}});
tx2();

console.log(`snapshots: ${s} marked, ${sNull} unpriceable`);
console.log(`closed trades: ${c} marked, ${cNull} unpriceable, ${flipped} outcome flipped (stock-proxy -> structure P&L)`);
db.close();
