// T1 (FR-SEY-5) — is the short put's 0.30 delta target right?
//
// `strategy-lab-service.ts` builds every `short-naked-put` at a hardcoded `deltaTarget: 0.30` —
// one constant for every ticker in every IV regime. It sets assignment probability, premium, and
// therefore the cost basis simultaneously, and it has never been tested here.
//
// WHAT CANNOT BE DONE, AND WHY. There are no historical option chains: `options_cache` is a live
// cache (0 rows) and `daily_briefs.picks` stores only the contract chosen. So the CSP CANNOT be
// re-selected at an arbitrary delta from real quotes, and any 0.10 / 0.40 arm would have to be
// synthesised through Black-Scholes on the stored IV. That would ignore the volatility smile,
// which understates OTM put premium and therefore penalises low-delta arms — a directional bias
// on exactly the axis under test. This study does not do that. It uses only real quotes.
//
// WHAT CAN BE DONE. `options_premium_history` records one real CSP per ticker per day per
// strategy, with its real `delta`, `premium` and `strike`, and outcomes settle against the real
// close at expiry. The wheel band spans 0.20–0.30 and income 0.20–0.35, so the stored history is
// itself an observational experiment over the delta range that matters.
//
//   SECTION A — all settled wheel CSPs, binned by delta, with the confounds printed alongside.
//   SECTION B — MATCHED PAIRS: the same ticker, same day, same expiry, where wheel and income
//               happened to select DIFFERENT strikes. Ticker, regime, IV and DTE are held
//               constant by construction; only delta differs. This is the real test.
//
// Both collapse repeated picks of one position into a single episode, and the outcome is settled
// at intrinsic with no path or IV assumption:
//     pnl/share = premium − max(0, strike − close@expiry)      return on capital = pnl / strike
//
// see docs/wheel-parameters.md (T1), docs/formulas.md#roll-the-dice

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

const db = new Database(join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));
const maxPx = db.prepare('SELECT MAX(date) d FROM historical_prices').get().d;

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));

/** Realized outcome of a short CSP held to expiry, settled at intrinsic. */
const outcome = r => {
  const pnl = r.premium - Math.max(0, r.strike - r.settle);
  return { pnl, retPct: (pnl / r.strike) * 100, assigned: r.settle < r.strike };
};

// ── Section A: every settled wheel CSP, binned by delta ──────────────────────
const wheel = db.prepare(`
  SELECT o.as_of_date, o.ticker, o.strike, o.expiration, o.dte, o.premium, o.delta,
         o.iv, o.iv_rank, o.last_price, h.close AS settle
  FROM options_premium_history o
  JOIN historical_prices h ON h.ticker = o.ticker AND h.date = o.expiration
  WHERE o.strategy = 'wheel' AND o.structure = 'CSP' AND o.expiration <= ?
    AND o.delta IS NOT NULL AND o.premium IS NOT NULL AND o.strike > 0
`).all(maxPx).map(r => ({ ...r, d: Math.abs(r.delta), ...outcome(r) }));

console.log(`\nT1 — does the short put's delta target earn its 0.30?`);
console.log(`${wheel.length} settled wheel CSPs · ${new Set(wheel.map(r => r.ticker)).size} tickers · `
  + `${new Set(wheel.map(r => r.as_of_date)).size} dates (${wheel[0]?.as_of_date} → ${wheel.at(-1)?.as_of_date})`);
console.log(`outcome = premium − max(0, strike − close@expiry), as % of strike (collateral)\n`);

console.log('═══ A. ALL SETTLED WHEEL CSPs, BINNED BY DELTA ═══');
console.log('  (confound columns matter: if IV rank or DTE drift across bins, the bins are not comparable)');
const BINS = [[0.195, 0.225], [0.225, 0.255], [0.255, 0.285], [0.285, 0.305]];
console.log(`\n  ${'delta band'.padEnd(14)} ${'n'.padStart(6)} ${'assigned'.padStart(9)} ${'mean ret'.padStart(9)} `
  + `${'median'.padStart(8)} ${'prem/strike'.padStart(11)} ${'ivRank'.padStart(7)} ${'DTE'.padStart(5)}`);
