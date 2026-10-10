// FR-SEY-5 study — does the lab's ~30-DTE expiry selection systematically land on thin
// WEEKLY expirations when a liquid MONTHLY sits nearby?
//
// selectExpiration (strategy-lab-service.ts) picks the expiration in [20,50] DTE closest
// to 30 with NO liquidity awareness. Standard monthly options (3rd Friday) carry far more
// open interest and tighter spreads than the end-of-month / mid-month WEEKLY expirations.
// When neither monthly lands near 30 DTE (e.g. 2026-07-01: Jul monthly 16 DTE, Aug monthly
// 51 DTE), the 30-DTE rule snaps to a weekly (Jul 31, 30 DTE) with two-digit OI.
//
// This measures, over every stored brief structure:
//   A) how often the chosen near-expiration is a weekly vs a monthly,
//   B) the liquidityScore / per-leg OI / per-leg spread% gap between weekly- and
//      monthly-landed structures (aggregate, correlational),
//   C) for weekly-landed picks, how far the NEAREST monthly sat from 30 DTE — i.e. the
//      DTE cost of snapping to the monthly instead.
//
// Reads through the running app's API (scripts/lib/app-api.mjs), never the SQLite file. The clean same-ticker A/B
// (re-price the identical structure at the nearest monthly) needs the app running and is
// the confirmation step if this aggregate looks promising.

import { loadBriefHistory } from './lib/app-api.mjs';
import { etDate } from './lib/et-time.mjs';


// ── 3rd-Friday monthly detection ────────────────────────────────────────────────
// Standard monthly options expire the 3rd Friday. Return that date (YYYY-MM-DD) for the
// month of `iso`.
function thirdFriday(year, monthIdx0) {
  // monthIdx0: 0-11. Find first Friday, add 14 days. Work in UTC to avoid TZ drift.
  const first = new Date(Date.UTC(year, monthIdx0, 1));
  const dow = first.getUTCDay();               // 0 Sun .. 6 Sat
  const firstFri = 1 + ((5 - dow + 7) % 7);    // date of first Friday
  const d = new Date(Date.UTC(year, monthIdx0, firstFri + 14));
  return d.toISOString().slice(0, 10);
}
function isMonthly(iso) {
  const [y, m] = iso.split('-').map(Number);
  return thirdFriday(y, m - 1) === iso;
}
// Nearest monthly (3rd Friday) expiration to `fromIso`, scanning this month ± a few.
function nearestMonthlyDte(fromIso) {
  const from = new Date(fromIso + 'T16:00:00Z').getTime();
  const [y, m] = fromIso.split('-').map(Number);
  let best = null;
  for (let k = -1; k <= 3; k++) {
    const mi = (m - 1) + k;
    const yy = y + Math.floor(mi / 12);
    const mm = ((mi % 12) + 12) % 12;
    const tf = thirdFriday(yy, mm);
    const dte = Math.round((new Date(tf + 'T16:00:00Z').getTime() - from) / 86_400_000);
    if (dte < 1) continue;
    if (best === null || Math.abs(dte - 30) < Math.abs(best.dte - 30)) best = { exp: tf, dte };
  }
  return best;
}

const dteBetween = (fromEt, exp) =>
  Math.round((new Date(exp + 'T16:00:00Z').getTime() - new Date(fromEt + 'T16:00:00Z').getTime()) / 86_400_000);

const legSpreadPct = (l) => (l.bid > 0 ? ((l.ask - l.bid) / ((l.ask + l.bid) / 2)) * 100 : null);

const { briefs: rows } = await loadBriefHistory();

const seen = new Set();
const buckets = { monthly: [], weekly: [] }; // each entry: { liq, oiAvg, spreadAvg, dte }
let totalStructures = 0;
const weeklyDteShift = [];        // (nearest-monthly DTE − 30) magnitude for weekly-landed picks
let weeklyMonthlyInBand = 0;      // weekly-landed where a monthly ALSO fell in [20,50]
let weeklyLanded = 0;

