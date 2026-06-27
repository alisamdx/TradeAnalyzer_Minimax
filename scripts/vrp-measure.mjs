// NEW_FRONTIER §3.2 / §10 — measure the volatility risk premium (VRP) and test whether it splits
// by IV-regime / sector / realized-vol regime on our ~12-month ATM-IV panel.
//   VRP(d) = atm_iv(d) - fwdRV30(d)   (vol points; >0 = IV was richer than the vol that followed)
//   fwdRV30 = annualized realized vol of daily log returns over the next ~21 trading days.
// Zero new data: iv_history + historical_prices + fundamentals_cache. Read-only.

import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const FWD = 21; // trading days forward for realized vol
const tickers = db.prepare(`SELECT DISTINCT ticker FROM iv_history`).all().map(r => r.ticker);
const barsOf = db.prepare(`SELECT date,close FROM historical_prices WHERE ticker=? ORDER BY date ASC`);
const ivOf = db.prepare(`SELECT date,atm_iv FROM iv_history WHERE ticker=? AND atm_iv>0 ORDER BY date ASC`);
const fundOf = db.prepare(`SELECT payload_json FROM fundamentals_cache WHERE ticker=? LIMIT 1`);
function sectorFor(t) {
  try { return JSON.parse((fundOf.get(t) || {}).payload_json || '{}').sector || 'unknown'; }
  catch { return 'unknown'; }
}

function fwdRV(closes, i) {
  // realized vol over closes[i..i+FWD]
  if (i + FWD >= closes.length) return null;
  const r = [];
  for (let k = i + 1; k <= i + FWD; k++) {
    const a = closes[k - 1], b = closes[k];
    if (a > 0 && b > 0) r.push(Math.log(b / a));
  }
  if (r.length < FWD - 2) return null;
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(252 * v) * 100;
}

const obs = [];
for (const t of tickers) {
  const bars = barsOf.all(t);
  if (bars.length < 60) continue;
  const dates = bars.map(b => b.date), closes = bars.map(b => b.close);
  const ivRows = ivOf.all(t);
  if (ivRows.length < 30) continue;
  // IV-rank from trailing iv (252) — reuse a running window
  const ivVals = ivRows.map(r => r.atm_iv);
  const sector = sectorFor(t);
  for (let j = 0; j < ivRows.length; j++) {
    const d = ivRows[j].date, iv = ivRows[j].atm_iv;
    // forward RV needs the bar index at/after d
    let lo = 0, hi = dates.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] >= d) { idx = m; hi = m - 1; } else lo = m + 1; }
    if (idx < 0) continue;
    const rv = fwdRV(closes, idx);
    if (rv === null) continue;
    // IV rank over trailing 252 iv obs
    const win = ivVals.slice(Math.max(0, j - 251), j + 1);
    const mn = Math.min(...win), mx = Math.max(...win);
    const ivr = mx > mn ? ((iv - mn) / (mx - mn)) * 100 : null;
    // trailing RV20 regime
    const rv20 = idx >= 21 ? fwdRVback(closes, idx) : null;
    obs.push({ t, d, iv, rv, vrp: iv - rv, ivr, sector, rv20 });
  }
}
function fwdRVback(closes, i) {
  const r = [];
  for (let k = i - 20; k <= i; k++) { const a = closes[k - 1], b = closes[k]; if (a > 0 && b > 0) r.push(Math.log(b / a)); }
  if (r.length < 18) return null;
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  return Math.sqrt(252 * r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)) * 100;
}

function agg(label, rs) {
  if (!rs.length) { console.log(`${label.padEnd(34)} n=     0`); return; }
  const vrp = rs.map(r => r.vrp).sort((a, b) => a - b);
  const mean = vrp.reduce((s, x) => s + x, 0) / vrp.length;
  const med = vrp[Math.floor(vrp.length / 2)];
  const pos = rs.filter(r => r.vrp > 0).length / rs.length * 100;
  const mIv = rs.reduce((s, r) => s + r.iv, 0) / rs.length;
  const mRv = rs.reduce((s, r) => s + r.rv, 0) / rs.length;
  console.log(`${label.padEnd(34)} n=${String(rs.length).padStart(6)}  meanVRP=${mean.toFixed(1).padStart(6)}  medVRP=${med.toFixed(1).padStart(6)}  %pos=${pos.toFixed(0).padStart(3)}  (IV ${mIv.toFixed(1)} − RV ${mRv.toFixed(1)})`);
}

console.log(`VRP = atm_iv − fwdRV${FWD}d. ${obs.length} ticker-day obs across ${tickers.length} tickers.\n`);
console.log('=== headline ===');
agg('ALL', obs);

console.log('\n=== by IV-rank bucket (is rich IV richer or mean-reverting?) ===');
const wIvr = obs.filter(o => o.ivr != null);
agg('  IVR low   (0–33)', wIvr.filter(o => o.ivr <= 33));
agg('  IVR mid   (33–66)', wIvr.filter(o => o.ivr > 33 && o.ivr <= 66));
agg('  IVR high  (66–100)', wIvr.filter(o => o.ivr > 66));

console.log('\n=== by trailing RV20 regime (calm vs stormy names) ===');
const wRv = obs.filter(o => o.rv20 != null).sort((a, b) => a.rv20 - b.rv20);
const tt = Math.floor(wRv.length / 3);
agg(`  RV20 low  (${wRv[0]?.rv20.toFixed(0)}..${wRv[tt - 1]?.rv20.toFixed(0)})`, wRv.slice(0, tt));
agg('  RV20 mid', wRv.slice(tt, 2 * tt));
agg(`  RV20 high (${wRv[2 * tt]?.rv20.toFixed(0)}..${wRv[wRv.length - 1]?.rv20.toFixed(0)})`, wRv.slice(2 * tt));

console.log('\n=== by sector (top/bottom by mean VRP, min 200 obs) ===');
const bySec = {};
for (const o of obs) (bySec[o.sector] ||= []).push(o);
const secRows = Object.entries(bySec).filter(([, rs]) => rs.length >= 200)
  .map(([s, rs]) => ({ s, n: rs.length, mean: rs.reduce((a, r) => a + r.vrp, 0) / rs.length }))
  .sort((a, b) => b.mean - a.mean);
for (const r of secRows.slice(0, 6)) agg(`  + ${r.s.slice(0, 28)}`, bySec[r.s]);
console.log('  ...');
for (const r of secRows.slice(-6)) agg(`  − ${r.s.slice(0, 28)}`, bySec[r.s]);
db.close();
