// How much does v1.1.189's critic context actually change the verdicts?
//
// WHY THIS EXISTS, AND WHAT IT CANNOT DO. The critic verdict is a HARD GATE — the dice rejects
// anything that is not `pass`, and so does the v2 entry path — so changing what the reviewer sees
// changes which trades are taken. That is FR-SEY-5 territory, and FR-SEY-5 asks for a replay
// showing the change is at worst neutral ON OUTCOMES.
//
// That replay cannot be built here, and pretending otherwise would be worse than not running it.
// The reason is arithmetic, not effort: only picks whose expiry has already passed can be scored,
// only a minority of verdicts will flip at all, and the intersection of those two sets across one
// regime is a handful of trades. Attaching a return figure to it would be a number with no power
// behind it — exactly the trap `docs/wheel-parameters.md` records for the own-at-strike study
// (12 episodes in one 4-week window) and the brief-P&L experiment before it.
//
// So this measures the BLAST RADIUS instead, which is both answerable and the thing an operator
// actually needs before shipping: how many verdicts move, in which direction, and on which picks.
// A change that flips 2% of verdicts is a different proposition from one that flips 40%, whatever
// the outcome data says.
//
// COST. One Anthropic call per pick per arm. The wheel corpus is ~250 picks, so a full run is
// ~500 calls. Use `--limit` to sample; the default is deliberately small so an accidental run is
// cheap. Needs ANTHROPIC_API_KEY.
//
// METHOD. Both arms are the SAME code path and the SAME picks, differing only in the
// CRITIC_CONTEXT_V2 flag, so nothing but the context can explain a difference. The rule checks run
// identically in both arms and their flags are passed to both.
//
// Usage:
//   node scripts/critic-context-ab.mjs --limit 20            # ~40 calls
//   node scripts/critic-context-ab.mjs --limit 250 --strategy wheel
//
// see src/main/services/critic-service.ts (CRITIC_CONTEXT_V2), docs/wheel-parameters.md

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const argS = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const argN = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d; };
const LIMIT = argN('--limit', 10);
const STRATEGY = argS('--strategy', 'wheel');
const DB_PATH = argS('--db', join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite'));

if (!process.env['ANTHROPIC_API_KEY']) {
  console.error('\nANTHROPIC_API_KEY is not set. This script makes real API calls (2 per pick).\n');
  process.exit(1);
}

// The service is TypeScript; run this through the same loader the tests use.
const { CriticService } = await import('../src/main/services/critic-service.ts')
  .catch(() => { throw new Error(
    'Run through a TS loader, e.g.  npx vitest run --config /dev/null  or  npx tsx scripts/critic-context-ab.mjs'); });

const db = new Database(DB_PATH);
const svc = new CriticService(db);

const briefs = db.prepare(
  `SELECT generated_at, picks FROM daily_briefs WHERE strategy = ? ORDER BY generated_at DESC`,
).all(STRATEGY);

const picks = [];
for (const b of briefs) {
  let ps; try { ps = JSON.parse(b.picks); } catch { continue; }
  for (const p of ps) picks.push({ date: b.generated_at.slice(0, 10), p });
  if (picks.length >= LIMIT) break;
}
const sample = picks.slice(0, LIMIT);

console.log(`\nCritic context A/B — ${STRATEGY} — ${sample.length} picks, ${sample.length * 2} API calls`);
console.log(`arms differ ONLY in CRITIC_CONTEXT_V2; rule checks are identical in both\n`);

const market = svc.getMarketContext ? svc.getMarketContext() : { vix: null, spyAbove200ma: null };
const config = { strategy: STRATEGY, signals: [], version: 'ab', updatedAt: '2026-01-01' };

async function verdictWith(v2, pick) {
  process.env['CRITIC_CONTEXT_V2'] = v2 ? '1' : '0';
  const flags = svc.runRuleChecks(pick, STRATEGY, config, new Map(), market);
  const out = await svc.synthesizeVerdict(pick, STRATEGY, flags, process.env['ANTHROPIC_API_KEY'], market);
  return out;
}

const rows = [];
for (const { date, p } of sample) {
  try {
    const before = await verdictWith(false, p);
    const after = await verdictWith(true, p);
    rows.push({ date, ticker: p.ticker, before: before.verdict, after: after.verdict,
                beforeDegraded: before.degraded === true, afterDegraded: after.degraded === true,
                afterRationale: after.rationale });
    process.stdout.write('.');
  } catch (err) {
    process.stdout.write('x');
    rows.push({ date, ticker: p.ticker, error: String(err?.message ?? err) });
  }
}
console.log('\n');

const ok = rows.filter(r => !r.error && !r.beforeDegraded && !r.afterDegraded);
const errored = rows.filter(r => r.error);
const degraded = rows.filter(r => !r.error && (r.beforeDegraded || r.afterDegraded));
const same = ok.filter(r => r.before === r.after);
const rank = { pass: 0, caution: 1, flag: 2 };
const stricter = ok.filter(r => rank[r.after] > rank[r.before]);
const looser = ok.filter(r => rank[r.after] < rank[r.before]);

console.log(`comparable: ${ok.length}   (${degraded.length} degraded — LLM did not run, excluded; ${errored.length} errored)`);
if (ok.length === 0) { console.log('\nNothing comparable.\n'); db.close(); process.exit(0); }
const pct = n => `${((100 * n) / ok.length).toFixed(0)}%`;
console.log(`unchanged:  ${same.length} (${pct(same.length)})`);
console.log(`STRICTER:   ${stricter.length} (${pct(stricter.length)})   <- picks the dice would now reject`);
console.log(`looser:     ${looser.length} (${pct(looser.length)})`);

if (stricter.length + looser.length > 0) {
  console.log(`\nverdicts that moved:`);
  for (const r of [...stricter, ...looser]) {
    console.log(`  ${r.date}  ${r.ticker.padEnd(6)} ${r.before} -> ${r.after}`);
    if (r.afterRationale) console.log(`      ${r.afterRationale.slice(0, 160)}`);
  }
}

console.log(`\nReading this`);
console.log(`• This is a BLAST RADIUS, not a validation. It says how much moved, not whether the`);
console.log(`  moves were right — see the header for why the outcome test is not available.`);
console.log(`• The LLM is non-deterministic, so a small number of flips is partly noise. Re-run`);
console.log(`  before treating any single flip as attributable to the context change.`);
console.log(`• "STRICTER" is the number that matters operationally: the critic already passes only`);
console.log(`  ~17% of picks, and it is the dice's largest rejector. A big stricter count shrinks`);
console.log(`  the dice's hit rate, which is a real cost even if every individual call is better.`);
console.log(`• Roll back with CRITIC_CONTEXT_V2=0 — no rebuild needed.\n`);
db.close();
