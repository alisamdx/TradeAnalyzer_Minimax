import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const pct = (n, total) => total > 0 ? (n / total * 100).toFixed(1) + '%' : '—';
const avg = (arr) => arr.length ? arr.reduce((s,v) => s+v, 0) / arr.length : null;
const med = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a,b)=>a-b); const m = Math.floor(s.length/2); return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };
const fmt = (v) => v === null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
const fmtN = (v) => v === null ? '—' : v.toFixed(1) + '%';
const W = 70;
const line  = () => console.log('='.repeat(W));
const dline = () => console.log('-'.repeat(W));
const hdr   = (s) => { line(); console.log('  ' + s); dline(); };

// ── Load all replay data ──────────────────────────────────────────────────────
const rows = db.prepare(`
  SELECT rb.as_of_date, rb.strategy,
    rb.picks,
    ro.ticker, ro.rank, ro.composite_score, ro.entry_price,
    ro.ret_5d, ro.ret_10d, ro.ret_21d, ro.max_drawdown_21d,
    ro.synth_strike, ro.stayed_above_strike, ro.close_price, ro.close_date
  FROM replay_briefs rb
  JOIN replay_outcomes ro ON ro.replay_brief_id = rb.id
  ORDER BY rb.as_of_date, rb.strategy, ro.rank
`).all();

// SPY regime map
const spyPrices = db.prepare(`SELECT date, close FROM historical_prices WHERE ticker='SPY' ORDER BY date`).all();
const regimeMap = new Map();
const allDates = [...new Set(rows.map(r => r.as_of_date))].sort();
for (const date of allDates) {
  let endIdx = -1;
  for (let i = spyPrices.length - 1; i >= 0; i--) {
    if (spyPrices[i].date <= date) { endIdx = i; break; }
  }
  if (endIdx < 49) continue;
  const close = spyPrices[endIdx].close;
  const sma50 = spyPrices.slice(endIdx - 49, endIdx + 1).reduce((s,p) => s+p.close, 0) / 50;
  regimeMap.set(date, close > sma50 ? 'bull' : 'bear');
}

// Parse picks JSON for critic verdict
const criticMap = new Map(); // "date|strategy|ticker" => verdict
for (const rb of db.prepare('SELECT as_of_date, strategy, picks FROM replay_briefs').all()) {
  try {
    const picks = JSON.parse(rb.picks);
    for (const p of picks) {
      const cv = typeof p.criticVerdict === 'object' && p.criticVerdict !== null ? p.criticVerdict : {};
      criticMap.set(rb.as_of_date + '|' + rb.strategy + '|' + p.ticker, cv.verdict ?? null);
    }
  } catch {}
}

const strategies = ['buy', 'bullish', 'income', 'wheel', 'bearish'];
const strats = {};
for (const s of strategies) strats[s] = rows.filter(r => r.strategy === s);

// Helper: compute stats for a set of rows
function stats(rows) {
  const r5 = rows.filter(r => r.ret_5d !== null).map(r => r.ret_5d);
  const r10 = rows.filter(r => r.ret_10d !== null).map(r => r.ret_10d);
  const r21 = rows.filter(r => r.ret_21d !== null).map(r => r.ret_21d);
  const dd = rows.filter(r => r.max_drawdown_21d !== null).map(r => r.max_drawdown_21d);
  const win5  = r5.filter(v => v > 0).length;
  const win21 = r21.filter(v => v > 0).length;
  return {
    n: rows.length,
    avg5: avg(r5), avg10: avg(r10), avg21: avg(r21),
    med21: med(r21),
    hr5: r5.length ? win5/r5.length : null,
    hr21: r21.length ? win21/r21.length : null,
    avgDd: avg(dd),
  };
}

