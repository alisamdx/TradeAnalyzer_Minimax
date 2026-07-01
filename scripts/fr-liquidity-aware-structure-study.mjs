// FR-SEY-5 study — liquidity-aware structure selection for the Brief/Critic.
//
// Hypothesis: picks get critic-flagged `low_liquidity` because `pickRelevantStructure`
// selects the highest-graded structure (often a multi-leg exotic — big-lizard,
// put-butterfly) whose liquidityScore sits below the tradability bar (8/15), while a
// plainer strategy-relevant structure (e.g. long-call-vertical) clears the bar with an
// acceptable grade. If so, preferring bar-clearing structures converts warning-flags
// into clean verdicts WITHOUT losing P&L.
//
// V0 = current selection (mirrors src/shared/strategy-structures.ts pickRelevantStructure).
// V1 = V0 tiers (defined-risk pref → pin-bet rule) + final tier: prefer structures with
//      liquidityScore ≥ 8, no zero-bid leg, grade ≥ C; grade order within (scores are
//      best-first). Falls back to the V0 choice when nothing clears.
// Inflection is direction-locked (single slug) — V1 ≡ V0 by construction.
//
// Part A: critic-warning emulation (mirrors critic-service.checkLiquidity's warning
//         branch: defined-risk spread AND (liq < 8 OR zero-bid leg)) for V0 vs V1.
// Part B: realized hold-to-expiry intrinsic P&L of V0 vs V1 structures on picks where
//         the choice differs and the expiry has settled (mirrors structure-settle.ts).
//
// Read-only SELECTs over a write-capable connection (CLAUDE.md quirk).

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

const db = new Database(join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));

// ── Mirrors of src/shared/strategy-structures.ts (keep in sync manually) ────────
const STRATEGY_RELEVANT_SLUGS = {
  wheel:   ['short-naked-put', 'covered-call'],
  bullish: ['long-call-vertical', 'big-lizard', 'call-zebra', 'call-butterfly', 'poor-mans-covered-call'],
  bearish: ['long-put-vertical', 'reverse-big-lizard', 'put-zebra', 'put-butterfly', 'poor-mans-covered-put'],
  income:  ['short-strangle', 'iron-condor', 'short-straddle', 'dynamic-width-iron-condor', 'iron-fly'],
  buy:     ['long-call-vertical', 'call-zebra', 'poor-mans-covered-call', 'call-calendar'],
  inflection: ['short-put-vertical', 'short-call-vertical'],
};
const INFLECTION_SLUG_BY_DIRECTION = { up: 'short-put-vertical', down: 'short-call-vertical' };
const GRADE_RANK = { 'A+': 6, A: 5, B: 4, C: 3, D: 2, F: 1 };
const PIN_BET_SLUGS = new Set(['put-butterfly', 'call-butterfly']);
const DIRECTIONAL_STRATEGIES = new Set(['bullish', 'bearish', 'buy']);
const MIN_DIRECTIONAL_GRADE = GRADE_RANK.C;
const MIN_TRADABLE_LIQUIDITY_SCORE = 8;

const relevantSlugs = (strategy, dir) =>
  strategy === 'inflection'
    ? [INFLECTION_SLUG_BY_DIRECTION[dir ?? 'up']]
    : (STRATEGY_RELEVANT_SLUGS[strategy] ?? []);

const hasNoBidLeg = (s) => (s.setup?.legs ?? []).some((l) => (l.bid ?? 0) <= 0);
const isTradable = (s) => (s.liquidityScore ?? 0) >= MIN_TRADABLE_LIQUIDITY_SCORE && !hasNoBidLeg(s);

function basePool(scores, strategy, dir) {
  const slugs = relevantSlugs(strategy, dir);
  const valid = (scores ?? []).filter((s) => slugs.includes(s.slug) && s.setup != null && !s.setup.unavailableReason);
  if (valid.length === 0) return [];
  const definedRisk = valid.filter((s) => s.setup?.maxLoss != null);
  let pool = definedRisk.length > 0 ? definedRisk : valid;
  if (DIRECTIONAL_STRATEGIES.has(strategy)) {
    const directional = pool.filter(
      (s) => !PIN_BET_SLUGS.has(s.slug) && (GRADE_RANK[s.grade] ?? 0) >= MIN_DIRECTIONAL_GRADE,
    );
    if (directional.length > 0) pool = directional;
  }
  return pool;
}

