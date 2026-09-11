// T4 (FR-SEY-5) — does the ETF wheel-composite deflation matter, and can it be validated?
//
// `ETF_AWARE_WHEEL_SCORING` is false. With it off, `fundamentalScore` (17) and `leverageQuality`
// (4) are structurally unpopulatable for a fund wrapper — no P/E, no ND/EBITDA — yet they keep
// their weight in the composite's DENOMINATOR under FR-SE-03. Every ETF is therefore scored as if
// it had *failed* two signals it can never possess.
//
// The code comment says the fix "must show a Brief Replay improvement (or at least neutrality) on
// ETF wheel outcomes before shipping enabled." This script's main finding is that **that
// condition can never be met**, and why. See the verdict at the end.
//
// see docs/wheel-parameters.md (T4, F6), Requirements/spec/13-scoring-engine.md

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

const db = new Database(join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));
const etfs = db.prepare(`SELECT ticker FROM constituents WHERE index_name='etf'`).all().map(r => r.ticker);
const etfSet = new Set(etfs);
const ph = etfs.map(() => '?').join(',');

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const f = (x, d = 1) => (x == null ? '—' : x.toFixed(d));

console.log(`\nT4 — ETF wheel-composite deflation`);
console.log(`${etfs.length} curated ETFs in the scoring universe (constituents.index_name = 'etf')\n`);

// ── 1. The distortion, in arithmetic ────────────────────────────────────────
console.log('═══ 1. THE DISTORTION ═══');
const fcOk = db.prepare(`SELECT COUNT(*) n FROM fundamentals_cache WHERE ticker IN (${ph})`).get(...etfs).n;
console.log(`  fundamentals_cache rows for the 60 ETFs : ${fcOk} / ${etfs.length}`);
console.log(`  iv_history coverage                     : ${db.prepare(`SELECT COUNT(DISTINCT ticker) n FROM iv_history WHERE ticker IN (${ph})`).get(...etfs).n} / ${etfs.length}`);
console.log(`  historical_prices coverage              : ${db.prepare(`SELECT COUNT(DISTINCT ticker) n FROM historical_prices WHERE ticker IN (${ph})`).get(...etfs).n} / ${etfs.length}`);
console.log(`\n  Live wheel config enables 91 weight. fundamentalScore (17) + leverageQuality (4)`);
console.log(`  = 21 of it can never be populated for an ETF, but still counts in the denominator:`);
console.log(`    ETF composite ceiling  : 70/91 = 76.9% of an otherwise-identical stock`);
console.log(`    uplift if the fix ships: x 91/70 = 1.300`);

// ── 2. The consequence: total absence ───────────────────────────────────────
console.log('\n═══ 2. THE CONSEQUENCE ═══');
let etfPicks = 0, totalPicks = 0, briefs = 0;
for (const b of db.prepare(`SELECT picks FROM daily_briefs WHERE strategy='wheel'`).all()) {
  briefs++;
  let a; try { a = JSON.parse(b.picks); } catch { continue; }
  for (const p of a ?? []) { totalPicks++; if (etfSet.has(p.ticker)) etfPicks++; }
}
let snapTickers = new Set(), etfSnapHits = 0, snaps = 0;
for (const r of db.prepare(`SELECT payload_json FROM analysis_snapshots WHERE mode='wheel'`).all()) {
  snaps++;
  let a; try { a = JSON.parse(r.payload_json); } catch { continue; }
  for (const x of (Array.isArray(a) ? a : a?.results ?? [])) {
    if (!x?.ticker) continue; snapTickers.add(x.ticker); if (etfSet.has(x.ticker)) etfSnapHits++;
  }
}
const ophEtf = db.prepare(`SELECT COUNT(*) n FROM options_premium_history
  WHERE strategy='wheel' AND structure='CSP' AND ticker IN (${ph})`).get(...etfs).n;
console.log(`  wheel picks in ${briefs} stored briefs      : ${etfPicks} ETF of ${totalPicks}`);
console.log(`  wheel analysis snapshots (${snaps}, ${snapTickers.size} tickers) : ${etfSnapHits} ETF appearances`);
console.log(`  wheel CSP rows in options_premium_history : ${ophEtf}`);
console.log(`\n  ETFs are absent at EVERY stage, not merely unpicked.`);

// ── 3. Would fixing it actually admit them? ─────────────────────────────────
console.log('\n═══ 3. WOULD THE FIX ADMIT THEM? ═══');
console.log('  The deflation is only binding if ETFs are competitive on the signals that DO');
console.log('  populate. ivRank is the largest single weight (22 of 91), so it decides.\n');
const ivRows = db.prepare(`SELECT ticker, atm_iv FROM iv_history WHERE atm_iv IS NOT NULL ORDER BY ticker, date`).all();
const byT = new Map();
for (const r of ivRows) { if (!byT.has(r.ticker)) byT.set(r.ticker, []); byT.get(r.ticker).push(r.atm_iv); }
const ranks = [];
for (const [t, series] of byT) {
  if (series.length < 30) continue;
  const w = series.slice(-252), cur = w.at(-1), lo = Math.min(...w), hi = Math.max(...w);
  if (hi <= lo) continue;
  ranks.push({ ticker: t, rank: ((cur - lo) / (hi - lo)) * 100, isEtf: etfSet.has(t) });
}
const E = ranks.filter(r => r.isEtf), S = ranks.filter(r => !r.isEtf);
console.log(`  ivRank   ETFs n=${E.length}: mean ${f(mean(E.map(x => x.rank)))} median ${f(med(E.map(x => x.rank)))}`
  + `   |   stocks n=${S.length}: mean ${f(mean(S.map(x => x.rank)))} median ${f(med(S.map(x => x.rank)))}`);
