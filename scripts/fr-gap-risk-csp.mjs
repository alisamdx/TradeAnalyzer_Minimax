// FR-SEY-6 (draft), swing 2 — gap-risk filter on the UNBOUNDED short-premium book (naked CSP).
// The defined-risk spread test (fr-gap-risk-study.mjs) falsified the thesis because a vertical
// caps gap loss at its long wing. A naked cash-secured put does NOT: an overnight gap-down through
// the strike is realized at the gapped price (the daily-close stop can't fire intraday), so this is
// where gap risk has a real mechanism. Run the same GapRiskScore A/B over wheel+income replay picks.
//
// CSP model: sell the stored delta-30 synth_strike put, BS-priced premium, 30 DTE, 50% PT / 200%
// stop checked at each daily close (gaps blow past it → uncapped loss). Return = % of cash collateral
// (K*100). Zero new data. Mirror of fr-gap-risk-study.mjs / fr-sey-spread-pnl-confirm.mjs.

import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

function cdfNorm(x) {
  const sign = x < 0 ? -1 : 1;
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const p = 0.3275911, ax = Math.abs(x) / Math.SQRT2, t = 1 / (1 + p * ax);
  const poly = ((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t;
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-ax * ax)));
}
function bsPrice(S, K, T, r, sigma, side) {
  if (T <= 0 || sigma <= 0) return Math.max(0, side === 'call' ? S - K : K - S);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T)), d2 = d1 - sigma * Math.sqrt(T);
  return side === 'call' ? S * cdfNorm(d1) - K * Math.exp(-r * T) * cdfNorm(d2) : K * Math.exp(-r * T) * cdfNorm(-d2) - S * cdfNorm(-d1);
}
function rollingVol(closes, w = 20) {
  const s = closes.slice(-Math.min(w + 1, closes.length));
  if (s.length < 3) return 0.30;
  const r = []; for (let i = 1; i < s.length; i++) r.push(Math.log(s[i] / s[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.max(0.05, Math.sqrt(r.reduce((q, x) => q + (x - m) ** 2, 0) / (r.length - 1) * 252));
}
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000;

const DTE = 30, R = 0.02, PT = 50, STOP = 200;
const barRange = db.prepare(`SELECT date,close FROM historical_prices WHERE ticker=? AND date>=? AND date<=? ORDER BY date ASC`);
const ivAll = db.prepare(`SELECT date,atm_iv FROM iv_history WHERE ticker=? AND atm_iv>0 ORDER BY date ASC`);

// Naked short put (CSP). K = stored delta-30 synth strike. Returns pnl ($) and return-on-collateral.
function simCsp(ticker, entryDate, K) {
  const bars = barRange.all(ticker, addDays(entryDate, -60), addDays(entryDate, DTE + 10));
  if (bars.length < 5) return null;
  const ei = bars.findIndex(b => b.date >= entryDate); if (ei < 0) return null;
  const ivRows = ivAll.all(ticker);
  const ivAsOf = d => { let lo = 0, hi = ivRows.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ivRows[m].date <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a >= 0 ? ivRows[a].atm_iv / 100 : null; };
  const S0 = bars[ei].close; if (!(S0 > 0) || !(K > 0)) return null;
  const sigma0 = ivAsOf(entryDate) ?? rollingVol(bars.slice(0, ei + 1).map(b => b.close), 20);
  const T = DTE / 365;
  const premium = bsPrice(S0, K, T, R, sigma0, 'put') * 100;
  if (premium < 5) return null;
  const collateral = K * 100;
  const exp = addDays(entryDate, DTE);
  for (let i = ei + 1; i < bars.length; i++) {
    const bar = bars[i];
    const out = pnl => ({ pnl, returnPct: pnl / collateral * 100 });
    if (bar.date >= exp) {
      const intrinsic = Math.max(0, K - bar.close) * 100;
      return out(premium - intrinsic);
    }
    const sig = ivAsOf(bar.date) ?? sigma0;
    const val = bsPrice(bar.close, K, Math.max(0, daysBetween(bar.date, exp)) / 365, R, sig, 'put') * 100;
    const pnlSoFar = premium - val;                       // gap-down → val explodes → big loss here
    if (pnlSoFar >= premium * (PT / 100)) return out(pnlSoFar);
    if (val >= premium * (STOP / 100)) return out(pnlSoFar); // daily-close stop; gaps overshoot it
  }
  return null;
}

// ── Gap-risk metric (identical to fr-gap-risk-study.mjs; CSP adverse side = down gaps = 'put') ──
const ohlcDesc = db.prepare(`SELECT date,open,close FROM historical_prices WHERE ticker=? AND date<? ORDER BY date DESC LIMIT 260`);
const ivOne = db.prepare(`SELECT atm_iv FROM iv_history WHERE ticker=? AND date<=? AND atm_iv>0 ORDER BY date DESC LIMIT 1`);
const pctile = (sorted, q) => { if (!sorted.length) return null; const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1)))); return sorted[i]; };
function gapRiskScore(ticker, asOf, window = 252) {
  const b = ohlcDesc.all(ticker, asOf);
  if (b.length < 60) return null;
  const use = b.slice(0, Math.min(window + 1, b.length));
  const adverse = [];
  for (let i = 0; i + 1 < use.length; i++) {
    const open_t = use[i].open, prevClose = use[i + 1].close;
    if (!(open_t > 0) || !(prevClose > 0)) continue;
    const g = (open_t - prevClose) / prevClose;
    if (-g > 0) adverse.push(-g);                          // down gaps = adverse for a short put
  }
  if (adverse.length < 10) return null;
  adverse.sort((a, b) => a - b);
  const gAdv = pctile(adverse, 0.95);
  const ivPct = (ivOne.get(ticker, asOf) || {}).atm_iv ?? null;
  if (!(ivPct > 0)) return null;
  return { score: gAdv / ((ivPct / 100) / Math.sqrt(252)) };
}

