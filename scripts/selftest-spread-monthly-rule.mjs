// Self-test for fr-spread-monthly-rule-study.mjs, on a synthetic chain set with KNOWN answers.
//
// Why this exists: that harness decides whether a live selection rule should change, on a
// reimplementation of the mode's expiry picker that nothing else exercises (a `scripts/*.mjs` harness
// cannot import the real service — plain node cannot resolve the `@shared/*` aliases). It also has to
// get two things right that are easy to get subtly wrong: arm B must FALL BACK to arm A when no
// monthly exists (or the two arms differ on runs where no choice existed), and the earnings filter
// must apply to both arms identically.
//
// The dates are real and were checked, not assumed: 2026-06-19 IS a third Friday; 2026-06-12,
// 2026-06-26 and 2026-07-03 are not. From 2026-05-29 they sit at 21, 28 and 35 DTE.
//
// The fixture:
//   DISAGREE × 12  expiries at 21 (monthly, TIGHT, THIN) / 28 (weekly, WIDE, DEEP) / 35 (weekly).
//                  A takes 28 DTE (nearest 30); B takes the monthly at 21. So B must be cheaper on
//                  all 12 AND thinner on all 12 — the two reports must move independently, because
//                  the wheel's rejection turned on exactly that combination.
//   AGREE × 3      from 2026-05-21 the monthly is at 29 DTE, so it IS the nearest-30 pick. Both arms
//                  choose it: agreed, and NOT counted as "no monthly available".
//   NOMONTHLY × 2  only weeklies in the window. B must fall back to A — agreed, and counted.
//   EARN × 1       an earnings date of 2026-06-25 excludes the 28 and 35 DTE expiries from BOTH arms,
//                  leaving only the monthly. Agreed, and the earnings filter must be reported as
//                  having bound on exactly one run.
//
// Needs the NODE better-sqlite3 ABI: run `npm run rebuild:node` first if you have just packaged.
//
//   node scripts/selftest-spread-monthly-rule.mjs

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MONTHLY = '2026-06-19';     // third Friday
const WEEKLY_28 = '2026-06-26';
const WEEKLY_35 = '2026-07-03';
const WEEKLY_22 = '2026-06-12';

// A put: [strike, bid, ask, delta, ivPct, openInterest, volume]
const put = (strike, bid, ask, delta, oi) => [strike, bid, ask, delta, 30, oi, 10];
// Spot 100 → short lands at 95 (Δ −0.30), wing target 90, inside the 3–10% band.
const chain = (halfSpread, mid95, mid90, oi) => [
  put(95, mid95 - halfSpread, mid95 + halfSpread, -0.30, oi),
  put(90, mid90 - halfSpread, mid90 + halfSpread, -0.15, oi),
];
const TIGHT_THIN = () => chain(0.02, 3.00, 1.50, 40);    // cheap, shallow  → clears the gate
const WIDE_DEEP = () => chain(0.50, 5.00, 2.50, 900);    // dear, deep      → fails the gate

