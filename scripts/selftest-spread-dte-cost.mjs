// Self-test for fr-spread-dte-cost-study.mjs, on a synthetic chain set with KNOWN answers.
//
// Why this exists: that harness reimplements `buildBullPutSpread` and `fillPrice`, because a
// scripts/*.mjs harness cannot import the real service (plain node cannot resolve the `@shared/*`
// aliases). A reimplementation nothing exercises is a confident wrong answer waiting to happen, and
// this project has shipped two of them. Every fixture below has one unambiguous right answer.
//
// The fixture (2 capture dates × the tickers below, expiries at 21 and 30 DTE):
//   WIDE   — the 21-DTE chain quotes twice the spread of the 30-DTE one on a smaller credit, so the
//            shorter expiry MUST come out more expensive and MUST fail the 25% gate at 21 only.
//   TIGHT  — penny-wide quotes at both expiries, so both clear and the pair sits on the diagonal.
//   NOWING — the 30-DTE chain has no strike inside the 3–10% wing band, so the pair is DROPPED
//            (paired-only) and the reason is counted under "could not build".
//   ONEEXP — only a 30-DTE chain exists, so it is dropped as "no 21-DTE expiry" and never pairs.
//   SAMEXP — both buckets resolve to the ONE stored expiry, which must be refused rather than
//            compared against itself (a self-comparison would report a perfect tie and read as a
//            clean null).
//
// Needs the NODE better-sqlite3 ABI: run `npm run rebuild:node` first if you have just packaged.
//
//   node scripts/selftest-spread-dte-cost.mjs

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'bps4-'));
const dbPath = join(dir, 'fixture.sqlite');
const db = new Database(dbPath);
db.exec(`CREATE TABLE spread_chain_capture (
  as_of_date TEXT, slot TEXT, captured_at TEXT, ticker TEXT, expiration TEXT, dte INTEGER,
  reason TEXT, underlying_price REAL, contract_count INTEGER, puts_json TEXT
);`);

const ins = db.prepare(
  `INSERT INTO spread_chain_capture
     (as_of_date, slot, captured_at, ticker, expiration, dte, reason, underlying_price, contract_count, puts_json)
   VALUES (?, 'intraday', 'x', ?, ?, ?, 'entry', ?, ?, ?)`,
);

// A put: [strike, bid, ask, delta, ivPct, openInterest, volume]
const put = (strike, bid, ask, delta) => [strike, bid, ask, delta, 30, 500, 10];

// Spot 100. Short leg lands at strike 95 (Δ −0.30); the wing target is 95 − 5 = 90, inside 3–10%.
const chain = (halfSpread, mid95, mid90) => [
  put(95, mid95 - halfSpread, mid95 + halfSpread, -0.30),
  put(90, mid90 - halfSpread, mid90 + halfSpread, -0.15),
];

// 2026-06-01 + 21d = 2026-06-22 (Mon), + 30d = 2026-07-01 (Wed) — neither is a third Friday, so the
// monthly split is 0%/0% and cannot be mistaken for the driver.
const DATES = [['2026-06-01', '2026-06-22', '2026-07-01'], ['2026-06-02', '2026-06-23', '2026-07-02']];

