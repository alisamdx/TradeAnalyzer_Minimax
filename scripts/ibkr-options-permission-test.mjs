// One-off: does the connected (paper) account have OPTIONS trading permission right now?
// Places a single 1-lot SELL PUT (= "Short Put", a Level 3 permission) with a limit far
// from the market so it CANNOT fill, observes IBKR's response, then cancels. Not part of the build.
//
//   node scripts/ibkr-options-permission-test.mjs [port]   (default 7497 = TWS paper)
import { IBApi, EventName, SecType, OptionType, OrderAction, OrderType, TimeInForce } from '@stoqey/ib';

const PORT = Number(process.argv[2] ?? 7497);
const SYMBOL = 'AAPL';
const ib = new IBApi({ host: '127.0.0.1', port: PORT, clientId: 0 });

const log = (...a) => console.log(...a);
let account = null;
let nextId = -1;
let testOrderId = null;
let verdict = null;

const finish = (code) => { try { ib.disconnect(); } catch { /* already down; the exit code is the result */ } process.exit(code); };
const watchdog = setTimeout(() => { console.error('✗ timed out (20s) with no verdict'); finish(1); }, 20000);
watchdog.unref?.();

const benign = new Set([2104, 2106, 2107, 2108, 2158, 2119, 2100, 1102]);

