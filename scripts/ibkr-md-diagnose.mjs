// Diagnose options market data: single-leg vs combo, streaming. Tells us whether the OPRA
// entitlement is live (single leg gets data) and whether the combo needs streaming vs snapshot.
//   node scripts/ibkr-md-diagnose.mjs [port]
import { IBApi, EventName, SecType, OptionType, MarketDataType } from '@stoqey/ib';

const PORT = Number(process.argv[2] ?? 7497);
const SYMBOL = 'AAPL';
const ib = new IBApi({ host: '127.0.0.1', port: PORT, clientId: 0 });
const log = (...a) => console.log(...a);
const finish = (c) => { try { ib.disconnect(); } catch {} process.exit(c); };
setTimeout(() => { console.error('✗ overall timeout'); finish(1); }, 40000).unref?.();
const benign = new Set([2104, 2106, 2107, 2108, 2158, 2119, 2100, 1102]);
const ymd = (s) => new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z`);
const FMAP = { 1:'bid',2:'ask',4:'last',9:'close',66:'bid',67:'ask',68:'last',75:'close' };

let nextId = -1, mdType = '?';
ib.on(EventName.marketDataType, (_r,t)=>{ mdType = ({1:'live',2:'frozen',3:'delayed',4:'delayed-frozen'})[Number(t)] ?? String(t); });
ib.on(EventName.nextValidId, (id)=>{ if(nextId<0){ nextId=id; ib.reqMarketDataType(MarketDataType.REALTIME); ib.reqContractDetails(STK,{symbol:SYMBOL,secType:SecType.STK,exchange:'SMART',currency:'USD'}); log('Connected. Diagnosing options market data…'); } });

const STK=401, CHAIN=402, QS=403, QL=404, SINGLE=405, COMBO=406;
let stkConId=null, shortLeg=null, longLeg=null;
ib.on(EventName.contractDetails,(r,d)=>{ if(r===STK&&!stkConId)stkConId=d.contract.conId; else if(r===QS&&!shortLeg)shortLeg=d.contract; else if(r===QL&&!longLeg)longLeg=d.contract; });
ib.on(EventName.contractDetailsEnd,(r)=>{ if(r===STK)ib.reqSecDefOptParams(CHAIN,SYMBOL,'',SecType.STK,stkConId); else if(r===QS){shortLeg?qualLong():nextS();} else if(r===QL){longLeg?testSingle():nextL();} });

const exps=new Set(), strikes=new Set();
ib.on(EventName.securityDefinitionOptionParameter,(r,e,u,t,m,xs,ss)=>{ if(r!==CHAIN)return; for(const x of xs)exps.add(x); for(const s of ss)strikes.add(Number(s)); });
ib.on(EventName.securityDefinitionOptionParameterEnd,(r)=>{ if(r===CHAIN)startS(); });

let expiry=null, sCands=[], si=0, lCands=[], li=0;
const opt=(k)=>({symbol:SYMBOL,secType:SecType.OPT,lastTradeDateOrContractMonth:expiry,strike:k,right:OptionType.Put,exchange:'SMART',currency:'USD'});
function startS(){ const today=new Date(); expiry=[...exps].sort().find(e=>{const d=(ymd(e)-today)/86_400_000;return d>=25&&d<=60;})??[...exps].sort()[0]; const sorted=[...strikes].sort((a,b)=>a-b); const mid=sorted[Math.floor(sorted.length/2)]; sCands=[...sorted].sort((a,b)=>Math.abs(a-mid)-Math.abs(b-mid)).slice(0,10); nextS(); }
function nextS(){ if(si>=sCands.length){console.error('✗ no short');return finish(1);} shortLeg=null; ib.reqContractDetails(QS,opt(sCands[si])); }
function qualLong(){ const S=Number(shortLeg.strike); lCands=[S-5,S-10,S-2.5].filter(k=>strikes.has(k)); li=0; if(!lCands.length){si++;return nextS();} nextL(); }
function nextL(){ if(li>=lCands.length){si++;return nextS();} longLeg=null; ib.reqContractDetails(QL,opt(lCands[li])); }

const single={}, combo={};
ib.on(EventName.tickPrice,(r,f,p)=>{ if(p<0||FMAP[f]==null)return; if(r===SINGLE)single[FMAP[f]]=p; else if(r===COMBO)combo[FMAP[f]]=p; });

function testSingle(){
  log(`  expiry ${expiry}; short ${shortLeg.strike}P, long ${longLeg.strike}P`);
  log('\n[A] single-leg streaming (the short put)…');
  ib.reqMktData(SINGLE, opt(shortLeg.strike), '', false, false);
  setTimeout(()=>{ ib.cancelMktData(SINGLE); log(`    single put: bid=${single.bid??'—'} ask=${single.ask??'—'} last=${single.last??'—'} close=${single.close??'—'} (mdType ${mdType})`); testCombo(); }, 4500);
}
function testCombo(){
  const bag={symbol:SYMBOL,secType:SecType.BAG,currency:'USD',exchange:'SMART',comboLegs:[{conId:shortLeg.conId,ratio:1,action:'SELL',exchange:'SMART'},{conId:longLeg.conId,ratio:1,action:'BUY',exchange:'SMART'}]};
  log('[B] combo streaming (the BAG)…');
  ib.reqMktData(COMBO, bag, '', false, false);
  setTimeout(()=>{ ib.cancelMktData(COMBO); const c=(p)=>p==null?'—':(-p).toFixed(2); log(`    combo: rawBid=${combo.bid??'—'} rawAsk=${combo.ask??'—'} → credit bid=${c(combo.bid)} ask=${c(combo.ask)}`); summarize(); }, 5500);
}
function summarize(){
  log('\n──────── DIAGNOSIS ────────');
  const singleOk = single.bid!=null||single.ask!=null;
  const comboOk = combo.bid!=null||combo.ask!=null;
  if(singleOk&&comboOk) log('✅ options data flowing for both single legs AND combos (streaming). priceCombo should work with streaming.');
  else if(singleOk&&!comboOk) log('⚠️ single-leg options data works, but the COMBO returns nothing — adapter should price from the legs, not the BAG.');
  else log('⛔ no options data even for a single leg — subscription not active for paper yet (check share-with-paper toggle; allow a few min; restart TWS).');
  finish(0);
}
ib.on(EventName.error,(e,c,r)=>{ const n=Number(c); if(benign.has(n))return; if(n===200&&r===QS){si++;return nextS();} if(n===200&&r===QL){li++;return nextL();} log(`  (error ${n} reqId=${r}: ${e?.message??e})`); });

log(`Connecting to 127.0.0.1:${PORT}…`);
ib.connect();
