// FR-SEY-5 validation harness — WHEEL_MONTHLY_FIRST_EXPIRY (v1.1.128, default OFF).
//
// The wheel snapshot's `optionLiquidityScore` reads 0/10 across ~94% of the universe because
// `findSuitableChain` returns the FIRST delta-band match walking expirations ascending — which is
// structurally a WEEKLY — and the [30,45] DTE window is narrower than the ~30-day monthly cycle.
// The flag tries 3rd-Friday monthlies first and widens the window to [28,52].
//
// This cannot be validated retrospectively: `analysis_snapshots` holds the OLD measurements and
// recomputing needs historical chains that were never stored, while Brief Replay nulls the signal
// for every ticker (see REPLAY_BLIND_SIGNAL_KEYS in brief-replay-service.ts). So validation is
// necessarily forward-looking, and MUST run during market hours — outside RTH E*Trade returns
// bid/ask/volume of 0 and two of the score's three components are unmeasurable.
//
// Design notes
// ────────────
// • Implements BOTH policies here and measures them in the SAME pass, so the arms share one
//   instant. No app restart, no WHEEL_MONTHLY_FIRST env var, no DB writes. Given how badly
//   time-of-day confounds option liquidity (see the intraday-vs-after-close thread), an
//   A-now/B-later comparison would be worthless.
// • Reads chains through the app's own API server (127.0.0.1:7432), so E*Trade auth, the rate
//   limiter and the provider seam are all the production ones. The app must be RUNNING.
// • This is a REPLICA of findSuitableChain + wheelOptionLiquidityScore (same pattern as the other
//   fr-*-study scripts). Keep it in sync if those change — the constants are pinned below.
//
// Usage:
//   node scripts/fr-wheel-monthly-first-ab.mjs [--limit 40] [--tickers AAPL,WMT,PG] [--out file.json]
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── replica constants (mirror analysis-service.ts) ──────────────────────────────
const DELTA_MIN = 0.20, DELTA_MAX = 0.30, DELTA_TARGET = 0.25;
const CURRENT_WINDOW = { minDTE: 30, maxDTE: 45 };   // wheelDteWindow(false)
const MONTHLY_WINDOW = { minDTE: 28, maxDTE: 52 };   // wheelDteWindow(true)
const SLIPPAGE_FRACTION = 0.5;                        // options-fill.ts
const OI_PASS = 50, SPREAD_PASS_PCT = 5, VOL_PASS = 50;
// Wheel scoring weights/normalisation (scoring-service.ts BASELINE_WHEEL)
const W_LIQ = 9, NORMMAX_LIQ = 10;
const W_PREMYIELD = 19, NORMMAX_PREMYIELD = 60;
const HOLIDAY_FRIDAYS = new Set([
  '2025-04-18', '2025-07-04', '2026-04-03', '2026-06-19',
  '2026-12-25', '2027-01-01', '2027-03-26', '2028-04-14',
]);

