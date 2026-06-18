// Phase 7 fill calibration: price a real spread from legs, OPEN a marketable 1-lot on PAPER,
// capture fill + commission, then CLOSE it to flatten. Verifies the live fill/commission pipeline.
//   node scripts/ibkr-fill-calibration.mjs SYMBOL EXPIRY SHORT_STRIKE LONG_STRIKE [port]
//   e.g. node scripts/ibkr-fill-calibration.mjs AMAT 20260717 580 520
import { IBApi, EventName, SecType, OptionType, OrderAction, OrderType, TimeInForce, MarketDataType } from '@stoqey/ib';

const [SYMBOL, EXPIRY, SSTRIKE, LSTRIKE] = process.argv.slice(2);
const PORT = Number(process.argv[6] ?? 7497);
if (!SYMBOL || !EXPIRY || !SSTRIKE || !LSTRIKE) { console.error('usage: SYMBOL EXPIRY SHORT LONG [port]'); process.exit(1); }
const shortStrike = Number(SSTRIKE), longStrike = Number(LSTRIKE);
const ib = new IBApi({ host: '127.0.0.1', port: PORT, clientId: 0 });
const log = (...a) => console.log(...a);
const finish = (c) => { try { ib.disconnect(); } catch {} process.exit(c); };
const watchdog = setTimeout(() => { console.error('✗ overall timeout — check TWS, may have left an order/position'); finish(1); }, 60000);
watchdog.unref?.();
const benign = new Set([2104, 2106, 2107, 2108, 2158, 2119, 2100, 1102, 399, 2109]);
const FMAP = { 1:'bid',2:'ask',4:'last',66:'bid',67:'ask',68:'last' };

let account = null, nextId = -1;
let sLeg = null, lLeg = null;
const sQ = {}, lQ = {};
const orders = {}; // orderId -> { label, filled, fillPrice, commission, status, execIds:Set }
const execToOrder = {};

ib.on(EventName.managedAccounts, (a) => { account = a.split(',')[0]?.trim() ?? null; });
ib.on(EventName.nextValidId, (id) => { if (nextId < 0) { nextId = id; ib.reqMarketDataType(MarketDataType.REALTIME); qualify(); log(`Connected ${account}. Calibrating ${SYMBOL} ${shortStrike}/${longStrike}P ${EXPIRY}…`); } });

const QS=601, QL=602, MS=603, ML=604;
const optC = (k) => ({ symbol: SYMBOL, secType: SecType.OPT, lastTradeDateOrContractMonth: EXPIRY, strike: k, right: OptionType.Put, exchange: 'SMART', currency: 'USD' });
function qualify() { ib.reqContractDetails(QS, optC(shortStrike)); ib.reqContractDetails(QL, optC(longStrike)); }
ib.on(EventName.contractDetails, (r, d) => { if (r===QS&&!sLeg) sLeg=d.contract; else if (r===QL&&!lLeg) lLeg=d.contract; });
ib.on(EventName.contractDetailsEnd, () => { if (sLeg && lLeg && !quoting) { quoting=true; getQuotes(); } });

let quoting=false;
function getQuotes() {
  log('  qualified both legs; fetching quotes…');
  ib.reqMktData(MS, optC(shortStrike), '', false, false);
  ib.reqMktData(ML, optC(longStrike), '', false, false);
  setTimeout(openTrade, 5000);
}
ib.on(EventName.tickPrice, (r, f, p) => { if (p<0||FMAP[f]==null) return; if (r===MS) sQ[FMAP[f]]=p; else if (r===ML) lQ[FMAP[f]]=p; });

function bag(legs) {
  return { symbol: SYMBOL, secType: SecType.BAG, currency: 'USD', exchange: 'SMART',
    comboLegs: legs.map(l => ({ conId: l.conId, ratio: 1, action: l.action, exchange: 'SMART' })) };
}
function mkOrder(lmt) {
  return { action: OrderAction.BUY, orderType: OrderType.LMT, totalQuantity: 1, lmtPrice: Number(lmt.toFixed(2)),
    tif: TimeInForce.DAY, transmit: true, eTradeOnly: false, firmQuoteOnly: false,
    smartComboRoutingParams: [{ tag: 'NonGuaranteed', value: '1' }], ...(account ? { account } : {}) };
}

