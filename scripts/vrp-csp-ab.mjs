// NEW_FRONTIER §10.6 follow-up — does a VRP signal add value BEYOND the IV-rank the engine already
// uses? Attach entry-time IVR + trailing-RV regime + sector-historical-VRP to the real naked-CSP P&L
// (the §9 harness) over wheel+income replay picks, then test marginal discrimination WITHIN IVR
// buckets. If "high IVR ∩ calm" beats "high IVR alone", the RV/VRP axis adds something; if not, VRP
// is just IVR in disguise. Zero new data. Run with the node ABI (npm run rebuild:node).

import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

// ── BS + CSP sim (verbatim from fr-gap-risk-csp.mjs) ──
function cdfNorm(x) {
  const s = x < 0 ? -1 : 1, a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const p = 0.3275911, ax = Math.abs(x) / Math.SQRT2, t = 1 / (1 + p * ax);
  const poly = ((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t;
  return 0.5 * (1 + s * (1 - poly * Math.exp(-ax * ax)));
}
function bsPut(S, K, T, r, sig) {
  if (T <= 0 || sig <= 0) return Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + 0.5 * sig * sig) * T) / (sig * Math.sqrt(T)), d2 = d1 - sig * Math.sqrt(T);
  return K * Math.exp(-r * T) * cdfNorm(-d2) - S * cdfNorm(-d1);
}
function rollVol(cl, w = 20) {
  const s = cl.slice(-Math.min(w + 1, cl.length)); if (s.length < 3) return 0.30;
  const r = []; for (let i = 1; i < s.length; i++) r.push(Math.log(s[i] / s[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.max(0.05, Math.sqrt(r.reduce((q, x) => q + (x - m) ** 2, 0) / (r.length - 1) * 252));
}
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dBetween = (a, b) => (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000;
const DTE = 30, R = 0.02, PT = 50, STOP = 200;
const barRange = db.prepare(`SELECT date,close FROM historical_prices WHERE ticker=? AND date>=? AND date<=? ORDER BY date ASC`);
const ivAll = db.prepare(`SELECT date,atm_iv FROM iv_history WHERE ticker=? AND atm_iv>0 ORDER BY date ASC`);

function simCsp(ticker, entryDate, K) {
  const bars = barRange.all(ticker, addDays(entryDate, -60), addDays(entryDate, DTE + 10));
  if (bars.length < 5) return null;
  const ei = bars.findIndex(b => b.date >= entryDate); if (ei < 0) return null;
  const ivRows = ivAll.all(ticker);
  const ivAsOf = d => { let lo = 0, hi = ivRows.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ivRows[m].date <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a >= 0 ? ivRows[a].atm_iv / 100 : null; };
  const S0 = bars[ei].close; if (!(S0 > 0) || !(K > 0)) return null;
  const sig0 = ivAsOf(entryDate) ?? rollVol(bars.slice(0, ei + 1).map(b => b.close));
  const T = DTE / 365, premium = bsPut(S0, K, T, R, sig0) * 100;
  if (premium < 5) return null;
  const collateral = K * 100, exp = addDays(entryDate, DTE);
  for (let i = ei + 1; i < bars.length; i++) {
    const bar = bars[i], out = pnl => ({ pnl, returnPct: pnl / collateral * 100 });
    if (bar.date >= exp) return out(premium - Math.max(0, K - bar.close) * 100);
    const sig = ivAsOf(bar.date) ?? sig0;
    const val = bsPut(bar.close, K, Math.max(0, dBetween(bar.date, exp)) / 365, R, sig) * 100;
    const pnlSoFar = premium - val;
    if (pnlSoFar >= premium * (PT / 100)) return out(pnlSoFar);
    if (val >= premium * (STOP / 100)) return out(pnlSoFar);
  }
  return null;
}

// ── entry-time features (point-in-time) ──
const ivHist = db.prepare(`SELECT date,atm_iv FROM iv_history WHERE ticker=? AND atm_iv>0 AND date<=? ORDER BY date DESC LIMIT 252`);
const closesBefore = db.prepare(`SELECT close FROM historical_prices WHERE ticker=? AND date<=? ORDER BY date DESC LIMIT 22`);
const fundOf = db.prepare(`SELECT payload_json FROM fundamentals_cache WHERE ticker=? LIMIT 1`);
function ivrAt(t, d) {
  const rows = ivHist.all(t, d); if (rows.length < 21) return null;
  const vals = rows.map(r => r.atm_iv), latest = vals[0];
  const mn = Math.min(...vals), mx = Math.max(...vals);
  return mx > mn ? ((latest - mn) / (mx - mn)) * 100 : null;
}
function rv20At(t, d) {
  const c = closesBefore.all(t, d).map(r => r.close).reverse(); if (c.length < 19) return null;
  return rollVol(c) * 100;
}
function sectorOf(t) { try { return JSON.parse((fundOf.get(t) || {}).payload_json || '{}').sector || 'unknown'; } catch { return 'unknown'; } }

// ── sector historical mean VRP (from the full panel; structural property, negligible self-leak) ──
const allTickers = db.prepare(`SELECT DISTINCT ticker FROM iv_history`).all().map(r => r.ticker);
const barsAll = db.prepare(`SELECT date,close FROM historical_prices WHERE ticker=? ORDER BY date ASC`);
const secVrpSum = {}, secVrpN = {};
for (const t of allTickers) {
  const b = barsAll.all(t); if (b.length < 60) continue;
  const dates = b.map(x => x.date), cl = b.map(x => x.close);
  const ivs = ivAll.all(t); if (ivs.length < 30) continue;
  const sec = sectorOf(t);
  for (const row of ivs) {
    let lo = 0, hi = dates.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] >= row.date) { idx = m; hi = m - 1; } else lo = m + 1; }
    if (idx < 0 || idx + 21 >= cl.length) continue;
    const r = []; for (let k = idx + 1; k <= idx + 21; k++) if (cl[k - 1] > 0 && cl[k] > 0) r.push(Math.log(cl[k] / cl[k - 1]));
    if (r.length < 19) continue;
    const m = r.reduce((s, x) => s + x, 0) / r.length;
    const rv = Math.sqrt(252 * r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)) * 100;
    secVrpSum[sec] = (secVrpSum[sec] || 0) + (row.atm_iv - rv); secVrpN[sec] = (secVrpN[sec] || 0) + 1;
  }
}
const secVrp = s => (secVrpN[s] >= 200 ? secVrpSum[s] / secVrpN[s] : null);