// ── args ────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const LIMIT = Number(argOf('--limit', 40));
const ONLY = (argOf('--tickers', '') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const OUT = argOf('--out', null);

// ── API access (CLAUDE.md: use the API server while the app is running) ─────────
const TOKEN = readFileSync(join(homedir(), '.tradeanalyzer', 'agent.token'), 'utf8').trim();
const API = 'http://127.0.0.1:7432/api/v1';
async function getChain(ticker, expiration) {
  const res = await fetch(`${API}/options/${ticker}?expiration=${expiration}`, {
    headers: { 'X-Agent-Token': TOKEN },
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const rows = body?.data;
  return Array.isArray(rows) ? rows : null;
}

// ── date helpers — ALL UTC (CLAUDE.md weekly-expiration time-base quirk) ────────
const addDaysUTC = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const ymd = (d) => d.toISOString().slice(0, 10);
function thirdFriday(y, m0) {
  const first = new Date(Date.UTC(y, m0, 1));
  const firstFri = 1 + ((5 - first.getUTCDay() + 7) % 7);
  return ymd(new Date(Date.UTC(y, m0, firstFri + 14)));
}
const isMonthly = (iso) => { const [y, m] = iso.split('-').map(Number); return thirdFriday(y, m - 1) === iso; };
/** Mirror of getNearTermExpirations: next `count` Fridays, holiday Fridays shifted to Thursday. */
function nearTermExpirations(count) {
  const now = new Date();
  const first = addDaysUTC(now, (5 - now.getUTCDay() + 7) % 7);
  const out = [];
  for (let w = 0; w < count; w++) {
    let d = addDaysUTC(first, w * 7);
    if (HOLIDAY_FRIDAYS.has(ymd(d))) d = addDaysUTC(d, -1);
    out.push(ymd(d));
  }
  return out;
}
/** Mirror of dteDays: 21:00 UTC settlement reference. */
const dteDays = (exp) => Math.max(0, Math.round((new Date(exp + 'T21:00:00Z') - Date.now()) / 86_400_000));

// ── replica scoring ─────────────────────────────────────────────────────────────
function spreadPct(bid, ask) {
  return (bid > 0 && ask > 0 && ask > bid) ? ((ask - bid) / ((ask + bid) / 2)) * 100 : 0;
}
/** wheelOptionLiquidityScore — null when there is no contract to score. */
function liquidityScore(c) {
  if (!c) return null;
  let s = 0;
  if ((c.openInterest ?? 0) >= OI_PASS) s += 4;
  if (spreadPct(c.bid, c.ask) <= SPREAD_PASS_PCT) s += 4;
  if ((c.volume ?? 0) >= VOL_PASS) s += 2;
  return Math.min(10, s);
}
/** options-fill.ts fillPrice(bid, ask, 'sell'). */
function fillPrice(bid, ask) {
  const mid = (bid + ask) / 2;
  if (!(ask > bid) || mid <= 0) return Math.max(0, mid);
  return Math.max(0, mid - SLIPPAGE_FRACTION * (ask - bid) / 2);
}
const annualizedReturn = (premium, strike, dte) =>
  (dte <= 0 || strike <= 0) ? null : premium / strike * (365 / dte) * 100;

/** Mirror of findSuitableChain's per-expiry contract choice: delta band, bid>0, closest to 0.25. */
function pickContract(rows) {
  const inBand = (c) => c.delta != null && Math.abs(c.delta) >= DELTA_MIN
    && Math.abs(c.delta) <= DELTA_MAX && c.bid > 0;
  const puts = rows.filter((c) => c.type === 'put' && inBand(c));
  const pool = puts.length ? puts : rows.filter((c) => c.type === 'call' && inBand(c));
  if (!pool.length) return null;
  return pool.reduce((a, b) =>
    Math.abs(Math.abs(a.delta) - DELTA_TARGET) < Math.abs(Math.abs(b.delta) - DELTA_TARGET) ? a : b);
}

/** Expirations a policy will consult, in try-order. */
function tryOrder(expirations, { minDTE, maxDTE }, monthlyFirst) {
  const inWindow = expirations.filter((e) => { const d = dteDays(e); return d >= minDTE && d <= maxDTE; }).sort();
  if (!monthlyFirst) return inWindow;
  return [...inWindow.filter(isMonthly), ...inWindow.filter((e) => !isMonthly(e))];
}

/** Walk the try-order, first expiry yielding a contract wins. `cache` avoids double fetches. */
async function runPolicy(ticker, order, cache) {
  for (const exp of order) {
    if (!cache.has(exp)) cache.set(exp, await getChain(ticker, exp));
    const rows = cache.get(exp);
    if (!rows || !rows.length) continue;
    const c = pickContract(rows);
    if (c) {
      const premium = fillPrice(c.bid, c.ask);
      const dte = dteDays(exp);
      return {
        expiration: exp, monthly: isMonthly(exp), dte, strike: c.strike,
        side: c.type, delta: c.delta, bid: c.bid, ask: c.ask,
        oi: c.openInterest ?? 0, volume: c.volume ?? 0, spreadPct: spreadPct(c.bid, c.ask),
        liq: liquidityScore(c), premium, annualizedReturn: annualizedReturn(premium, c.strike, dte),
      };
    }
  }
  return null;
}

// ── ticker sample: names that resolved a chain in the latest wheel snapshot ─────
function sampleTickers() {
  if (ONLY.length) return ONLY;
  const db = new Database(join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));
  const row = db.prepare(`SELECT payload_json FROM analysis_snapshots WHERE mode='wheel' ORDER BY run_at DESC LIMIT 1`).get();
  db.close();
  if (!row) return [];
  const arr = JSON.parse(row.payload_json);
  const list = Array.isArray(arr) ? arr : (arr.results ?? arr.rows ?? []);
  // Only names that already resolve a chain — for the rest both arms would be null and the
  // comparison is vacuous. Highest IV rank first: those are the real wheel brief candidates.
  return list
    .filter((r) => r.recommendedStrike != null && r.ivRank != null)
    .sort((a, b) => b.ivRank - a.ivRank)
    .slice(0, LIMIT)
    .map((r) => r.ticker);
}

// ── report helpers ──────────────────────────────────────────────────────────────
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));
const norm = (raw, normMax) => Math.max(0, Math.min(100, (raw / normMax) * 100));

