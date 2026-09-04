import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';
const db=new Database(join(homedir(),'AppData','Roaming','trade-analyzer','trade-analyzer.sqlite'));
const b=db.prepare(`SELECT generated_at, picks FROM daily_briefs WHERE strategy='wheel' ORDER BY generated_at DESC LIMIT 1`).get();
console.log('latest wheel brief generated_at:', b.generated_at);
const picks=JSON.parse(b.picks);
console.log('picks:', picks.map(p=>`${p.ticker} ${p.compositeScore?.toFixed(1)} critic=${p.criticVerdict?.verdict}${p.criticVerdict?.degraded?'/degraded':''}`).join(' | '));
const d=picks.find(p=>p.ticker==='DINO');
if(d){
  const s=(d.strategyLabResult?.scores??[]).find(x=>x.slug==='short-naked-put');
  const leg=s?.setup?.legs?.find(l=>l.side==='put');
  console.log('\nDINO stored setup:', JSON.stringify({liq:s?.liquidityScore, grade:s?.grade, exp:s?.setup?.expiration, dte:s?.setup?.dte, strike:leg?.strike, mid:leg?.mid, delta:leg?.delta, bid:leg?.bid, ask:leg?.ask, oi:leg?.openInterest, netCredit:s?.setup?.netCredit, pop:s?.setup?.popEstimate, annRet:s?.setup?.annualizedReturn}));
  console.log('critic:', JSON.stringify(d.criticVerdict));
}
console.log('\nbrief_candidates rows:', db.prepare('SELECT COUNT(*) n FROM brief_candidates').get().n);
db.close();
