// Is there an objective stand-in for "would I be happy owning this at the strike?"  (v1.1.169)
//
// Runs the whole argument end to end, in the order it was actually discovered:
//
//   STAGE 1  Is the conviction never-above band doing anything?      -> no, it cannot
//   STAGE 2  Do price-history anchors separate outcomes?             -> yes, strongly
//   STAGE 3  Is that separation real or a confound?                  -> survives every check
//   STAGE 4  Is the sample big enough to gate on?                    -> no. annotate, do not gate
//
// Outcome metric: own-at-strike is about what happens AFTER assignment, so it measures the
// underlying's return FROM the effective cost basis (strike - premium) at expiry + 30 days,
// EXCESS of SPY over the identical window. Computed for every pick rather than only the ~27%
// actually assigned — it is the counterfactual "if I had ended up owning it here, how did that
// go?", which uses all the data.
//
// Point-in-time discipline: every signal comes from `historical_prices` filtered to
// `date <= briefDate`. Fundamentals are deliberately excluded — `fundamentals_cache` keeps one
// row per ticker with no history, the same trap that makes the earnings gate unreplayable.
//
// see docs/formulas.md#own-at-strike, Requirements/spec/14 FR-BRIEF-DICE-10

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Write-capable on purpose: a readonly connection cannot attach the live WAL index on Windows.
// see CLAUDE.md "Inspecting the production DB"
const db = new Database(join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));

const SLUG = 'short-naked-put';
const H = 30;

const barsUpTo = db.prepare(`SELECT date, close, high, low FROM historical_prices WHERE ticker=? AND date<=? ORDER BY date DESC LIMIT 260`);
const barAfter = db.prepare(`SELECT date, close FROM historical_prices WHERE ticker=? AND date>=? ORDER BY date ASC LIMIT 1`);
const barBefore = db.prepare(`SELECT date, close FROM historical_prices WHERE ticker=? AND date<=? ORDER BY date DESC LIMIT 1`);
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const stats = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y);
  return { n: s.length, mean: s.reduce((p, c) => p + c, 0) / s.length, median: s[Math.floor(s.length / 2)], neg: s.filter(x => x < 0).length / s.length }; };
const fmt = st => st ? `n=${String(st.n).padStart(3)}  mean ${(st.mean * 100).toFixed(2).padStart(7)}%  median ${(st.median * 100).toFixed(2).padStart(7)}%  negative ${(st.neg * 100).toFixed(0).padStart(3)}%` : 'n=0';

// ── Gather every wheel pick with a constructible CSP ──────────────────────────
const picksAll = [];
for (const b of db.prepare(`SELECT generated_at, picks FROM daily_briefs WHERE strategy='wheel' ORDER BY generated_at`).all()) {
  const briefDate = b.generated_at.slice(0, 10);
  let arr; try { arr = JSON.parse(b.picks); } catch { continue; }
  for (const p of arr ?? []) {
    const s = (p.strategyLabResult?.scores ?? []).find(x => x.slug === SLUG);
    const leg = s?.setup?.legs?.find(l => l.side === 'put' && String(l.action).toLowerCase().startsWith('sell'));
    if (!leg || !p.price || !s?.setup?.expiration) continue;
    picksAll.push({ ticker: p.ticker, briefDate, spot: p.price, strike: leg.strike, mid: leg.mid, expiry: s.setup.expiration });
  }
}

// ── STAGE 1: can the conviction band ever bind? ───────────────────────────────
console.log('='.repeat(96));
console.log('STAGE 1 — is the conviction never-above band capable of rejecting anything?');
console.log('='.repeat(96));
const conv = new Map();
for (const r of db.prepare('SELECT ticker, price_high, updated_at FROM conviction_stocks').all()) conv.set(r.ticker, r);
const hiRatio = [];
for (const [, r] of conv) {
  const c = barBefore.get(r.ticker, r.updated_at.slice(0, 10))?.close;
  if (c && r.price_high != null) hiRatio.push(r.price_high / c);
}
const hr = stats(hiRatio.map(x => x - 1));
const mny = picksAll.map(p => p.strike / p.spot).sort((a, b) => a - b);
const listed = picksAll.filter(p => conv.get(p.ticker)?.price_high != null);
const breached = listed.filter(p => p.strike > conv.get(p.ticker).price_high).length;
console.log(`  price_high / spot AT WRITE TIME:   median ${(1 + hr.median).toFixed(3)}  (n=${hr.n} bands)`);
console.log(`  CSP strike / spot:                 median ${mny[Math.floor(mny.length / 2)].toFixed(3)}  (n=${mny.length} picks)`);
console.log(`  => the band sits ~${(((1 + hr.median) / mny[Math.floor(mny.length / 2)]) - 1) * 100 | 0}% out of reach BY CONSTRUCTION.`);
console.log(`  picks on a listed ticker: ${listed.length}   of which strike ABOVE the line: ${breached}`);
console.log(`  VERDICT: the band is decorative. It was not a protection that v1.1.168 removed.\n`);

