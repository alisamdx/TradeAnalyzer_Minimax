// Save and compare Brief Replay arms — for A/B-ing a scoring flag that only the app can exercise.
//
// Brief Replay runs inside Electron (`replay:run-range` IPC) and writes to `replay_briefs` /
// `replay_outcomes`, overwriting the previous run. A flag A/B therefore needs the first arm
// captured before the second is run. This does that, without touching the live tables.
//
//   node scripts/replay-arm.mjs save <label>          -> writes <label>.json beside the DB
//   node scripts/replay-arm.mjs compare <a> <b>       -> ETF-aware wheel comparison of two arms
//   node scripts/replay-arm.mjs list
//
// Built for T4 (ETF wheel-composite deflation) but arm-agnostic.
// see docs/wheel-parameters.md, scripts/fr-etf-wheel-deflation-study.mjs

import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';

const DB_PATH = join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite');
const ARM_DIR = join(dirname(DB_PATH), 'replay-arms');
const db = new Database(DB_PATH);

const [cmd, ...rest] = process.argv.slice(2);
const armFile = label => join(ARM_DIR, `${label}.json`);
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const f = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));

function save(label) {
  if (!label) { console.error('usage: replay-arm.mjs save <label>'); process.exit(1); }
  mkdirSync(ARM_DIR, { recursive: true });
  const briefs = db.prepare('SELECT * FROM replay_briefs').all();
  const outcomes = db.prepare('SELECT * FROM replay_outcomes').all();
  const payload = {
    label, savedAt: new Date().toISOString(),
    etfAware: process.env['SCORING_ETF_AWARE_WHEEL'] === '1' ? 'set-in-this-shell' : 'unknown',
    briefs, outcomes,
  };
  writeFileSync(armFile(label), JSON.stringify(payload));
  const dates = new Set(briefs.map(b => b.as_of_date));
  console.log(`saved "${label}": ${briefs.length} brief-rows, ${outcomes.length} outcomes, `
    + `${dates.size} dates (${[...dates].sort()[0]} .. ${[...dates].sort().at(-1)})`);
  console.log(`  -> ${armFile(label)}`);
}

function list() {
  if (!existsSync(ARM_DIR)) return console.log('no arms saved yet');
  for (const fn of readdirSync(ARM_DIR).filter(x => x.endsWith('.json'))) {
    const a = JSON.parse(readFileSync(join(ARM_DIR, fn), 'utf8'));
    const d = [...new Set(a.briefs.map(b => b.as_of_date))].sort();
    console.log(`${a.label.padEnd(16)} ${a.savedAt.slice(0, 19)}  ${a.briefs.length} briefs  `
      + `${d.length} dates  ${d[0]} .. ${d.at(-1)}`);
  }
}

/** Wheel picks for one arm, joined brief -> outcome, flagged ETF. */
function wheelPicks(arm, etfSet) {
  const byId = new Map(arm.briefs.map(b => [b.id, b]));
  return arm.outcomes
    .map(o => ({ ...o, brief: byId.get(o.replay_brief_id) }))
    .filter(o => o.brief?.strategy === 'wheel')
    .map(o => ({ ...o, asOf: o.brief.as_of_date, isEtf: etfSet.has(o.ticker) }));
}

