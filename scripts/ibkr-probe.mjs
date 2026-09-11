// One-off IBKR/TWS connectivity probe. Not part of the build.
// Confirms the TWS API handshake on the paper port and reads back the managed
// account + server version before we write the Phase 6 adapter.
import { IBApi, EventName } from '@stoqey/ib';

const PORT = Number(process.argv[2] ?? 7497); // 7497 = TWS paper
const ib = new IBApi({ host: '127.0.0.1', port: PORT, clientId: 0 });

let connected = false;
const done = (code) => { try { ib.disconnect(); } catch { /* already down; the exit code is the result */ } process.exit(code); };
const overall = setTimeout(() => { console.error('✗ probe did not complete within 15s'); done(1); }, 15000);
overall.unref?.();

const timer = setTimeout(() => {
  console.error(`✗ Timed out after 8s with no handshake on 127.0.0.1:${PORT}.`);
  console.error('  Is TWS logged in and "Enable ActiveX and Socket Clients" on, port', PORT, '?');
  done(1);
}, 8000);

ib.on(EventName.connected, () => { connected = true; console.log('• socket connected'); });
ib.on(EventName.server, (version, connTime) =>
  console.log(`• TWS server version ${version}, connection time ${connTime}`));
ib.on(EventName.managedAccounts, (accounts) => {
  console.log(`✓ handshake OK — managed account(s): ${accounts}`);
  clearTimeout(timer);
  ib.reqCurrentTime();
});
ib.on(EventName.currentTime, (t) => {
  console.log(`✓ server time: ${new Date(t * 1000).toISOString()}`);
  // Exercise the no-options-needed account-data paths the adapter relies on.
  ib.reqAccountSummary(9001, 'All', 'NetLiquidation,AvailableFunds,BuyingPower');
});
const summary = {};
ib.on(EventName.accountSummary, (_reqId, _acct, tag, value, currency) => { summary[tag] = `${value} ${currency}`; });
ib.on(EventName.accountSummaryEnd, () => {
  console.log('✓ account summary:', JSON.stringify(summary));
  ib.cancelAccountSummary(9001);
  ib.reqPositions();
});
let posCount = 0;
ib.on(EventName.position, (_acct, contract, pos) => { if (pos !== 0) { posCount++; console.log(`  position: ${contract.symbol} ${contract.secType} ${pos}`); } });
ib.on(EventName.positionEnd, () => {
  console.log(`✓ positions reported (${posCount} non-zero)`);
  done(0);
});
ib.on(EventName.error, (err, code) => {
  // 2104/2106/2158 are benign "market data farm connected" info notices.
  if ([2104, 2106, 2158, 2107].includes(Number(code))) { console.log(`  (info ${code})`); return; }
  console.error(`✗ error ${code}: ${err?.message ?? err}`);
  if (!connected) done(1);
});

console.log(`Connecting to 127.0.0.1:${PORT} (clientId 0)…`);
ib.connect();