for (const [lo, hi] of BINS) {
  const b = wheel.filter(r => r.d >= lo && r.d < hi);
  if (!b.length) continue;
  console.log(`  ${(`${lo.toFixed(2)}–${hi.toFixed(2)}`).padEnd(14)} ${String(b.length).padStart(6)} `
    + `${(f(mean(b.map(r => r.assigned ? 100 : 0)), 1) + '%').padStart(9)} `
    + `${(f(mean(b.map(r => r.retPct))) + '%').padStart(9)} `
    + `${(f(med(b.map(r => r.retPct))) + '%').padStart(8)} `
    + `${(f(mean(b.map(r => (r.premium / r.strike) * 100))) + '%').padStart(11)} `
    + `${f(mean(b.map(r => r.iv_rank)), 0).padStart(7)} `
    + `${f(mean(b.map(r => r.dte)), 0).padStart(5)}`);
}

// ── Section B: matched pairs — the real test ─────────────────────────────────
const pairRows = db.prepare(`
  SELECT w.as_of_date, w.ticker, w.expiration, w.dte,
         w.strike AS wStrike, w.premium AS wPrem, w.delta AS wDelta,
         i.strike AS iStrike, i.premium AS iPrem, i.delta AS iDelta,
         h.close AS settle
  FROM options_premium_history w
  JOIN options_premium_history i
    ON i.ticker = w.ticker AND i.as_of_date = w.as_of_date AND i.expiration = w.expiration
   AND i.strategy = 'income' AND i.structure = 'CSP'
  JOIN historical_prices h ON h.ticker = w.ticker AND h.date = w.expiration
  WHERE w.strategy = 'wheel' AND w.structure = 'CSP' AND w.expiration <= ?
    AND w.delta IS NOT NULL AND i.delta IS NOT NULL
    AND ABS(ABS(w.delta) - ABS(i.delta)) > 0.02
`).all(maxPx);

// Orient each pair as LOW-delta vs HIGH-delta, never as wheel vs income — the question is about
// delta, and which strategy happened to pick the further strike is incidental.
const pairs = pairRows.map(p => {
  const a = { strike: p.wStrike, premium: p.wPrem, d: Math.abs(p.wDelta), settle: p.settle };
  const b = { strike: p.iStrike, premium: p.iPrem, d: Math.abs(p.iDelta), settle: p.settle };
  const [lo, hi] = a.d <= b.d ? [a, b] : [b, a];
  return {
    ticker: p.ticker, as_of_date: p.as_of_date, expiration: p.expiration, dte: p.dte,
    lo: { ...lo, ...outcome(lo) }, hi: { ...hi, ...outcome(hi) },
    dDelta: hi.d - lo.d,
  };
});

// One ticker+expiry = one episode: re-picking the same position on consecutive days is not
// independent evidence. (The same de-duplication the own-at-strike study needed.)
const epMap = new Map();
for (const p of pairs) {
  const k = `${p.ticker}|${p.expiration}`;
  if (!epMap.has(k)) epMap.set(k, []);
  epMap.get(k).push(p);
}
const episodes = [...epMap.values()].map(g => ({
  ticker: g[0].ticker, expiration: g[0].expiration, n: g.length,
  loRet: mean(g.map(x => x.lo.retPct)), hiRet: mean(g.map(x => x.hi.retPct)),
  loAsg: mean(g.map(x => x.lo.assigned ? 1 : 0)), hiAsg: mean(g.map(x => x.hi.assigned ? 1 : 0)),
  loD: mean(g.map(x => x.lo.d)), hiD: mean(g.map(x => x.hi.d)),
  loPrem: mean(g.map(x => (x.lo.premium / x.lo.strike) * 100)),
  hiPrem: mean(g.map(x => (x.hi.premium / x.hi.strike) * 100)),
}));

console.log(`\n═══ B. MATCHED PAIRS — same ticker, same day, same expiry, different delta ═══`);
console.log(`  ${pairs.length} pairs → ${episodes.length} independent episodes (ticker + expiry)`);
console.log(`  Ticker, regime, IV and days-to-expiry are held constant by construction.\n`);

const row = (label, lo, hi) => console.log(`  ${label.padEnd(28)} ${f(lo).padStart(9)}   ${f(hi).padStart(9)}`);
console.log(`  ${''.padEnd(28)} ${'LOW delta'.padStart(9)}   ${'HIGH delta'.padStart(9)}`);
row('mean |delta|', mean(episodes.map(e => e.loD)), mean(episodes.map(e => e.hiD)));
row('premium / strike  %', mean(episodes.map(e => e.loPrem)), mean(episodes.map(e => e.hiPrem)));
row('assigned  %', mean(episodes.map(e => e.loAsg * 100)), mean(episodes.map(e => e.hiAsg * 100)));
row('mean return on capital %', mean(episodes.map(e => e.loRet)), mean(episodes.map(e => e.hiRet)));
row('median return on capital %', med(episodes.map(e => e.loRet)), med(episodes.map(e => e.hiRet)));

