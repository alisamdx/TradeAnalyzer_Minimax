// Self-test for fr-spread-pool-selection-study.mjs, on a synthetic database with KNOWN answers.
//
// Why this exists: that harness reimplements five scoring signals, an episode collapse, a scale guard
// and a random baseline, and a `scripts/*.mjs` harness cannot import the real service (plain node
// cannot resolve the `@shared/*` aliases), so nothing else checks the reimplementation. A study whose
// arithmetic has never been exercised is a confident wrong answer waiting to happen — and this project
// has had two: the study that priced exits on a mark already carrying the exit cost, and the one whose
// realized-vol copy accepted 10 closes and took log(0).
//
// The fixture is built so each assertion has one unambiguous right answer:
//   • GOOD_n   high annualized return, high IV rank, never assigned  -> premium richness must find them
//   • TREND_n  perfect trend/RSI/vol signals, low premium, ALWAYS assigned -> the 29 "dead" points must
//              pick them, and must therefore lose
//   • 3 dates one day apart -> every ticker repeats, so the episode collapse must fold 9 picks to 3
//   • SPLIT    a strike 5x spot -> the scale guard must exclude it and print it
//
// Needs the NODE better-sqlite3 ABI: run `npm run rebuild:node` first if you have just packaged.
//
//   node scripts/selftest-spread-pool-selection.mjs

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'bps2-'));
const dbPath = join(dir, 'fixture.sqlite');
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE historical_prices (ticker TEXT, date TEXT, close REAL);
  CREATE TABLE analysis_snapshots (run_at TEXT, mode TEXT, payload_json TEXT);