// ── §1 OVERALL SUMMARY ────────────────────────────────────────────────────────
hdr('§1  OVERALL STRATEGY SUMMARY  (May 2025 – Jun 2026, ' + allDates.length + ' dates)');
console.log('  Strategy  Picks   5d avg  10d avg  21d avg  med21d  HR5    HR21   MaxDD');
dline();
for (const s of strategies) {
  const st = stats(strats[s]);
  console.log(
    '  ' + s.padEnd(8) +
    String(st.n).padStart(5) + '  ' +
    fmt(st.avg5).padStart(7) + '  ' +
    fmt(st.avg10).padStart(7) + '  ' +
    fmt(st.avg21).padStart(7) + '  ' +
    fmt(st.med21).padStart(7) + '  ' +
    (st.hr5 !== null ? (st.hr5*100).toFixed(0)+'%' : '—').padStart(5) + '  ' +
    (st.hr21 !== null ? (st.hr21*100).toFixed(0)+'%' : '—').padStart(5) + '  ' +
    fmt(st.avgDd).padStart(7)
  );
}

// ── §2 SPY REGIME SPLIT ───────────────────────────────────────────────────────
hdr('§2  SPY REGIME SPLIT  (bull = SPY > 50-day SMA)');
const bullDates = allDates.filter(d => regimeMap.get(d) === 'bull');
const bearDates = allDates.filter(d => regimeMap.get(d) === 'bear');
console.log('  Bull regime dates: ' + bullDates.length + '   Bear regime dates: ' + bearDates.length);
console.log();
console.log('  Strategy  Regime  Picks  21d avg  HR21   │  Picks  21d avg  HR21');
console.log('            BULL ──────────────────────────│── BEAR ─────────────');
dline();
for (const s of strategies) {
  const bull = strats[s].filter(r => regimeMap.get(r.as_of_date) === 'bull');
  const bear = strats[s].filter(r => regimeMap.get(r.as_of_date) === 'bear');
  const sb = stats(bull), sr = stats(bear);
  console.log(
    '  ' + s.padEnd(8) + '  BULL' +
    String(sb.n).padStart(7) + '  ' + fmt(sb.avg21).padStart(7) + '  ' +
    (sb.hr21 !== null ? (sb.hr21*100).toFixed(0)+'%' : '—').padStart(5) +
    '  │  BEAR' +
    String(sr.n).padStart(5) + '  ' + fmt(sr.avg21).padStart(7) + '  ' +
    (sr.hr21 !== null ? (sr.hr21*100).toFixed(0)+'%' : '—').padStart(5)
  );
}

// ── §3 MONTHLY BREAKDOWN ──────────────────────────────────────────────────────
hdr('§3  MONTHLY HIT RATE (21d) BY STRATEGY');
const months = [...new Set(allDates.map(d => d.slice(0,7)))].sort();
// Header
const monthCols = months.map(m => m.slice(5)); // MM
console.log('  Strategy  ' + monthCols.map(m => m.padStart(5)).join('  '));
dline();
for (const s of strategies) {
  const cols = months.map(ym => {
    const r = strats[s].filter(row => row.as_of_date.startsWith(ym) && row.ret_21d !== null);
    if (!r.length) return '  — ';
    const hr = r.filter(x => x.ret_21d > 0).length / r.length * 100;
    return (hr.toFixed(0) + '%').padStart(5);
  });
  console.log('  ' + s.padEnd(8) + '  ' + cols.join('  '));
}
console.log();
console.log('  (regime: bull=B bear=R)');
const regimeLine = months.map(ym => {
  const ds = allDates.filter(d => d.startsWith(ym));
  const bs = ds.filter(d => regimeMap.get(d) === 'bull').length;
  const br = ds.filter(d => regimeMap.get(d) === 'bear').length;
  if (bs > br * 2) return '  B  ';
  if (br > bs * 2) return '  R  ';
  return ' mix ';
});
console.log('  regime    ' + regimeLine.join('  '));

