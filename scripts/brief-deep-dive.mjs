// Brief Deep-Dive — sanity-check the latest daily brief before relying on it.
// Shows the ACTUAL strategy-relevant structure each pick presents (not scores[0],
// which is the overall top structure and misleads), scoring signals, critic
// rationales, verdict summary, market context, snapshot freshness, and anomalies.
import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// All six strategies (inflection is the 6th — previously omitted here).
const strategies = ['bullish', 'bearish', 'buy', 'income', 'wheel', 'inflection'];

// Mirror of STRATEGY_RELEVANT_SLUGS (critic-service.ts / daily-intelligence-brief-job.ts)
// so we display the structure the brief actually presents, not the top-graded one.
const SLUGS = {
  wheel: ['short-naked-put', 'covered-call'],
  bullish: ['long-call-vertical', 'big-lizard', 'call-zebra', 'call-butterfly', 'poor-mans-covered-call'],
  bearish: ['long-put-vertical', 'reverse-big-lizard', 'put-zebra', 'put-butterfly', 'poor-mans-covered-put'],
  income: ['short-strangle', 'iron-condor', 'short-straddle', 'dynamic-width-iron-condor', 'iron-fly'],
  buy: ['long-call-vertical', 'call-zebra', 'poor-mans-covered-call', 'call-calendar'],
  inflection: ['short-put-vertical', 'short-call-vertical'],
};
const GRADE = { 'A+': 6, A: 5, B: 4, C: 3, D: 2, F: 1 };
function relevantStructure(lab, strat) {
  const slugs = SLUGS[strat] ?? [];
  const valid = (lab?.scores ?? []).filter(s => slugs.includes(s.slug) && s.setup != null && !s.setup.unavailableReason);
  if (!valid.length) return null;
  if (strat === 'inflection') return valid.reduce((b, s) => (GRADE[s.grade] ?? 0) > (GRADE[b.grade] ?? 0) ? s : b);
  return valid[0];
}

const latestGen = db.prepare('SELECT MAX(generated_at) as g FROM daily_briefs').get().g;
const briefRows = db.prepare(`
  SELECT strategy, picks, run_meta, generated_at, valid_until
  FROM daily_briefs WHERE date(generated_at) = date(?) ORDER BY strategy
`).all(latestGen);

console.log('\n' + '='.repeat(62));
console.log('  Daily Brief Deep-Dive  |  today=' + today);
console.log('='.repeat(62));
console.log('  Most recent brief: ' + latestGen.slice(0, 19) + ' UTC');
console.log('  Valid until:       ' + (briefRows[0]?.valid_until?.slice(0, 16) ?? '?'));
console.log('  Strategies in run: ' + briefRows.map(r => r.strategy).join(', '));
if (!latestGen.startsWith(today)) {
  console.log('  ** NOTE: No brief for ' + today + ' yet — showing ' + latestGen.slice(0, 10) + ' run **');
}

const allPicks = {};
for (const row of briefRows) {
  try { allPicks[row.strategy] = JSON.parse(row.picks); }
  catch { allPicks[row.strategy] = []; }
}

