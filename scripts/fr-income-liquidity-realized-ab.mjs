// FR-SEY-5 — realized-outcome A/B for WHEEL_GRADED_LIQUIDITY (v1.1.131), run on INCOME rows.
//
// Why income and not wheel: `options_premium_history` stores bid/ask/open_interest on all 22,302
// income rows and on ZERO of the 21,127 wheel rows — `WheelResult` never carried them until
// v1.1.132, so the wheel path recorded the liquidity VERDICT with none of the EVIDENCE. Re-scoring
// a historical recommendation under a different scheme needs the inputs, so only the income side
// can be replayed. Income carries the same `optionLiquidity` signal (weight 13 vs wheel's 9) and
// its CSP is built by the same `findSuitableChain`, so it is a close proxy — not the same
// population (see the caveats printed at the end).
//
// The income composite is fully reconstructible point-in-time:
//   ivRank           30  <- options_premium_history.iv_rank
//   premiumRiskRatio 22  <- options_premium_history.annualized_return
//   recentVolatility 20  <- 20-day realized vol from historical_prices, as of as_of_date
//   trendNeutral     15  <- trendStrengthAdx, permanently null while ADX is out of scoring, so it
//                           contributes 0 at full weight — in replay AND live (v1.1.33)
//   optionLiquidity  13  <- recomputed from stored bid/ask/open_interest under BOTH schemes
//
// Realized outcome of a short cash-secured put held to expiry (no assumptions — intrinsic only):
//   settle S = close on the expiration date
//   pnl/share = premium - max(0, strike - S)          return on capital = pnl / strike
//
// Two analyses, because they answer different questions:
//   A) SIGNAL LEVEL (high power, every settled row): does the liquidity score predict realized
//      outcome at all, and does grading it predict better? If neither does, its weight is
//      misallocated regardless of which scheme wins.
//   B) PORTFOLIO LEVEL (decision-relevant, thin): re-rank each date by full composite under each
//      scheme, take the top N, compare what actually happened. This is the FR-SEY-5 question, but
//      the sample is small — read the confidence note it prints.
//
// Usage: node scripts/fr-income-liquidity-realized-ab.mjs [--picks 5]
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PICKS = Number(argOf('--picks', 5));   // PICKS_PER_STRATEGY in the brief/replay

const db = new Database(join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));

// ── scoring replicas (mirror scoring-service.ts BASELINE_INCOME + normalizeSignal) ──
const clamp = (x) => Math.max(0, Math.min(100, x));
const normHigher = (raw, max) => clamp((raw / max) * 100);
const normLower = (raw, max) => clamp((1 - raw / max) * 100);
const INCOME_WEIGHTS = { ivRank: 30, premiumRiskRatio: 22, recentVolatility: 20, trendNeutral: 15, optionLiquidity: 13 };
const TOTAL_WEIGHT = Object.values(INCOME_WEIGHTS).reduce((a, b) => a + b, 0);

/** Legacy: three binary gates. volume floored to 0 — no historical row has it (migration 066). */
const liqLegacy = (bid, ask, oi) => {
  const spread = (bid > 0 && ask > 0 && ask > bid) ? ((ask - bid) / ((ask + bid) / 2)) * 100 : 0;
  return (oi >= 50 ? 4 : 0) + (spread <= 5 ? 4 : 0);   // + volume>=50 ? 2 : 0  -> always 0 here
};
/** Graded: continuous (analysis-service.ts, WHEEL_GRADED_LIQUIDITY). Same volume floor. */
const liqGraded = (bid, ask, oi) => {
  const spread = (bid > 0 && ask > 0 && ask > bid) ? ((ask - bid) / ((ask + bid) / 2)) * 100 : 0;
  const c01 = (x) => Math.max(0, Math.min(1, x));
  const s = bid > 0 ? 4 * c01(1 - (spread - 5) / 35) : 0;
  const o = 4 * c01(Math.log10(Math.max(oi, 1)) / 3.3);
  return Math.min(10, s + o);                          // + volume term -> always 0 here
};

/** Full income composite. Missing signals contribute 0 to the numerator, full weight to the
 *  denominator (FR-SE-03 as implemented) — trendNeutral is always missing. */