const pickV0 = (scores, strategy, dir) => basePool(scores, strategy, dir)[0] ?? null;

function pickV1(scores, strategy, dir) {
  const pool = basePool(scores, strategy, dir);
  if (pool.length === 0) return null;
  if (strategy === 'inflection') return pool[0]; // direction-locked — never swapped
  const tradable = pool.filter((s) => isTradable(s) && (GRADE_RANK[s.grade] ?? 0) >= GRADE_RANK.C);
  return tradable[0] ?? pool[0];
}

// Critic warning emulation (critic-service.checkLiquidity warning branch).
function emitsWarning(s) {
  if (!s) return false;
  const legs = s.setup?.legs ?? [];
  const isDefinedRiskSpread = legs.length > 1 && s.setup?.maxLoss != null;
  return isDefinedRiskSpread && ((s.liquidityScore ?? 0) < MIN_TRADABLE_LIQUIDITY_SCORE || hasNoBidLeg(s));
}

// ── Part B settle helpers (mirror structure-settle.ts / backtest-lizard-vs-spread) ──
const settleStmt = db.prepare(
  `SELECT close FROM historical_prices WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT 1`
);
const latestStmt = db.prepare(`SELECT MAX(date) d FROM historical_prices WHERE ticker = ?`);
const settle = (legs, px) => legs.reduce((pnl, l) => {
  const intrinsic = l.side === 'call' ? Math.max(0, px - l.strike) : Math.max(0, l.strike - px);
  return pnl + (l.action === 'buy' ? 1 : -1) * (intrinsic - l.mid) * (l.qty ?? 1);
}, 0) * 100;
const maxLossOf = (setup) => (setup.maxLoss != null ? Math.abs(setup.maxLoss) : null);

// ── Walk every stored brief pick ───────────────────────────────────────────────
const rows = db.prepare(`SELECT strategy, generated_at, picks FROM daily_briefs ORDER BY generated_at`).all();

const perStrategy = {}; // strategy → counters
const transitions = {}; // "fromSlug → toSlug" → count
const gradeDeltas = [];
const pnlPairs = []; // { strategy, v0Pnl, v1Pnl, v0Cap, v1Cap }
const seenPick = new Set();
const seenPnl = new Set();
let totalPicks = 0, withLab = 0, pendingPnl = 0;

for (const row of rows) {
  let picks; try { picks = JSON.parse(row.picks); } catch { continue; }
  const strategy = row.strategy;
  for (const p of picks) {
    totalPicks++;
    const scores = p.strategyLabResult?.scores;
    if (!Array.isArray(scores) || scores.length === 0) continue;
    withLab++;

    const dir = p.breakoutDirection
      ?? (p.signals?.breakout?.value === -1 || p.signals?.breakoutState?.value === -1 ? 'down' : 'up');

    const v0 = pickV0(scores, strategy, dir);
    const v1 = pickV1(scores, strategy, dir);
    if (!v0) continue;

    // De-dupe the same pick re-run across the two daily slots / consecutive days.
    const pickKey = `${strategy}|${p.ticker}|${v0.setup?.expiration}|${v0.slug}|${v1?.slug}`;
    if (seenPick.has(pickKey)) continue;
    seenPick.add(pickKey);

    const st = (perStrategy[strategy] ??= {
      picks: 0, v0Warn: 0, v1Warn: 0, changed: 0, converted: 0, unresolvable: 0,
    });
    st.picks++;

    const w0 = emitsWarning(v0);
    const w1 = emitsWarning(v1);
    if (w0) st.v0Warn++;
    if (w1) st.v1Warn++;
    if (w0 && w1) st.unresolvable++;
    if (w0 && !w1) st.converted++;

    if (v1 && v1.slug !== v0.slug) {
      st.changed++;
      const key = `${strategy}: ${v0.slug} (${v0.grade}, liq ${v0.liquidityScore ?? '?'}) → ${v1.slug} (${v1.grade}, liq ${v1.liquidityScore ?? '?'})`;
      transitions[key] = (transitions[key] ?? 0) + 1;
      gradeDeltas.push((GRADE_RANK[v1.grade] ?? 0) - (GRADE_RANK[v0.grade] ?? 0));

      // Part B — settle both structures at expiry when possible.
      const exp = v0.setup?.expiration;
      const exp1 = v1.setup?.expiration;
      if (exp && exp1) {
        const pnlKey = `${p.ticker}|${exp}|${v0.slug}|${v1.slug}|${v0.setup.legs?.[0]?.strike}`;
        if (!seenPnl.has(pnlKey)) {
          seenPnl.add(pnlKey);
          const latest = latestStmt.get(p.ticker)?.d ?? null;
          if (latest && latest >= exp && latest >= exp1) {
            const px0 = settleStmt.get(p.ticker, exp)?.close;
            const px1 = settleStmt.get(p.ticker, exp1)?.close;
            if (px0 != null && px1 != null && v0.setup.legs?.length && v1.setup.legs?.length) {
              pnlPairs.push({
                strategy,
                v0Pnl: settle(v0.setup.legs, px0), v1Pnl: settle(v1.setup.legs, px1),
                v0Cap: maxLossOf(v0.setup),       v1Cap: maxLossOf(v1.setup),
              });
            }
          } else {
            pendingPnl++;
          }
        }
      }
    }
  }
}