// ── §4 MONTHLY AVG RETURN (21d) ───────────────────────────────────────────────
hdr('§4  MONTHLY AVG RETURN (21d) BY STRATEGY');
console.log('  Strategy  ' + monthCols.map(m => m.padStart(6)).join(' '));
dline();
for (const s of strategies) {
  const cols = months.map(ym => {
    const r = strats[s].filter(row => row.as_of_date.startsWith(ym) && row.ret_21d !== null);
    if (!r.length) return '   — ';
    const a = avg(r.map(x => x.ret_21d));
    return (a >= 0 ? '+' : '') + a.toFixed(1) + '%';
  });
  console.log('  ' + s.padEnd(8) + '  ' + cols.map(c => c.padStart(6)).join(' '));
}

// ── §5 SCORE QUINTILE ANALYSIS ────────────────────────────────────────────────
hdr('§5  COMPOSITE SCORE QUINTILE → OUTCOME  (21d return)');
console.log('  Strategy  Q1(lo)   Q2      Q3      Q4      Q5(hi)   score_r2');
dline();
for (const s of strategies) {
  const r = strats[s].filter(x => x.composite_score !== null && x.ret_21d !== null);
  if (r.length < 20) { console.log('  ' + s + ': insufficient data'); continue; }
  r.sort((a, b) => a.composite_score - b.composite_score);
  const chunk = Math.floor(r.length / 5);
  const quintiles = [0,1,2,3,4].map(i => {
    const slice = r.slice(i * chunk, i === 4 ? r.length : (i+1)*chunk);
    return avg(slice.map(x => x.ret_21d));
  });
  // Rank correlation score vs ret_21d (Spearman approx via Pearson on ranks)
  const n = r.length;
  const scores = r.map(x => x.composite_score);
  const rets   = r.map(x => x.ret_21d);
  const meanS = avg(scores), meanR = avg(rets);
  const cov = scores.reduce((s,v,i) => s + (v-meanS)*(rets[i]-meanR), 0) / n;
  const sdS = Math.sqrt(scores.reduce((s,v) => s+(v-meanS)**2, 0)/n);
  const sdR = Math.sqrt(rets.reduce((s,v) => s+(v-meanR)**2, 0)/n);
  const r2 = sdS > 0 && sdR > 0 ? (cov/(sdS*sdR)).toFixed(2) : '—';
  console.log(
    '  ' + s.padEnd(8) + '  ' +
    quintiles.map(q => fmt(q).padStart(7)).join('  ') + '   r=' + r2
  );
}

// ── §6 RANK POSITION WITHIN BRIEF ────────────────────────────────────────────
hdr('§6  PICK RANK WITHIN BRIEF → OUTCOME  (21d avg return)');
console.log('  "Does rank 1 outperform rank 5?" — tests whether ordering is meaningful');
console.log();
console.log('  Strategy  Rank-1   Rank-2   Rank-3   Rank-4   Rank-5+');
dline();
for (const s of strategies) {
  const cols = [1,2,3,4,'5+'].map(rank => {
    const r = strats[s].filter(x => {
      if (rank === '5+') return x.rank >= 5 && x.ret_21d !== null;
      return x.rank === rank && x.ret_21d !== null;
    });
    return r.length ? avg(r.map(x => x.ret_21d)) : null;
  });
  console.log('  ' + s.padEnd(8) + '  ' + cols.map(c => fmt(c).padStart(7)).join('  '));
}

// ── §7 CRITIC VERDICT CORRELATION ────────────────────────────────────────────
hdr('§7  CRITIC VERDICT → ACTUAL OUTCOME  (21d avg return + HR)');
console.log('  Strategy  Verdict   Picks   21d avg   HR21');
dline();
for (const s of strategies) {
  for (const verdict of ['pass', 'caution', 'flag', null]) {
    const r = strats[s].filter(x => {
      const v = criticMap.get(x.as_of_date + '|' + x.strategy + '|' + x.ticker) ?? null;
      return v === verdict && x.ret_21d !== null;
    });
    if (!r.length) continue;
    const a = avg(r.map(x => x.ret_21d));
    const hr = r.filter(x => x.ret_21d > 0).length / r.length;
    const vLabel = (verdict ?? 'unknown').padEnd(7);
    console.log(
      '  ' + s.padEnd(8) + '  ' + vLabel + '  ' +
      String(r.length).padStart(5) + '   ' +
      fmt(a).padStart(8) + '   ' +
      (hr*100).toFixed(0) + '%'
    );
  }
  console.log();
}

