// BPS-4 — does a 21-DTE bull put spread cost more to trade than a 30-DTE one, on REAL quotes?
//
// QUESTION. The mode targets 30 DTE in a 21–35 window (08 §3.2). The #43 study's per-trade grid says
// 21 DTE beat 30 and 35 at every delta — but that grid runs on the DRAFT exits (`pt 0.5 sl 2 ts 15`),
// and the 15-day time stop is not DTE-neutral: it truncates 71% of the way through a 21-DTE trade's
// life and 43% of the way through a 35-DTE one. In the study's own table the time-stop exit share is
// 18% / 36% / 42% at 21 / 30 / 35 DTE (Δ0.30), so the longer arms are force-closed mid-flight at twice
// the rate. The exits that SHIPPED (BPS-13: 50% target, no stop, no time stop) were never swept across
// DTE at all — §4b and §4c switch to them and hold DTE fixed at 30. So the per-trade case for 21 DTE
// describes a rule the mode does not use, and the confound is larger than the effect: at Δ0.25 the
// 21-over-30 gap is 0.85 pts of mean return, while removing the time stop adds 2.08 pts to 30 DTE.
//
// This harness does NOT re-litigate returns — it cannot; nothing here is settled. It answers the half
// that is measurable today and that the study is WORST at: the cost of getting in and out. The study
// prices the long wing with Black-Scholes plus a flat "vol points per 10% OTM" skew, and its own
// sensitivity table moves the 30-DTE answer from 0.277 to 0.081 %/day across skew 0→6. Real skew
// steepens as expiry approaches, so that modelling error is itself DTE-dependent — exactly the wrong
// instrument for a DTE comparison. `spread_chain_capture` holds REAL bid/ask for every expiry in a
// 14–45 day window for every entry ticker, every run, already paid for. This reads those.
//
// It matters because of BPS-3 (v1.1.310): round-trip cost share is the quantity that actually
// discriminates between these trades, and BPS-9's 25% gate is the most active gate in the mode —
// 47 of 139 rejections. A shorter expiry collects a smaller credit against the same four leg-fills,
// so cost share is mechanically higher; the question is by how much, and how many names stop being
// tradable at all.
//
// METHOD. For each (ticker, as_of_date, slot) that captured BOTH buckets, build the mode's spread from
// the SAME stored quotes at each: short put |Δ| 0.20–0.40 nearest 0.30, long put nearest short − 5% of
// spot within 3–10%, fills at mid ∓ half the half-spread per leg (options-fill.ts). Report credit,
// round-trip cost, cost share, and whether each clears the 25% gate.
//
// DE-BIASING — three, and the first two have each cost this project real time:
//   • PAIRED ONLY. A (ticker, date, slot) counts only if a spread builds in BOTH buckets. A naive
//     pooled weekly-vs-monthly friction comparison INVERTS in this codebase, because the names landing
//     in each bucket differ (memory: expiry-selection-followup, 2026-08-04). Hold the name, the moment
//     and the quote fixed; vary only the expiry.
//   • THE COST GATE IS NOT APPLIED WHEN BUILDING. `buildBullPutSpread` refuses above 25%, so using it
//     as-is would drop the expensive half of the very distribution being measured — the censoring
//     BPS-3 had to parse back out of rejection sentences. Here the gate is an OUTCOME, never a filter.
//   • MONTHLY vs WEEKLY IS REPORTED, because it could be the whole answer. A ~30 DTE bucket often
//     lands on a third-Friday monthly while ~21 lands on a weekly, and the monthly's open interest
//     advantage in this codebase is a 23–33 DTE phenomenon. If the buckets differ in monthly share,
//     a "DTE" finding may be an expiry-type finding wearing its clothes.
//
// LIMITS. Entry cost only — the exit is modelled at the same convention, so the round trip is 2× the
// entry slip exactly as the mode computes it; it is not a measured exit. Says nothing about returns,
// assignment, or which DTE wins. Captures are ~7 days of one regime. `reason = 'entry'` rows only:
// those come from the uniform 14–45 day sweep, while a 'track' row exists only because that expiry was
// already picked, which is a selection effect on the long bucket.
//
// RUN with TradeAnalyzer running (it reads GET /api/v1/diagnostics/spread-capture-panel, v1.1.339+;
// the harness never opens the live SQLite file, so any shell works, including the Claude app's):
//   node scripts/fr-spread-dte-cost-study.mjs --out bps4-dte-cost.md
//       [--short-dte 21] [--long-dte 30] [--tol 4]
//   node scripts/selftest-spread-dte-cost.mjs   (synthetic fixture, known answers)

