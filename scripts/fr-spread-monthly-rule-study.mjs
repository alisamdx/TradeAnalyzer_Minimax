// BPS-19 — should the expiry rule PREFER THE MONTHLY inside 21–35 DTE, instead of getting it by accident?
//
// QUESTION. BPS-4 (v1.1.314) found that the whole 13.6% cost gap between a ~21 and a ~30 DTE spread is
// EXPIRY TYPE, not tenor: with expiry type and tradability both held fixed the difference is −0.9% on
// 15 pairs, noise against a 25% gate. What the nearest-30 rule is really doing is landing on a
// third-Friday monthly about two times in three and inheriting its depth — open interest 460/565
// against a weekly's 37/42. That is a good reason to keep the rule and a bad reason to keep it
// implicit, because on the runs where the nearest-30 expiry is a WEEKLY the rule takes the weekly even
// when a monthly is sitting inside the same 21–35 window.
//
// This measures the rule change directly rather than by proxy. BPS-4's harness compares DTE BUCKETS
// (~21 vs ~30); that is not the rule. The rule is the mode's own picker, and the only honest test is
// to run both pickers over the same captured expiry set and compare what they choose.
//
// THE TWO ARMS (both from `spread-study-lib.mjs`, the same code the mode's logic is mirrored into):
//   A — incumbent: in 21–35 DTE, before earnings, nearest 30, ties to the shorter (pickNearestTarget)
//   B — candidate: the MONTHLY in that same eligible set if there is one, else exactly A's pick
// B falls back to A deliberately: a strict refinement, so the arms can only differ where a real choice
// existed. Without the fallback the comparison would quietly include runs where no monthly was
// available and measure something else entirely.
//
// THE PRECEDENT, WHICH SAYS THIS MAY WELL BE A DEAD END. The wheel's version of this exact rule was
// tested on realized P&L and REJECTED on 2026-08-04 (memory: expiry-selection-followup, v1.1.126), for
// two reasons that both have to be checked here rather than assumed away:
//   1. The friction saving was never PAID. Monthly-vs-weekly friction was 19.6% vs 40.3% of credit —
//      and conditional on clearing the engine's entry gate it was 6.9% vs 6.0%, indistinguishable. The
//      whole gap sat in structures already refused. So this harness reports gate clearance, not just
//      cost: a saving only available on trades you would not take is not a saving.
//   2. Snapping away from ~30 DTE landed on a contract THINNER than the weekly it replaced, because
//      the monthly's open-interest advantage is a 23–33 DTE phenomenon. So this harness reports the
//      open interest of both picks and counts how often B's is lower — the failure mode, measured,
//      not argued.
// That was a one-leg CSP behind a `liquidityScore >= 8` gate; this is a four-fill spread behind a cost
// gate that refuses 47% of candidates. Genuinely a different question — and the same trap is available.
//
// FR-SEY-5: COST IS NOT RETURN. Nothing here can enable a rule change. A cheaper entry that
// systematically selects a different population is not shown to be better until returns are measured,
// and a switch would also interact with the earnings gate (BPS-5), which can move either arm's pick.
//
// RUN with TradeAnalyzer running (it reads GET /api/v1/diagnostics/spread-capture-panel, v1.1.339+;
// the harness never opens the live SQLite file, so any shell works, including the Claude app's):
//   node scripts/fr-spread-monthly-rule-study.mjs --out bps19-monthly-rule.md
//   node scripts/selftest-spread-monthly-rule.mjs   (synthetic fixture, known answers)

import { writeFileSync } from 'node:fs';
import {
  P, NO_EARNINGS, med, f, pctf, loadStudyData, buildFromRow,
  pickNearestTarget, pickPreferMonthly, isMonthly, reportPaired,
} from './lib/spread-study-lib.mjs';

const argv = process.argv.slice(2);
const strOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const OUT = strOf('--out', null);

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

const { rows, runs, earnings } = await loadStudyData(argv, { earnings: true });