// ── §8 TOP RECURRING WINNERS & LOSERS ─────────────────────────────────────────
hdr('§8  TOP RECURRING TICKERS — 21d return (≥4 appearances)');
for (const s of strategies) {
  const byTicker = {};
  for (const row of strats[s].filter(x => x.ret_21d !== null)) {
    if (!byTicker[row.ticker]) byTicker[row.ticker] = [];
    byTicker[row.ticker].push(row.ret_21d);
  }
  const summary = Object.entries(byTicker)
    .filter(([, arr]) => arr.length >= 4)
    .map(([t, arr]) => ({ t, n: arr.length, avg: avg(arr), hr: arr.filter(v=>v>0).length/arr.length }))
    .sort((a, b) => b.avg - a.avg);
  if (!summary.length) continue;
  console.log('  ' + s.toUpperCase() + ':');
  console.log('    Best:');
  for (const x of summary.slice(0, 5))
    console.log('      ' + x.t.padEnd(6) + ' n=' + x.n + '  avg=' + fmt(x.avg) + '  HR=' + (x.hr*100).toFixed(0) + '%');
  console.log('    Worst:');
  for (const x of summary.slice(-5).reverse())
    console.log('      ' + x.t.padEnd(6) + ' n=' + x.n + '  avg=' + fmt(x.avg) + '  HR=' + (x.hr*100).toFixed(0) + '%');
  console.log();
}

// ── §9 WHEEL/INCOME: STRIKE RETENTION ────────────────────────────────────────
hdr('§9  WHEEL/INCOME — STAYED ABOVE STRIKE (assignment risk)');
for (const s of ['wheel', 'income']) {
  const r = strats[s].filter(x => x.synth_strike !== null && x.stayed_above_strike !== null);
  if (!r.length) { console.log('  ' + s + ': no strike data'); continue; }
  const total = r.length;
  const safe  = r.filter(x => x.stayed_above_strike === 1).length;
  const byMonth = {};
  for (const row of r) {
    const ym = row.as_of_date.slice(0,7);
    if (!byMonth[ym]) byMonth[ym] = { safe: 0, total: 0 };
    byMonth[ym].total++;
    if (row.stayed_above_strike === 1) byMonth[ym].safe++;
  }
  console.log('  ' + s.toUpperCase() + ': stayed-above-strike ' + safe + '/' + total + ' (' + (safe/total*100).toFixed(0) + '%)');
  const monthLine = Object.entries(byMonth).sort().map(([ym, v]) =>
    ym.slice(5) + ':' + (v.safe/v.total*100).toFixed(0) + '%'
  ).join('  ');
  console.log('    Monthly: ' + monthLine);
  console.log();
}

// ── §10 MAX DRAWDOWN PROFILE ──────────────────────────────────────────────────
hdr('§10  MAX DRAWDOWN PROFILE (21d) BY STRATEGY + REGIME');
console.log('  Strategy  Overall avgDD  Bull avgDD  Bear avgDD  Worst single pick');
dline();
for (const s of strategies) {
  const all = strats[s].filter(x => x.max_drawdown_21d !== null);
  const bull = all.filter(x => regimeMap.get(x.as_of_date) === 'bull');
  const bear = all.filter(x => regimeMap.get(x.as_of_date) === 'bear');
  const worst = all.length ? Math.min(...all.map(x => x.max_drawdown_21d)) : null;
  const worstRow = worst !== null ? all.find(x => x.max_drawdown_21d === worst) : null;
  console.log(
    '  ' + s.padEnd(8) + '  ' +
    fmt(avg(all.map(x=>x.max_drawdown_21d))).padStart(9) + '       ' +
    fmt(avg(bull.map(x=>x.max_drawdown_21d))).padStart(9) + '   ' +
    fmt(avg(bear.map(x=>x.max_drawdown_21d))).padStart(9) + '   ' +
    (worstRow ? worstRow.ticker + ' ' + fmt(worst) + ' (' + worstRow.as_of_date + ')' : '—')
  );
}

