// Replicate critic/brief selectRelevantStructure to show what each pick ACTUALLY
// presents to the user (vs scores[0]), and check IV-in-rationale vs lab ATM IV.
import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const SLUGS = {
  wheel:['short-naked-put','covered-call'],
  bullish:['long-call-vertical','big-lizard','call-zebra','call-butterfly','poor-mans-covered-call'],
  bearish:['long-put-vertical','reverse-big-lizard','put-zebra','put-butterfly','poor-mans-covered-put'],
  income:['short-strangle','iron-condor','short-straddle','dynamic-width-iron-condor','iron-fly'],
  buy:['long-call-vertical','call-zebra','poor-mans-covered-call','call-calendar'],
  inflection:['short-put-vertical','short-call-vertical'],
};
const GRADE = {'A+':6,A:5,B:4,C:3,D:2,F:1};

function selectRelevant(lab, strat) {
  const slugs = SLUGS[strat] ?? [];
  const valid = (lab?.scores ?? []).filter(s => slugs.includes(s.slug) && s.setup != null && !s.setup.unavailableReason);
  if (!valid.length) return null;
  if (strat === 'inflection') return valid.reduce((b,s)=>(GRADE[s.grade]??0)>(GRADE[b.grade]??0)?s:b);
  return valid[0];
}

const latestGen = db.prepare('SELECT MAX(generated_at) g FROM daily_briefs').get().g;
const rows = db.prepare(`SELECT strategy, picks FROM daily_briefs WHERE date(generated_at)=date(?)`).all(latestGen);
const byStrat = {}; for (const r of rows) { try{byStrat[r.strategy]=JSON.parse(r.picks);}catch{byStrat[r.strategy]=[];} }

for (const strat of ['bearish','income','wheel','bullish','buy','inflection']) {
  console.log(`\n=== ${strat.toUpperCase()} — presented (strategy-relevant) structure ===`);
  for (const p of (byStrat[strat]??[])) {
    const lab = p.strategyLabResult ?? {};
    const sel = selectRelevant(lab, strat);
    const top = lab.scores?.[0];
    const legs = sel?.setup?.legs ? sel.setup.legs.map(l=>`${l.action} ${l.right??l.type??''}${l.strike}`).join('/') : '—';
    const presentAsStock = p.presentAsStock ? ' [STOCK]' : '';
    const mismatch = sel && top && sel.slug !== top.slug ? `  (scores[0]=${top.slug}/${top.grade})` : '';
    console.log(`  ${p.ticker.padEnd(6)} presents: ${sel ? sel.slug+'/'+sel.grade : 'NONE (null)'}${presentAsStock}  legs[${legs}]${mismatch}`);
    if (!sel && !p.presentAsStock) console.log(`         ^^ no relevant structure AND not stock-flagged — what does the view show??`);
    // IV-in-rationale vs lab ATM IV
    const cv = typeof p.criticVerdict==='object'?p.criticVerdict:{};
    const rat = cv.rationale ?? '';
    const m = rat.match(/(\d{2,3}(?:\.\d)?)\s*%\s*(?:annualized\s*)?(?:implied\s*)?vol|implied volatility[^0-9]*(\d{2,3}(?:\.\d)?)/i);
    const ivInRat = m ? (m[1]??m[2]) : null;
    const labIv = lab.context?.currentAtmIv;
    if (ivInRat && labIv && Math.abs(Number(ivInRat)-labIv) > 15)
      console.log(`         IV MISMATCH: rationale cites ${ivInRat}% vs lab ATM IV ${labIv.toFixed(1)}%`);
  }
}
db.close();
