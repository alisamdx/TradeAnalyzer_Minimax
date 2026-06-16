// Audit the ADVOCATE rationale (aiRationale) for fabricated numbers — does it cite
// IV/vol figures it was never given? The advocate gets only non-missing signal RAW
// values (no currentAtmIv), and its prompt does NOT ask for a 1-sigma calc.
import Database from 'better-sqlite3';
const db = new Database('C:/Users/shaky/AppData/Roaming/trade-analyzer/trade-analyzer.sqlite');

const latestGen = db.prepare('SELECT MAX(generated_at) g FROM daily_briefs').get().g;
const rows = db.prepare(`SELECT strategy, picks FROM daily_briefs WHERE date(generated_at)=date(?)`).all(latestGen);
const byStrat = {}; for (const r of rows) { try { byStrat[r.strategy] = JSON.parse(r.picks); } catch { byStrat[r.strategy] = []; } }

let flagged = 0, total = 0;
for (const strat of ['bullish','bearish','buy','income','wheel','inflection']) {
  console.log(`\n=== ${strat.toUpperCase()} ===`);
  for (const p of (byStrat[strat] ?? [])) {
    total++;
    const adv = p.aiRationale ?? '(none)';
    // Signals the advocate actually received (non-missing raw values).
    const sigKeys = Object.entries(p.signals ?? {}).filter(([,v]) => !v?.missing).map(([k]) => k);
    const hasIvSignal = sigKeys.some(k => /iv|vol/i.test(k));
    // Numbers the advocate cited that look like vol/IV (e.g. "104% IV", "vol of 78%").
    const volClaims = [...adv.matchAll(/(\d{2,3}(?:\.\d)?)\s*%?\s*(?:annualized\s*)?(?:implied\s*|realized\s*)?vol(?:atility)?|implied\s+vol[^.]*?(\d{2,3}(?:\.\d)?)\s*%/gi)].map(m => m[0]);
    const labIv = p.strategyLabResult?.context?.currentAtmIv;
    const mark = volClaims.length && !hasIvSignal ? '  ⚠ vol claim w/o IV signal' : '';
    if (volClaims.length && !hasIvSignal) flagged++;
    console.log(`  ${p.ticker.padEnd(6)} sigs:[${sigKeys.join(',')}]${mark}`);
    console.log(`     "${adv.slice(0, 220)}"`);
    if (volClaims.length) console.log(`     vol-claims: ${JSON.stringify(volClaims)}  labATMIv=${labIv?.toFixed?.(1) ?? '?'}`);
  }
}
console.log(`\n${flagged}/${total} picks cite a vol figure without an IV/vol signal in their data.`);
db.close();