const diffs = episodes.map(e => e.hiRet - e.loRet);
const wins = diffs.filter(d => d > 0).length, ties = diffs.filter(d => d === 0).length;
console.log(`\n  PAIRED DIFFERENCE (high − low), per episode:`);
console.log(`    mean   ${f(mean(diffs))} pts      median ${f(med(diffs))} pts`);
console.log(`    higher delta won ${wins} / ${episodes.length - ties} decided episodes `
  + `(${f((wins / Math.max(1, episodes.length - ties)) * 100, 1)}%)`);
console.log(`    ties (identical outcome): ${ties}`);

// The decomposition that answers WHY — extra premium collected vs extra assignment paid.
const extraPrem = mean(episodes.map(e => e.hiPrem - e.loPrem));
const extraAsg = mean(episodes.map(e => (e.hiAsg - e.loAsg) * 100));
console.log(`\n  DECOMPOSITION — what the extra delta buys and what it costs:`);
console.log(`    extra premium collected : ${f(extraPrem)} pts of strike`);
console.log(`    extra assignment rate   : ${f(extraAsg, 1)} pts`);
console.log(`    net effect on return    : ${f(mean(diffs))} pts`);
console.log(`    => ${mean(diffs) > 0 ? 'the extra premium MORE than covers the extra assignment'
  : 'the extra premium does NOT cover the extra assignment'}`);

// Does the effect scale with how much the deltas differ? A real effect should.
console.log(`\n  DOSE–RESPONSE (a real effect should scale with the delta gap):`);
for (const [lo, hi] of [[0.02, 0.04], [0.04, 0.07], [0.07, 1.0]]) {
  const g = pairs.filter(p => p.dDelta >= lo && p.dDelta < hi);
  if (g.length < 15) { console.log(`    gap ${lo}–${hi}: n=${g.length} (too few)`); continue; }
  const d = g.map(p => p.hi.retPct - p.lo.retPct);
  console.log(`    gap ${lo.toFixed(2)}–${hi === 1 ? '  +' : hi.toFixed(2)}  n=${String(g.length).padStart(4)}  `
    + `mean high−low ${f(mean(d)).padStart(7)} pts`);
}

// ── Section C: does going ABOVE 0.30 help? Only income's band reaches there. ──
const income = db.prepare(`
  SELECT o.strike, o.premium, o.delta, o.dte, o.iv_rank, o.ticker, o.expiration, h.close AS settle
  FROM options_premium_history o
  JOIN historical_prices h ON h.ticker = o.ticker AND h.date = o.expiration
  WHERE o.strategy = 'income' AND o.structure = 'CSP' AND o.expiration <= ?
    AND o.delta IS NOT NULL AND o.premium IS NOT NULL AND o.strike > 0
`).all(maxPx).map(r => ({ ...r, d: Math.abs(r.delta), ...outcome(r) }));

console.log(`\n\u2550\u2550\u2550 C. ABOVE 0.30 \u2014 income CSPs, whose band reaches 0.35 \u2550\u2550\u2550`);
console.log(`  ${income.length} settled income CSPs. A different strategy, but the same CSP structure`);
console.log(`  and the same findSuitableChain \u2014 the only real quotes above wheel's 0.30 ceiling.\n`);
console.log(`  ${'delta band'.padEnd(14)} ${'n'.padStart(6)} ${'assigned'.padStart(9)} ${'mean ret'.padStart(9)} `
  + `${'median'.padStart(8)} ${'prem/strike'.padStart(11)} ${'ivRank'.padStart(7)} ${'DTE'.padStart(5)}`);
for (const [lo, hi] of [[0.195, 0.245], [0.245, 0.295], [0.295, 0.325], [0.325, 0.36]]) {
  const b = income.filter(r => r.d >= lo && r.d < hi);
  if (!b.length) continue;
  console.log(`  ${(`${lo.toFixed(2)}-${hi.toFixed(2)}`).padEnd(14)} ${String(b.length).padStart(6)} `
    + `${(f(mean(b.map(r => r.assigned ? 100 : 0)), 1) + '%').padStart(9)} `
    + `${(f(mean(b.map(r => r.retPct))) + '%').padStart(9)} `
    + `${(f(med(b.map(r => r.retPct))) + '%').padStart(8)} `
    + `${(f(mean(b.map(r => (r.premium / r.strike) * 100))) + '%').padStart(11)} `
    + `${f(mean(b.map(r => r.iv_rank)), 0).padStart(7)} `
    + `${f(mean(b.map(r => r.dte)), 0).padStart(5)}`);
}