for (const [asOf, e21, e30] of DATES) {
  // WIDE: 21-DTE credit 1.50 on $0.40 half-spreads; 30-DTE credit 2.50 on $0.10.
  //   21: entry slip = 0.40/2 + 0.40/2 = 0.40 → round trip 0.80 → 0.80/1.50 = 53.3% → FAILS
  //   30: entry slip = 0.10/2 + 0.10/2 = 0.10 → round trip 0.20 → 0.20/2.50 =  8.0% → clears
  ins.run(asOf, 'WIDE', e21, 21, 100, 2, JSON.stringify(chain(0.40, 3.00, 1.50)));
  ins.run(asOf, 'WIDE', e30, 30, 100, 2, JSON.stringify(chain(0.10, 5.00, 2.50)));

  // TIGHT: $0.02 half-spreads both sides → 2.7% and 1.6%, both clear.
  ins.run(asOf, 'TIGHT', e21, 21, 100, 2, JSON.stringify(chain(0.02, 3.00, 1.50)));
  ins.run(asOf, 'TIGHT', e30, 30, 100, 2, JSON.stringify(chain(0.02, 5.00, 2.50)));

  // NOWING: the 30-DTE chain's only lower strike is 93, i.e. 2% below the short — under wingMinPct 3%.
  ins.run(asOf, 'NOWING', e21, 21, 100, 2, JSON.stringify(chain(0.05, 3.00, 1.50)));
  ins.run(asOf, 'NOWING', e30, 30, 100, 2, JSON.stringify([
    put(95, 4.95, 5.05, -0.30), put(93, 3.95, 4.05, -0.22),
  ]));

  // ONEEXP: no 21-DTE chain at all.
  ins.run(asOf, 'ONEEXP', e30, 30, 100, 2, JSON.stringify(chain(0.05, 5.00, 2.50)));

  // SAMEXP: one expiration stored under two DTE values, as a stale re-capture would leave it. Both
  // buckets resolve to the same contract, which must be refused on EXPIRATION equality — a DTE check
  // alone would not catch it, and comparing a row against itself reports a perfect tie that reads as
  // a clean null.
  ins.run(asOf, 'SAMEXP', '2026-06-25', 21, 100, 2, JSON.stringify(chain(0.05, 3.00, 1.50)));
  ins.run(asOf, 'SAMEXP', '2026-06-25', 30, 100, 2, JSON.stringify(chain(0.05, 5.00, 2.50)));
}
db.close();

const outText = execFileSync(process.execPath, [
  join(import.meta.dirname, 'fr-spread-dte-cost-study.mjs'), '--db', dbPath,
], { encoding: 'utf8' });

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const has = s => outText.includes(s);

console.log(outText);
console.log('— assertions —');

// Pairing: WIDE and TIGHT pair on both dates = 4. NOWING/ONEEXP/SAMEXP must not.
check('4 pairs (WIDE + TIGHT × 2 dates)', /→ \*\*4 paired\*\*/.test(outText), outText.match(/→ \*\*\d+ paired\*\*/)?.[0]);
check('ONEEXP dropped for having no 21-DTE expiry', /no 21-DTE expiry 2\b/.test(outText));
check('SAMEXP refused as a self-comparison', /same contract 2\b/.test(outText));

// The headline direction: the shorter expiry must be the more expensive one here.
const diff = outText.match(/Median per-pair cost share difference \(21 − 30\): \*\*([-\d.]+)%\*\*/);
check('median paired difference is positive (21 DTE costs more)', diff != null && Number(diff[1]) > 0, diff?.[1]);
check('the shorter expiry is cheaper on 0 of 4 pairs', /cheaper on \*\*0 of 4\*\*/.test(outText));

// The 2×2: WIDE fails at 21 and clears at 30 on both dates; TIGHT clears both.
check('2 pairs clear at both DTEs (TIGHT × 2)', /\| \*\*clears at 21\*\* \| 2 \| 0 \|/.test(outText));
check('2 pairs are tradable only at 30 DTE (WIDE × 2)', /\| \*\*fails at 21\*\* \| 2 \| 0 \|/.test(outText));

// The cost gate must never be used as a filter — WIDE's 53% must be visible, not dropped.
check('the over-gate bucket is reported, not filtered out', /fails the 25% gate/.test(outText) && has('| 21 DTE | 4 |'));

// The wing failure is counted where that evidence lives, and only on the 30-DTE side.
check('NOWING counted under "could not build" at 30 DTE', /At 30 DTE: no two-sided long put in the wing band 2/.test(outText));
check('nothing failed to build at 21 DTE', /At 21 DTE: none/.test(outText));