// ── STAGE 2/3: do price anchors separate, and does that survive confounds? ────
const rows = [];
for (const p of picksAll) {
  const hist = barsUpTo.all(p.ticker, p.briefDate);
  if (hist.length < 200) continue;
  const sma200 = hist.slice(0, 200).reduce((a, x) => a + x.close, 0) / 200;
  const costBasis = p.strike - p.mid;
  const endBar = barAfter.get(p.ticker, addDays(p.expiry, H));
  if (!endBar) continue;
  const spy0 = barBefore.get('SPY', p.briefDate), spy1 = barAfter.get('SPY', endBar.date);
  if (!spy0 || !spy1) continue;
  rows.push({ ...p, expiry: p.expiry, accept: p.strike <= sma200,
    raw: endBar.close / costBasis - 1, spy: spy1.close / spy0.close - 1,
    excess: (endBar.close / costBasis - 1) - (spy1.close / spy0.close - 1) });
}
const A = rows.filter(r => r.accept), R = rows.filter(r => !r.accept);
console.log('='.repeat(96));
console.log(`STAGE 2/3 — does "strike <= SMA200" separate outcomes, net of regime?  (${rows.length} measurable picks)`);
console.log('='.repeat(96));
console.log('  RAW return from cost basis');
console.log('    accept', fmt(stats(A.map(r => r.raw))), '\n    reject', fmt(stats(R.map(r => r.raw))));
console.log('  SPY over the identical windows (if these differ, the result is just regime)');
console.log('    accept', fmt(stats(A.map(r => r.spy))), '\n    reject', fmt(stats(R.map(r => r.spy))));
console.log('  EXCESS of SPY');
console.log('    accept', fmt(stats(A.map(r => r.excess))), '\n    reject', fmt(stats(R.map(r => r.excess))));

// Episode de-duplication: repeated picks of the same position across consecutive days are ONE
// observation, not many. (The expiry-selection study's pooled-comparison trap inverted its own
// answer until this was done.)
const eps = new Map();
for (const r of rows) {
  const k = `${r.ticker}|${r.expiry}|${r.accept}`;
  if (!eps.has(k)) eps.set(k, { ticker: r.ticker, expiry: r.expiry, accept: r.accept, xs: [] });
  eps.get(k).xs.push(r.excess);
}
const episodes = [...eps.values()].map(e => ({ ...e, excess: e.xs.reduce((a, c) => a + c, 0) / e.xs.length, picks: e.xs.length }));
const EA = episodes.filter(e => e.accept), ER = episodes.filter(e => !e.accept);
const sa = stats(EA.map(e => e.excess)), sr = stats(ER.map(e => e.excess));
console.log(`\n  Collapsed to INDEPENDENT EPISODES (one ticker+expiry = one observation): ${episodes.length}`);
console.log('    accept', fmt(sa), '\n    reject', fmt(sr));
console.log(`    separation: mean ${((sa.mean - sr.mean) * 100).toFixed(2)} pts   median ${((sa.median - sr.median) * 100).toFixed(2)} pts`);
console.log('\n  Leave-one-out on the accept arm (can one name carry it?):');
for (const drop of [...EA].sort((a, b) => b.excess - a.excess).slice(0, 3)) {
  const s = stats(EA.filter(e => e !== drop).map(e => e.excess));
  console.log(`    without ${drop.ticker.padEnd(6)} (${(drop.excess * 100).toFixed(1)}%): accept mean ${(s.mean * 100).toFixed(2)}%  separation ${((s.mean - sr.mean) * 100).toFixed(2)} pts`);
}

// ── STAGE 4: is the sample good enough to GATE on? ────────────────────────────
const spanA = [...EA].map(e => e.expiry).sort();
console.log('\n' + '='.repeat(96));
console.log('STAGE 4 — is this enough to turn into a gate?');
console.log('='.repeat(96));
console.log(`  accept-arm episodes: ${EA.length}`);
console.log(`  distinct expiries in the accept arm: ${[...new Set(spanA)].join(', ')}`);
console.log(`  Only picks whose expiry + ${H}d has already passed are measurable, which truncates the`);
console.log(`  sample to a single ~4-week window. This project has rejected several levers that`);
console.log(`  looked this good on one regime (SPY-regime gate, overbought guard, expiry selection).`);
console.log(`\n  VERDICT: ship as an ANNOTATION, not a gate. Re-run once >=3 months of briefs have`);
console.log(`  matured past expiry+${H}d and the accept arm spans multiple regimes.`);
db.close();
