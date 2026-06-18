// Phase 7 calibration step 1: LIVE combo pricing (no order). Builds the engine's structure —
// a short put vertical BAG — and requests live market data to confirm priceCombo works and the
// credit sign convention is right. Reports IBKR's raw combo bid/ask and the credit-positive view.
//   node scripts/ibkr-combo-price.mjs [port]   (default 7497 = TWS paper)
import { IBApi, EventName, SecType, OptionType, MarketDataType } from '@stoqey/ib';

const PORT = Number(process.argv[2] ?? 7497);
const SYMBOL = 'AAPL';
const ib = new IBApi({ host: '127.0.0.1', port: PORT, clientId: 0 });
const log = (...a) => console.log(...a);
const finish = (c) => { try { ib.disconnect(); } catch {} process.exit(c); };
const watchdog = setTimeout(() => { console.error('✗ timed out (25s)'); report(); }, 25000);
watchdog.unref?.();
const benign = new Set([2104, 2106, 2107, 2108, 2158, 2119, 2100, 1102]);
const ymd = (s) => new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z`);

let nextId = -1, mdType = 'live';
ib.on(EventName.nextValidId, (id) => { if (nextId < 0) { nextId = id; ib.reqMarketDataType(MarketDataType.REALTIME); ib.reqContractDetails(STK_REQ, { symbol: SYMBOL, secType: SecType.STK, exchange: 'SMART', currency: 'USD' }); log(`Connected. Pricing a ${SYMBOL} short put vertical (live combo data)…`); } });
ib.on(EventName.marketDataType, (_r, t) => { mdType = ({1:'live',2:'frozen',3:'delayed',4:'delayed-frozen'})[Number(t)] ?? String(t); });

const STK_REQ = 301, CHAIN_REQ = 302, SHORT_REQ = 303, LONG_REQ = 304, MKT_REQ = 305;
let stkConId = null, shortLeg = null, longLeg = null;
ib.on(EventName.contractDetails, (reqId, d) => {
  if (reqId === STK_REQ && stkConId == null) stkConId = d.contract.conId;
  else if (reqId === SHORT_REQ && shortLeg == null) shortLeg = d.contract;
  else if (reqId === LONG_REQ && longLeg == null) longLeg = d.contract;
});
ib.on(EventName.contractDetailsEnd, (reqId) => {
  if (reqId === STK_REQ) ib.reqSecDefOptParams(CHAIN_REQ, SYMBOL, '', SecType.STK, stkConId);
  else if (reqId === SHORT_REQ) { shortLeg ? pickLong() : nextShort(); }
  else if (reqId === LONG_REQ) { longLeg ? priceIt() : nextLong(); }
});

const expirations = new Set(), strikes = new Set();
ib.on(EventName.securityDefinitionOptionParameter, (reqId, e, u, t, m, exps, strs) => {
  if (reqId !== CHAIN_REQ) return;
  for (const x of exps) expirations.add(x);
  for (const s of strs) strikes.add(Number(s));
});
ib.on(EventName.securityDefinitionOptionParameterEnd, (reqId) => { if (reqId === CHAIN_REQ) startShort(); });

let expiry = null, shortCands = [], shortIdx = 0, longCands = [], longIdx = 0;
function startShort() {
  const today = new Date();
  expiry = [...expirations].sort().find((e) => { const d = (ymd(e) - today)/86_400_000; return d >= 25 && d <= 60; }) ?? [...expirations].sort()[0];
  const sorted = [...strikes].sort((a,b)=>a-b);
  const mid = sorted[Math.floor(sorted.length/2)];
  shortCands = [...sorted].sort((a,b)=>Math.abs(a-mid)-Math.abs(b-mid)).slice(0,10);
  log(`  expiry ${expiry}, ${strikes.size} strikes`);
  nextShort();
}
const opt = (strike) => ({ symbol: SYMBOL, secType: SecType.OPT, lastTradeDateOrContractMonth: expiry, strike, right: OptionType.Put, exchange: 'SMART', currency: 'USD' });
function nextShort() { if (shortIdx>=shortCands.length){console.error('✗ no short leg');return finish(1);} shortLeg=null; ib.reqContractDetails(SHORT_REQ, opt(shortCands[shortIdx])); }
function pickLong() { const S=Number(shortLeg.strike); longCands=[S-5,S-10,S-2.5,S-7.5].filter(k=>strikes.has(k)); longIdx=0; if(!longCands.length){shortIdx++;return nextShort();} nextLong(); }
function nextLong() { if(longIdx>=longCands.length){shortIdx++;return nextShort();} longLeg=null; ib.reqContractDetails(LONG_REQ, opt(longCands[longIdx])); }

const ticks = {};
function priceIt() {
  const bag = {
    symbol: SYMBOL, secType: SecType.BAG, currency: 'USD', exchange: 'SMART',
    comboLegs: [
      { conId: shortLeg.conId, ratio: 1, action: 'SELL', exchange: 'SMART' },
      { conId: longLeg.conId, ratio: 1, action: 'BUY', exchange: 'SMART' },
    ],
  };
  log(`  combo: SELL ${shortLeg.strike}P / BUY ${longLeg.strike}P (${Number(shortLeg.strike)-Number(longLeg.strike)}-wide). Requesting market data…`);
  ib.reqMktData(MKT_REQ, bag, '', true, false);
}
// field map: live 1/2/4/9, delayed 66/67/68/75
const FMAP = { 1:'bid',2:'ask',4:'last',9:'close',66:'bid',67:'ask',68:'last',75:'close' };
ib.on(EventName.tickPrice, (reqId, field, price) => { if (reqId===MKT_REQ && FMAP[field]!=null && price>=0) ticks[FMAP[field]] = price; });
ib.on(EventName.tickSnapshotEnd, (reqId) => { if (reqId===MKT_REQ) report(); });

let done = false;
function report() {
  if (done) return; done = true; clearTimeout(watchdog);
  log('\n──────── LIVE COMBO PRICE ────────');
  log(`  market-data type: ${mdType}`);
  if (ticks.bid==null && ticks.ask==null) {
    log('  ⚠️  No combo bid/ask returned — likely no options market-data subscription on this account.');
    log('     (Order placement still works; we may need delayed data or a subscription for live pricing.)');
    return setTimeout(()=>finish(0), 500);
  }
  const credit = (p) => p==null ? null : Number((-p).toFixed(2));
  // BAG built as SELL/BUY → IBKR prices are negative (a credit). credit-positive = -price.
  log(`  IBKR raw combo  bid=${ticks.bid ?? '—'}  ask=${ticks.ask ?? '—'}  last=${ticks.last ?? '—'}`);
  log(`  credit-positive bid=${credit(ticks.bid) ?? '—'}  ask=${credit(ticks.ask) ?? '—'}  (what you'd receive to sell)`);
  if (ticks.bid!=null && ticks.ask!=null) {
    const mid = Number(((ticks.bid+ticks.ask)/2).toFixed(2));
    log(`  → net credit at mid ≈ $${credit(mid)} per share  ($${(credit(mid)*100).toFixed(0)} per contract)`);
  }
  setTimeout(()=>finish(0), 500);
}

ib.on(EventName.error, (err, code, reqId) => {
  const n = Number(code); if (benign.has(n)) return;
  if (n===200 && reqId===SHORT_REQ){shortIdx++;return nextShort();}
  if (n===200 && reqId===LONG_REQ){longIdx++;return nextLong();}
  if (n===354 || n===10167 || n===10168) { log(`  market-data not subscribed (code ${n}) — retrying delayed…`); ib.reqMarketDataType(MarketDataType.DELAYED); return; }
  log(`  (error ${n} reqId=${reqId}: ${err?.message ?? err})`);
});

log(`Connecting to 127.0.0.1:${PORT}…`);
ib.connect();
