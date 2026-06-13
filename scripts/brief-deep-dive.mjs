import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const today = new Date().toISOString().slice(0, 10);

// Most recent brief run
const latestGen = db.prepare('SELECT MAX(generated_at) as g FROM daily_briefs').get().g;
const briefRows = db.prepare(`
  SELECT strategy, picks, run_meta, generated_at, valid_until
  FROM daily_briefs WHERE date(generated_at) = date(?) ORDER BY strategy
`).all(latestGen);

console.log('\n='.repeat(62));
console.log('  Daily Brief Deep-Dive  |  today=' + today);
console.log('='.repeat(62));
console.log('  Most recent brief: ' + latestGen.slice(0,19) + ' UTC');
console.log('  Valid until:       ' + (briefRows[0]?.valid_until?.slice(0,16) ?? '?'));
console.log('  Strategies in run: ' + briefRows.map(r => r.strategy).join(', '));
if (!latestGen.startsWith(today)) {
  console.log('  ** NOTE: No brief for ' + today + ' yet — showing ' + latestGen.slice(0,10) + ' run **');
}

const strategies = ['bullish','bearish','buy','income','wheel'];
const allPicks = {};
for (const row of briefRows) {
  try { allPicks[row.strategy] = JSON.parse(row.picks); }
  catch { allPicks[row.strategy] = []; }
}

// ── PICKS WITH VERDICTS ───────────────────────────────────────────────────────
console.log('\n' + '-'.repeat(62));
console.log('  STRATEGY PICKS');
console.log('-'.repeat(62));
for (const strat of strategies) {
  const picks = allPicks[strat] ?? [];
  console.log('\n  ' + strat.toUpperCase() + ' (' + picks.length + ' picks):');
  if (!picks.length) { console.log('    (no picks)'); continue; }
  for (const p of picks) {
    const cv      = typeof p.criticVerdict === 'object' && p.criticVerdict !== null ? p.criticVerdict : {};
    const verdict = cv.verdict ?? String(p.criticVerdict ?? '—');
    const conf    = cv.confidence ? ' (' + cv.confidence + ')' : '';
    const flags   = cv.flags ?? [];
    const warns   = flags.filter(f => f.severity !== 'info');
    const infos   = flags.filter(f => f.severity === 'info');
    const grade   = p.strategyLabResult?.scores?.[0]?.grade ?? '—';
    const struct  = (p.strategyLabResult?.scores?.[0]?.name ?? '—').slice(0, 20);
    const stockFlag = p.presentAsStock ? ' [stock-only]' : '';
    const wStr = warns.length ? '  WARN=[' + warns.map(f=>f.key).join(', ') + ']' : '';
    const iStr = infos.length ? '  info=[' + infos.map(f=>f.key).join(', ') + ']' : '';
    console.log('    ' + String(p.rank).padStart(2) + '. ' + p.ticker.padEnd(6) +
      '  score=' + p.compositeScore.toFixed(1) +
      '  $' + (p.price?.toFixed(2) ?? '?') +
      '  verdict=' + verdict + conf +
      '  grade=' + grade + '  [' + struct + ']' + stockFlag + wStr + iStr);
  }
}

// ── SCORING SIGNALS ───────────────────────────────────────────────────────────
console.log('\n\n' + '-'.repeat(62));
console.log('  SCORING SIGNALS  (norm_score x weight, * = missing/null)');
console.log('-'.repeat(62));
for (const strat of strategies) {
  const picks = allPicks[strat] ?? [];
  if (!picks.length) continue;
  console.log('\n  ' + strat.toUpperCase() + ':');
  for (const p of picks) {
    const sigs = p.signals ?? {};
    const parts = Object.entries(sigs).map(([k, v]) => {
      const label = k.replace(/([A-Z])/g, '_$1').toLowerCase();
      return label + '=' + (v?.normalized ?? 0).toFixed(0) + '(w' + (v?.weight ?? 0) + (v?.missing ? '*' : '') + ')';
    });
    const missing = Object.entries(sigs).filter(([, v]) => v?.missing).map(([k]) => k);
    console.log('    ' + p.ticker.padEnd(6) + ' ' + parts.join('  '));
    if (missing.length) console.log('           MISSING: ' + missing.join(', '));
  }
}