// ── build the CSP sample with features ──
const picks = db.prepare(`
  SELECT ro.ticker t, rb.as_of_date asOf, ro.synth_strike K
  FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
  WHERE rb.strategy IN ('wheel','income') AND ro.synth_strike IS NOT NULL
`).all();
const rows = [];
for (const p of picks) {
  const r = simCsp(p.t, p.asOf, p.K); if (!r) continue;
  const ivr = ivrAt(p.t, p.asOf), rv20 = rv20At(p.t, p.asOf);
  if (ivr == null || rv20 == null) continue;
  rows.push({ ...p, ...r, ivr, rv20, secVrp: secVrp(sectorOf(p.t)) });
}

function show(label, rs) {
  if (!rs.length) { console.log(`${label.padEnd(32)} n=   0`); return; }
  const rets = rs.map(r => r.returnPct).sort((a, b) => a - b);
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const win = rs.filter(r => r.pnl > 0).length / rs.length * 100;
  const cvar = mean(rets.slice(0, Math.max(1, Math.floor(rets.length * 0.05))));
  console.log(`${label.padEnd(32)} n=${String(rs.length).padStart(4)}  win=${win.toFixed(1).padStart(5)}%  avgRet=${mean(rets).toFixed(2).padStart(6)}%  CVaR5=${cvar.toFixed(1).padStart(6)}%`);
}
const terc = (rs, key) => { const v = [...rs].sort((a, b) => a[key] - b[key]); const t = Math.floor(v.length / 3); return [v.slice(0, t), v.slice(t, 2 * t), v.slice(2 * t)]; };

console.log(`${rows.length} CSP picks with entry-time IVR + RV20 + sector VRP.\n`);
show('BASELINE (all)', rows);

console.log('\n=== STEP 1: does IVR predict CSP success on its own? ===');
{
  const [lo, mid, hi] = terc(rows, 'ivr');
  show(`  IVR low  (${lo[0].ivr.toFixed(0)}..${lo[lo.length - 1].ivr.toFixed(0)})`, lo);
  show('  IVR mid', mid);
  show(`  IVR high (${hi[0].ivr.toFixed(0)}..${hi[hi.length - 1].ivr.toFixed(0)})`, hi);
}

console.log('\n=== STEP 2 (the marginal test): WITHIN high-IVR, does RV-regime add discrimination? ===');
{
  const [, , hiIvr] = terc(rows, 'ivr');
  show('  high-IVR (control)', hiIvr);
  const [calm, mid, storm] = terc(hiIvr, 'rv20');
  show('    ∩ calm  (low RV20)', calm);
  show('    ∩ mid', mid);
  show('    ∩ stormy(high RV20)', storm);
}

console.log('\n=== STEP 3: within high-IVR, does sector historical-VRP add discrimination? ===');
{
  const [, , hiIvr] = terc(rows, 'ivr');
  const wSec = hiIvr.filter(r => r.secVrp != null);
  const [lo, mid, hi] = terc(wSec, 'secVrp');
  show('  high-IVR ∩ low sectorVRP', lo);
  show('  high-IVR ∩ mid sectorVRP', mid);
  show('  high-IVR ∩ high sectorVRP', hi);
}

console.log('\n=== STEP 4: standalone RV-regime (for reference) ===');
{
  const [calm, mid, storm] = terc(rows, 'rv20');
  show('  calm (low RV20)', calm);
  show('  mid', mid);
  show('  stormy (high RV20)', storm);
}
db.close();
