// Dump full pick JSON for targeted tickers to audit structure selection + data fidelity.
import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const latestGen = db.prepare('SELECT MAX(generated_at) g FROM daily_briefs').get().g;
const rows = db.prepare(`SELECT strategy, picks FROM daily_briefs WHERE date(generated_at) = date(?)`).all(latestGen);
const byStrat = {};
for (const r of rows) { try { byStrat[r.strategy] = JSON.parse(r.picks); } catch { /* a strategy with unparseable picks is simply absent from the dump */ } }

function summarize(p, strat) {
  const lab = p.strategyLabResult ?? {};
  const scores = lab.scores ?? [];
  // The structure the brief should present = strategy-relevant, not scores[0].
  console.log(`\n### ${strat.toUpperCase()} ${p.ticker}  rank=${p.rank} composite=${p.compositeScore?.toFixed(1)} price=$${p.price}`);
  console.log(`  presentAsStock=${p.presentAsStock}  presentedStructure keys: ${Object.keys(p).filter(k=>/struct|present|setup|leg/i.test(k)).join(', ')}`);
  console.log(`  lab.scores (top 6 by grade order as stored):`);
  for (const s of scores.slice(0, 6)) {
    const setup = s.setup ?? null;
    const legs = setup?.legs ? setup.legs.map(l => `${l.action ?? l.side ?? '?'} ${l.type ?? l.right ?? ''}${l.strike ?? '?'}`).join(' / ') : '—';
    console.log(`    [${s.grade ?? '?'}] ${(s.name ?? '?').padEnd(24)} relevant=${s.strategyRelevant ?? '?'} unavail=${setup?.unavailableReason ?? ''} legs: ${legs}`);
  }
  // Data fidelity fields
  console.log(`  data: ivRank=${p.ivRank ?? p.signals?.ivRank?.raw ?? '?'} iv=${lab.underlyingIv ?? '?'} 52wRet=${p.price52wReturnPct ?? '?'} priceMomentumPct=${p.priceMomentumPct ?? p.signals?.priceMomentumPct?.raw ?? '?'}`);
}

for (const strat of ['bullish','bearish','income','wheel','buy','inflection']) {
  for (const p of (byStrat[strat] ?? [])) {
    if (['MRVL','EL','GPN'].includes(p.ticker)) summarize(p, strat);
  }
}

// Dump one FULL pick to see the entire shape once.
console.log('\n\n========== FULL JSON: bearish EL ==========');
const el = (byStrat['bearish'] ?? []).find(p => p.ticker === 'EL');
console.log(JSON.stringify(el, null, 2).slice(0, 4000));

db.close();