// ── CRITIC RATIONALES ─────────────────────────────────────────────────────────
console.log('\n\n' + '-'.repeat(62));
console.log('  CRITIC RATIONALES');
console.log('-'.repeat(62));
for (const strat of strategies) {
  const picks = allPicks[strat] ?? [];
  if (!picks.length) continue;
  console.log('\n  ' + strat.toUpperCase() + ':');
  for (const p of picks) {
    const cv = typeof p.criticVerdict === 'object' && p.criticVerdict !== null ? p.criticVerdict : {};
    const flags = cv.flags ?? [];
    console.log('    ' + p.ticker + ' [' + (cv.verdict ?? '?') + '/' + (cv.confidence ?? '?') + ']: ' + (cv.rationale ?? '').slice(0, 250));
    for (const f of flags) {
      console.log('      [' + f.severity?.toUpperCase() + '] ' + f.key + ': ' + (f.description ?? '').slice(0, 100));
    }
  }
}

// ── VERDICT SUMMARY ───────────────────────────────────────────────────────────
console.log('\n\n' + '-'.repeat(62));
console.log('  VERDICT SUMMARY');
console.log('-'.repeat(62));
let total = 0, pass = 0, caution = 0, flagV = 0;
const ruleCounts = {};
for (const strat of strategies) {
  for (const p of (allPicks[strat] ?? [])) {
    total++;
    const cv = typeof p.criticVerdict === 'object' ? p.criticVerdict : {};
    const v = cv.verdict ?? '';
    if (v === 'pass') pass++; else if (v === 'caution') caution++; else if (v === 'flag') flagV++;
    for (const f of (cv.flags ?? [])) {
      const key = f.rule + ' [' + f.severity + ']';
      ruleCounts[key] = (ruleCounts[key] ?? 0) + 1;
    }
  }
}
console.log('  Total=' + total + '  pass=' + pass + '  caution=' + caution + '  flag=' + flagV);
for (const [k, n] of Object.entries(ruleCounts).sort((a, b) => b[1] - a[1])) {
  console.log('    ' + String(n).padStart(2) + 'x  ' + k);
}

// ── SPY REGIME ────────────────────────────────────────────────────────────────
console.log('\n\n' + '-'.repeat(62));
console.log('  MARKET CONTEXT (SPY regime)');
console.log('-'.repeat(62));
const spy = db.prepare('SELECT date, close FROM historical_prices WHERE ticker=? ORDER BY date DESC LIMIT 200').all('SPY');
if (spy.length >= 50) {
  const close = spy[0].close, date = spy[0].date;
  const sma50  = spy.slice(0, 50).reduce((s, r) => s + r.close, 0) / 50;
  const sma200 = spy.length >= 200 ? spy.slice(0, 200).reduce((s, r) => s + r.close, 0) / 200 : null;
  const regime = close > sma50 ? 'BULLISH' : 'BEARISH';
  console.log('  SPY $' + close.toFixed(2) + ' on ' + date + '  SMA50=$' + sma50.toFixed(2) + (sma200 ? '  SMA200=$' + sma200.toFixed(2) : ''));
  console.log('  Regime: ' + regime + '  => bearish picks are ' + (regime === 'BULLISH' ? 'REGIME RISK (hist HR ~25%)' : 'regime-aligned (hist HR ~79%)'));
}

