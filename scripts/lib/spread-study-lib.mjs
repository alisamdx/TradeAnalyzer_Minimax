// Shared pieces for the bull put spread study harnesses (BPS-4, BPS-19).
//
// WHY THIS EXISTS. `packages/core/scripts/exception.mjs` was written after three sibling scripts had
// each grown their own copy of four safety checks, and it had none of them — the write-up of that
// (CLAUDE.md) is blunt: *a copy in each caller is not a safeguard, it is a list of the callers somebody
// remembered, and the next script is written after the list.* Two harnesses now reimplement
// `buildBullPutSpread` and `fillPrice`, because a `scripts/*.mjs` harness cannot import the real
// service — plain node cannot resolve the `@shared/*` aliases. One reimplementation, in one place,
// exercised by one self-test.
//
// Mirrors: src/shared/spread-mode.ts (profile), src/main/services/options-fill.ts (fills),
// src/main/services/spread-mode.ts (construction and expiry choice).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** The mode's trade profile — src/shared/spread-mode.ts SPREAD_MODE_PROFILE. */
export const P = {
  dteMin: 21, dteMax: 35, dteTarget: 30,
  deltaMin: 0.20, deltaMax: 0.40, deltaTarget: 0.30,
  wingMinPct: 0.03, wingMaxPct: 0.10, wingTargetPct: 0.05,
  maxCostShare: 0.25, minNetCredit: 0.05,
  slipFraction: 0.5,
};

/** No earnings row / an ETF — the mode's sentinel, so `expiration < NO_EARNINGS` is always true. */
export const NO_EARNINGS = '9999-12-31';

export const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
export const f = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));
export const pctf = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);

const CAPTURE_SQL = `SELECT as_of_date, slot, ticker, expiration, dte, underlying_price, puts_json
  FROM spread_chain_capture WHERE reason = 'entry' ORDER BY as_of_date, slot, ticker, dte`;

/**
 * The harnesses' data: `spread_chain_capture` entry rows grouped into runs, plus — when asked —
 * earnings dates.
 *
 * Real data comes from the RUNNING app (GET /diagnostics/spread-capture-panel, v1.1.339+). These
 * harnesses used to open `%APPDATA%\trade-analyzer\trade-analyzer.sqlite` themselves, which cannot be
 * done from a redirected shell such as the Claude app's (CLAUDE.md).
 *
 * `--db <file>` remains, for the self-tests' synthetic fixtures ONLY — a fresh file no other process
 * has open. It is NOT for pointing at a copy of the live database: a copy read while the app is running
 * is a stale shadow (CLAUDE.md). better-sqlite3 is imported only on that path, so a real run does not
 * need the Node ABI.
 */