// ── PICKS WITH VERDICTS ───────────────────────────────────────────────────────
console.log('\n' + '-'.repeat(62));
console.log('  STRATEGY PICKS  (structure = strategy-relevant, as presented)');
console.log('-'.repeat(62));
for (const strat of strategies) {
  const picks = allPicks[strat] ?? [];
  console.log('\n  ' + strat.toUpperCase() + ' (' + picks.length + ' picks):');
  if (!picks.length) { console.log('    (no picks)'); continue; }
  for (const p of picks) {
    const cv = typeof p.criticVerdict === 'object' && p.criticVerdict !== null ? p.criticVerdict : {};
    const verdict = cv.verdict ?? String(p.criticVerdict ?? '—');
    const conf = cv.confidence ? ' (' + cv.confidence + ')' : '';
    const flags = cv.flags ?? [];
    const warns = flags.filter(f => f.severity !== 'info');
    const infos = flags.filter(f => f.severity === 'info');
    const sel = relevantStructure(p.strategyLabResult, strat);
    const grade = sel?.grade ?? '—';
    const struct = (sel?.slug ?? 'NONE').slice(0, 22);
    const stockFlag = p.presentAsStock ? ' [stock-only]' : '';
    const wStr = warns.length ? '  WARN=[' + warns.map(f => f.key).join(', ') + ']' : '';
    const iStr = infos.length ? '  info=[' + infos.map(f => f.key).join(', ') + ']' : '';
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
      const key = (f.key ?? '?') + ' [' + (f.severity ?? '?') + ']';   // flags carry .key, not .rule
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
  const sma50 = spy.slice(0, 50).reduce((s, r) => s + r.close, 0) / 50;
  const sma200 = spy.length >= 200 ? spy.slice(0, 200).reduce((s, r) => s + r.close, 0) / 200 : null;
  const regime = close > sma50 ? 'BULLISH' : 'BEARISH';
  console.log('  SPY $' + close.toFixed(2) + ' on ' + date + '  SMA50=$' + sma50.toFixed(2) + (sma200 ? '  SMA200=$' + sma200.toFixed(2) : ''));
  console.log('  Regime: ' + regime + '  => bearish picks carry ' + (regime === 'BULLISH' ? 'elevated_market_risk (SPY uptrend)' : 'regime tailwind'));
}

// ── SNAPSHOT FRESHNESS & IV RANK ──────────────────────────────────────────────
// Per-ticker data lives in technical_signals (computed_at/rsi/trend_label/adx);
// iv_rank comes from each pick's lab context, not a table column.
console.log('\n\n' + '-'.repeat(62));
console.log('  SNAPSHOT FRESHNESS & IV RANK');
console.log('-'.repeat(62));
const genDate = latestGen.slice(0, 10);
const tickerStrat = {};
for (const strat of strategies) for (const p of (allPicks[strat] ?? [])) {
  if (!tickerStrat[p.ticker]) tickerStrat[p.ticker] = { ivRank: p.strategyLabResult?.context?.ivRank ?? null };
}
const allTickers = Object.keys(tickerStrat);
let nullIvr = 0, stale = 0, missing = 0;
for (const t of allTickers) {
  const ts = db.prepare(
    'SELECT computed_at, trend_label, rsi, adx FROM technical_signals WHERE ticker=? ORDER BY computed_at DESC LIMIT 1'
  ).get(t);
  const ivr = tickerStrat[t].ivRank;
  if (ivr === null || ivr === undefined) nullIvr++;
  if (!ts) {
    missing++;
    console.log('  ' + t.padEnd(6) + ' NO technical_signals row');
    continue;
  }
  const sigDate = (ts.computed_at ?? '').slice(0, 10);
  const ageFlag = sigDate && sigDate < genDate ? ' WARN:STALE(' + sigDate + ')' : '';
  if (ageFlag) stale++;
  console.log('  ' + t.padEnd(6) + ' sig=' + sigDate + '  trend=' + (ts.trend_label ?? '—') +
    '  rsi=' + (ts.rsi?.toFixed(1) ?? '—') + '  adx=' + (ts.adx?.toFixed(1) ?? '—') +
    '  ivr=' + (ivr != null ? ivr.toFixed(0) : 'null') + (ivr == null ? ' WARN:IV_RANK_NULL' : '') + ageFlag);
}
console.log('\n  Summary: null_ivr=' + nullIvr + '/' + allTickers.length +
  '  stale=' + stale + '/' + allTickers.length + '  missing=' + missing + '/' + allTickers.length);

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
  const isBriefDay = r.last_started?.startsWith(genDate) ? ' <<brief_day' : '';
  console.log('  ' + (r.job_name ?? '?').padEnd(40) + (r.last_started ?? 'never').slice(0, 16) + '  ' + (r.last_status ?? '—') + isToday + isBriefDay);
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
    // A presented pick with no strategy-relevant structure (and not stock-flagged) is suspicious.
    if (!relevantStructure(p.strategyLabResult, strat) && !p.presentAsStock && p.strategyLabResult) {
      anomalies.push('NO_RELEVANT_STRUCT: ' + strat + '/' + p.ticker + ' — lab ran but no ' + strat + ' structure');
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