// ── main ────────────────────────────────────────────────────────────────────────
const tickers = sampleTickers();
if (!tickers.length) {
  console.error('No tickers to test — is there a wheel analysis_snapshots row? Or pass --tickers.');
  process.exit(1);
}

const health = await fetch(`${API}/health`, { headers: { 'X-Agent-Token': TOKEN } }).catch(() => null);
if (!health || !health.ok) {
  console.error('API server not reachable on 127.0.0.1:7432 — the app must be RUNNING for this script.');
  process.exit(1);
}

console.log(`\nFR-SEY-5 — WHEEL_MONTHLY_FIRST_EXPIRY side-by-side, ${tickers.length} tickers`);
console.log(`current  = first-by-date in [${CURRENT_WINDOW.minDTE},${CURRENT_WINDOW.maxDTE}] DTE   (shipped)`);
console.log(`monthly  = 3rd Fridays first in [${MONTHLY_WINDOW.minDTE},${MONTHLY_WINDOW.maxDTE}] DTE (flag ON)`);
console.log(`run at ${new Date().toISOString()} — both arms priced in the SAME pass\n`);

const expirations = nearTermExpirations(Math.ceil(MONTHLY_WINDOW.maxDTE / 7) + 2);
const rows = [];
for (const [i, ticker] of tickers.entries()) {
  const cache = new Map();
  const cur = await runPolicy(ticker, tryOrder(expirations, CURRENT_WINDOW, false), cache);
  const mon = await runPolicy(ticker, tryOrder(expirations, MONTHLY_WINDOW, true), cache);
  rows.push({ ticker, cur, mon });
  process.stdout.write(`\r  fetched ${i + 1}/${tickers.length} (${ticker})          `);
}
process.stdout.write('\n\n');

// Market-hours sanity gate — outside RTH every quote is 0 and 2 of 3 components are dead.
const quoted = rows.filter((r) => r.cur && r.cur.bid > 0).length;
const withCur = rows.filter((r) => r.cur).length;
if (withCur > 0 && quoted / withCur < 0.5) {
  console.log('!! WARNING: ' + (withCur - quoted) + '/' + withCur + ' contracts have bid = 0.');
  console.log('!! The market is almost certainly CLOSED. Spread and volume are unmeasurable now,');
  console.log('!! so the liquidity scores below are NOT valid. Re-run during RTH.\n');
}

// ── per-ticker table ────────────────────────────────────────────────────────────
console.log('ticker   │ CURRENT (first-by-date)                    │ MONTHLY-FIRST                              │ Δ');
console.log('         │ exp        dte  liq   OI     spr%   ann%   │ exp        dte  liq   OI     spr%   ann%   │ liq  ann%');
console.log('─'.repeat(140));
const fmtArm = (a) => a
  ? `${a.expiration} ${String(a.dte).padStart(3)} ${String(a.liq).padStart(4)} ${String(a.oi).padStart(6)} ${f(a.spreadPct).padStart(6)} ${f(a.annualizedReturn).padStart(6)}`
  : '—'.padEnd(43);
for (const r of rows) {
  const dLiq = r.cur && r.mon ? r.mon.liq - r.cur.liq : null;
  const dAnn = r.cur && r.mon && r.cur.annualizedReturn != null && r.mon.annualizedReturn != null
    ? r.mon.annualizedReturn - r.cur.annualizedReturn : null;
  const changed = r.cur && r.mon && r.cur.expiration !== r.mon.expiration ? '*' : ' ';
  console.log(
    `${r.ticker.padEnd(7)}${changed}│ ${fmtArm(r.cur)} │ ${fmtArm(r.mon)} │ ${(dLiq == null ? '—' : (dLiq >= 0 ? '+' : '') + dLiq).padStart(4)} ${(dAnn == null ? '—' : (dAnn >= 0 ? '+' : '') + f(dAnn)).padStart(7)}`
  );
}
console.log('  (* = the two policies chose different expirations)');

// ── aggregate ───────────────────────────────────────────────────────────────────
const both = rows.filter((r) => r.cur && r.mon);
const changed = both.filter((r) => r.cur.expiration !== r.mon.expiration);
const agg = (arm, key) => med(both.map((r) => r[arm][key]).filter((x) => x != null));
const pctAtLeast = (arm, key, n) => (both.filter((r) => r[arm][key] >= n).length / both.length) * 100;