// ── SNAPSHOT FRESHNESS ────────────────────────────────────────────────────────
console.log('\n\n' + '-'.repeat(62));
console.log('  SNAPSHOT FRESHNESS & IV RANK');
console.log('-'.repeat(62));
const allTickers = [...new Set(strategies.flatMap(s => (allPicks[s] ?? []).map(p => p.ticker)))];
if (allTickers.length > 0) {
  const ph = allTickers.map(() => '?').join(',');
  const genDate = latestGen.slice(0, 10);
  const snaps = db.prepare(
    'SELECT ticker, as_of_date, trend_label, rsi, iv_rank, price_last FROM analysis_snapshots WHERE ticker IN (' + ph + ') ORDER BY ticker, as_of_date DESC'
  ).all(...allTickers).filter((r, i, a) => i === a.findIndex(x => x.ticker === r.ticker));

  let nullIvr = 0, staleSnap = 0;
  for (const s of snaps) {
    const ivFlag  = s.iv_rank === null ? ' WARN:IV_RANK_NULL' : '';
    const ageFlag = s.as_of_date < genDate ? ' WARN:STALE(' + s.as_of_date + ')' : '';
    if (s.iv_rank === null) nullIvr++;
    if (s.as_of_date < genDate) staleSnap++;
    const ok = !ivFlag && !ageFlag ? ' OK' : '';
    console.log('  ' + s.ticker.padEnd(6) + ' snap=' + s.as_of_date + '  trend=' + (s.trend_label ?? '—') +
      '  rsi=' + (s.rsi?.toFixed(1) ?? '—') + '  ivr=' + (s.iv_rank?.toFixed(0) ?? 'null') + ivFlag + ageFlag + ok);
  }
  const missing = allTickers.filter(t => !snaps.find(s => s.ticker === t));
  if (missing.length) console.log('  NO SNAPSHOT: ' + missing.join(', '));
  console.log('\n  Summary: null_ivr=' + nullIvr + '/' + allTickers.length + '  stale/missing=' + (staleSnap + missing.length) + '/' + allTickers.length);
}

// ── BATCH JOB STATUS ──────────────────────────────────────────────────────────
console.log('\n\n' + '-'.repeat(62));
console.log('  BATCH JOB LAST RUNS');
console.log('-'.repeat(62));
const batchJobs = db.prepare(`
  SELECT bj.name as job_name, bj.sequence_order,
    (SELECT started_at FROM batch_runs WHERE job_id=bj.id ORDER BY started_at DESC LIMIT 1) as last_started,
    (SELECT status   FROM batch_runs WHERE job_id=bj.id ORDER BY started_at DESC LIMIT 1) as last_status
  FROM batch_jobs bj ORDER BY sequence_order
`).all();
for (const r of batchJobs) {
  const isToday = r.last_started?.startsWith(today) ? ' <<TODAY' : '';
  const isRecent = r.last_started?.startsWith(latestGen.slice(0,10)) ? ' <<brief_day' : '';
  console.log('  ' + (r.job_name ?? '?').padEnd(40) + (r.last_started ?? 'never').slice(0, 16) + '  ' + (r.last_status ?? '—') + isToday + isRecent);
}

// ── ANOMALIES ─────────────────────────────────────────────────────────────────
console.log('\n\n' + '-'.repeat(62));
console.log('  ANOMALY CHECKS');
console.log('-'.repeat(62));
const anomalies = [];
for (const strat of strategies) {
  for (const p of (allPicks[strat] ?? [])) {
    if ((p.compositeScore ?? 0) < 20) anomalies.push('LOW_SCORE: ' + strat + '/' + p.ticker + ' score=' + p.compositeScore);
    if (!p.criticVerdict) anomalies.push('NO_CRITIC: ' + strat + '/' + p.ticker);
    const sigs = p.signals ?? {};
    const missingCount = Object.values(sigs).filter(v => v?.missing).length;
    const totalSigs = Object.keys(sigs).length;
    if (totalSigs > 0 && missingCount / totalSigs > 0.4) {
      anomalies.push('MANY_MISSING_SIGS: ' + strat + '/' + p.ticker + ' ' + missingCount + '/' + totalSigs + ' missing');
    }
  }
}
const bullSet = new Set((allPicks['bullish'] ?? []).map(p => p.ticker));
const bearSet = new Set((allPicks['bearish'] ?? []).map(p => p.ticker));
for (const t of bullSet) {
  if (bearSet.has(t)) anomalies.push('DIRECTION_CONFLICT: ' + t + ' in both bullish AND bearish');
}
if (!anomalies.length) console.log('  No anomalies detected -- all checks pass.');
else anomalies.forEach(a => console.log('  ** ' + a));

console.log('\n' + '='.repeat(62) + '\n');
db.close();