const picks = db.prepare(`
  SELECT ro.ticker t, rb.as_of_date asOf, rb.strategy strat, ro.synth_strike K, ro.stayed_above_strike sas
  FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
  WHERE rb.strategy IN ('wheel','income') AND ro.synth_strike IS NOT NULL
`).all();

let skipSim = 0, skipGap = 0;
const rows = [];
for (const p of picks) {
  const r = simCsp(p.t, p.asOf, p.K);
  if (!r) { skipSim++; continue; }
  const g = gapRiskScore(p.t, p.asOf);
  if (!g) { skipGap++; continue; }
  rows.push({ ...p, ...r, gap: g.score });
}

function stats(rs) {
  if (!rs.length) return null;
  const rets = rs.map(r => r.returnPct).sort((a, b) => a - b);
  const wins = rs.filter(r => r.pnl > 0).length;
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const tailN = Math.max(1, Math.floor(rets.length * 0.10));
  const cvarN = Math.max(1, Math.floor(rets.length * 0.05));
  return { n: rs.length, win: wins / rs.length * 100, avgRet: mean(rets),
    worstDecile: mean(rets.slice(0, tailN)), cvar5: mean(rets.slice(0, cvarN)), worst: rets[0] };
}
function show(label, rs) {
  const s = stats(rs);
  if (!s) { console.log(`${label.padEnd(28)} n=   0`); return; }
  console.log(`${label.padEnd(28)} n=${String(s.n).padStart(4)}  win=${s.win.toFixed(1).padStart(5)}%  avgRet=${s.avgRet.toFixed(2).padStart(6)}%  worstDecile=${s.worstDecile.toFixed(1).padStart(7)}%  CVaR5=${s.cvar5.toFixed(1).padStart(7)}%  worst=${s.worst.toFixed(0).padStart(5)}%`);
}

console.log(`resolved ${rows.length}/${picks.length} CSP picks (skipped ${skipSim} sim, ${skipGap} gap-metric)\n`);
console.log('=== headline (naked CSP, return on cash collateral) ===');
show('ALL wheel+income', rows);
show('  wheel', rows.filter(r => r.strat === 'wheel'));
show('  income', rows.filter(r => r.strat === 'income'));

console.log('\n=== gap-risk distribution ===');
const gs = rows.map(r => r.gap).sort((a, b) => a - b);
const q = pp => gs[Math.min(gs.length - 1, Math.round(pp * (gs.length - 1)))];
console.log(`  p10=${q(.1).toFixed(2)}  p25=${q(.25).toFixed(2)}  median=${q(.5).toFixed(2)}  p75=${q(.75).toFixed(2)}  p90=${q(.9).toFixed(2)}  max=${q(1).toFixed(2)}`);
console.log(`  share score>1: ${(rows.filter(r => r.gap > 1).length / rows.length * 100).toFixed(0)}%`);

console.log('\n=== A/B: cutoff sweep (treatment = keep score<=c) ===');
show('  BASELINE (all)', rows);
for (const c of [2.0, 1.5, 1.25, 1.0, 0.8]) {
  const kept = rows.filter(r => r.gap <= c);
  show(`  c<=${c.toFixed(2)} (drop ${((rows.length - kept.length) / rows.length * 100).toFixed(0)}%)`, kept);
}

console.log('\n=== sanity: DROPPED tail (high gap-risk) — thesis predicts this is the WORSE cohort ===');
for (const c of [1.5, 1.25, 1.0]) show(`  DROPPED (score>${c.toFixed(2)})`, rows.filter(r => r.gap > c));

console.log('\n=== gap-risk terciles, monotonicity check ===');
const sorted = [...rows].sort((a, b) => a.gap - b.gap);
const tt = Math.floor(sorted.length / 3);
show(`  LOW gap (${sorted[0].gap.toFixed(2)}..${sorted[tt - 1].gap.toFixed(2)})`, sorted.slice(0, tt));
show('  MID gap', sorted.slice(tt, 2 * tt));
show(`  HIGH gap (${sorted[2 * tt].gap.toFixed(2)}..${sorted[sorted.length - 1].gap.toFixed(2)})`, sorted.slice(2 * tt));
db.close();
