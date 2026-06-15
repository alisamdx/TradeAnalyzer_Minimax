// Authoritative spread-P&L confirmation for the inflection follow-ups.
// Faithful offline replica of BacktestEngine.simulateSingleSpread (Black-Scholes, IV-priced
// credit, 0.30/0.15-delta vertical, 30 DTE, 50% PT / 200% stop) run over every inflection
// replay pick, sliced by ATR% / IV / 50-200 regime. Because credit scales with IV, this
// resolves the proxy's IV/credit confound: returns are % of the spread's max-loss capital.

import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

// ── BS helpers (verbatim from backtest-engine.ts) ──
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
function bsDelta(S, K, T, r, sigma, side) {
  if (T <= 0 || sigma <= 0) return side === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return side === 'call' ? cdfNorm(d1) : cdfNorm(d1) - 1;
}
function findStrikeForDelta(S, T, sigma, targetDelta, side, r = 0.02) {
  let best = S, bestDiff = Infinity;
  for (let i = 0; i <= 160; i++) {
    const strike = Math.round(S * (0.60 + (i / 160) * 0.80) * 2) / 2;
    const diff = Math.abs(Math.abs(bsDelta(S, strike, T, r, sigma, side)) - targetDelta);
    if (diff < bestDiff) { bestDiff = diff; best = strike; }
  }
  return best;
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

const P = { deltaTarget: 0.30, dteTarget: 30, profitTargetPct: 50, stopLossPct: 200 };
const barRange = db.prepare(`SELECT date,close FROM historical_prices WHERE ticker=? AND date>=? AND date<=? ORDER BY date ASC`);
const ivAll = db.prepare(`SELECT date,atm_iv FROM iv_history WHERE ticker=? AND atm_iv>0 ORDER BY date ASC`);

function simSpread(ticker, entryDate, direction) {
  const R = 0.02, side = direction > 0 ? 'put' : 'call';
  const bars = barRange.all(ticker, addDays(entryDate, -60), addDays(entryDate, P.dteTarget + 10));
  if (bars.length < 5) return null;
  const ei = bars.findIndex(b => b.date >= entryDate); if (ei < 0) return null;
  const ivRows = ivAll.all(ticker);
  const ivAsOf = d => { let lo = 0, hi = ivRows.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ivRows[m].date <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a >= 0 ? ivRows[a].atm_iv / 100 : null; };
  const S0 = bars[ei].close; if (!(S0 > 0)) return null;
  const sigma0 = ivAsOf(entryDate) ?? rollingVol(bars.slice(0, ei + 1).map(b => b.close), 20);
  const T = P.dteTarget / 365;
  const shortK = findStrikeForDelta(S0, T, sigma0, P.deltaTarget, side, R);
  const longK = findStrikeForDelta(S0, T, sigma0, 0.15, side, R);
  if (shortK === longK) return null;
  const credit = (bsPrice(S0, shortK, T, R, sigma0, side) - bsPrice(S0, longK, T, R, sigma0, side)) * 100;
  if (credit < 5) return null;
  const width = Math.abs(shortK - longK) * 100, maxLoss = width - credit;
  if (!(maxLoss > 0)) return null;
  const exp = addDays(entryDate, P.dteTarget);
  for (let i = ei + 1; i < bars.length; i++) {
    const bar = bars[i];
    const out = pnl => ({ pnl, returnPct: pnl / maxLoss * 100 });
    if (bar.date >= exp) {
      const intr = side === 'put'
        ? (Math.max(0, shortK - bar.close) - Math.max(0, longK - bar.close)) * 100
        : (Math.max(0, bar.close - shortK) - Math.max(0, bar.close - longK)) * 100;
      return out(credit - intr);
    }
    const sig = ivAsOf(bar.date) ?? sigma0;
    const val = (bsPrice(bar.close, shortK, Math.max(0, daysBetween(bar.date, exp)) / 365, R, sig, side)
              - bsPrice(bar.close, longK, Math.max(0, daysBetween(bar.date, exp)) / 365, R, sig, side)) * 100;
    const pnlSoFar = credit - val;
    if (pnlSoFar >= credit * (P.profitTargetPct / 100)) return out(pnlSoFar);
    if (val >= credit * (P.stopLossPct / 100)) return out(pnlSoFar);
  }
  return null;
}

// feats for slicing
const barsDesc = db.prepare(`SELECT date,high,low,close FROM historical_prices WHERE ticker=? AND date<=? ORDER BY date DESC LIMIT 220`);
const ivOne = db.prepare(`SELECT atm_iv FROM iv_history WHERE ticker=? AND date<=? AND atm_iv>0 ORDER BY date DESC LIMIT 1`);
function feats(t, asOf) {
  const b = barsDesc.all(t, asOf); if (b.length < 60) return null;
  const close = b[0].close;
  let tr = 0, k = 0; for (let i = 0; i < 14 && i + 1 < b.length; i++) { const c = b[i], pc = b[i + 1].close; tr += Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)); k++; }
  const atrPct = (tr / k) / close * 100;
  const s50 = b.slice(0, 50).reduce((s, r) => s + r.close, 0) / 50;
  const s200 = b.length >= 200 ? b.slice(0, 200).reduce((s, r) => s + r.close, 0) / 200 : null;
  return { atrPct, regimeUp: s200 != null ? s50 > s200 : null, iv: (ivOne.get(t, asOf) || {}).atm_iv ?? null };
}