console.log(`\n─── AGGREGATE (${both.length} tickers resolved under both policies) ───`);
console.log(`expiry changed on ${changed.length}/${both.length} (${f((changed.length / both.length) * 100, 0)}%)`);
console.log(`landed on a MONTHLY:  current ${f((both.filter((r) => r.cur.monthly).length / both.length) * 100, 0)}%   monthly-first ${f((both.filter((r) => r.mon.monthly).length / both.length) * 100, 0)}%`);
console.log('');
console.log('                         current    monthly-first');
console.log(`median liquidityScore  ${f(agg('cur', 'liq'), 1).padStart(8)}  ${f(agg('mon', 'liq'), 1).padStart(13)}`);
console.log(`  scoring 0/10         ${f(100 - pctAtLeast('cur', 'liq', 1), 0).padStart(7)}%  ${f(100 - pctAtLeast('mon', 'liq', 1), 0).padStart(12)}%   ← the 94%-zeros symptom`);
console.log(`  clearing >=5/10      ${f(pctAtLeast('cur', 'liq', 5), 0).padStart(7)}%  ${f(pctAtLeast('mon', 'liq', 5), 0).padStart(12)}%   ← the suitability-score gate`);
console.log(`median OI              ${f(agg('cur', 'oi'), 0).padStart(8)}  ${f(agg('mon', 'oi'), 0).padStart(13)}`);
console.log(`median spread %        ${f(agg('cur', 'spreadPct'), 1).padStart(8)}  ${f(agg('mon', 'spreadPct'), 1).padStart(13)}`);
console.log(`median volume          ${f(agg('cur', 'volume'), 0).padStart(8)}  ${f(agg('mon', 'volume'), 0).padStart(13)}`);
console.log(`median DTE             ${f(agg('cur', 'dte'), 0).padStart(8)}  ${f(agg('mon', 'dte'), 0).padStart(13)}`);
console.log(`median annualized %    ${f(agg('cur', 'annualizedReturn'), 1).padStart(8)}  ${f(agg('mon', 'annualizedReturn'), 1).padStart(13)}   ← premiumYield signal`);

// Per-strike volume accrues through the session, so an early run understates the +2 component
// for BOTH arms and makes the score look flatter than it is at the close.
if ((agg('cur', 'volume') ?? 0) === 0 && (agg('mon', 'volume') ?? 0) === 0) {
  const etHour = Number(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  console.log(`\n  ! median volume is 0 in BOTH arms (now ~${etHour}:00 ET). Per-strike volume builds`);
  console.log('    through the session, so the +2 volume component is understated this early.');
  console.log('    Re-run in the last hour of trading before treating the score levels as final.');
}
// The score's other two components are threshold gates that may still be miscalibrated — a
// monthly with five-figure OI can still cap at 4/10. Flag it so the flag is not oversold.
const clearing5 = pctAtLeast('mon', 'liq', 5);
if (clearing5 < 25) {
  console.log(`\n  ! monthly-first still clears >=5/10 on only ${f(clearing5, 0)}% of tickers. The OI component`);
  console.log('    (+4) is doing all the work; spread<=5% and volume>=50 rarely fire, so the signal is');
  console.log('    near-constant at 4 rather than discriminating. Fixing WHICH contract is measured');
  console.log('    does not by itself fix the THRESHOLDS — see docs/formulas.md#liquidity-score.');
}

// Composite impact — only the two signals this change can move; every other signal is untouched.
const deltas = both.map((r) => {
  const dLiq = (norm(r.mon.liq, NORMMAX_LIQ) - norm(r.cur.liq, NORMMAX_LIQ)) * W_LIQ;
  const dPy = (norm(r.mon.annualizedReturn ?? 0, NORMMAX_PREMYIELD) - norm(r.cur.annualizedReturn ?? 0, NORMMAX_PREMYIELD)) * W_PREMYIELD;
  return (dLiq + dPy) / 100;   // weights sum to 100 for wheel
});
console.log(`\nEstimated wheel COMPOSITE delta (optionLiquidity w${W_LIQ} + premiumYield w${W_PREMYIELD} only; all other signals unchanged):`);
console.log(`  mean ${(mean(deltas) >= 0 ? '+' : '') + f(mean(deltas), 2)} pts   median ${(med(deltas) >= 0 ? '+' : '') + f(med(deltas), 2)} pts   improved on ${deltas.filter((d) => d > 0).length}/${deltas.length}`);
console.log('\nNOTE: this measures the SIGNAL, not trade outcomes. It answers "does the flag make');
console.log('optionLiquidity discriminate again", which is the defect. Whether the resulting');
console.log('re-ranking picks better trades needs forward realized P&L — FR-SEY-5 is not');
console.log('satisfied by this script alone.');

if (OUT) {
  writeFileSync(OUT, JSON.stringify({ runAt: new Date().toISOString(), tickers, rows }, null, 2));
  console.log(`\nwrote ${OUT}`);
}