// The monthly confound is reported even when it is 0/0 — a silent 0 and an unreported 0 look alike.
check('monthly share reported for both buckets', /Monthly share: 21 DTE \*\*0%\*\* · 30 DTE \*\*0%\*\*/.test(outText));
check('expiry-type 2×2 puts all 4 pairs in the weekly/weekly cell',
  /\| \*\*21 DTE weekly\*\* \| 4 \| 0 \|/.test(outText) && /\| \*\*21 DTE monthly\*\* \| 0 \| 0 \|/.test(outText));
check('the both-monthly cell is named as structurally empty (17 < 28 days apart)',
  /structurally empty/.test(outText) && /at most 17 days apart/.test(outText));
check('same-expiry-type subgroup reported as too few at n=4', /Same expiry type: 4 pairs — too few to say anything/.test(outText));
// Only TIGHT clears at both DTEs (2 pairs), so the conditional subgroup must refuse to report a number
// rather than quoting one off two observations.
check('conditional-on-tradable subgroup refuses at n=2',
  /Both buckets clear the gate: 2 pairs — too few to say anything/.test(outText));
check('the both-controls-on cell refuses at n=2',
  /Same type AND both clear: 2 pairs — too few to say anything/.test(outText));
// As traded: TIGHT clears at both DTEs, WIDE only at 30 — so 2 of 4 at 21 and 4 of 4 at 30.
check('as-traded book counts are 2 of 4 at 21 DTE and 4 of 4 at 30 DTE',
  /\| 21 DTE \| 2 of 4 \|/.test(outText) && /\| 30 DTE \| 4 of 4 \|/.test(outText));
check('the pool change from moving the target is reported as −50%',
  /changes the tradable pool by \*\*−50%\*\*/.test(outText));

// ── the answer must be able to come out the OTHER way ───────────────────────────────────────────
// A check that can only report "the shorter expiry costs more" is decoration — the shape of the
// conviction band that could never fire and the liquidity gate that always did. This fixture inverts
// the quotes: the 21-DTE chain is penny-wide and the 30-DTE one is wide, so the sign must flip.
const dir2 = mkdtempSync(join(tmpdir(), 'bps4-inv-'));
const dbPath2 = join(dir2, 'fixture.sqlite');
const db2 = new Database(dbPath2);
db2.exec(`CREATE TABLE spread_chain_capture (
  as_of_date TEXT, slot TEXT, captured_at TEXT, ticker TEXT, expiration TEXT, dte INTEGER,
  reason TEXT, underlying_price REAL, contract_count INTEGER, puts_json TEXT
);`);
const ins2 = db2.prepare(
  `INSERT INTO spread_chain_capture
     (as_of_date, slot, captured_at, ticker, expiration, dte, reason, underlying_price, contract_count, puts_json)
   VALUES (?, 'intraday', 'x', ?, ?, ?, 'entry', ?, ?, ?)`,
);
for (const [asOf, e21, e30] of DATES) {
  ins2.run(asOf, 'INV', e21, 21, 100, 2, JSON.stringify(chain(0.02, 3.00, 1.50)));   // 2.7%
  ins2.run(asOf, 'INV', e30, 30, 100, 2, JSON.stringify(chain(0.50, 5.00, 2.50)));   // 40% — fails
}
db2.close();

const invText = execFileSync(process.execPath, [
  join(import.meta.dirname, 'fr-spread-dte-cost-study.mjs'), '--db', dbPath2,
], { encoding: 'utf8' });

const invDiff = invText.match(/Median per-pair cost share difference \(21 − 30\): \*\*([-\d.]+)%\*\*/);
check('inverted fixture: the median difference goes NEGATIVE', invDiff != null && Number(invDiff[1]) < 0, invDiff?.[1]);
check('inverted fixture: the shorter expiry is cheaper on 2 of 2', /cheaper on \*\*2 of 2\*\*/.test(invText));
check('inverted fixture: the 2×2 puts both names on the "only at 21" cell',
  /\| \*\*clears at 21\*\* \| 0 \| 2 \|/.test(invText));

rmSync(dir, { recursive: true, force: true });
rmSync(dir2, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