function composite(r, liq) {
  let sum = 0;
  if (r.iv_rank != null) sum += normHigher(r.iv_rank, 100) * INCOME_WEIGHTS.ivRank;
  if (r.annualized_return != null) sum += normHigher(r.annualized_return, 60) * INCOME_WEIGHTS.premiumRiskRatio;
  if (r.realizedVol != null) sum += normLower(r.realizedVol, 60) * INCOME_WEIGHTS.recentVolatility;
  // trendNeutral: null for every ticker while ADX is excluded from scoring -> contributes nothing
  sum += normHigher(liq, 10) * INCOME_WEIGHTS.optionLiquidity;
  return sum / TOTAL_WEIGHT;
}

// ── load settled income CSPs with the full input set ────────────────────────────
const maxPx = db.prepare(`SELECT MAX(date) d FROM historical_prices`).get().d;
const rows = db.prepare(`
  SELECT o.as_of_date, o.ticker, o.strike, o.expiration, o.dte, o.premium,
         o.bid, o.ask, o.open_interest AS oi, o.iv_rank, o.annualized_return,
         h.close AS settle
  FROM options_premium_history o
  JOIN historical_prices h ON h.ticker = o.ticker AND h.date = o.expiration
  WHERE o.strategy = 'income' AND o.structure = 'CSP'
    AND o.expiration <= ? AND o.bid IS NOT NULL AND o.ask IS NOT NULL
    AND o.open_interest IS NOT NULL AND o.premium IS NOT NULL AND o.strike > 0
  ORDER BY o.as_of_date, o.ticker
`).all(maxPx);

// 20-day realized vol as of each (ticker, as_of_date) — the recentVolatility signal.
const barsFor = db.prepare(
  `SELECT close FROM historical_prices WHERE ticker=? AND date<=? ORDER BY date DESC LIMIT 21`
);
const volCache = new Map();
for (const r of rows) {
  const key = `${r.ticker}|${r.as_of_date}`;
  if (!volCache.has(key)) {
    const closes = barsFor.all(r.ticker, r.as_of_date).map((x) => x.close).reverse();
    let v = null;
    if (closes.length >= 10) {
      const lr = [];
      for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) lr.push(Math.log(closes[i] / closes[i - 1]));
      const m = lr.reduce((a, b) => a + b, 0) / lr.length;
      const sd = Math.sqrt(lr.reduce((a, b) => a + (b - m) ** 2, 0) / (lr.length - 1));
      v = sd * Math.sqrt(252) * 100;
    }
    volCache.set(key, v);
  }
  r.realizedVol = volCache.get(key);
  // Realized CSP outcome, settled at intrinsic. No IV or path assumptions.
  r.pnl = r.premium - Math.max(0, r.strike - r.settle);
  r.retPct = (r.pnl / r.strike) * 100;
  r.assigned = r.settle < r.strike;
  r.liqLegacy = liqLegacy(r.bid, r.ask, r.oi);
  r.liqGraded = liqGraded(r.bid, r.ask, r.oi);
  r.compLegacy = composite(r, r.liqLegacy);
  r.compGraded = composite(r, r.liqGraded);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const f = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));