// ── Section D: the tension with own-at-strike (v1.1.169) ─────────────────────
//
// Sections A-C measure the PREMIUM SELLER'S outcome: dollars returned on collateral. But a wheel
// is not purely a premium business - assignment converts to stock, and v1.1.169 measured that
// where the cost basis lands matters a lot (basis at or below the 200-day average separated
// outcomes by 17.4pp per episode, excess of SPY).
//
// Delta moves those two metrics in OPPOSITE directions: a higher delta strikes closer to spot,
// so it collects more premium AND lands the cost basis higher against the stock's own history.
// This section prices that trade-off instead of leaving it as an assertion.
const smaCache = new Map();
const barsStmt = db.prepare(
  `SELECT close FROM historical_prices WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT 200`);
const sma200For = (ticker, asOf) => {
  const k = ticker + '|' + asOf;
  if (!smaCache.has(k)) {
    const b = barsStmt.all(ticker, asOf);
    smaCache.set(k, b.length >= 200 ? b.reduce((a, x) => a + x.close, 0) / 200 : null);
  }
  return smaCache.get(k);
};

console.log(`\n\u2550\u2550\u2550 D. THE TENSION \u2014 premium return vs where the cost basis lands \u2550\u2550\u2550`);
console.log(`  Cost basis = strike \u2212 premium, against the ticker's own 200-day average at entry.`);
console.log(`  v1.1.169 found a basis at or below that line separated outcomes by 17.4pp.\n`);
console.log(`  ${'delta band'.padEnd(14)} ${'n'.padStart(6)} ${'mean ret'.padStart(9)} `
  + `${'basis<=SMA200'.padStart(14)} ${'basis vs SMA200'.padStart(16)}`);
for (const [lo, hi] of BINS) {
  const b = wheel.filter(r => r.d >= lo && r.d < hi)
    .map(r => ({ ...r, sma: sma200For(r.ticker, r.as_of_date) }))
    .filter(r => r.sma != null);
  if (b.length < 50) continue;
  const basis = b.map(r => r.strike - r.premium);
  const below = b.filter((r, i) => basis[i] <= r.sma).length;
  const vs = b.map((r, i) => (basis[i] / r.sma - 1) * 100);
  console.log(`  ${(`${lo.toFixed(2)}-${hi.toFixed(2)}`).padEnd(14)} ${String(b.length).padStart(6)} `
    + `${(f(mean(b.map(r => r.retPct))) + '%').padStart(9)} `
    + `${(f((below / b.length) * 100, 1) + '%').padStart(14)} `
    + `${(f(mean(vs), 1) + '%').padStart(16)}`);
}
console.log(`\n  Read the last two columns together with the first: if premium return rises with delta`);
console.log(`  while the share of picks landing at or below the long-run average FALLS, the two`);
console.log(`  validated findings genuinely disagree about which way to move delta.`);

console.log(`\n═══ READ THIS BEFORE ACTING ═══`);
console.log(`• RANGE: real quotes only span |delta| 0.20–0.35. This study says NOTHING about 0.10 or`);
console.log(`  0.45 — no historical chain exists to price them, and synthesising them through`);
console.log(`  Black-Scholes would ignore the smile, understating OTM premium and biasing against`);
console.log(`  exactly the low-delta arm under test.`);
console.log(`• ONE REGIME: 31 entry dates, 2026-06-15 → 2026-07-29. Same caution as every other`);
console.log(`  study on this data — the SPY-regime gate and overbought guard both looked good here.`);
console.log(`• Section B pairs wheel against income contracts. They share ticker, date and expiry,`);
console.log(`  so delta is the only material difference — but the two were selected by different`);
console.log(`  code paths, so a pair exists only where those paths disagreed. That is a non-random`);
console.log(`  subset of days: names where the chain offered a meaningfully different strike.`);
console.log(`• Held to expiry at intrinsic: no early management, no roll, no covered call after`);
console.log(`  assignment. A wheel operator would do all three, and all three cushion assignment —`);
console.log(`  so the true cost of a higher delta is SMALLER than section B shows.`);
db.close();
