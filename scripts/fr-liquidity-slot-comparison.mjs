// Companion to fr-liquidity-aware-structure-study.mjs — is the low-liquidity wall a
// MEASUREMENT-TIME artifact? The orchestrator validates chains twice a trading day:
// ~10:15 ET (markets open, live quotes) and ~17:00+ ET (after close, quotes stale/wide).
// If the same pick's chosen structure scores materially lower on the evening run, the
// critic's warnings partly reflect WHEN we measure, not true tradability.
//
// Pairs picks by (date-ET, strategy, ticker, slug) across the two slots and compares
// liquidityScore + zero-bid-leg incidence. Read-only over a write-capable connection.

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

const db = new Database(join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));

const STRATEGY_RELEVANT_SLUGS = {
  wheel:   ['short-naked-put', 'covered-call'],
  bullish: ['long-call-vertical', 'big-lizard', 'call-zebra', 'call-butterfly', 'poor-mans-covered-call'],
  bearish: ['long-put-vertical', 'reverse-big-lizard', 'put-zebra', 'put-butterfly', 'poor-mans-covered-put'],
  income:  ['short-strangle', 'iron-condor', 'short-straddle', 'dynamic-width-iron-condor', 'iron-fly'],
  buy:     ['long-call-vertical', 'call-zebra', 'poor-mans-covered-call', 'call-calendar'],
  inflection: ['short-put-vertical', 'short-call-vertical'],
};

// ET calendar date + ET hour from a UTC ISO string (handles EDT approx via fixed -4 —
// the sample is Apr–Jul, all EDT).
function etParts(iso) {
  const d = new Date(new Date(iso).getTime() - 4 * 3600_000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

const rows = db.prepare(`SELECT strategy, generated_at, picks FROM daily_briefs ORDER BY generated_at`).all();

// key = date|strategy|ticker|slug → { morning: {liq, noBid}, evening: {...} }
const pairs = new Map();
let morningRuns = new Set(), eveningRuns = new Set();

for (const row of rows) {
  let picks; try { picks = JSON.parse(row.picks); } catch { continue; }
  const { date, hour } = etParts(row.generated_at);
  const slot = hour < 14 ? 'morning' : 'evening'; // 10:15 run lands ~10-13 ET; close run ≥ 16
  (slot === 'morning' ? morningRuns : eveningRuns).add(`${date}`);
  const slugs = STRATEGY_RELEVANT_SLUGS[row.strategy] ?? [];

  for (const p of picks) {
    const scores = p.strategyLabResult?.scores;
    if (!Array.isArray(scores)) continue;
    for (const s of scores) {
      if (!slugs.includes(s.slug) || !s.setup || s.setup.unavailableReason) continue;
      const key = `${date}|${row.strategy}|${p.ticker}|${s.slug}`;
      const entry = pairs.get(key) ?? {};
      entry[slot] = {
        liq: s.liquidityScore ?? null,
        noBid: (s.setup.legs ?? []).some((l) => (l.bid ?? 0) <= 0),
      };
      pairs.set(key, entry);
    }
  }
}

const paired = [...pairs.values()].filter((e) => e.morning?.liq != null && e.evening?.liq != null);
console.log(`\nDistinct ET dates with a morning run: ${morningRuns.size}, evening run: ${eveningRuns.size}`);
console.log(`Structure observations paired across both slots (same date+strategy+ticker+slug): ${paired.length}`);

if (paired.length === 0) {
  console.log('No paired observations — cannot compare slots.');
  db.close(); process.exit(0);
}

const f = (x, d = 2) => x.toFixed(d);
const mLiq = paired.map((e) => e.morning.liq);
const eLiq = paired.map((e) => e.evening.liq);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const deltas = paired.map((e) => e.evening.liq - e.morning.liq);

console.log(`\nliquidityScore  morning mean ${f(mean(mLiq))} | evening mean ${f(mean(eLiq))} | paired delta (eve−morn) mean ${f(mean(deltas))}`);
console.log(`zero-bid leg    morning ${paired.filter((e) => e.morning.noBid).length}/${paired.length} | evening ${paired.filter((e) => e.evening.noBid).length}/${paired.length}`);

const BAR = 8;
const mPass = paired.filter((e) => e.morning.liq >= BAR).length;
const ePass = paired.filter((e) => e.evening.liq >= BAR).length;
const flips = paired.filter((e) => e.morning.liq >= BAR && e.evening.liq < BAR).length;
const flipsUp = paired.filter((e) => e.morning.liq < BAR && e.evening.liq >= BAR).length;
console.log(`clears bar (≥${BAR})  morning ${mPass}/${paired.length} (${f((mPass / paired.length) * 100, 0)}%) | evening ${ePass}/${paired.length} (${f((ePass / paired.length) * 100, 0)}%)`);
console.log(`bar flips: morning-pass → evening-fail ${flips} | morning-fail → evening-pass ${flipsUp}`);

// Distribution of deltas
const hist = {};
for (const d of deltas) { const b = d < -4 ? '≤-5' : d > 4 ? '≥+5' : String(d); hist[b] = (hist[b] ?? 0) + 1; }
console.log('\npaired delta histogram (evening − morning):');
for (const k of Object.keys(hist).sort((a, b) => (parseInt(a) || -99) - (parseInt(b) || 99))) {
  console.log(`  ${k.padStart(4)}: ${hist[k]}`);
}
db.close();
