// Cross-consistency audit of the latest daily brief — hunts for internal
// contradictions that could mislead a real-money decision.
import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const latestGen = db.prepare('SELECT MAX(generated_at) g FROM daily_briefs').get().g;
const rows = db.prepare(`SELECT strategy, picks FROM daily_briefs WHERE date(generated_at)=date(?)`).all(latestGen);
const byStrat = {};
for (const r of rows) { try { byStrat[r.strategy] = JSON.parse(r.picks); } catch { byStrat[r.strategy] = []; } }
console.log(`Brief: ${latestGen.slice(0,19)} UTC\n`);

// Map a structure category/slug to a directional sign for the consistency check.
function structDir(s) {
  const c = (s.category ?? '').toLowerCase();
  if (c.includes('bear')) return 'bear';
  if (c.includes('bull')) return 'bull';
  return 'neutral';
}

const issues = [];
function flag(sev, code, msg) { issues.push({ sev, code, msg }); }

for (const strat of ['bullish','bearish','buy','income','wheel','inflection']) {
  const picks = byStrat[strat] ?? [];
  for (const p of picks) {
    const lab = p.strategyLabResult ?? {};
    const ctx = lab.context ?? {};
    const scores = lab.scores ?? [];
    const top = scores[0] ?? {};
    const bias = ctx.directionBias ?? '?';
    const iv = ctx.currentAtmIv ?? null;
    const tag = `${strat}/${p.ticker}`;

    // 1. Directional contradiction: brief strategy vs lab directionBias.
    if (strat === 'bearish' && bias === 'bullish')
      flag('HIGH','dir_bias_conflict',`${tag} comp=${p.compositeScore?.toFixed(1)} — BEARISH pick but lab directionBias=BULLISH (ma20=${ctx.ma20?.toFixed(1)} ma50=${ctx.ma50?.toFixed(1)} px=${ctx.underlyingPx} mom5d=${ctx.momentum5d?.toFixed(1)})`);
    if ((strat === 'bullish' || strat === 'buy') && bias === 'bearish')
      flag('HIGH','dir_bias_conflict',`${tag} comp=${p.compositeScore?.toFixed(1)} — ${strat.toUpperCase()} pick but lab directionBias=BEARISH`);

    // 2. Top structure direction contradicts strategy direction.
    const td = structDir(top);
    if (strat === 'bearish' && td === 'bull')
      flag('HIGH','struct_dir_conflict',`${tag} — bearish pick, top structure "${top.name}" is BULLISH (grade ${top.grade})`);
    if ((strat === 'bullish') && td === 'bear')
      flag('HIGH','struct_dir_conflict',`${tag} — bullish pick, top structure "${top.name}" is BEARISH`);

    // 3. No strategy-aligned structure exists at all (bearish wants a bearish structure).
    if (strat === 'bearish') {
      const anyBear = scores.some(s => structDir(s) === 'bear');
      if (!anyBear) flag('HIGH','no_aligned_struct',`${tag} — NO bearish structure in lab scores (all bull/neutral) — what does the brief present?`);
    }

    // 4. IV sanity — ATM IV > 100% is extreme for a large/mid-cap; > 150% almost certainly bad data.
    if (iv != null && iv > 100)
      flag(iv > 150 ? 'HIGH' : 'MED','iv_outlier',`${tag} — currentAtmIv=${iv.toFixed(1)}% (px=$${ctx.underlyingPx}, ivRank=${ctx.ivRank?.toFixed(0)})`);

    // 5. Primary directional signal weak but composite high (score carried by non-directional signals).
    const sig = p.signals ?? {};
    const primary = strat === 'bearish' ? sig.downtrendScore : (strat === 'bullish' ? sig.trendStrength : null);
    if (primary && primary.normalized < 50 && (p.compositeScore ?? 0) >= 70)
      flag('MED','weak_primary_signal',`${tag} comp=${p.compositeScore?.toFixed(1)} but primary ${strat==='bearish'?'downtrend':'trend'}=${primary.normalized.toFixed(0)}/100 — score carried by secondary signals`);

    // 6. rsiOverbought over-credit: RSI raw < 70 but normalized = 100.
    if (sig.rsiOverbought && sig.rsiOverbought.raw != null && sig.rsiOverbought.raw < 70 && sig.rsiOverbought.normalized >= 99)
      flag('MED','rsi_overbought_norm',`${tag} — rsiOverbought raw RSI=${sig.rsiOverbought.raw.toFixed(1)} (<70, not overbought) normalized to ${sig.rsiOverbought.normalized.toFixed(0)}`);

    // 7. Missing signal share.
    const sv = Object.values(sig); const miss = sv.filter(v=>v?.missing).length;
    if (sv.length && miss/sv.length > 0.25)
      flag('MED','missing_signals',`${tag} — ${miss}/${sv.length} signals missing/null (${Object.entries(sig).filter(([,v])=>v?.missing).map(([k])=>k).join(', ')})`);
  }
}

// 8. Cross-strategy: same ticker in opposite-direction strategies.
const bull = new Set((byStrat.bullish??[]).map(p=>p.ticker));
const bear = new Set((byStrat.bearish??[]).map(p=>p.ticker));
for (const t of bull) if (bear.has(t)) flag('HIGH','cross_dir',`${t} appears in BOTH bullish and bearish`);

// 9. Same ticker across many strategies (concentration).
const counts = {};
for (const s of Object.keys(byStrat)) for (const p of byStrat[s]) counts[p.ticker]=(counts[p.ticker]??0)+1;
for (const [t,n] of Object.entries(counts)) if (n>=4) flag('LOW','concentration',`${t} appears in ${n} of 6 strategy lists`);

// Report
const order = { HIGH:0, MED:1, LOW:2 };
issues.sort((a,b)=>order[a.sev]-order[b.sev]);
console.log(`Found ${issues.length} potential issues:\n`);
for (const i of issues) console.log(`  [${i.sev}] ${i.code}: ${i.msg}`);
const byCode = {};
for (const i of issues) byCode[i.code]=(byCode[i.code]??0)+1;
console.log('\nBy code:', JSON.stringify(byCode));
db.close();