function ymdToDate(s) { return new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z`); }

ib.on(EventName.error, (err, code, reqId) => {
  const n = Number(code);
  if (benign.has(n)) return;
  // Order-level rejections arrive with the order's id as reqId.
  if (reqId === testOrderId && testOrderId != null) {
    const msg = err?.message ?? String(err);
    const permission = /permission|not allowed|trade options|order rejected/i.test(msg);
    log(`\n${permission ? '⛔' : '⚠️ '} order response (code ${n}): ${msg}`);
    verdict = verdict ?? (permission ? 'NO_PERMISSION' : `REJECTED(${n})`);
    setTimeout(() => report(), 400);
    return;
  }
  // A contract-not-found on a qualify attempt: advance to the next candidate strike.
  if (n === 200 && reqId === OPT_REQ) {
    candidateIdx++;
    if (candidateIdx < candidates.length) { qualifyNext(); }
    else { console.error('✗ could not qualify any candidate option contract'); finish(1); }
    return;
  }
  log(`  (error ${n} reqId=${reqId}: ${err?.message ?? err})`);
});

ib.on(EventName.managedAccounts, (a) => { account = a.split(',')[0]?.trim() ?? null; });
ib.on(EventName.nextValidId, (id) => { if (nextId < 0) { nextId = id; start(); } });

// ── step 1: qualify the underlying to get its conId ──
const STK_REQ = 101;
let stkConId = null;
ib.on(EventName.contractDetails, (reqId, details) => {
  if (reqId === STK_REQ && stkConId == null) stkConId = details.contract.conId;
});
ib.on(EventName.contractDetailsEnd, (reqId) => {
  if (reqId === STK_REQ) reqChain();
});

// ── step 2: pull real expirations + strikes ──
const CHAIN_REQ = 102;
const expirations = new Set();
const strikes = new Set();
ib.on(EventName.securityDefinitionOptionParameter, (reqId, exch, ulConId, tclass, mult, exps, strs) => {
  if (reqId !== CHAIN_REQ) return;
  for (const e of exps) expirations.add(e);
  for (const s of strs) strikes.add(Number(s));
});
ib.on(EventName.securityDefinitionOptionParameterEnd, (reqId) => {
  if (reqId === CHAIN_REQ) startQualify();
});

// ── step 2b: qualify the option contract (confirm it exists + get conId) ──
const OPT_REQ = 103;
let candidates = [];
let candidateIdx = 0;
let chosenExp = null;
let qualified = null;
ib.on(EventName.contractDetails, (reqId, details) => {
  if (reqId === OPT_REQ && qualified == null) qualified = details.contract;
});
ib.on(EventName.contractDetailsEnd, (reqId) => {
  if (reqId !== OPT_REQ) return;
  if (qualified) { placeTest(); return; }
  candidateIdx++;
  if (candidateIdx < candidates.length) { qualifyNext(); }
  else { console.error('✗ could not qualify any candidate option contract'); finish(1); }
});

// ── step 3: watch for acceptance ──
function accepted(via, status) {
  log(`  ${via}: ${status}`);
  if (['PreSubmitted', 'Submitted', 'Filled'].includes(status) && !verdict) {
    verdict = 'HAS_PERMISSION';
    setTimeout(() => report(), 400);
  }
}
ib.on(EventName.orderStatus, (orderId, status) => {
  if (orderId === testOrderId) accepted('orderStatus', status);
});
ib.on(EventName.openOrder, (orderId, _c, _o, orderState) => {
  if (orderId === testOrderId) accepted('openOrder', orderState?.status ?? '(no status)');
});

function start() {
  log(`Connected (clientId 0). Account: ${account}. Probing OPTIONS permission via a no-fill ${SYMBOL} short put…`);
  ib.reqContractDetails(STK_REQ, { symbol: SYMBOL, secType: SecType.STK, exchange: 'SMART', currency: 'USD' });
}

function reqChain() {
  if (stkConId == null) { console.error('✗ could not resolve underlying conId'); return finish(1); }
  ib.reqSecDefOptParams(CHAIN_REQ, SYMBOL, '', SecType.STK, stkConId);
}

function placeTest() {
  // Use the broker-qualified contract (real conId) so a contract error can't masquerade
  // as a permission error.
  testOrderId = nextId++;
  const order = {
    action: OrderAction.BUY, orderType: OrderType.LMT, totalQuantity: 1,
    lmtPrice: 0.1, // far below market → won't fill, tiny value → no precaution; permission checked at submit
    tif: TimeInForce.DAY, orderRef: 'perm-test', transmit: true,
    eTradeOnly: false, firmQuoteOnly: false, // @stoqey/ib: omit-or-false, else newer TWS drops the order
    ...(account ? { account } : {}),
  };
  log(`Submitting: BUY 1 ${SYMBOL} ${qualified.lastTradeDateOrContractMonth} ${qualified.strike} PUT @ limit 0.10 (no-fill probe, orderId ${testOrderId})…`);
  ib.placeOrder(testOrderId, qualified, order);
}

function startQualify() {
  // Pick an expiry ~25–60 days out, then candidate strikes nearest the median, best-first.
  const today = new Date();
  chosenExp = [...expirations].sort().find((e) => {
    const days = (ymdToDate(e) - today) / 86_400_000;
    return days >= 25 && days <= 60;
  }) ?? [...expirations].sort()[0];
  const sorted = [...strikes].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  candidates = [...sorted].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid)).slice(0, 12);
  if (!chosenExp || candidates.length === 0) { console.error('✗ no expirations/strikes returned'); return finish(1); }
  log(`  chain: ${expirations.size} expirations, ${strikes.size} strikes. Using expiry ${chosenExp}; candidate strikes: ${candidates.join(', ')}`);
  qualifyNext();
}

function qualifyNext() {
  const strike = candidates[candidateIdx];
  qualified = null;
  ib.reqContractDetails(OPT_REQ, {
    symbol: SYMBOL, secType: SecType.OPT, lastTradeDateOrContractMonth: chosenExp,
    strike, right: OptionType.Put, exchange: 'SMART', currency: 'USD',
  });
}

function report() {
  clearTimeout(watchdog);
  if (testOrderId != null) { try { ib.cancelOrder(testOrderId, ''); } catch { /* best effort: the order may already be cancelled or rejected */ } }
  log('\n──────── VERDICT ────────');
  if (verdict === 'HAS_PERMISSION') {
    log('✅ Paper account HAS options permission — the order was accepted (now cancelled).');
  } else if (verdict === 'NO_PERMISSION') {
    log('⛔ Paper account does NOT have options permission — order rejected on permission grounds.');
    log('   → Waiting on the live options approval to propagate to paper.');
  } else {
    log(`⚠️  Order was rejected, but not clearly a permission issue: ${verdict}`);
    log('   → Read the message above; may be a contract/price detail rather than permission.');
  }
  setTimeout(() => finish(0), 600);
}

log(`Connecting to 127.0.0.1:${PORT}…`);
ib.connect();
ib.reqMarketDataType?.(3); // delayed data is fine; we don't rely on quotes