const pairs = [];            // runs where the two rules disagree
let agreed = 0, noEligible = 0, noMonthly = 0, unbuilt = 0, earningsBound = 0;

for (const list of runs.values()) {
  const ticker = list[0].ticker;
  // A missing earnings row reads as unconstrained. The mode would reject the ticker outright, but that
  // refusal is identical for both arms, so including the run cannot bias the difference.
  const rd = earnings.get(ticker) ?? NO_EARNINGS;
  const inWindow = list.filter(e => e.dte >= P.dteMin && e.dte <= P.dteMax);
  if (inWindow.length === 0) { noEligible++; continue; }
  if (inWindow.some(e => e.expiration >= rd)) earningsBound++;

  const a = pickNearestTarget(inWindow, rd);
  const b = pickPreferMonthly(inWindow, rd);
  if (!a || !b) { noEligible++; continue; }
  if (a.expiration === b.expiration) { agreed++; if (!isMonthly(a.expiration)) noMonthly++; continue; }

  const sa = buildFromRow(inWindow.find(e => e.expiration === a.expiration));
  const sb = buildFromRow(inWindow.find(e => e.expiration === b.expiration));
  if (sa.reason || sb.reason) { unbuilt++; continue; }
  pairs.push({ ticker, date: list[0].as_of_date, slot: list[0].slot, a: sa, b: sb });
}

const asOf = rows.length ? rows[rows.length - 1].as_of_date : '—';
say('# BPS-19 — prefer the monthly inside 21–35 DTE, or keep nearest-30?');
say();
say(`Captures to ${asOf}. Both arms run the mode's own picker over the same captured expiry set: ` +
    '**A** = nearest 30 DTE (incumbent), **B** = the monthly in the window if there is one, else A.');
say();
say(`${runs.size} ticker-runs → **${pairs.length} where the two rules DISAGREE**. ` +
    `Agreed ${agreed} (of which ${noMonthly} had no monthly in the window at all, so no choice existed) · ` +
    `no eligible expiry ${noEligible} · one side would not build ${unbuilt}. ` +
    `The earnings filter removed at least one expiry on ${earningsBound} runs.`);

if (pairs.length === 0) {
  say();
  say('**The rules never disagree on this sample — there is nothing to decide.** That is a different ' +
      'outcome from "the two rules cost the same", and it is reported as one.');
  if (OUT) writeFileSync(OUT, out.join('\n') + '\n');
  process.exit(0);
}

const arm = (label, k) => {
  const xs = pairs.map(p => p[k]);
  return `| ${label} | ${med(xs.map(x => x.dte))} | ${pctf(xs.filter(x => x.monthly).length / xs.length, 0)} | ` +
    `$${f(med(xs.map(x => x.midCredit)))} | $${f(med(xs.map(x => x.roundTripCost)))} | ` +
    `**${pctf(med(xs.map(x => x.costShare).filter(Number.isFinite)))}** | ` +
    `${xs.filter(x => x.clearsGate).length} of ${xs.length} | ` +
    `${med(xs.map(x => x.shortOi).filter(v => v != null)) ?? '—'} / ${med(xs.map(x => x.longOi).filter(v => v != null)) ?? '—'} |`;
};

say();
say('## The runs where the rules disagree');
say();
say('| arm | median DTE | monthly | median mid credit | median round-trip cost | **median cost share** | clears the 25% gate | median OI short/long |');
say('|---|--:|--:|--:|--:|--:|--:|--:|');
say(arm('A — nearest 30 (incumbent)', 'a'));
say(arm('B — prefer the monthly', 'b'));

say();
reportPaired(say, 'Cost share, B − A', pairs.map(p => p.b.costShare - p.a.costShare),
  'Negative = the monthly is cheaper. These are the same name at the same moment, differing only in ' +
  'which expiry the rule chose.');
say();
say(`Median DTE shift: **${f(med(pairs.map(p => p.b.dte - p.a.dte)), 1)} days** · ` +
    `median credit change: **$${f(med(pairs.map(p => p.b.midCredit - p.a.midCredit)))}**.`);