function rankOf(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(arr.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function spearman(x, y) {
  const rx = rankOf(x), ry = rankOf(y), mx = mean(rx), my = mean(ry);
  let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) { const a = rx[i] - mx, b = ry[i] - my; n += a * b; dx += a * a; dy += b * b; }
  return (dx > 0 && dy > 0) ? n / Math.sqrt(dx * dy) : 0;
}

const dates = [...new Set(rows.map((r) => r.as_of_date))].sort();
console.log(`\nFR-SEY-5 — graded vs legacy option liquidity, realized on INCOME CSPs`);
console.log(`${rows.length} settled CSPs · ${new Set(rows.map((r) => r.ticker)).size} tickers · ` +
            `${dates.length} dates (${dates[0]} → ${dates[dates.length - 1]})`);
console.log(`outcome = premium − max(0, strike − close@expiry), as % of strike (collateral)\n`);
console.log(`overall: assigned ${f((rows.filter((r) => r.assigned).length / rows.length) * 100, 1)}%  ` +
            `mean return on capital ${f(mean(rows.map((r) => r.retPct)))}%`);

// ── A) signal level ─────────────────────────────────────────────────────────────
console.log('\n═══ A. SIGNAL LEVEL — does the liquidity score predict the outcome? ═══');
console.log(`Spearman(score, realized return):  legacy ${f(spearman(rows.map((r) => r.liqLegacy), rows.map((r) => r.retPct)), 3)}   ` +
            `graded ${f(spearman(rows.map((r) => r.liqGraded), rows.map((r) => r.retPct)), 3)}`);
for (const [name, key] of [['legacy', 'liqLegacy'], ['graded', 'liqGraded']]) {
  const sorted = [...rows].sort((a, b) => a[key] - b[key]);
  const q = Math.floor(sorted.length / 4);
  const bands = [['bottom 25%', sorted.slice(0, q)], ['mid 50%', sorted.slice(q, sorted.length - q)], ['top 25%', sorted.slice(sorted.length - q)]];
  console.log(`\n  ${name}:`);
  for (const [label, set] of bands) {
    console.log(`    ${label.padEnd(11)} n=${String(set.length).padStart(4)}  score ${f(mean(set.map((r) => r[key])), 1).padStart(5)}  ` +
                `assigned ${f((set.filter((r) => r.assigned).length / set.length) * 100, 1).padStart(5)}%  ` +
                `mean ret ${f(mean(set.map((r) => r.retPct))).padStart(6)}%   ` +
                `[ivRank ${f(mean(set.map((r) => r.iv_rank).filter((x) => x != null)), 0).padStart(3)}  ` +
                `realVol ${f(mean(set.map((r) => r.realizedVol).filter((x) => x != null)), 0).padStart(3)}%  ` +
                `annRet ${f(mean(set.map((r) => r.annualized_return).filter((x) => x != null)), 0).padStart(3)}%]`);
  }
}
console.log('\n  [bracketed] = what else varies with liquidity — the confound check. If high-liquidity');
console.log('  names also carry higher IV rank and realized vol, the adverse relation is selection,');
console.log('  not causation: liquidity tracks attention, and attention tracks names that move.');

// ── B) portfolio level ──────────────────────────────────────────────────────────
console.log(`\n═══ B. PORTFOLIO LEVEL — top-${PICKS} per date by full composite ═══`);
const arms = { legacy: [], graded: [] };
let changedDays = 0, overlapTotal = 0;
for (const day of dates) {
  const onDay = rows.filter((r) => r.as_of_date === day);
  const pick = (key) => [...onDay].sort((a, b) => b[key] - a[key]).slice(0, PICKS);
  const L = pick('compLegacy'), G = pick('compGraded');
  arms.legacy.push(...L); arms.graded.push(...G);
  const lt = new Set(L.map((r) => r.ticker)), overlap = G.filter((r) => lt.has(r.ticker)).length;
  overlapTotal += overlap;
  if (overlap < PICKS) changedDays++;
}
const summarize = (label, set) => {
  console.log(`  ${label.padEnd(8)} n=${String(set.length).padStart(3)}  ` +
              `assigned ${f((set.filter((r) => r.assigned).length / set.length) * 100, 1).padStart(5)}%  ` +
              `mean ret ${f(mean(set.map((r) => r.retPct))).padStart(6)}%  ` +
              `total ${f(set.reduce((s, r) => s + r.retPct, 0), 1).padStart(7)} pts  ` +
              `mean liq ${f(mean(set.map((r) => label === 'legacy' ? r.liqLegacy : r.liqGraded)), 1)}`);
};
console.log(`  pick sets differ on ${changedDays}/${dates.length} dates ` +
            `(mean overlap ${f(overlapTotal / dates.length, 1)}/${PICKS})`);
summarize('legacy', arms.legacy);
summarize('graded', arms.graded);
const delta = mean(arms.graded.map((r) => r.retPct)) - mean(arms.legacy.map((r) => r.retPct));
console.log(`  Δ mean return on capital: ${(delta >= 0 ? '+' : '') + f(delta)} pts per trade`);

// ── C) weight sweep — what if optionLiquidity simply carried LESS weight? ───────
//
// v1.1.133 concluded liquidity is a gate, not a ranking signal. The direct test of that is to
// vary its composite weight rather than its formula. Weight 0 == `enabled: false` in
// ScoringService: the signal drops out of BOTH numerator and denominator, so the remaining
// signals keep their relative proportions and renormalise to 100 (no manual reweighting).
// Scored with the LEGACY liquidity formula throughout — that is the shipped path.
console.log('\n═══ C. WEIGHT SWEEP — optionLiquidity weight vs realized outcome ═══');
console.log(`(legacy formula; weight 0 = signal disabled entirely, others renormalise)`);
console.log('weight   top-5/date: assigned   mean ret   total pts   picks changed vs w=13');
const base13 = new Map();
for (const w of [13, 9, 6, 3, 0]) {
  const weights = { ...INCOME_WEIGHTS, optionLiquidity: w };
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const comp = (r) => {
    let sum = 0;
    if (r.iv_rank != null) sum += normHigher(r.iv_rank, 100) * weights.ivRank;
    if (r.annualized_return != null) sum += normHigher(r.annualized_return, 60) * weights.premiumRiskRatio;
    if (r.realizedVol != null) sum += normLower(r.realizedVol, 60) * weights.recentVolatility;
    sum += normHigher(r.liqLegacy, 10) * weights.optionLiquidity;
    return sum / total;
  };
  const picked = [];
  let changed = 0;
  for (const day of dates) {
    const onDay = rows.filter((r) => r.as_of_date === day);
    const top = [...onDay].sort((a, b) => comp(b) - comp(a)).slice(0, PICKS);
    picked.push(...top);
    const key = top.map((r) => r.ticker).sort().join(',');
    if (w === 13) base13.set(day, key);
    else if (base13.get(day) !== key) changed++;
  }
  console.log(`${String(w).padStart(4)}     ` +
    `${f((picked.filter((r) => r.assigned).length / picked.length) * 100, 1).padStart(11)}%  ` +
    `${f(mean(picked.map((r) => r.retPct))).padStart(9)}%  ` +
    `${f(picked.reduce((s, r) => s + r.retPct, 0), 1).padStart(9)}   ` +
    `${w === 13 ? '(baseline)' : changed + '/' + dates.length + ' dates'}`);
}

// ── honesty block ───────────────────────────────────────────────────────────────
console.log('\n═══ READ THIS BEFORE ACTING ═══');
console.log(`• Sample: ${dates.length} entry dates inside a single ${dates[0]}→${dates[dates.length - 1]} window,`);
console.log(`  so section B rests on ~${PICKS * dates.length} trades per arm from ONE market regime. That is thin for a`);
console.log('  realized-outcome claim — the sibling FR-SEY studies used 1,000+ picks over ~1.1 years.');
console.log('• INCOME is a proxy for WHEEL: same optionLiquidity signal and same findSuitableChain,');
console.log('  but delta band 0.20–0.35 vs 0.20–0.30 and weight 13 vs 9. Not the same population.');
console.log('• The volume term (+2 of 10) is floored to 0 in BOTH arms — no historical row has volume');
console.log('  (migration 066 starts capturing it). Fair between arms, but it caps the graded scheme,');
console.log('  whose whole point is grading the components the legacy gates fail to register.');
console.log('• trendNeutral (weight 15) is null for every ticker in both arms, exactly as in live.');
console.log('• Held to expiry at intrinsic: no early management, no roll, no assignment-then-CC leg.');
console.log('• The ABSOLUTE section-B numbers are pessimistic and are NOT what the live brief would');
console.log('  produce. This reconstruction ranks on composite alone; the live income path also');
console.log('  applies the Stage-3 earnings penalty (−20 composite for income — it strips exactly the');
console.log('  earnings-runner names that blow up a short put), the liquidity hard gate, and the');
console.log('  critic. The DELTA between arms is still apples-to-apples — both omit the same things —');
console.log('  so read section B as "which scheme ranks better", never as "this is income\'s P&L".');
db.close();
