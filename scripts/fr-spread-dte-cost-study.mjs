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
// RUN from a normal terminal (NOT from inside a packaged app's shell — CLAUDE.md: this shell is
// MSIX-containerised and reads a stale shadow copy of the database):
//   npm run rebuild:node        (if you have just packaged — the Electron ABI will not load here)
//   node scripts/fr-spread-dte-cost-study.mjs --out bps4-dte-cost.md
//       [--short-dte 21] [--long-dte 30] [--tol 4]
//   node scripts/selftest-spread-dte-cost.mjs   (synthetic fixture, known answers)

import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const numOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d; };
const strOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const SHORT_DTE = numOf('--short-dte', 21);
const LONG_DTE = numOf('--long-dte', 30);
const TOL = numOf('--tol', 4);
const OUT = strOf('--out', null);

// The mode's profile (src/shared/spread-mode.ts). Duplicated because a scripts/*.mjs harness cannot
// import the real service — plain node cannot resolve the `@shared/*` aliases. selftest-spread-dte-cost
// exists because of that duplication.
const P = {
  deltaMin: 0.20, deltaMax: 0.40, deltaTarget: 0.30,
  wingMinPct: 0.03, wingMaxPct: 0.10, wingTargetPct: 0.05,
  maxCostShare: 0.25, minNetCredit: 0.05,
  slipFraction: 0.5,
};

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const f = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));
const pctf = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);

// --db is for the self-test's synthetic fixture only. It is NOT for pointing at a copy of the live
// database: a copy read while the app is running is a stale shadow (CLAUDE.md).
const db = new Database(strOf('--db', join(homedir(), 'AppData', 'Roaming', 'trade-analyzer', 'trade-analyzer.sqlite')));

// ── the mode's fill convention (src/main/services/options-fill.ts) ──────────────────────────────
function fillPrice(bid, ask, action) {
  const mid = (bid + ask) / 2;
  if (!(ask > bid) || mid <= 0) return Math.max(0, mid);   // locked/crossed/degenerate → mid
  const adj = P.slipFraction * (ask - bid) / 2;
  return action === 'sell' ? Math.max(0, mid - adj) : mid + adj;
}

// ── the mode's construction, WITHOUT its two refusals ───────────────────────────────────────────
// buildBullPutSpread rejects on net credit and on cost share. Both are reported here instead, because
// a study of what things cost must be able to see the expensive ones.
const twoSided = p => p[1] > 0 && p[2] >= p[1];
function buildSpread(puts, spot) {
  const shorts = puts
    .filter(p => twoSided(p) && p[3] != null && Math.abs(p[3]) >= P.deltaMin && Math.abs(p[3]) <= P.deltaMax)
    .sort((a, b) => Math.abs(Math.abs(a[3]) - P.deltaTarget) - Math.abs(Math.abs(b[3]) - P.deltaTarget) || a[0] - b[0]);
  const s = shorts[0];
  if (!s) return { reason: 'no two-sided put in the delta band' };

  const eps = 1e-9;
  const target = s[0] - P.wingTargetPct * spot;
  const longs = puts
    .filter(p => {
      if (!twoSided(p) || p[0] >= s[0]) return false;
      const w = (s[0] - p[0]) / spot;
      return w >= P.wingMinPct - eps && w <= P.wingMaxPct + eps;
    })
    .sort((a, b) => Math.abs(a[0] - target) - Math.abs(b[0] - target) || b[0] - a[0]);
  const l = longs[0];
  if (!l) return { reason: 'no two-sided long put in the wing band' };

  const shortMid = (s[1] + s[2]) / 2, longMid = (l[1] + l[2]) / 2;
  const shortFill = fillPrice(s[1], s[2], 'sell'), longFill = fillPrice(l[1], l[2], 'buy');
  const midCredit = shortMid - longMid;
  const netCredit = shortFill - longFill;
  const entrySlip = (shortMid - shortFill) + (longFill - longMid);
  const width = s[0] - l[0];
  return {
    shortStrike: s[0], longStrike: l[0], width,
    shortDelta: Math.abs(s[3]), shortOi: s[5], longOi: l[5],
    midCredit, netCredit,
    roundTripCost: 2 * entrySlip,
    costShare: midCredit > 0 ? (2 * entrySlip) / midCredit : Infinity,
    creditOverWidth: width > 0 ? midCredit / width : null,
    clearsGate: midCredit > 0 && netCredit > P.minNetCredit && (2 * entrySlip) / midCredit <= P.maxCostShare,
  };
}

// ── third-Friday monthly, in ONE time base (CLAUDE.md: mixing local weekday math with toISOString
// shifts every date to Saturday on evening runs) ────────────────────────────────────────────────
function isMonthly(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (d.getUTCDay() !== 5) return false;
  return Math.ceil(d.getUTCDate() / 7) === 3;
}

// ── load ────────────────────────────────────────────────────────────────────────────────────────
const rows = db.prepare(
  `SELECT as_of_date, slot, ticker, expiration, dte, underlying_price, puts_json
     FROM spread_chain_capture WHERE reason = 'entry' ORDER BY as_of_date, slot, ticker, dte`,
).all();

const runs = new Map();                       // ticker|date|slot -> [row]
for (const r of rows) {
  const k = `${r.ticker}|${r.as_of_date}|${r.slot}`;
  if (!runs.has(k)) runs.set(k, []);
  runs.get(k).push(r);
}

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
    if (r.underlying_price == null || !(r.underlying_price > 0)) {
      unbuilt[side].set('no underlying price', (unbuilt[side].get('no underlying price') ?? 0) + 1);
      return null;
    }
    let puts;
    try { puts = JSON.parse(r.puts_json); } catch {
      unbuilt[side].set('unreadable chain', (unbuilt[side].get('unreadable chain') ?? 0) + 1);
      return null;
    }
    const s = buildSpread(puts, r.underlying_price);
    if (s.reason) { unbuilt[side].set(s.reason, (unbuilt[side].get(s.reason) ?? 0) + 1); return null; }
    return { ...s, dte: r.dte, expiration: r.expiration, monthly: isMonthly(r.expiration) };
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
const report = (label, subset, note) => {
  const d = subset.map(p => p.short.costShare - p.long.costShare).filter(Number.isFinite);
  if (d.length < 10) {
    say(`**${label}: ${d.length} pairs — too few to say anything.** ${note}`);
    return;
  }
  const cheaper = d.filter(x => x < 0).length;
  say(`**${label}** (${d.length} pairs): median difference **${pctf(med(d))}**, the shorter expiry ` +
      `cheaper on **${cheaper} of ${d.length}** (${pctf(cheaper / d.length, 0)}). ${note}`);
};
report('Same expiry type', sameType,
  'If this is much smaller than the headline — or points the other way — the headline is about expiry ' +
  'type, not about DTE.');

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