for (const row of rows) {
  let picks; try { picks = JSON.parse(row.picks); } catch { continue; }
  const dEt = etDate(row.generated_at);
  for (const p of picks) {
    const scores = p.strategyLabResult?.scores;
    if (!Array.isArray(scores)) continue;
    for (const s of scores) {
      const exp = s.setup?.expiration;
      if (!s.setup || s.setup.unavailableReason || !exp || s.liquidityScore == null) continue;
      // Calendars/PMCC have a far leg on a different (usually monthly) expiration — the
      // liquidity concern is the NEAR/short expiration, which setup.expiration holds.
      const key = `${dEt}|${p.ticker}|${s.slug}|${exp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      totalStructures++;

      const legs = (s.setup.legs ?? []).filter((l) => l.expiration === exp);
      const ois = legs.map((l) => l.openInterest).filter((x) => typeof x === 'number');
      const spreads = legs.map(legSpreadPct).filter((x) => x != null);
      const entry = {
        liq: s.liquidityScore,
        oiAvg: ois.length ? ois.reduce((a, b) => a + b, 0) / ois.length : null,
        spreadAvg: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null,
        dte: dteBetween(dEt, exp),
      };
      const monthly = isMonthly(exp);
      buckets[monthly ? 'monthly' : 'weekly'].push(entry);

      if (!monthly) {
        weeklyLanded++;
        const nm = nearestMonthlyDte(dEt);
        if (nm) {
          weeklyDteShift.push(Math.abs(nm.dte - 30) - Math.abs(entry.dte - 30));
          if (nm.dte >= 20 && nm.dte <= 50) weeklyMonthlyInBand++;
        }
      }
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────────
const f = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));
const stats = (arr, k) => {
  const v = arr.map((e) => e[k]).filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return { mean: null, med: null, n: 0 };
  return { mean: v.reduce((a, b) => a + b, 0) / v.length, med: v[Math.floor(v.length / 2)], n: v.length };
};
const barAt8 = (arr) => arr.filter((e) => e.liq >= 8).length;

console.log(`\nUnique brief structures (de-duped by date+ticker+slug+expiration): ${totalStructures}`);
console.log(`  landed on MONTHLY (3rd Friday): ${buckets.monthly.length} (${f((buckets.monthly.length / totalStructures) * 100, 0)}%)`);
console.log(`  landed on WEEKLY:               ${buckets.weekly.length} (${f((buckets.weekly.length / totalStructures) * 100, 0)}%)`);

console.log('\n                     n     mean-liq  med-liq  clears≥8   mean-OI/leg  mean-spread%/leg  mean-DTE');
for (const [name, arr] of [['MONTHLY', buckets.monthly], ['WEEKLY', buckets.weekly]]) {
  const liq = stats(arr, 'liq'), oi = stats(arr, 'oiAvg'), sp = stats(arr, 'spreadAvg'), dte = stats(arr, 'dte');
  const pass = arr.length ? (barAt8(arr) / arr.length) * 100 : 0;
  console.log(
    `${name.padEnd(10)} ${String(arr.length).padStart(9)}   ${f(liq.mean, 2).padStart(6)}   ${f(liq.med, 0).padStart(5)}   ` +
    `${f(pass, 0).padStart(5)}%   ${f(oi.mean, 0).padStart(9)}   ${f(sp.mean, 1).padStart(12)}   ${f(dte.mean, 0).padStart(7)}`
  );
}

const shiftMean = weeklyDteShift.length ? weeklyDteShift.reduce((a, b) => a + b, 0) / weeklyDteShift.length : null;
console.log(`\nWeekly-landed structures: ${weeklyLanded}`);
console.log(`  a MONTHLY also fell within the [20,50] DTE band on ${weeklyMonthlyInBand}/${weeklyLanded} (${f((weeklyMonthlyInBand / Math.max(weeklyLanded, 1)) * 100, 0)}%) — i.e. an in-band monthly alternative existed`);
console.log(`  mean |Δ-from-30| penalty of snapping to nearest monthly: ${f(shiftMean, 1)} DTE (positive = monthly sits further from 30 than the chosen weekly)`);

// ── Within-slug control (removes the structure-composition confound) ────────────
// Compare monthly vs weekly liquidity for the SAME structure slug, so the gap can't be
// an artifact of monthlies hosting more far-OTM-wing structure types.
console.log('\nWithin-slug control (same structure type, monthly vs weekly mean liquidityScore):');
console.log('slug                         n-mo  liq-mo   n-wk  liq-wk   Δ(mo−wk)');
// Re-walk quickly for slug-level detail: cheaper than threading the slug through
// the entries above. (An empty scaffold loop stood here and did nothing.)
const slugAgg = {};
{
  const seen2 = new Set();
  for (const row of rows) {
    let picks; try { picks = JSON.parse(row.picks); } catch { continue; }
    const dEt = etDate(row.generated_at);
    for (const p of picks) {
      const scores = p.strategyLabResult?.scores;
      if (!Array.isArray(scores)) continue;
      for (const s of scores) {
        const exp = s.setup?.expiration;
        if (!s.setup || s.setup.unavailableReason || !exp || s.liquidityScore == null) continue;
        const key = `${dEt}|${p.ticker}|${s.slug}|${exp}`;
        if (seen2.has(key)) continue;
        seen2.add(key);
        const a = (slugAgg[s.slug] ??= { mo: [], wk: [] });
        a[isMonthly(exp) ? 'mo' : 'wk'].push(s.liquidityScore);
      }
    }
  }
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const slugRows = Object.entries(slugAgg)
  .filter(([, a]) => a.mo.length >= 20 && a.wk.length >= 20)
  .map(([slug, a]) => ({ slug, nMo: a.mo.length, liqMo: mean(a.mo), nWk: a.wk.length, liqWk: mean(a.wk) }))
  .sort((x, y) => (y.liqMo - y.liqWk) - (x.liqMo - x.liqWk));
for (const r of slugRows) {
  console.log(
    `${r.slug.padEnd(28)} ${String(r.nMo).padStart(4)}  ${f(r.liqMo, 2).padStart(5)}   ${String(r.nWk).padStart(4)}  ${f(r.liqWk, 2).padStart(5)}   ${f(r.liqMo - r.liqWk, 2).padStart(7)}`
  );
}
const posGap = slugRows.filter((r) => r.liqMo > r.liqWk).length;
console.log(`\n${posGap}/${slugRows.length} structure types are more liquid on the monthly. ` +
  `(Per-leg spread% in the top table is confounded by far-OTM wings — liquidityScore/OI are the reliable measures.)`);
console.log('\nNote: still aggregate. Same-ticker A/B (re-price identical structure at nearest monthly) needs the app running — the confirmation step.');
