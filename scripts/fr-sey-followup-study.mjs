// Two follow-ups on inflection (Brief Replay), using the OTM-expiry-within-buffer spread
// proxy (a credit spread wins if the stock stays within its short-strike buffer at ~21d):
//   bull put  (dir +1): win if ret_21d >= -B ;  bear call (dir -1): win if ret_21d <= +B
//
// Thread 1: does the 50/200 regime filter help the UP side on the spread proxy (not stock-HR)?
// Thread 2: which reconstructed breakout characteristic drives the composite's
//           anti-predictiveness on the DOWN side?  (composite weights: decisiveness 30,
//           volumeSurge 25, breakoutIvRank 25, atrPct 20 — so high composite = high on these.)

import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const picks = db.prepare(`
  SELECT ro.ticker t, rb.as_of_date asOf, ro.direction dir, ro.composite_score cs, ro.ret_21d r21
  FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id = ro.replay_brief_id
  WHERE rb.strategy='inflection' AND ro.direction IS NOT NULL AND ro.ret_21d IS NOT NULL
`).all();

const barsStmt = db.prepare(`SELECT date,high,low,close,volume FROM historical_prices WHERE ticker=? AND date<=? AND close IS NOT NULL ORDER BY date DESC LIMIT 220`);
const ivStmt = db.prepare(`SELECT atm_iv FROM iv_history WHERE ticker=? AND date<=? AND atm_iv>0 ORDER BY date DESC LIMIT 1`);

function feats(t, asOf) {
  const b = barsStmt.all(t, asOf); // most-recent first
  if (b.length < 60) return null;
  const close = b[0].close;
  // ATR14 %
  let tr = 0, k = 0;
  for (let i = 0; i < 14 && i + 1 < b.length; i++) {
    const c = b[i], pc = b[i + 1].close;
    tr += Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)); k++;
  }
  const atrPct = k ? (tr / k) / close * 100 : null;
  // volume surge = today vs avg of prior 20
  const v20 = b.slice(1, 21).reduce((s, r) => s + (r.volume || 0), 0) / 20;
  const volSurge = v20 > 0 ? b[0].volume / v20 : null;
  // prior 10-bar return into the breakout
  const prior10 = b.length > 10 ? close / b[10].close - 1 : null;
  // 50/200 regime
  const s50 = b.slice(0, 50).reduce((s, r) => s + r.close, 0) / 50;
  const s200 = b.length >= 200 ? b.slice(0, 200).reduce((s, r) => s + r.close, 0) / 200 : null;
  const regimeUp = s200 != null ? s50 > s200 : null;
  const iv = (ivStmt.get(t, asOf) || {}).atm_iv ?? null;
  return { atrPct, volSurge, prior10: prior10 != null ? prior10 * 100 : null, regimeUp, iv };
}

const B = 7.5;
const otmWin = (p) => p.dir > 0 ? p.r21 >= -B : p.r21 <= B;
// Normalised expectancy per $1 of spread width, assuming credit = 1/3 width (≈0.30-delta short):
// win → +0.333 ; loss → -(1-0.333). breakeven win rate = 0.667.
const CF = 1 / 3;
const expectancy = (rows) => {
  const w = rows.filter(otmWin).length / rows.length;
  return (w * CF - (1 - w) * (1 - CF));
};
const pct = (k, n) => n ? (k / n * 100).toFixed(1) : '--';
function rep(label, rows) {
  if (!rows.length) { console.log(`${label.padEnd(30)} n=   0`); return; }
  const w = rows.filter(otmWin).length;
  console.log(`${label.padEnd(30)} n=${String(rows.length).padStart(4)}  OTM-win=${pct(w, rows.length).padStart(5)}%  exp/width=${expectancy(rows).toFixed(3).padStart(6)}`);
}

const enriched = picks.map(p => ({ ...p, f: feats(p.t, p.asOf) })).filter(p => p.f);
const up = enriched.filter(p => p.dir > 0);
const down = enriched.filter(p => p.dir < 0);

console.log('=========== THREAD 1: up-breakout (bull put) by 50/200 regime ===========');
console.log('(spread proxy: OTM-win ±7.5%; exp/width breakeven ≈ 0.000 at 66.7% win)');
rep('up — ALL', up);
rep('up — regime AGREES (50>200)', up.filter(p => p.f.regimeUp === true));
rep('up — regime DISAGREES', up.filter(p => p.f.regimeUp === false));

console.log('\n=========== THREAD 2: down-breakout (bear call) by characteristic tercile ===========');
function terciles(rows, key, label) {
  const vals = rows.filter(p => p.f[key] != null).sort((a, b) => a.f[key] - b.f[key]);
  if (vals.length < 30) { console.log(`  ${label}: insufficient`); return; }
  const t = Math.floor(vals.length / 3);
  const lo = vals.slice(0, t), mid = vals.slice(t, 2 * t), hi = vals.slice(2 * t);
  const rng = s => `${s[0].f[key].toFixed(1)}..${s[s.length - 1].f[key].toFixed(1)}`;
  console.log(`  -- ${label} --`);
  rep(`    LOW  (${rng(lo)})`, lo);
  rep(`    MID  (${rng(mid)})`, mid);
  rep(`    HIGH (${rng(hi)})`, hi);
}
rep('down — ALL', down);
terciles(down, 'atrPct', 'ATR% (composite wt 20)');
terciles(down, 'volSurge', 'volume surge (wt 25)');
terciles(down, 'iv', 'ATM IV (breakoutIvRank wt 25)');
terciles(down, 'prior10', 'prior-10d run into breakout (decisiveness-ish)');

// Cross-check: same terciles on the UP side, to see if the driver is down-specific.
console.log('\n----- same terciles on UP side (control) -----');
terciles(up, 'volSurge', 'volume surge');
terciles(up, 'iv', 'ATM IV');
db.close();