const picks = db.prepare(`
  SELECT ro.ticker t, rb.as_of_date asOf, ro.direction dir
  FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
  WHERE rb.strategy='inflection' AND ro.direction IS NOT NULL
`).all();

let skipped = 0;
const rows = [];
for (const p of picks) {
  const r = simSpread(p.t, p.asOf, p.dir > 0 ? 1 : -1);
  if (!r) { skipped++; continue; }
  rows.push({ ...p, ...r, f: feats(p.t, p.asOf) });
}

function agg(label, rs) {
  if (!rs.length) { console.log(`${label.padEnd(30)} n=   0`); return; }
  const wins = rs.filter(r => r.pnl > 0).length;
  const avgRet = rs.reduce((s, r) => s + r.returnPct, 0) / rs.length;
  const avgPnl = rs.reduce((s, r) => s + r.pnl, 0) / rs.length;
  console.log(`${label.padEnd(30)} n=${String(rs.length).padStart(4)}  win=${(wins / rs.length * 100).toFixed(1).padStart(5)}%  avgRet/maxloss=${avgRet.toFixed(1).padStart(6)}%  avg$P&L=${avgPnl.toFixed(0).padStart(5)}`);
}
function terc(rs, key, label) {
  const v = rs.filter(r => r.f && r.f[key] != null).sort((a, b) => a.f[key] - b.f[key]);
  if (v.length < 30) return;
  const t = Math.floor(v.length / 3);
  console.log(`  -- ${label} --`);
  agg(`    LOW (${v[0].f[key].toFixed(1)}..${v[t - 1].f[key].toFixed(1)})`, v.slice(0, t));
  agg(`    MID`, v.slice(t, 2 * t));
  agg(`    HIGH(${v[2 * t].f[key].toFixed(1)}..${v[v.length - 1].f[key].toFixed(1)})`, v.slice(2 * t));
}

const up = rows.filter(r => r.dir > 0), down = rows.filter(r => r.dir < 0);
console.log(`resolved ${rows.length}/${picks.length} picks (skipped ${skipped} — too recent / no IV)\n`);
console.log('=== headline (real spread P&L) ===');
agg('ALL inflection', rows); agg('  up (bull put)', up); agg('  down (bear call)', down);
console.log('\n=== THREAD 1: up-breakout by 50/200 regime ===');
agg('up regime AGREES', up.filter(r => r.f && r.f.regimeUp === true));
agg('up regime DISAGREES', up.filter(r => r.f && r.f.regimeUp === false));
console.log('\n=== THREAD 2: down-breakout by ATR% and IV (credit-correct) ===');
terc(down, 'atrPct', 'ATR%');
terc(down, 'iv', 'ATM IV');
db.close();
