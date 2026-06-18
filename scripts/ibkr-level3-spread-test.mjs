// Validate LEVEL 3 (Short Put Spread) on the connected (paper) account using the engine's
// actual structure — a short put VERTICAL (sell higher put, buy lower put) as an IBKR BAG combo.
// Places a single 1-lot combo at a near-max, effectively-unfillable credit, then LEAVES IT WORKING
// for the user to review/validate in TWS. Run scripts/ibkr-cancel-all.mjs afterward to clear it.
//
//   node scripts/ibkr-level3-spread-test.mjs [port]   (default 7497 = TWS paper)
import { IBApi, EventName, SecType, OptionType, OrderAction, OrderType, TimeInForce } from '@stoqey/ib';

const PORT = Number(process.argv[2] ?? 7497);
const SYMBOL = 'AAPL';
const ib = new IBApi({ host: '127.0.0.1', port: PORT, clientId: 0 });
const log = (...a) => console.log(...a);

let account = null;
let nextId = -1;
let orderId = null;
const finish = (c) => { try { ib.disconnect(); } catch {} process.exit(c); };
const watchdog = setTimeout(() => { console.error('✗ timed out (25s) with no verdict'); finish(1); }, 25000);
watchdog.unref?.();
const benign = new Set([2104, 2106, 2107, 2108, 2158, 2119, 2100, 1102]);
const ymd = (s) => new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z`);

ib.on(EventName.managedAccounts, (a) => { account = a.split(',')[0]?.trim() ?? null; });
ib.on(EventName.nextValidId, (id) => { if (nextId < 0) { nextId = id; ib.reqContractDetails(STK_REQ, { symbol: SYMBOL, secType: SecType.STK, exchange: 'SMART', currency: 'USD' }); log(`Connected. Account ${account}. Building a ${SYMBOL} short put vertical (Level 3) probe…`); } });

// step 1: underlying conId
const STK_REQ = 201;
let stkConId = null;
ib.on(EventName.contractDetails, (reqId, d) => {
  if (reqId === STK_REQ && stkConId == null) stkConId = d.contract.conId;
  else if (reqId === SHORT_REQ && shortLeg == null) shortLeg = d.contract;
  else if (reqId === LONG_REQ && longLeg == null) longLeg = d.contract;
});
ib.on(EventName.contractDetailsEnd, (reqId) => {
  if (reqId === STK_REQ) ib.reqSecDefOptParams(CHAIN_REQ, SYMBOL, '', SecType.STK, stkConId);
  else if (reqId === SHORT_REQ) { if (shortLeg) pickLong(); else nextShort(); }
  else if (reqId === LONG_REQ) { if (longLeg) place(); else nextLong(); }
});

// step 2: chain
const CHAIN_REQ = 202;
const expirations = new Set();
const strikes = new Set();
ib.on(EventName.securityDefinitionOptionParameter, (reqId, e, u, t, m, exps, strs) => {
  if (reqId !== CHAIN_REQ) return;
  for (const x of exps) expirations.add(x);
  for (const s of strs) strikes.add(Number(s));
});
ib.on(EventName.securityDefinitionOptionParameterEnd, (reqId) => { if (reqId === CHAIN_REQ) startShort(); });

// step 3: qualify short leg, then long leg
const SHORT_REQ = 203, LONG_REQ = 204;
let expiry = null, sorted = [], shortCands = [], shortIdx = 0, shortLeg = null;
let longCands = [], longIdx = 0, longLeg = null;

function startShort() {
  const today = new Date();
  expiry = [...expirations].sort().find((e) => { const d = (ymd(e) - today) / 86_400_000; return d >= 25 && d <= 60; }) ?? [...expirations].sort()[0];
  sorted = [...strikes].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  shortCands = [...sorted].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid)).slice(0, 10);
  if (!expiry || shortCands.length === 0) { console.error('✗ no expirations/strikes'); return finish(1); }
  log(`  chain: ${expirations.size} expirations, ${strikes.size} strikes; expiry ${expiry}`);
  nextShort();
}
function nextShort() {
  if (shortIdx >= shortCands.length) { console.error('✗ could not qualify a short put leg'); return finish(1); }
  shortLeg = null;
  ib.reqContractDetails(SHORT_REQ, optContract(shortCands[shortIdx]));
}
function pickLong() {
  const S = Number(shortLeg.strike);
  // Prefer a $5-wide spread; fall back to other widths actually present in the chain.
  longCands = [S - 5, S - 10, S - 2.5, S - 7.5].filter((k) => strikes.has(k));
  longIdx = 0;
  if (longCands.length === 0) { shortIdx++; return nextShort(); }
  nextLong();
}
function nextLong() {
  if (longIdx >= longCands.length) { shortIdx++; return nextShort(); }
  longLeg = null;
  ib.reqContractDetails(LONG_REQ, optContract(longCands[longIdx]));
}
function optContract(strike) {
  return { symbol: SYMBOL, secType: SecType.OPT, lastTradeDateOrContractMonth: expiry, strike, right: OptionType.Put, exchange: 'SMART', currency: 'USD' };
}

// step 4: place the BAG combo, then LEAVE IT WORKING
function place() {
  const width = Number(shortLeg.strike) - Number(longLeg.strike);
  orderId = nextId++;
  const bag = {
    symbol: SYMBOL, secType: SecType.BAG, currency: 'USD', exchange: 'SMART',
    comboLegs: [
      { conId: shortLeg.conId, ratio: 1, action: OrderAction.SELL, exchange: 'SMART' },
      { conId: longLeg.conId, ratio: 1, action: OrderAction.BUY, exchange: 'SMART' },
    ],
  };
  // Near-max credit so it effectively cannot fill (and the market is closed → it queues anyway).
  // Engine convention: BUY the BAG, negative limit = net credit received (comboLimitOrderParams).
  const credit = Math.max(0.5, width - 0.05);
  const order = {
    action: OrderAction.BUY, orderType: OrderType.LMT, totalQuantity: 1, lmtPrice: -credit,
    tif: TimeInForce.DAY, orderRef: 'level3-spread-test', transmit: true,
    eTradeOnly: false, firmQuoteOnly: false,
    smartComboRoutingParams: [{ tag: 'NonGuaranteed', value: '1' }],
    ...(account ? { account } : {}),
  };
  log(`\nPlacing (orderId ${orderId}): SELL ${SYMBOL} ${expiry} ${shortLeg.strike}P / BUY ${longLeg.strike}P`);
  log(`  short put vertical, ${width}-wide, asking ~$${credit.toFixed(2)} credit (won't fill).`);
  ib.placeOrder(orderId, bag, order);
}

