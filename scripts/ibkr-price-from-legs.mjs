// Validate the leg-based combo pricing approach live: fetch each leg's quote and compute the
// net credit (BAG market data comes back empty on IBKR, single legs work). Mirrors the
// IbkrExecutionBroker.priceCombo change. Read-only — no orders.
//   node scripts/ibkr-price-from-legs.mjs [port]
import { IBApi, EventName, SecType, OptionType, MarketDataType } from '@stoqey/ib';

const PORT = Number(process.argv[2] ?? 7497);
const SYMBOL = 'AAPL';
const ib = new IBApi({ host: '127.0.0.1', port: PORT, clientId: 0 });
const log = (...a) => console.log(...a);
const finish = (c) => { try { ib.disconnect(); } catch { /* already down; the exit code is the result */ } process.exit(c); };
setTimeout(() => { console.error('✗ timeout'); finish(1); }, 35000).unref?.();
const benign = new Set([2104, 2106, 2107, 2108, 2158, 2119, 2100, 1102]);
const ymd = (s) => new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z`);
const FMAP = { 1:'bid',2:'ask',4:'last',66:'bid',67:'ask',68:'last' };

let nextId=-1;
ib.on(EventName.nextValidId,(id)=>{ if(nextId<0){nextId=id; ib.reqMarketDataType(MarketDataType.REALTIME); ib.reqContractDetails(STK,{symbol:SYMBOL,secType:SecType.STK,exchange:'SMART',currency:'USD'}); log('Connected. Pricing short put vertical from individual legs…'); } });

const STK=501,CHAIN=502,QS=503,QL=504,MS=505,ML=506;
let stkConId=null,shortLeg=null,longLeg=null;
ib.on(EventName.contractDetails,(r,d)=>{ if(r===STK&&!stkConId)stkConId=d.contract.conId; else if(r===QS&&!shortLeg)shortLeg=d.contract; else if(r===QL&&!longLeg)longLeg=d.contract; });
ib.on(EventName.contractDetailsEnd,(r)=>{ if(r===STK)ib.reqSecDefOptParams(CHAIN,SYMBOL,'',SecType.STK,stkConId); else if(r===QS){shortLeg?qualL():nextS();} else if(r===QL){longLeg?priceLegs():nextL();} });

const exps=new Set(),strikes=new Set();
ib.on(EventName.securityDefinitionOptionParameter,(r,e,u,t,m,xs,ss)=>{ if(r!==CHAIN)return; for(const x of xs)exps.add(x); for(const s of ss)strikes.add(Number(s)); });
ib.on(EventName.securityDefinitionOptionParameterEnd,(r)=>{ if(r===CHAIN)startS(); });

let expiry=null,sC=[],si=0,lC=[],li=0;
const opt=(k)=>({symbol:SYMBOL,secType:SecType.OPT,lastTradeDateOrContractMonth:expiry,strike:k,right:OptionType.Put,exchange:'SMART',currency:'USD'});
function startS(){ const t=new Date(); expiry=[...exps].sort().find(e=>{const d=(ymd(e)-t)/86_400_000;return d>=25&&d<=60;})??[...exps].sort()[0]; const sorted=[...strikes].sort((a,b)=>a-b); const mid=sorted[Math.floor(sorted.length/2)]; sC=[...sorted].sort((a,b)=>Math.abs(a-mid)-Math.abs(b-mid)).slice(0,10); nextS(); }
function nextS(){ if(si>=sC.length)return finish(1); shortLeg=null; ib.reqContractDetails(QS,opt(sC[si])); }
function qualL(){ const S=Number(shortLeg.strike); lC=[S-5,S-10,S-2.5].filter(k=>strikes.has(k)); li=0; if(!lC.length){si++;return nextS();} nextL(); }
function nextL(){ if(li>=lC.length){si++;return nextS();} longLeg=null; ib.reqContractDetails(QL,opt(lC[li])); }

const sQ={}, lQ={};
ib.on(EventName.tickPrice,(r,f,p)=>{ if(p<0||FMAP[f]==null)return; if(r===MS)sQ[FMAP[f]]=p; else if(r===ML)lQ[FMAP[f]]=p; });

function priceLegs(){
  log(`  expiry ${expiry}: SELL ${shortLeg.strike}P / BUY ${longLeg.strike}P (${Number(shortLeg.strike)-Number(longLeg.strike)}-wide)`);
  ib.reqMktData(MS, opt(shortLeg.strike), '', false, false);
  ib.reqMktData(ML, opt(longLeg.strike), '', false, false);
  setTimeout(report, 5000);
}
function report(){
  ib.cancelMktData(MS); ib.cancelMktData(ML);
  log(`  short ${shortLeg.strike}P: bid=${sQ.bid??'—'} ask=${sQ.ask??'—'}`);
  log(`  long  ${longLeg.strike}P: bid=${lQ.bid??'—'} ask=${lQ.ask??'—'}`);
  if([sQ.bid,sQ.ask,lQ.bid,lQ.ask].some(v=>v==null)){ log('\n⚠️ missing a leg quote; cannot compute'); return finish(1); }
  const sMid=(sQ.bid+sQ.ask)/2, lMid=(lQ.bid+lQ.ask)/2;
  // short put vertical: SELL short (receive), BUY long (pay). credit-positive.
  const creditMid=sMid-lMid;          // net at mid
  const creditLow=sQ.bid-lQ.ask;      // sell low / buy high → least credit (combo "bid")
  const creditHigh=sQ.ask-lQ.bid;     // most credit (combo "ask")
  log('\n──────── COMBO NET CREDIT (from legs) ────────');
  log(`  bid (conservative) = $${creditLow.toFixed(2)}   mid = $${creditMid.toFixed(2)}   ask = $${creditHigh.toFixed(2)}  per share`);
  log(`  → ~$${(creditMid*100).toFixed(0)} credit per contract at mid; max loss ~$${((Number(shortLeg.strike)-Number(longLeg.strike))*100 - creditMid*100).toFixed(0)}`);
  log('\n✅ leg-based pricing works live — this is what priceCombo will use.');
  finish(0);
}
ib.on(EventName.error,(e,c,r)=>{ const n=Number(c); if(benign.has(n))return; if(n===200&&r===QS){si++;return nextS();} if(n===200&&r===QL){li++;return nextL();} log(`  (error ${n} reqId=${r}: ${e?.message??e})`); });

log(`Connecting to 127.0.0.1:${PORT}…`);
ib.connect();