export async function loadStudyData(argv, { earnings: wantEarnings = false } = {}) {
  const i = argv.indexOf('--db');
  let captures, earningsRows;
  if (i >= 0) {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(argv[i + 1], { fileMustExist: true });
    try {
      captures = db.prepare(CAPTURE_SQL).all();
      if (wantEarnings) {
        try { earningsRows = db.prepare('SELECT ticker, report_date FROM earnings_calendar').all(); }
        catch { earningsRows = null; }   // no table in this fixture — every ticker reads as unconstrained
      }
    } finally { db.close(); }
  } else {
    const dataDir = join(homedir(), '.tradeanalyzer');
    let token;
    try { token = readFileSync(join(dataDir, 'agent.token'), 'utf8').trim(); } catch {
      console.error(`No agent token at ${join(dataDir, 'agent.token')} — start TradeAnalyzer once to create it.`);
      process.exit(2);
    }
    let port = '7432';
    try { port = readFileSync(join(dataDir, 'api.port'), 'utf8').trim() || port; } catch { /* default */ }
    const url = `http://127.0.0.1:${port}/api/v1/diagnostics/spread-capture-panel${wantEarnings ? '?earnings=1' : ''}`;
    const res = await fetch(url, { headers: { 'X-Agent-Token': token } }).catch((err) => {
      console.error(`API server not reachable on 127.0.0.1:${port} — the app must be RUNNING. (${err.message})`);
      process.exit(3);
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) {
      console.error(`spread-capture-panel failed: HTTP ${res.status} ${body?.error ?? ''}`);
      if (res.status === 404) console.error('This app build predates the route (v1.1.339). Install the new build.');
      process.exit(4);
    }
    captures = body.data.captures;
    earningsRows = body.data.earnings;
    if (captures == null) {
      console.error('spread_chain_capture could not be read by the app (no table?) — nothing to study.');
      process.exit(5);
    }
  }
  const earnings = new Map();
  for (const r of earningsRows ?? []) if (r.report_date) earnings.set(r.ticker, r.report_date);
  return { ...groupRuns(captures), earnings };
}

/** src/main/services/options-fill.ts — a fill sits halfway between mid and the far side. */
export function fillPrice(bid, ask, action) {
  const mid = (bid + ask) / 2;
  if (!(ask > bid) || mid <= 0) return Math.max(0, mid);   // locked/crossed/degenerate → mid
  const adj = P.slipFraction * (ask - bid) / 2;
  return action === 'sell' ? Math.max(0, mid - adj) : mid + adj;
}

const twoSided = p => p[1] > 0 && p[2] >= p[1];

/**
 * The mode's construction, WITHOUT its two refusals.
 *
 * `buildBullPutSpread` rejects on net credit and on cost share. Both are reported here instead, as
 * `clearsGate`, because a study of what things COST must be able to see the expensive ones — filtering
 * on the gate would delete exactly the half of the distribution under study (the censoring BPS-3 had
 * to parse back out of rejection sentences).
 *
 * A stored put is [strike, bid, ask, delta, ivPct, openInterest, volume].
 */
export function buildSpread(puts, spot) {
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

/**
 * Third-Friday monthly, in ONE time base.
 *
 * CLAUDE.md: mixing local weekday math with `toISOString()` shifts every date to Saturday on evening
 * runs, which starved the agent of contracts for ~10 days. All UTC here, no exceptions.
 */
export function isMonthly(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.getUTCDay() === 5 && Math.ceil(d.getUTCDate() / 7) === 3;
}

/**
 * The mode's expiry choice — src/main/services/spread-mode.ts `pickSpreadExpiration`.
 * In the DTE window, strictly before earnings, nearest the target; ties to the shorter.
 */
export function pickNearestTarget(expiries, earningsDate) {
  return expiries
    .filter(e => e.dte >= P.dteMin && e.dte <= P.dteMax && e.expiration < earningsDate)
    .sort((a, b) => Math.abs(a.dte - P.dteTarget) - Math.abs(b.dte - P.dteTarget) || a.dte - b.dte)[0] ?? null;
}

/**
 * BPS-19's candidate rule: the MONTHLY in the window if there is one, else exactly what the incumbent
 * would have picked. The fallback is the point — the rule must be a strict refinement, or the two arms
 * differ on runs where no choice was ever available and the comparison silently measures something else.
 */
export function pickPreferMonthly(expiries, earningsDate) {
  const eligible = expiries.filter(e => e.dte >= P.dteMin && e.dte <= P.dteMax && e.expiration < earningsDate);
  const monthlies = eligible.filter(e => isMonthly(e.expiration))
    .sort((a, b) => Math.abs(a.dte - P.dteTarget) - Math.abs(b.dte - P.dteTarget) || a.dte - b.dte);
  return monthlies[0] ?? pickNearestTarget(expiries, earningsDate);
}

/**
 * Entry captures grouped by ticker-run.
 *
 * `reason = 'entry'` only: those come from the uniform 14–45 day sweep, while a `track` row exists only
 * because that expiry was already picked — a selection effect on whichever bucket it lands in.
 */
export function groupRuns(rows) {
  const runs = new Map();
  for (const r of rows) {
    const k = `${r.ticker}|${r.as_of_date}|${r.slot}`;
    if (!runs.has(k)) runs.set(k, []);
    runs.get(k).push(r);
  }
  return { rows, runs };
}

/** Build from a stored capture row, or say why not. Never throws on a bad chain. */
export function buildFromRow(r) {
  if (r.underlying_price == null || !(r.underlying_price > 0)) return { reason: 'no underlying price' };
  let puts;
  try { puts = JSON.parse(r.puts_json); } catch { return { reason: 'unreadable chain' }; }
  const s = buildSpread(puts, r.underlying_price);
  if (s.reason) return s;
  return { ...s, dte: r.dte, expiration: r.expiration, monthly: isMonthly(r.expiration) };
}

/**
 * Earnings dates, as the mode reads them, come from `loadStudyData(argv, { earnings: true })`. A ticker
 * with no row gets the NO_EARNINGS sentinel in the harness rather than being dropped: the mode rejects
 * it ("earnings date unknown"), but that refusal is identical for every rule being compared, so
 * dropping those runs would only shrink the sample without changing any difference. Harnesses report
 * how many runs the filter actually bound.
 */

/**
 * Median of the per-pair differences with a sign count beside it, or an explicit refusal under `floor`
 * pairs. A median with no sign count is a point estimate nobody has looked at the distribution of, and
 * a number quoted off four observations is worse than no number — "no signal" and "weak signal" must
 * not look alike (QC-907).
 */
export function reportPaired(say, label, diffs, note, { floor = 10, phrase = 'negative' } = {}) {
  const d = diffs.filter(Number.isFinite);
  if (d.length < floor) {
    say(`**${label}: ${d.length} pairs — too few to say anything.** ${note}`);
    return false;
  }
  const neg = d.filter(x => x < 0).length;
  say(`**${label}** (${d.length} pairs): median difference **${pctf(med(d))}**, ${phrase} ` +
      `on **${neg} of ${d.length}** (${pctf(neg / d.length, 0)}). ${note}`);
  return true;
}
