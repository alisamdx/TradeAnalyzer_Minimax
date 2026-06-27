// FR-SEY-5 validation harness — realized hold-to-expiry P&L: Big Lizard (what the bullish
// brief recommends) vs Short Put Vertical (the defined-risk alternative the bullish bucket
// excludes), on every historical bullish brief pick where both were constructible.
//
// Settles each structure at EXPIRY intrinsic using historical_prices.close on the last trading
// day ≤ expiration — no IV / time-value assumptions, the rigorous version. Picks whose expiry
// hasn't passed (or lack a forward close) are reported as "pending" and skipped.
//
// As of the 2026-06 sample NONE had expired (earliest expiry Jul 2). Re-run after Jul 24 2026
// for the full settled sample. Read-only SELECTs over a write-capable connection (CLAUDE.md).
//
// Settlement math mirrors src/shared/structure-settle.ts (canonical, unit-tested).

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

const db = new Database(join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));

// Last close on/before `date` for `ticker` (settlement at the expiry's trading day).
const settleStmt = db.prepare(
  `SELECT close, date FROM historical_prices WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT 1`
);
// Latest price date we have for the ticker (to tell "no data yet" from "truly missing").
const latestStmt = db.prepare(`SELECT MAX(date) d FROM historical_prices WHERE ticker = ?`);

const avail = (s) => s && s.setup && !s.setup.unavailableReason;
const maxLossOf = (st) => {
  if (st.maxLoss != null) return Math.abs(st.maxLoss);
  const sp = st.legs.find((l) => l.side === 'put' && l.action === 'sell');
  return sp ? sp.strike * 100 - (st.netCredit ?? 0) : null;
};
// Per-contract realized P&L at expiry (mirrors structure-settle.ts).
const settle = (legs, px) => legs.reduce((pnl, l) => {
  const intrinsic = l.side === 'call' ? Math.max(0, px - l.strike) : Math.max(0, l.strike - px);
  return pnl + (l.action === 'buy' ? 1 : -1) * (intrinsic - l.mid) * (l.qty ?? 1);
}, 0) * 100;

const rows = db.prepare(`SELECT picks FROM daily_briefs WHERE strategy='bullish' ORDER BY generated_at`).all();
const seen = new Set();
const agg = { liz: [], spv: [] };
let both = 0, pending = 0, settled = 0;

for (const row of rows) {
  let picks; try { picks = JSON.parse(row.picks); } catch { continue; }
  for (const p of picks) {
    const scores = p.strategyLabResult?.scores;
    if (!Array.isArray(scores)) continue;
    const liz = scores.find((s) => s.slug === 'big-lizard');
    const spv = scores.find((s) => s.slug === 'short-put-vertical');
    if (!avail(liz) || !avail(spv)) continue;
    both++;
    const exp = liz.setup.expiration;
    const key = `${p.ticker}|${exp}|${liz.setup.legs[0]?.strike}`; // de-dupe re-runs of same pick
    if (seen.has(key)) continue;
    seen.add(key);

    const latest = latestStmt.get(p.ticker)?.d ?? null;
    if (!latest || latest < exp) { pending++; continue; } // expiry not reached / no forward data
    const settleRow = settleStmt.get(p.ticker, exp);
    if (!settleRow) { pending++; continue; }
    settled++;

    const px = settleRow.close;
    const lizPnl = settle(liz.setup.legs, px), spvPnl = settle(spv.setup.legs, px);
    const lizCap = maxLossOf(liz.setup), spvCap = maxLossOf(spv.setup);
    agg.liz.push({ pnl: lizPnl, cap: lizCap, ret: lizCap ? lizPnl / lizCap : 0 });
    agg.spv.push({ pnl: spvPnl, cap: spvCap, ret: spvCap ? spvPnl / spvCap : 0 });
  }
}

const sum = (a, k) => a.reduce((x, y) => x + y[k], 0);
const wins = (a) => a.filter((x) => x.pnl > 0).length;
const f = (x, d = 1) => x.toFixed(d);

console.log(`\nBullish picks (both structures constructible, de-duped): ${seen.size}`);
console.log(`  pending (expiry not yet reached / no forward close): ${pending}`);
console.log(`  SETTLED at expiry: ${settled}\n`);
if (settled === 0) {
  console.log('No settled trades yet — re-run after the July 2026 expiries land for the realized delta.');
  db.close(); process.exit(0);
}
for (const [name, a] of [['Big Lizard', agg.liz], ['Short Put Vertical', agg.spv]]) {
  console.log(`${name.padEnd(20)}  total P&L $${f(sum(a, 'pnl'), 0)} | win-rate ${f((wins(a) / a.length) * 100)}% | ` +
    `avg return-on-capital ${f((sum(a, 'ret') / a.length) * 100)}% | worst $${f(Math.min(...a.map((x) => x.pnl)), 0)} | ` +
    `Σcapital $${f(sum(a, 'cap'), 0)}`);
}
const lizRoc = sum(agg.liz, 'ret') / agg.liz.length, spvRoc = sum(agg.spv, 'ret') / agg.spv.length;
console.log(`\nRealized return-on-capital delta (spv − lizard): ${f((spvRoc - lizRoc) * 100)} pp`);
console.log('FR-SEY-5: enable USE_POP_WEIGHTED_PREMIUM only if this delta is ≥ 0 (spv at-worst-neutral).');
db.close();