let openId=null, closeId=null;
function openTrade() {
  ib.cancelMktData(MS); ib.cancelMktData(ML);
  if ([sQ.bid,sQ.ask,lQ.bid,lQ.ask].some(v=>v==null)) { console.error('✗ missing leg quotes', {sQ,lQ}); return finish(1); }
  const midCredit = ((sQ.bid+sQ.ask)/2)-((lQ.bid+lQ.ask)/2);
  const bidCredit = sQ.bid - lQ.ask; // conservative credit to sell now
  log(`  short ${shortStrike}P ${sQ.bid}/${sQ.ask}  long ${longStrike}P ${lQ.bid}/${lQ.ask}`);
  log(`  net credit  bid=$${bidCredit.toFixed(2)}  mid=$${midCredit.toFixed(2)}  ← priceCombo (from legs)`);
  // OPEN marketable: sell for a bit less than the bid to guarantee a fill.
  const openCredit = bidCredit - 0.50;
  openId = nextId++;
  orders[openId] = { label:'OPEN', filled:0, fillPrice:null, commission:0, status:'', execIds:new Set() };
  log(`\n[OPEN] BUY combo [SELL ${shortStrike}P / BUY ${longStrike}P] @ credit ~$${openCredit.toFixed(2)} (orderId ${openId})`);
  ib.placeOrder(openId, bag([{conId:sLeg.conId,action:OrderAction.SELL},{conId:lLeg.conId,action:OrderAction.BUY}]), mkOrder(-openCredit));
  awaitFill(openId, () => closeTrade());
}
function closeTrade() {
  const askDebit = sQ.ask - lQ.bid; // cost to buy the spread back now
  const closeDebit = askDebit + 0.50; // pay a bit more to guarantee fill
  closeId = nextId++;
  orders[closeId] = { label:'CLOSE', filled:0, fillPrice:null, commission:0, status:'', execIds:new Set() };
  log(`\n[CLOSE] BUY combo [BUY ${shortStrike}P / SELL ${longStrike}P] @ debit ~$${closeDebit.toFixed(2)} (orderId ${closeId})`);
  ib.placeOrder(closeId, bag([{conId:sLeg.conId,action:OrderAction.BUY},{conId:lLeg.conId,action:OrderAction.SELL}]), mkOrder(closeDebit));
  awaitFill(closeId, () => summarize());
}

ib.on(EventName.orderStatus, (id, status, filled, rem, avg, _p, _pp, lastFill) => {
  const o = orders[id]; if (!o) return; o.status=status; o.filled=filled;
  if (filled>0 && lastFill!=null) o.fillPrice = lastFill;
});
ib.on(EventName.execDetails, (_r, _c, ex) => { if (orders[ex.orderId]) { execToOrder[ex.execId]=ex.orderId; orders[ex.orderId].execIds.add(ex.execId); if (ex.price!=null) orders[ex.orderId].fillPrice=ex.price; } });
ib.on(EventName.commissionReport, (rep) => { const oid=execToOrder[rep.execId]; if (oid!=null && typeof rep.commission==='number') orders[oid].commission += rep.commission; });

function awaitFill(id, next) {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const o = orders[id];
    if (o.status==='Filled') { clearInterval(iv); setTimeout(()=>{ log(`  ${o.label} FILLED @ ${o.fillPrice} (commission so far $${o.commission.toFixed(2)})`); next(); }, 1200); }
    else if (['Cancelled','ApiCancelled','Inactive'].includes(o.status)) { clearInterval(iv); console.error(`✗ ${o.label} ${o.status} — aborting`); cleanupAndExit(); }
    else if (Date.now()-t0 > 12000) { clearInterval(iv); console.error(`✗ ${o.label} not filled in 12s (status ${o.status}) — aborting`); cleanupAndExit(); }
  }, 500);
}

function cleanupAndExit() {
  log('  attempting global cancel of any working orders…');
  try { ib.reqGlobalCancel(); } catch {}
  setTimeout(()=>{ checkFlat(()=>finish(1)); }, 2000);
}
function checkFlat(done) {
  let pos = 0;
  const h = (acct, c, p) => { if (c.symbol===SYMBOL && p!==0) pos++; };
  ib.on(EventName.position, h);
  ib.once(EventName.positionEnd, () => { log(`  ${SYMBOL} option positions open: ${pos}`); done(pos); });
  ib.reqPositions();
}
function summarize() {
  clearTimeout(watchdog);
  const o = orders[openId], c = orders[closeId];
  log('\n──────── FILL CALIBRATION ────────');
  log(`  OPEN  credit  $${Math.abs(o.fillPrice ?? 0).toFixed(2)}/sh  commission $${o.commission.toFixed(2)}`);
  log(`  CLOSE debit   $${Math.abs(c.fillPrice ?? 0).toFixed(2)}/sh  commission $${c.commission.toFixed(2)}`);
  const gross = (Math.abs(o.fillPrice ?? 0) - Math.abs(c.fillPrice ?? 0)) * 100;
  const totalComm = o.commission + c.commission;
  log(`  round-trip: gross $${gross.toFixed(2)} − commission $${totalComm.toFixed(2)} = net $${(gross-totalComm).toFixed(2)} (immediate open+close ≈ slippage+fees)`);
  setTimeout(()=>checkFlat((pos)=>{ log(pos===0 ? '\n✅ flat — round trip complete, fill + commission pipeline verified.' : `\n⚠️ ${pos} position(s) still open — check TWS / run ibkr-cancel-all`); finish(0); }), 1500);
}

ib.on(EventName.error, (e, code, reqId) => { const n=Number(code); if (benign.has(n)) return; log(`  (err ${n} reqId=${reqId}: ${e?.message ?? e})`); });
log(`Connecting to 127.0.0.1:${PORT}…`);
ib.connect();
