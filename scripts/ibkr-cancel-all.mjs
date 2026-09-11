// Cancel ALL open orders on the connected (paper) account — cleanup for the permission probe.
//   node scripts/ibkr-cancel-all.mjs [port]   (default 7497 = TWS paper)
import { IBApi, EventName } from '@stoqey/ib';

const PORT = Number(process.argv[2] ?? 7497);
const ib = new IBApi({ host: '127.0.0.1', port: PORT, clientId: 0 });
const log = (...a) => console.log(...a);
const finish = (c) => { try { ib.disconnect(); } catch { /* already down; the exit code is the result */ } process.exit(c); };
setTimeout(() => finish(0), 9000).unref?.();

let before = 0;
ib.on(EventName.openOrder, (id, c) => { before++; log(`  open order ${id}: ${c.symbol} ${c.secType} ${c.right ?? ''} ${c.strike ?? ''}`); });
ib.on(EventName.error, (e, code) => { const n = Number(code); if (![2104,2106,2107,2158,2100,2119].includes(n)) log(`  (info/err ${n}: ${e?.message ?? e})`); });

ib.on(EventName.nextValidId, () => {
  ib.reqAllOpenOrders();
  setTimeout(() => {
    log(before ? `Cancelling ${before} open order(s) via global cancel…` : 'No open orders found.');
    try { ib.reqGlobalCancel(); } catch (e) { log('reqGlobalCancel error:', e?.message ?? e); }
    setTimeout(() => {
      let remaining = 0;
      ib.removeAllListeners(EventName.openOrder);
      ib.on(EventName.openOrder, () => { remaining++; });
      ib.on(EventName.openOrderEnd, () => { log(`\n✓ open orders remaining: ${remaining}`); finish(0); });
      ib.reqAllOpenOrders();
    }, 2500);
  }, 1500);
});

log(`Connecting to 127.0.0.1:${PORT}…`);
ib.connect();