`);

const DATES = ['2026-01-05', '2026-01-06', '2026-01-07'];
const EXPIRY = '2026-02-06';
const insPx = db.prepare('INSERT INTO historical_prices (ticker, date, close) VALUES (?, ?, ?)');

// 300 sessions of history so SMA200 / RSI14 / 20d vol are all computable. Both ramps END near 125, so
// the two groups differ ONLY in the direction of their SMA stack — a rising ramp gives notDowntrend 100
// (bullish), a falling one gives 10 (bearish). That is what makes the trend-only rule separable from
// the premium-only rule; an earlier fixture gave both groups the same series, so the trend rule had
// nothing to choose between and the tie fell to array order. The test caught it, which is the point.
function writeSeries(ticker, { rising, endClose, expiryClose }) {
  const start = Date.parse('2025-01-02T00:00:00Z');
  for (let i = 0; i < 300; i++) {
    const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    const px = rising ? 50 + i * 0.25 : 200 - i * 0.25;   // ends 124.75 rising / 125.25 falling
    insPx.run(ticker, d, px);
  }
  for (const d of DATES) insPx.run(ticker, d, endClose);
  insPx.run(ticker, EXPIRY, expiryClose);
}

const rows = [];
// Rich premium, DOWNTREND (notDowntrend = 10), never assigned: expiry 150 > strike 115.
for (let i = 1; i <= 6; i++) {
  writeSeries(`GOOD${i}`, { rising: false, endClose: 125, expiryClose: 150 });
  rows.push({ ticker: `GOOD${i}`, recommendedStrike: 115, premium: 4.0, expiration: EXPIRY, lastPrice: 125,
    ivRank: 90, annualizedReturn: 50, optionLiquidityScore: 8 });
}
// Thin premium, textbook UPTREND (notDowntrend = 100), always assigned: expiry 70 < strike 115.
// This is the shape T6 measured — notDowntrend's bullish band assigns most and returns least.
for (let i = 1; i <= 6; i++) {
  writeSeries(`TREND${i}`, { rising: true, endClose: 125, expiryClose: 70 });
  rows.push({ ticker: `TREND${i}`, recommendedStrike: 115, premium: 0.2, expiration: EXPIRY, lastPrice: 125,
    ivRank: 5, annualizedReturn: 1, optionLiquidityScore: 8 });
}
// Illiquid — must be gated out entirely.
writeSeries('THIN', { rising: false, endClose: 125, expiryClose: 150 });
rows.push({ ticker: 'THIN', recommendedStrike: 115, premium: 9, expiration: EXPIRY, lastPrice: 125,
  ivRank: 99, annualizedReturn: 99, optionLiquidityScore: 1 });
// Scale guard — strike 5x spot.
writeSeries('SPLIT', { rising: false, endClose: 125, expiryClose: 150 });
rows.push({ ticker: 'SPLIT', recommendedStrike: 625, premium: 3, expiration: EXPIRY, lastPrice: 125,
  ivRank: 99, annualizedReturn: 99, optionLiquidityScore: 8 });

const insSnap = db.prepare('INSERT INTO analysis_snapshots (run_at, mode, payload_json) VALUES (?, ?, ?)');
for (const d of DATES) insSnap.run(`${d}T21:00:00.000Z`, 'wheel', JSON.stringify(rows));
db.close();

const outText = execFileSync(process.execPath, [
  join(import.meta.dirname, 'fr-spread-pool-selection-study.mjs'),
  '--db', dbPath, '--top', '3', '--min-liq', '5', '--episode-days', '14', '--draws', '40',
], { encoding: 'utf8' });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const lineOf = label => outText.split('\n').find(l => l.includes(label)) ?? '';
const numAfter = (line, key) => {
  const m = new RegExp(`${key}\\s+(-?[\\d.]+)`).exec(line);
  return m ? Number(m[1]) : null;
};

console.log('\nfr-spread-pool-selection-study self-test\n');

check('the scale guard excludes the 5x strike and prints it',
  /SCALE-GUARD EXCLUSIONS/.test(outText) && /SPLIT strike 625/.test(outText));

check('the illiquid row is gated out', / illiquid 3 /.test(outText),
  outText.split('\n').find(l => l.includes('dropped:')));

// 12 liquid tickers x 3 dates = 36 usable.
check('usable row count is 36', /usable 36 /.test(outText), lineOf('usable'));

// Episode collapse: 3 dates 1 day apart, so each ticker must fold to ONE bet.
const epsBlock = outText.slice(outText.indexOf('EPISODE-COLLAPSED'));
const rawBlock = outText.slice(outText.indexOf('RAW'), outText.indexOf('EPISODE-COLLAPSED'));
const rawN = numAfter(rawBlock.split('\n').find(l => l.includes('premium richness')) ?? '', 'n=');
const epsN = numAfter(epsBlock.split('\n').find(l => l.includes('premium richness')) ?? '', 'n=');
check('raw picks 3 per date x 3 dates = 9', rawN === 9, `got ${rawN}`);
check('episode collapse folds them to 3 distinct tickers', epsN === 3, `got ${epsN}`);

// Premium richness must find the GOOD names: never assigned, positive return.
const prem = epsBlock.split('\n').find(l => l.includes('premium richness')) ?? '';
check('premium richness is never assigned here', numAfter(prem, 'assigned') === 0, prem.trim());
check('premium richness returns positive', (numAfter(prem, 'mean') ?? -1) > 0, prem.trim());

// The 29 "dead" points rank on trend/RSI/vol alone, which the fixture makes always-assigned.
const dead = epsBlock.split('\n').find(l => l.includes('29 dead points')) ?? '';
check('the 29-point rule picks the always-assigned names', numAfter(dead, 'assigned') === 100, dead.trim());
check('the 29-point rule loses money', (numAfter(dead, 'mean') ?? 1) < 0, dead.trim());

// composite-70 is 41 points of premium richness against 29 of trend: richness must dominate.
const comp = epsBlock.split('\n').find(l => l.includes('composite-70 (the live cut)')) ?? '';
check('composite-70 is dominated by its premium-richness half', numAfter(comp, 'assigned') === 0, comp.trim());

// The inverted rule must be the mirror: it should pick the losers.
const inv = epsBlock.split('\n').find(l => l.includes('INVERTED composite-70')) ?? '';
check('inverting the composite picks the assigned names', numAfter(inv, 'assigned') === 100, inv.trim());

check('a random baseline band is reported',
  /random 5th–95th pct/.test(outText) && /random 3\/date × 40 draws/.test(outText));
check('the reconstructed-weight caveat is stated', /70 of 91 ranking points/.test(outText));
check('eligible-date count is reported', /dates with at least 3 candidates: 3 of 3/.test(outText));

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