// ── §11 HOLD PERIOD COMPARISON ────────────────────────────────────────────────
hdr('§11  RETURN DECAY — DOES HOLDING LONGER HELP? (avg return)');
console.log('  Strategy  5d      10d     21d     best_hold');
dline();
for (const s of strategies) {
  const r5  = strats[s].filter(x => x.ret_5d  !== null).map(x => x.ret_5d);
  const r10 = strats[s].filter(x => x.ret_10d !== null).map(x => x.ret_10d);
  const r21 = strats[s].filter(x => x.ret_21d !== null).map(x => x.ret_21d);
  const a5 = avg(r5), a10 = avg(r10), a21 = avg(r21);
  const best = a5 !== null && a10 !== null && a21 !== null
    ? [['5d',a5],['10d',a10],['21d',a21]].sort((a,b)=>b[1]-a[1])[0][0]
    : '—';
  console.log(
    '  ' + s.padEnd(8) + '  ' +
    fmt(a5).padStart(6) + '  ' + fmt(a10).padStart(6) + '  ' + fmt(a21).padStart(6) + '  → ' + best
  );
}

// ── §12 REGIME TIMING: TRANSITION PERIODS ────────────────────────────────────
hdr('§12  REGIME TRANSITIONS — WHAT HAPPENS AROUND TURNS');
// Find regime transition dates
const transitions = [];
for (let i = 1; i < allDates.length; i++) {
  const prev = regimeMap.get(allDates[i-1]);
  const curr = regimeMap.get(allDates[i]);
  if (prev && curr && prev !== curr) {
    transitions.push({ date: allDates[i], from: prev, to: curr });
  }
}
console.log('  Regime changes detected: ' + transitions.length);
for (const t of transitions) {
  // Performance of buys/bulls 10 days before and after
  const daysBefore = allDates.filter(d => d < t.date).slice(-10);
  const daysAfter  = allDates.filter(d => d >= t.date).slice(0, 10);
  for (const s of ['buy', 'bullish', 'bearish']) {
    const before = strats[s].filter(x => daysBefore.includes(x.as_of_date) && x.ret_21d !== null);
    const after  = strats[s].filter(x => daysAfter.includes(x.as_of_date) && x.ret_21d !== null);
    if (!before.length && !after.length) continue;
    console.log(
      '  ' + t.date + ' ' + t.from.toUpperCase() + '→' + t.to.toUpperCase() +
      '  ' + s + ':  before=' + fmt(avg(before.map(x=>x.ret_21d))) + '  after=' + fmt(avg(after.map(x=>x.ret_21d)))
    );
  }
  console.log();
}

// ── §13 STRATEGY CORRELATION ──────────────────────────────────────────────────
hdr('§13  DATE-LEVEL CORRELATION — DO STRATEGIES MOVE TOGETHER?');
console.log('  When BUY does well, do other strategies also do well on the same date?');
console.log();
// Per-date avg 21d return
const dateAvg = {};
for (const s of strategies) {
  dateAvg[s] = {};
  for (const d of allDates) {
    const r = strats[s].filter(x => x.as_of_date === d && x.ret_21d !== null);
    if (r.length) dateAvg[s][d] = avg(r.map(x => x.ret_21d));
  }
}
const commonDates = allDates.filter(d => strategies.every(s => dateAvg[s][d] !== undefined));
console.log('  Dates with all 5 strategies: ' + commonDates.length);
console.log();
console.log('  Correlation matrix (Pearson, date-level avg 21d return):');
console.log('           ' + strategies.map(s => s.slice(0,6).padStart(8)).join(''));
for (const s1 of strategies) {
  const row = strategies.map(s2 => {
    const x = commonDates.map(d => dateAvg[s1][d]);
    const y = commonDates.map(d => dateAvg[s2][d]);
    const mx = avg(x), my = avg(y);
    const cov = x.reduce((s,v,i) => s + (v-mx)*(y[i]-my), 0) / x.length;
    const sx = Math.sqrt(x.reduce((s,v)=>s+(v-mx)**2,0)/x.length);
    const sy = Math.sqrt(y.reduce((s,v)=>s+(v-my)**2,0)/y.length);
    return sx > 0 && sy > 0 ? (cov/(sx*sy)).toFixed(2) : '1.00';
  });
  console.log('  ' + s1.padEnd(9) + row.map(v => v.padStart(8)).join(''));
}