// Precedent check 1 — is the saving PAYABLE? The wheel's lever died here.
say();
say('## Is the saving payable? (the half that killed the wheel\'s version)');
say();
const aOk = pairs.filter(p => p.a.clearsGate).length, bOk = pairs.filter(p => p.b.clearsGate).length;
say(`| | B clears | B fails |`);
say('|---|--:|--:|');
say(`| **A clears** | ${pairs.filter(p => p.a.clearsGate && p.b.clearsGate).length} | ${pairs.filter(p => p.a.clearsGate && !p.b.clearsGate).length} |`);
say(`| **A fails** | ${pairs.filter(p => !p.a.clearsGate && p.b.clearsGate).length} | ${pairs.filter(p => !p.a.clearsGate && !p.b.clearsGate).length} |`);
say();
say(`On these disagreeing runs the rule change turns **${pairs.filter(p => !p.a.clearsGate && p.b.clearsGate).length}** ` +
    `untradable candidates into tradable ones and **${pairs.filter(p => p.a.clearsGate && !p.b.clearsGate).length}** ` +
    `the other way — a net **${bOk - aOk >= 0 ? '+' : ''}${bOk - aOk}** candidates.`);
say();
const bothOk = pairs.filter(p => p.a.clearsGate && p.b.clearsGate);
reportPaired(say, 'Cost share among candidates BOTH rules can trade, B − A',
  bothOk.map(p => p.b.costShare - p.a.costShare),
  'The wheel\'s friction gap was 19.6% vs 40.3% and became **6.9% vs 6.0%** once the entry gate was ' +
  'applied — the whole saving sat in structures already refused. If this row is ~0 the same thing is ' +
  'happening here, and the rule change buys nothing on the trades you would actually take.');

// Precedent check 2 — does snapping away from ~30 land on something THINNER?
say();
say('## Does snapping to the monthly land on a THINNER contract?');
say();
const oiPairs = pairs.filter(p => p.a.shortOi != null && p.b.shortOi != null);
if (oiPairs.length >= 10) {
  const thinner = oiPairs.filter(p => p.b.shortOi < p.a.shortOi).length;
  say(`B's short leg has **lower** open interest than A's on **${thinner} of ${oiPairs.length}** ` +
      `(${pctf(thinner / oiPairs.length, 0)}). Median OI: A **${med(oiPairs.map(p => p.a.shortOi))}** · ` +
      `B **${med(oiPairs.map(p => p.b.shortOi))}**.`);
  say();
  say('This is the failure the wheel study found: the monthly\'s depth advantage is a 23–33 DTE ' +
      'phenomenon, so snapping away from ~30 can land on a contract thinner than the weekly it ' +
      'replaced. Measured here rather than assumed, in either direction.');
} else {
  say(`Only **${oiPairs.length}** disagreeing runs carry open interest on both picks — too few to say ` +
      'anything about the thinner-contract failure mode.');
}

// Book level: the change across EVERY run, not just the disagreeing ones, since B == A elsewhere.
say();
say('## At book level — every run, not just the disagreements');
say();
say('B equals A wherever no monthly was available, so the book-level effect is exactly the ' +
    'disagreements diluted by how rarely they happen. That dilution is the honest size of the lever.');
say();
const share = pairs.length / (pairs.length + agreed);
say(`The rules disagree on **${pctf(share, 0)}** of runs with an eligible expiry ` +
    `(${pairs.length} of ${pairs.length + agreed}).`);

say();
say('## Limits');
say();
say('Entry slip doubled, the way the mode computes a round trip — not a measured exit. **Cost is not ' +
    'return (FR-SEY-5)**: nothing here can enable a rule change, because a cheaper entry that selects ' +
    'a different population is not shown to be better until the returns are measured. A real switch ' +
    'also interacts with the earnings gate (BPS-5), which can move either arm\'s pick. One regime, a ' +
    'handful of capture days.');

if (OUT) { writeFileSync(OUT, out.join('\n') + '\n'); console.log(`\nwrote ${OUT}`); }