function summarise(label, picks) {
  const etf = picks.filter(p => p.isEtf), stock = picks.filter(p => !p.isEtf);
  console.log(`\n  ${label}: ${picks.length} wheel picks · ${new Set(picks.map(p => p.ticker)).size} tickers`);
  console.log(`    ETF picks: ${etf.length}  (${f((etf.length / Math.max(1, picks.length)) * 100, 1)}%)`);
  if (etf.length) {
    const byT = {};
    for (const p of etf) byT[p.ticker] = (byT[p.ticker] ?? 0) + 1;
    console.log(`      ${Object.entries(byT).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}:${n}`).join(' ')}`);
  }
  const sas = a => { const v = a.filter(p => p.stayed_above_strike != null); return v.length ? mean(v.map(p => p.stayed_above_strike * 100)) : null; };
  const r21 = a => { const v = a.filter(p => p.ret_21d != null); return v.length ? mean(v.map(p => p.ret_21d)) : null; };
  const n21 = a => a.filter(p => p.ret_21d != null).length;
  console.log(`    stayed above strike : all ${f(sas(picks), 1)}%   ETF ${f(sas(etf), 1)}%   stock ${f(sas(stock), 1)}%`);
  console.log(`    mean 21d return     : all ${f(r21(picks))}% (n=${n21(picks)})   `
    + `ETF ${f(r21(etf))}% (n=${n21(etf)})   stock ${f(r21(stock))}% (n=${n21(stock)})`);
  console.log(`    mean composite      : all ${f(mean(picks.map(p => p.composite_score)), 1)}   `
    + `ETF ${f(mean(etf.map(p => p.composite_score)), 1)}   stock ${f(mean(stock.map(p => p.composite_score)), 1)}`);
}

function compare(aLabel, bLabel) {
  if (!aLabel || !bLabel) { console.error('usage: replay-arm.mjs compare <a> <b>'); process.exit(1); }
  const etfSet = new Set(db.prepare(`SELECT ticker FROM constituents WHERE index_name='etf'`).all().map(r => r.ticker));
  const A = JSON.parse(readFileSync(armFile(aLabel), 'utf8'));
  const B = JSON.parse(readFileSync(armFile(bLabel), 'utf8'));
  const pa = wheelPicks(A, etfSet), pb = wheelPicks(B, etfSet);

  console.log(`\nT4 arm comparison — wheel picks`);
  const da = new Set(pa.map(p => p.asOf)), dbb = new Set(pb.map(p => p.asOf));
  const shared = [...da].filter(d => dbb.has(d));
  console.log(`  ${aLabel}: ${da.size} dates   ${bLabel}: ${dbb.size} dates   shared: ${shared.length}`);
  if (shared.length < Math.max(da.size, dbb.size)) {
    console.log(`  ⚠ date ranges differ — only the ${shared.length} shared dates are comparable.`);
  }
  const inShared = arr => arr.filter(p => shared.includes(p.asOf));
  summarise(aLabel, inShared(pa));
  summarise(bLabel, inShared(pb));

  // What actually changed: which picks were displaced, and by what.
  const key = p => `${p.asOf}|${p.ticker}`;
  const setA = new Set(inShared(pa).map(key)), setB = new Set(inShared(pb).map(key));
  const added = inShared(pb).filter(p => !setA.has(key(p)));
  const dropped = inShared(pa).filter(p => !setB.has(key(p)));
  console.log(`\n  churn on shared dates: +${added.length} added, −${dropped.length} dropped`);
  console.log(`    added that are ETFs   : ${added.filter(p => p.isEtf).length}`);
  const sas = a => { const v = a.filter(p => p.stayed_above_strike != null); return v.length ? mean(v.map(p => p.stayed_above_strike * 100)) : null; };
  console.log(`    added   — stayed above strike ${f(sas(added), 1)}% (n=${added.filter(p => p.stayed_above_strike != null).length})`);
  console.log(`    dropped — stayed above strike ${f(sas(dropped), 1)}% (n=${dropped.filter(p => p.stayed_above_strike != null).length})`);
  console.log(`\n  The decision question: did the picks the fix ADDED do at least as well as the`);
  console.log(`  ones it DISPLACED? That is the FR-SEY-5 neutrality test for this flag.`);
}

if (cmd === 'save') save(rest[0]);
else if (cmd === 'compare') compare(rest[0], rest[1]);
else if (cmd === 'list') list();
else console.log('usage: replay-arm.mjs save <label> | compare <a> <b> | list');
db.close();