import { writeFileSync } from 'node:fs';
import {
  P, med, f, pctf, loadStudyData, buildFromRow, reportPaired,
} from './lib/spread-study-lib.mjs';

const argv = process.argv.slice(2);
const numOf = (n, d) => { const k = argv.indexOf(n); return k >= 0 ? Number(argv[k + 1]) : d; };
const strOf = (n, d) => { const k = argv.indexOf(n); return k >= 0 ? argv[k + 1] : d; };

const SHORT_DTE = numOf('--short-dte', 21);
const LONG_DTE = numOf('--long-dte', 30);
const TOL = numOf('--tol', 4);
const OUT = strOf('--out', null);

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

// ── load ────────────────────────────────────────────────────────────────────────────────────────
const { rows, runs } = await loadStudyData(argv);

const nearest = (list, want) => {
  const inTol = list.filter(r => Math.abs(r.dte - want) <= TOL);
  return inTol.sort((a, b) => Math.abs(a.dte - want) - Math.abs(b.dte - want) || a.dte - b.dte)[0] ?? null;
};

const pairs = [];
const unbuilt = { short: new Map(), long: new Map() };
let noShortExpiry = 0, noLongExpiry = 0, sameExpiry = 0;

for (const list of runs.values()) {
  const a = nearest(list, SHORT_DTE), b = nearest(list, LONG_DTE);
  if (!a) { noShortExpiry++; continue; }
  if (!b) { noLongExpiry++; continue; }
  // The two buckets must be DIFFERENT contracts, or the "comparison" is a row against itself — which
  // would silently report a perfect tie and look like a clean null.
  if (a.expiration === b.expiration) { sameExpiry++; continue; }

  const build = (r, side) => {
    const built = buildFromRow(r);
    if (built.reason) { unbuilt[side].set(built.reason, (unbuilt[side].get(built.reason) ?? 0) + 1); return null; }
    return built;
  };
  const sa = build(a, 'short'), sb = build(b, 'long');
  if (!sa || !sb) continue;          // paired only — one side missing is not a pair
  pairs.push({ ticker: list[0].ticker, date: list[0].as_of_date, slot: list[0].slot, short: sa, long: sb });
}

// ── report ──────────────────────────────────────────────────────────────────────────────────────
const asOf = rows.length ? rows[rows.length - 1].as_of_date : '—';
say(`# BPS-4 — round-trip cost at ${SHORT_DTE} DTE vs ${LONG_DTE} DTE, on captured quotes`);
say();
say(`Captures to ${asOf}. \`reason = 'entry'\` rows only. Buckets are the nearest stored expiry to ` +
    `**${SHORT_DTE}** and **${LONG_DTE}** DTE within ±${TOL} days, and must be different contracts.`);
say();
say(`${runs.size} ticker-runs captured → **${pairs.length} paired**. ` +
    `Dropped: no ${SHORT_DTE}-DTE expiry ${noShortExpiry} · no ${LONG_DTE}-DTE expiry ${noLongExpiry} · ` +
    `both buckets hit the same contract ${sameExpiry}.`);

if (pairs.length === 0) {
  say();
  say('**No pairs — nothing to say.** This is a different outcome from "the buckets cost the same", and ' +
      'it is reported as one. Check that `spread_chain_capture` has entry rows spanning both buckets.');
  if (OUT) writeFileSync(OUT, out.join('\n') + '\n');
  process.exit(0);
}