// ── §14 SCORE THRESHOLD — DOES FILTERING HIGH SCORES HELP? ───────────────────
hdr('§14  SCORE THRESHOLD FILTER — WHAT IF YOU ONLY TOOK HIGH-SCORE PICKS?');
console.log('  Strategy  All picks    Score≥60       Score≥70       Score≥80');
console.log('            avg21 HR21   avg21 HR21     avg21 HR21     avg21 HR21');
dline();
for (const s of strategies) {
  const all = strats[s].filter(x => x.ret_21d !== null);
  const s60 = all.filter(x => x.composite_score >= 60);
  const s70 = all.filter(x => x.composite_score >= 70);
  const s80 = all.filter(x => x.composite_score >= 80);
  const cell = (r) => {
    if (!r.length) return '   —     —  ';
    const a = avg(r.map(x=>x.ret_21d));
    const hr = r.filter(x=>x.ret_21d>0).length/r.length;
    return fmt(a).padStart(6) + ' ' + (hr*100).toFixed(0).padStart(2) + '%';
  };
  console.log(
    '  ' + s.padEnd(8) + '  ' +
    (String(all.length)+'p').padEnd(5) + cell(all) + '   ' +
    (String(s60.length)+'p').padEnd(5) + cell(s60) + '   ' +
    (String(s70.length)+'p').padEnd(5) + cell(s70) + '   ' +
    (String(s80.length)+'p').padEnd(5) + cell(s80)
  );
}

// ── §15 SIGNAL COVERAGE GAPS ──────────────────────────────────────────────────
hdr('§15  MISSING SIGNAL FREQUENCY (how often are key signals null?)');
const signalCounts = {};
const sigMissing = {};
for (const rb of db.prepare('SELECT strategy, picks FROM replay_briefs').all()) {
  try {
    const picks = JSON.parse(rb.picks);
    for (const p of picks) {
      for (const [key, v] of Object.entries(p.signals ?? {})) {
        const k = rb.strategy + ':' + key;
        signalCounts[k] = (signalCounts[k] ?? 0) + 1;
        if (v?.missing) sigMissing[k] = (sigMissing[k] ?? 0) + 1;
      }
    }
  } catch {}
}
// Top missing per strategy
for (const s of strategies) {
  const entries = Object.entries(sigMissing)
    .filter(([k]) => k.startsWith(s + ':'))
    .map(([k, m]) => ({ sig: k.slice(s.length+1), miss: m, total: signalCounts[k] ?? 1 }))
    .sort((a,b) => b.miss/b.total - a.miss/a.total)
    .slice(0, 5);
  if (!entries.length) continue;
  console.log('  ' + s.toUpperCase() + ':');
  for (const e of entries)
    console.log('    ' + e.sig.padEnd(28) + (e.miss/e.total*100).toFixed(0) + '% missing  (' + e.miss + '/' + e.total + ')');
}

line();
console.log('  END OF ANALYSIS  (' + rows.length + ' outcome rows, ' + allDates.length + ' dates, ' + strategies.length + ' strategies)');
line();

db.close();