let reported = false;
function accepted(via, status) {
  log(`  ${via}: ${status}`);
  if (reported) return;
  if (['PreSubmitted', 'Submitted', 'Filled'].includes(status)) {
    reported = true;
    clearTimeout(watchdog);
    log('\n──────── VERDICT ────────');
    log('✅ LEVEL 3 CONFIRMED — the short put SPREAD was accepted (not permission-rejected).');
    log(`   Order ${orderId} is now WORKING in TWS for you to review/validate.`);
    log('   → When you\'re done, tell me and I\'ll clear it (scripts/ibkr-cancel-all.mjs).');
    setTimeout(() => finish(0), 800); // disconnect; the order stays live in TWS/IBKR
  }
}
ib.on(EventName.orderStatus, (id, status) => { if (id === orderId) accepted('orderStatus', status); });
ib.on(EventName.openOrder, (id, _c, _o, st) => { if (id === orderId) accepted('openOrder', st?.status ?? '(no status)'); });

ib.on(EventName.error, (err, code, reqId) => {
  const n = Number(code);
  if (benign.has(n)) return;
  if (n === 200 && reqId === SHORT_REQ) { shortIdx++; return nextShort(); }
  if (n === 200 && reqId === LONG_REQ) { longIdx++; return nextLong(); }
  if (reqId === orderId && orderId != null) {
    const msg = err?.message ?? String(err);
    if (/permission|not allowed|trade options/i.test(msg)) {
      clearTimeout(watchdog);
      log(`\n⛔ LEVEL 3 NOT permitted — order rejected on permission grounds: ${msg}`);
      return finish(0);
    }
    log(`  order msg (code ${n}): ${msg}`); // 399 = market-closed warning, etc.
    return;
  }
  log(`  (error ${n} reqId=${reqId}: ${err?.message ?? err})`);
});

log(`Connecting to 127.0.0.1:${PORT}…`);
ib.connect();