const side = k => pairs.map(p => p[k]);
const bucket = (label, k) => {
  const xs = side(k);
  const costs = xs.map(x => x.costShare).filter(Number.isFinite);
  return `| ${label} | ${xs.length} | ${med(xs.map(x => x.dte))} | ` +
    `${pctf(xs.filter(x => x.monthly).length / xs.length, 0)} | ` +
    `$${f(med(xs.map(x => x.midCredit)))} | ${pctf(med(xs.map(x => x.creditOverWidth).filter(v => v != null)))} | ` +
    `$${f(med(xs.map(x => x.roundTripCost)))} | **${pctf(med(costs))}** | ` +
    `${xs.filter(x => !x.clearsGate).length} | ${f(med(xs.map(x => x.shortDelta)))} | ` +
    `${med(xs.map(x => x.shortOi).filter(v => v != null)) ?? '—'} / ${med(xs.map(x => x.longOi).filter(v => v != null)) ?? '—'} |`;
};

say();
say('## Per bucket');
say();
say('| bucket | n | median DTE | monthly | median mid credit | credit ÷ width | median round-trip cost | **median cost share** | fails the 25% gate | median short Δ | median OI short/long |');
say('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
say(bucket(`${SHORT_DTE} DTE`, 'short'));
say(bucket(`${LONG_DTE} DTE`, 'long'));

// Paired differences — the median of per-pair differences, never the difference of medians, and a
// sign count beside it so the answer does not rest on a distribution nobody has looked at.
const diffs = pairs.map(p => p.short.costShare - p.long.costShare).filter(Number.isFinite);
const shortCheaper = diffs.filter(d => d < 0).length;
const g = (p, k) => p[k].clearsGate;
const bothClear = pairs.filter(p => g(p, 'short') && g(p, 'long')).length;
const onlyLong = pairs.filter(p => !g(p, 'short') && g(p, 'long')).length;
const onlyShort = pairs.filter(p => g(p, 'short') && !g(p, 'long')).length;
const neither = pairs.filter(p => !g(p, 'short') && !g(p, 'long')).length;

say();
say('## Paired — the same name, the same moment, the same quotes');
say();
say(`Median per-pair cost share difference (${SHORT_DTE} − ${LONG_DTE}): **${pctf(med(diffs))}** ` +
    `(positive = the shorter expiry costs more).`);
say(`The shorter expiry is cheaper on **${shortCheaper} of ${diffs.length}** pairs ` +
    `(${pctf(shortCheaper / diffs.length, 0)}). A coin flip is 50%.`);
say(`Median per-pair credit difference: **$${f(med(pairs.map(p => p.short.midCredit - p.long.midCredit)))}**.`);
say();
say(`### Who is tradable under BPS-9's 25% gate`);
say();
say('| | clears at ' + LONG_DTE + ' | fails at ' + LONG_DTE + ' |');
say('|---|--:|--:|');
say(`| **clears at ${SHORT_DTE}** | ${bothClear} | ${onlyShort} |`);
say(`| **fails at ${SHORT_DTE}** | ${onlyLong} | ${neither} |`);
say();
say(`**${onlyLong}** names are tradable only at ${LONG_DTE} DTE; **${onlyShort}** only at ${SHORT_DTE}. ` +
    'The off-diagonal is the finding — the diagonal says nothing, because a name that clears both or ' +
    'neither is not choosing between them.');

// The monthly/weekly confound, stated whether or not it bites.
const shortMonthly = side('short').filter(x => x.monthly).length / pairs.length;
const longMonthly = side('long').filter(x => x.monthly).length / pairs.length;
say();
say('## Is this DTE, or is it monthly vs weekly?');
say();
say(`Monthly share: ${SHORT_DTE} DTE **${pctf(shortMonthly, 0)}** · ${LONG_DTE} DTE **${pctf(longMonthly, 0)}**.`);
say();

// The composition, spelled out rather than deduced. Both buckets landing on a monthly is IMPOSSIBLE
// whenever the buckets are closer together than two third Fridays (28–35 days) — with ±4 tolerance the
// widest gap here is (LONG+TOL) − (SHORT−TOL) days. Print the cell counts anyway: a calendar argument
// that decides how a result is read belongs in the output, not in the reader's head.
const cell = (sm, lm) => pairs.filter(p => p.short.monthly === sm && p.long.monthly === lm);
const maxGap = (LONG_DTE + TOL) - (SHORT_DTE - TOL);
say(`| | ${LONG_DTE} DTE weekly | ${LONG_DTE} DTE monthly |`);
say('|---|--:|--:|');
say(`| **${SHORT_DTE} DTE weekly** | ${cell(false, false).length} | ${cell(false, true).length} |`);
say(`| **${SHORT_DTE} DTE monthly** | ${cell(true, false).length} | ${cell(true, true).length} |`);
say();
if (maxGap < 28) {
  say(`The both-monthly cell is **structurally empty**: consecutive third Fridays are 28–35 days apart ` +
      `and these buckets can be at most ${maxGap} days apart. So the same-type comparison below is ` +
      `weekly-vs-weekly, and there is no monthly-vs-monthly evidence here at any n.`);
  say();
}

// Same-type: the median AND the sign count. A median with no sign count is a point estimate nobody has
// looked at the distribution of.
const sameType = pairs.filter(p => p.short.monthly === p.long.monthly);
// A thin adapter: this harness's subgroups are pair SUBSETS, while the shared reporter takes the
// differences. The floor, the sign count and the refusal wording live in one place (the lib) so a
// second harness cannot drift from them.
const report = (label, subset, note) =>
  reportPaired(say, label, subset.map(p => p.short.costShare - p.long.costShare), note,
    { phrase: 'the shorter expiry cheaper' });
report('Same expiry type', sameType,
  'If this is much smaller than the headline — or points the other way — the headline is about expiry ' +
  'type, not about DTE.');

// The DISCORDANT cell is the falsification test, and it is free. If the headline is expiry type rather
// than tenor, then where the SHORT bucket holds the monthly the sign must REVERSE — the shorter expiry
// becoming markedly cheaper. If it does not reverse there, type is not the explanation and something
// else is doing the work. A hypothesis that only ever gets checked where it is comfortable is not a
// hypothesis (v1.1.176: a mechanism read off a structure is a hypothesis, and this data can test it).
say();
say(`### The discordant cells — where the expiry types are swapped`);
say();
report(`${SHORT_DTE} DTE monthly vs ${LONG_DTE} DTE weekly`, cell(true, false),
  'The falsification test: if expiry type is the explanation, the sign must REVERSE here.');
report(`${SHORT_DTE} DTE weekly vs ${LONG_DTE} DTE monthly`, cell(false, true),
  'The majority case, and the one the headline is made of.');

// What the swapped cell is worth operationally: in those runs the nearest-30 rule takes the weekly
// while a monthly sits inside the DTE window. That is the whole of the prefer-the-monthly lever.
const swapped = cell(true, false);
if (swapped.length >= 10) {
  const shortOk = swapped.filter(p => p.short.clearsGate).length;
  const longOk = swapped.filter(p => p.long.clearsGate).length;
  say();
  say(`In those ${swapped.length} runs the nearest-${LONG_DTE} rule takes a **weekly** while a monthly ` +
      `sits inside the DTE window. Clearing the ${pctf(P.maxCostShare, 0)} gate there: the monthly at ` +
      `${SHORT_DTE} DTE **${shortOk}**, the weekly at ${LONG_DTE} DTE **${longOk}**. ` +
      'That difference is what a prefer-the-monthly rule would be worth — on cost alone, which is not ' +
      'the same as being worth it (FR-SEY-5 needs returns).');
}

// The half that killed the wheel's expiry lever (2026-08-04): the friction gap was real and VANISHED
// conditional on clearing the entry gate — the whole gap sat in structures already rejected. A saving
// that is only available on trades you would not take is not a saving.
say();
say(`### Conditional on being tradable — does the gap survive BPS-9's ${pctf(P.maxCostShare, 0)} gate?`);
say();
const bothOk = pairs.filter(p => p.short.clearsGate && p.long.clearsGate);
report('Both buckets clear the gate', bothOk,
  'This is the population the mode would actually trade either way. The wheel\'s expiry lever was ' +
  'rejected here: a real friction gap that sat entirely in structures the gate already refused.');
if (bothOk.length >= 10) {
  say();
  say(`Median cost share among those: ${SHORT_DTE} DTE **${pctf(med(bothOk.map(p => p.short.costShare)))}** · ` +
      `${LONG_DTE} DTE **${pctf(med(bothOk.map(p => p.long.costShare)))}**.`);
}

// Conditioning on gate-clearance SELECTS FOR the liquid leg, which is the monthly — so the row above
// is still an expiry-type comparison, measured after the gate instead of before it. Only the
// intersection controls both at once, and if the two controls point opposite ways this is the cell
// that decides which one was carrying the answer.
say();
say('#### …and same expiry type at the same time — the only cell with both controls on');
say();
report('Same type AND both clear', bothOk.filter(p => p.short.monthly === p.long.monthly),
  'Controls expiry type and tradability together. Anything above controls one of them.');

// The DECISION is not a paired difference. Changing the target changes WHICH names are tradable, so
// the two books are different populations — and that is the thing being chosen between, not a
// confound to remove.
const book = k => pairs.filter(p => p[k].clearsGate).map(p => p[k]);
const shortBook = book('short'), longBook = book('long');
say();
say('## As traded — the book each target would actually produce');
say();
say('Not paired, deliberately: a DTE target changes which names clear the gate, so these are different ' +
    'populations. That difference IS the decision. (It is not evidence about tenor — a target that ' +
    'lands on monthlies gets the monthlies\' liquidity, which is a fact about the rule, not about DTE.)');
say();
say('| target | candidates clearing the 25% gate | median cost share | median mid credit | monthly |');
say('|---|--:|--:|--:|--:|');
for (const [label, b] of [[`${SHORT_DTE} DTE`, shortBook], [`${LONG_DTE} DTE`, longBook]]) {
  say(`| ${label} | ${b.length} of ${pairs.length} | ${pctf(med(b.map(x => x.costShare)))} | ` +
      `$${f(med(b.map(x => x.midCredit)))} | ${pctf(b.length ? b.filter(x => x.monthly).length / b.length : null, 0)} |`);
}
if (shortBook.length && longBook.length) {
  const lost = 1 - shortBook.length / longBook.length;
  say();
  say(`Moving the target from ${LONG_DTE} to ${SHORT_DTE} DTE changes the tradable pool by ` +
      `**${lost > 0 ? '−' : '+'}${Math.abs(lost * 100).toFixed(0)}%**. Read that against BPS-10: the ` +
      'eligible set is what the top-5 cut chooses between, and it is already thin.');
}

const reasons = m => ([...m].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(' · ') || 'none');
say();
say('## Could not build');
say();
say(`At ${SHORT_DTE} DTE: ${reasons(unbuilt.short)}`);
say(`At ${LONG_DTE} DTE: ${reasons(unbuilt.long)}`);
say();
say('A bucket that fails to build more often is a finding in its own right — the pairs above exclude ' +
    'those runs by construction, so this list is where that evidence lives.');

say();
say('## Limits');
say();
say('Entry slip doubled, the way the mode computes a round trip — not a measured exit. Says nothing ' +
    'about returns or assignment, which need settled positions. One regime, a handful of capture days. ' +
    'FR-SEY-5: this shapes a criterion; it cannot by itself move a live rule.');

if (OUT) { writeFileSync(OUT, out.join('\n') + '\n'); console.log(`\nwrote ${OUT}`); }