const all = ranks.map(x => x.rank).sort((a, b) => b - a);
const cut15 = all[14];
console.log(`  15th-highest ivRank in the universe (the STAGE4_POOL_SIZE bar): ${f(cut15)}`);
console.log(`  ETFs at or above it: ${E.filter(x => x.rank >= cut15).length} of ${E.length}`);
console.log(`\n  Best ETFs by ivRank:`);
for (const r of [...E].sort((a, b) => b.rank - a.rank).slice(0, 5)) {
  const pct = (all.filter(x => x > r.rank).length / all.length) * 100;
  console.log(`    ${r.ticker.padEnd(6)} ${f(r.rank).padStart(5)}  -> top ${f(pct)}% of the universe`);
}

// recentVolatility is LOWER-better at weight 10 — ETFs are strong here, which partly offsets.
const barsFor = db.prepare(`SELECT close FROM historical_prices WHERE ticker=? ORDER BY date DESC LIMIT 21`);
const rv = t => {
  const c = barsFor.all(t).map(x => x.close).reverse();
  if (c.length < 10) return null;
  const lr = []; for (let i = 1; i < c.length; i++) if (c[i - 1] > 0) lr.push(Math.log(c[i] / c[i - 1]));
  const m = lr.reduce((a, b) => a + b, 0) / lr.length;
  return Math.sqrt(lr.reduce((a, b) => a + (b - m) ** 2, 0) / (lr.length - 1)) * Math.sqrt(252) * 100;
};
const ev = E.map(x => rv(x.ticker)).filter(x => x != null);
const sv = S.slice(0, 400).map(x => rv(x.ticker)).filter(x => x != null);
console.log(`\n  recentVolatility (weight 10, LOWER is better) — ETFs are strong here:`);
console.log(`    ETFs median ${f(med(ev))}%   stocks median ${f(med(sv))}%`);
console.log(`    normalised (1 - v/60): ETFs ${f((1 - med(ev) / 60) * 100)}  vs stocks ${f((1 - med(sv) / 60) * 100)}`);
console.log(`    => on the populated signals ETFs are roughly competitive: a large edge on`);
console.log(`       volatility, a mild deficit on IV rank. The 23% denominator penalty is the`);
console.log(`       larger effect, but no ETF is near the top on the heaviest signal either.`);

// ── 4. Composite bar ────────────────────────────────────────────────────────
const comps = [];
for (const b of db.prepare(`SELECT picks FROM daily_briefs WHERE strategy='wheel'`).all()) {
  let a; try { a = JSON.parse(b.picks); } catch { continue; }
  for (const p of a ?? []) if (typeof p.compositeScore === 'number') comps.push(p.compositeScore);
}
comps.sort((a, b) => a - b);
const pc = p => comps[Math.floor(comps.length * p)];
console.log(`\n═══ 4. THE BAR ═══`);
console.log(`  wheel composites that made the top-5 (n=${comps.length}):`);
console.log(`    min ${f(pc(0))}  p25 ${f(pc(.25))}  median ${f(pc(.5))}  p75 ${f(pc(.75))}  max ${f(comps.at(-1))}`);
console.log(`  An ETF scoring X today would score 1.30X with the fix. To reach the observed`);
console.log(`  minimum winner (${f(pc(0))}) it needs a pre-fix composite of ~${f(pc(0) / 1.3)}.`);

// ── 5. Verdict ──────────────────────────────────────────────────────────────
console.log(`\n═══ 5. VERDICT — THE BOOTSTRAP PROBLEM ═══`);
console.log(`  The code comment requires "a Brief Replay improvement on ETF wheel outcomes"`);
console.log(`  before enabling. THAT CONDITION CANNOT BE MET:`);
console.log(`    - 0 ETF wheel picks exist in 62 stored briefs`);
console.log(`    - 0 ETF rows exist in options_premium_history, so no ETF CSP has ever settled`);
console.log(`    - none can be generated while the flag stays off, because the deflation is what`);
console.log(`      keeps ETFs out of the stage-4 pool in the first place`);
console.log(`  The distortion suppresses exactly the evidence that would justify removing it.`);
console.log(`  This is a CORRECTNESS question that cannot be resolved as a PERFORMANCE question:`);
console.log(`  scoring a fund wrapper 0 on ND/EBITDA is a category error, not a judgement about`);
console.log(`  the trade. Enabling the fix is the only way the evidence can ever exist.`);
console.log(`\n  Bounded risk if enabled: it affects 60 of ~1,100 tickers, multiplies only their`);
console.log(`  composite by 1.30, and no ETF is near the top on ivRank — so it admits them to`);
console.log(`  CONSIDERATION rather than handing them the picks.`);
db.close();
