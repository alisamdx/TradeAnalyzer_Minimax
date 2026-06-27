// FR-SEY-6 (draft) — Gap-risk entry filter for short-premium, validated on Brief Replay.
// Thesis (NEW_FRONTIER.md §3.3 / §9): short premium has negative EV on names that gap harder
// than their IV implies. GapRiskScore = (trailing 95th-pctile ADVERSE overnight gap) / (IV-implied
// daily move). >1 ⇒ underpaid for jump risk. A/B = drop high-gap-risk picks, measure realized
// spread P&L (mean, win, and crucially the LEFT TAIL) through the simulateSingleSpread replica.
// Zero new data: entirely off historical_prices + iv_history. Mirror of fr-sey-spread-pnl-confirm.mjs.

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

// ── Gap-risk metric (the new object) ──
// Trailing OHLC bars with open+close, date < asOf (strict — no look-ahead).
const ohlcDesc = db.prepare(`SELECT date,open,close FROM historical_prices WHERE ticker=? AND date<? ORDER BY date DESC LIMIT 260`);
const ivOne = db.prepare(`SELECT atm_iv FROM iv_history WHERE ticker=? AND date<=? AND atm_iv>0 ORDER BY date DESC LIMIT 1`);
const pctile = (sorted, q) => { if (!sorted.length) return null; const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1)))); return sorted[i]; };

// side: 'put' (short downside → adverse = down gaps) | 'call' (short upside → adverse = up gaps)
function gapRiskScore(ticker, asOf, side, window = 252) {
  const b = ohlcDesc.all(ticker, asOf);            // newest first, date < asOf
  if (b.length < 60) return null;
  const use = b.slice(0, Math.min(window + 1, b.length)); // chronological-agnostic: pairs only
  // overnight gap g_t = (open_t - close_{t-1}) / close_{t-1}; b is DESC so close_{t-1} = b[i+1]
  const adverse = [];
  for (let i = 0; i + 1 < use.length; i++) {
    const open_t = use[i].open, prevClose = use[i + 1].close;
    if (!(open_t > 0) || !(prevClose > 0)) continue;
    const g = (open_t - prevClose) / prevClose;
    const adv = side === 'put' ? -g : g;           // adverse-direction magnitude (positive = bad)
    if (adv > 0) adverse.push(adv);
  }
  if (adverse.length < 10) return null;
  adverse.sort((a, b) => a - b);
  const gAdv = pctile(adverse, 0.95);              // P95 adverse gap — inherently mostly ex-earnings
  const worst = adverse[adverse.length - 1];
  const ivPct = (ivOne.get(ticker, asOf) || {}).atm_iv ?? null;
  if (!(ivPct > 0)) return null;
  const mIv = (ivPct / 100) / Math.sqrt(252);      // IV-implied daily move
  return { score: gAdv / mIv, gAdvPct: gAdv * 100, worstPct: worst * 100, ivDailyPct: mIv * 100 };
}

// ── Build sample ──
const picks = db.prepare(`
  SELECT ro.ticker t, rb.as_of_date asOf, ro.direction dir
  FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id=ro.replay_brief_id
  WHERE rb.strategy='inflection' AND ro.direction IS NOT NULL
`).all();

let skippedSim = 0, skippedGap = 0;
const rows = [];
for (const p of picks) {
  const r = simSpread(p.t, p.asOf, p.dir > 0 ? 1 : -1);
  if (!r) { skippedSim++; continue; }
  const side = p.dir > 0 ? 'put' : 'call';
  const g = gapRiskScore(p.t, p.asOf, side);
  if (!g) { skippedGap++; continue; }
  rows.push({ ...p, ...r, gap: g.score, gAdvPct: g.gAdvPct, ivDailyPct: g.ivDailyPct });
}

// ── Aggregations: central tendency AND left tail ──
function stats(rs) {
  if (!rs.length) return null;
  const rets = rs.map(r => r.returnPct).sort((a, b) => a - b);
  const wins = rs.filter(r => r.pnl > 0).length;
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const tailN = Math.max(1, Math.floor(rets.length * 0.10)); // worst decile
  const cvarN = Math.max(1, Math.floor(rets.length * 0.05)); // worst 5%
  return {
    n: rs.length,
    win: wins / rs.length * 100,
    avgRet: mean(rets),
    worstDecile: mean(rets.slice(0, tailN)),
    cvar5: mean(rets.slice(0, cvarN)),
    worst: rets[0],
  };
}
function show(label, rs) {
  const s = stats(rs);
  if (!s) { console.log(`${label.padEnd(26)} n=   0`); return; }
  console.log(`${label.padEnd(26)} n=${String(s.n).padStart(4)}  win=${s.win.toFixed(1).padStart(5)}%  avgRet=${s.avgRet.toFixed(1).padStart(6)}%  worstDecile=${s.worstDecile.toFixed(1).padStart(7)}%  CVaR5=${s.cvar5.toFixed(1).padStart(7)}%  worst=${s.worst.toFixed(0).padStart(5)}%`);
}

const up = rows.filter(r => r.dir > 0);   // bull-put, the validated-profitable book
const down = rows.filter(r => r.dir < 0);
console.log(`resolved ${rows.length}/${picks.length} picks (skipped ${skippedSim} sim, ${skippedGap} gap-metric)\n`);

console.log('=== headline (real spread P&L) ===');
show('ALL inflection', rows);
show('  up (bull put)', up);
show('  down (bear call)', down);

console.log('\n=== gap-risk distribution (up/bull-put book) ===');
const gs = up.map(r => r.gap).sort((a, b) => a - b);
if (gs.length) {
  const q = p => gs[Math.min(gs.length - 1, Math.round(p * (gs.length - 1)))];
  console.log(`  p10=${q(.1).toFixed(2)}  p25=${q(.25).toFixed(2)}  median=${q(.5).toFixed(2)}  p75=${q(.75).toFixed(2)}  p90=${q(.9).toFixed(2)}  max=${q(1).toFixed(2)}`);
  console.log(`  share with score>1 (gaps harder than IV pays): ${(up.filter(r => r.gap > 1).length / up.length * 100).toFixed(0)}%`);
}

console.log('\n=== A/B: cutoff sweep on up-breakout bull-put book (treatment = keep score<=c) ===');
show('  BASELINE (all up)', up);
for (const c of [2.0, 1.5, 1.25, 1.0, 0.8]) {
  const kept = up.filter(r => r.gap <= c);
  const dropped = up.length - kept.length;
  show(`  c<=${c.toFixed(2)} (drop ${(dropped / up.length * 100).toFixed(0)}%)`, kept);
}

console.log('\n=== sanity: the DROPPED tail (high gap-risk) should be the worse cohort ===');
for (const c of [1.5, 1.25, 1.0]) {
  show(`  DROPPED (score>${c.toFixed(2)})`, up.filter(r => r.gap > c));
}

console.log('\n=== gap-risk terciles (up book), monotonicity check ===');
const sortedUp = [...up].sort((a, b) => a.gap - b.gap);
const tt = Math.floor(sortedUp.length / 3);
if (tt >= 10) {
  show(`  LOW gap (${sortedUp[0].gap.toFixed(2)}..${sortedUp[tt - 1].gap.toFixed(2)})`, sortedUp.slice(0, tt));
  show('  MID gap', sortedUp.slice(tt, 2 * tt));
  show(`  HIGH gap (${sortedUp[2 * tt].gap.toFixed(2)}..${sortedUp[sortedUp.length - 1].gap.toFixed(2)})`, sortedUp.slice(2 * tt));
}
db.close();