// ── Report ─────────────────────────────────────────────────────────────────────
const f = (x, d = 1) => (x == null ? '—' : x.toFixed(d));
console.log(`\nBrief picks scanned: ${totalPicks} (${withLab} with lab result; ${seenPick.size} unique after de-dupe)\n`);

console.log('Part A — critic low-liquidity WARNING emulation (V0 = current, V1 = liquidity-aware):');
console.log('strategy    picks  V0-warn  V1-warn  converted  unresolvable  structure-changed');
for (const [s, c] of Object.entries(perStrategy).sort()) {
  console.log(
    `${s.padEnd(11)} ${String(c.picks).padStart(5)}  ${String(c.v0Warn).padStart(7)}  ${String(c.v1Warn).padStart(7)}` +
    `  ${String(c.converted).padStart(9)}  ${String(c.unresolvable).padStart(12)}  ${String(c.changed).padStart(17)}`
  );
}

console.log('\nSlug transitions (V0 → V1) with counts:');
for (const [k, n] of Object.entries(transitions).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}× ${k}`);
}

if (gradeDeltas.length) {
  const mean = gradeDeltas.reduce((a, b) => a + b, 0) / gradeDeltas.length;
  console.log(`\nGrade delta on changed picks (V1 − V0, grade ranks): mean ${f(mean, 2)} | ` +
    `min ${Math.min(...gradeDeltas)} | max ${Math.max(...gradeDeltas)}`);
}

console.log(`\nPart B — realized hold-to-expiry intrinsic P&L on CHANGED picks (settled only; ${pendingPnl} pending):`);
if (pnlPairs.length === 0) {
  console.log('  No settled changed picks yet.');
} else {
  const byStrat = {};
  for (const p of pnlPairs) (byStrat[p.strategy] ??= []).push(p);
  for (const [s, arr] of Object.entries(byStrat).sort()) {
    const sum = (k) => arr.reduce((a, b) => a + b[k], 0);
    const wins = (k) => arr.filter((x) => x[k] > 0).length;
    const roc = (pk, ck) => arr.filter((x) => x[ck]).reduce((a, b) => a + b[pk] / b[ck], 0) / arr.filter((x) => x[ck]).length;
    console.log(`  ${s} (${arr.length} settled):`);
    console.log(`    V0 total $${f(sum('v0Pnl'), 0)} | win ${wins('v0Pnl')}/${arr.length} | avg RoC ${f(roc('v0Pnl', 'v0Cap') * 100)}%`);
    console.log(`    V1 total $${f(sum('v1Pnl'), 0)} | win ${wins('v1Pnl')}/${arr.length} | avg RoC ${f(roc('v1Pnl', 'v1Cap') * 100)}%`);
  }
  const t0 = pnlPairs.reduce((a, b) => a + b.v0Pnl, 0), t1 = pnlPairs.reduce((a, b) => a + b.v1Pnl, 0);
  console.log(`  ALL (${pnlPairs.length}): V0 $${f(t0, 0)} vs V1 $${f(t1, 0)} → delta $${f(t1 - t0, 0)} (V1 − V0)`);
}
db.close();