function build(dir, { invert = false } = {}) {
  const dbPath = join(dir, 'fixture.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE spread_chain_capture (
      as_of_date TEXT, slot TEXT, captured_at TEXT, ticker TEXT, expiration TEXT, dte INTEGER,
      reason TEXT, underlying_price REAL, contract_count INTEGER, puts_json TEXT
    );
    CREATE TABLE earnings_calendar (ticker TEXT, report_date TEXT);
  `);
  const ins = db.prepare(
    `INSERT INTO spread_chain_capture
       (as_of_date, slot, captured_at, ticker, expiration, dte, reason, underlying_price, contract_count, puts_json)
     VALUES (?, 'intraday', 'x', ?, ?, ?, 'entry', 100, 2, ?)`,
  );
  // Inverted: the monthly is the expensive one, so the answer must come out the other way.
  const monthlyChain = invert ? WIDE_DEEP : TIGHT_THIN;
  const weeklyChain = invert ? TIGHT_THIN : WIDE_DEEP;

  for (let i = 0; i < 12; i++) {
    ins.run('2026-05-29', `DIS${i}`, MONTHLY, 21, JSON.stringify(monthlyChain()));
    ins.run('2026-05-29', `DIS${i}`, WEEKLY_28, 28, JSON.stringify(weeklyChain()));
    ins.run('2026-05-29', `DIS${i}`, WEEKLY_35, 35, JSON.stringify(weeklyChain()));
  }
  for (let i = 0; i < 3; i++) {
    ins.run('2026-05-21', `AGR${i}`, WEEKLY_22, 22, JSON.stringify(weeklyChain()));
    ins.run('2026-05-21', `AGR${i}`, MONTHLY, 29, JSON.stringify(monthlyChain()));
  }
  for (let i = 0; i < 2; i++) {
    ins.run('2026-05-29', `NOM${i}`, WEEKLY_28, 28, JSON.stringify(weeklyChain()));
    ins.run('2026-05-29', `NOM${i}`, WEEKLY_35, 35, JSON.stringify(weeklyChain()));
  }
  ins.run('2026-05-29', 'EARN', MONTHLY, 21, JSON.stringify(monthlyChain()));
  ins.run('2026-05-29', 'EARN', WEEKLY_28, 28, JSON.stringify(weeklyChain()));
  ins.run('2026-05-29', 'EARN', WEEKLY_35, 35, JSON.stringify(weeklyChain()));
  db.prepare('INSERT INTO earnings_calendar (ticker, report_date) VALUES (?, ?)').run('EARN', '2026-06-25');
  db.close();
  return dbPath;
}

const run = (dbPath) => execFileSync(process.execPath, [
  join(import.meta.dirname, 'fr-spread-monthly-rule-study.mjs'), '--db', dbPath,
], { encoding: 'utf8' });

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const dir = mkdtempSync(join(tmpdir(), 'bps19-'));
const text = run(build(dir));
console.log(text);
console.log('— assertions —');

// Accounting. 18 runs: 12 disagree, 6 agree (3 monthly-is-nearest, 2 no monthly, 1 earnings-pinned).
check('18 runs, 12 disagreements', /18 ticker-runs → \*\*12 where the two rules DISAGREE\*\*/.test(text));
check('6 agreed, of which 2 had no monthly available', /Agreed 6 \(of which 2 had no monthly in the window at all/.test(text));
check('nothing dropped as unbuildable or ineligible', /no eligible expiry 0 · one side would not build 0/.test(text));
// The earnings filter must bind on EARN and nowhere else — applied to both arms, so it cannot skew them.
check('the earnings filter is reported as binding on exactly 1 run', /earnings filter removed at least one expiry on 1 runs/.test(text));

// Arm B must pick the monthly at 21 DTE where A picks the weekly at 28.
check('arm A lands on 28 DTE, weekly', /\| A — nearest 30 \(incumbent\) \| 28 \| 0% \|/.test(text));
check('arm B lands on 21 DTE, monthly', /\| B — prefer the monthly \| 21 \| 100% \|/.test(text));
check('the DTE shift is −7 days', /Median DTE shift: \*\*-7\.0 days\*\*/.test(text));

const d = text.match(/Cost share, B − A\*\* \(12 pairs\): median difference \*\*([-\d.]+)%\*\*/);
check('B is cheaper — negative median on 12 pairs', d != null && Number(d[1]) < 0, d?.[1]);
check('B is cheaper on all 12', /on \*\*12 of 12\*\* \(100%\)/.test(text));

// Payability: A clears nothing here, B clears everything, so the 2x2 must sit on one cell.
check('the gate 2×2 puts all 12 on "A fails, B clears"', /\| \*\*A fails\*\* \| 12 \| 0 \|/.test(text));
check('a net +12 tradable candidates', /a net \*\*\+12\*\* candidates/.test(text));
check('the both-tradable row refuses at n=0 (A clears nothing)',
  /Cost share among candidates BOTH rules can trade, B − A: 0 pairs — too few to say anything/.test(text));

// The wheel's failure mode, measured independently of cost: B is cheaper AND thinner here.
check('B is reported as thinner on all 12 despite being cheaper',
  /lower\*\* open interest than A's on \*\*12 of 12\*\*/.test(text));
check('median OI is reported for both arms', /Median OI: A \*\*900\*\* · B \*\*40\*\*/.test(text));

// Dilution: the lever is only worth what it is times how often it applies.
check('the rules are reported as disagreeing on 67% of eligible runs', /disagree on \*\*67%\*\* of runs/.test(text));

// ── and it must be able to come out the other way ───────────────────────────────────────────────
// A harness that can only report "the monthly is cheaper" would be decoration — the shape of the
// conviction band that could never fire. With the quotes swapped the sign must flip and the gate
// arithmetic must reverse with it.
const dirInv = mkdtempSync(join(tmpdir(), 'bps19-inv-'));
const inv = run(build(dirInv, { invert: true }));
const dInv = inv.match(/Cost share, B − A\*\* \(12 pairs\): median difference \*\*([-\d.]+)%\*\*/);
check('inverted fixture: the median goes POSITIVE (the monthly is dearer)', dInv != null && Number(dInv[1]) > 0, dInv?.[1]);
check('inverted fixture: the gate 2×2 reverses to "A clears, B fails"', /\| \*\*A clears\*\* \| 0 \| 12 \|/.test(inv));
check('inverted fixture: a net −12 candidates', /a net \*\*-12\*\* candidates/.test(inv));
check('inverted fixture: B is no longer the thinner pick', /lower\*\* open interest than A's on \*\*0 of 12\*\*/.test(inv));

rmSync(dir, { recursive: true, force: true });
rmSync(dirInv, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
