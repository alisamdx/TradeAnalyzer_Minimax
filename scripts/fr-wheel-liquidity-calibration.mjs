// FR-SEY-5 — recalibrating the wheel `optionLiquidityScore` thresholds.
//
// v1.1.130 established that fixing WHICH contract gets measured (WHEEL_MONTHLY_FIRST_EXPIRY) is
// necessary but not sufficient: the score still barely discriminates because two of its three
// components are binary gates that almost never fire.
//   OI >= 50        -> +4   (fires often)
//   spread <= 5%    -> +4   (almost never — WMT at OI 13,824 / spread 5.2% MISSES by 0.2pp)
//   volume >= 50    -> +2   (rarely, on a single strike)
// Net effect: the score sits at a near-constant 0 or 4 instead of ranking anything.
//
// This script measures candidate scoring schemes against real chains on two axes:
//
//   1. DISCRIMINATION — does the scheme actually spread contracts out? A signal that returns the
//      same value for every ticker contributes nothing to a composite no matter its weight.
//      Reported as distinct values used, share at the extremes, and normalised entropy.
//
//   2. AGREEMENT WITH REAL EXECUTION COST — the score exists to predict what trading the contract
//      costs. Ground truth here is the app's own fill model (options-fill.ts, SLIPPAGE_FRACTION
//      0.5): friction = 0.5 x half-spread, expressed as a share of the credit collected. Reported
//      as Spearman rank correlation (want strongly NEGATIVE: higher score = cheaper).
//
// Caveat kept explicit: cost% is driven by the spread, so optimising correlation alone would
// delete the OI and volume components. Those price *exit optionality and depth*, which a
// single-contract entry-cost measure cannot see. Read axis 2 as "is the spread component sane",
// not as the whole objective — a wheel CSP that has to be rolled needs a book on the other side.
//
// Data source
// ───────────
// DEFAULT is `--source db`: real short-put legs pulled from the stored `daily_briefs` structures.
// Those quotes were all captured DURING market hours by the brief job, across many dates and
// tickers, so this needs no live market and gives a far larger panel than polling chains. The
// `--source live` path polls the API server instead and requires RTH (outside it every bid is 0,
// which kills two of the three components).
//
// Usage: node scripts/fr-wheel-liquidity-calibration.mjs [--source db|live] [--limit 60] [--out file.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { etDate } from './lib/et-time.mjs';
import { apiGet, loadBriefHistory } from './lib/app-api.mjs';

const DELTA_MIN = 0.20, DELTA_MAX = 0.30, DELTA_TARGET = 0.25;
const WINDOW = { minDTE: 28, maxDTE: 52 };   // monthly-first window — the better contract choice
const SLIPPAGE_FRACTION = 0.5;
const HOLIDAY_FRIDAYS = new Set([
  '2025-04-18', '2025-07-04', '2026-04-03', '2026-06-19',
  '2026-12-25', '2027-01-01', '2027-03-26', '2028-04-14',
]);

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const LIMIT = Number(argOf('--limit', 60));
const OUT = argOf('--out', null);
const SOURCE = argOf('--source', 'db');

const TOKEN = readFileSync(join(homedir(), '.tradeanalyzer', 'agent.token'), 'utf8').trim();
const API = 'http://127.0.0.1:7432/api/v1';
async function getChain(ticker, expiration) {
  const res = await fetch(`${API}/options/${ticker}?expiration=${expiration}`, { headers: { 'X-Agent-Token': TOKEN } });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.data) ? body.data : null;
}

const addDaysUTC = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const ymd = (d) => d.toISOString().slice(0, 10);
function thirdFriday(y, m0) {
  const first = new Date(Date.UTC(y, m0, 1));
  return ymd(new Date(Date.UTC(y, m0, 1 + ((5 - first.getUTCDay() + 7) % 7) + 14)));
}
const isMonthly = (iso) => { const [y, m] = iso.split('-').map(Number); return thirdFriday(y, m - 1) === iso; };
function nearTermExpirations(count) {
  const now = new Date();
  const first = addDaysUTC(now, (5 - now.getUTCDay() + 7) % 7);
  const out = [];
  for (let w = 0; w < count; w++) {
    let d = addDaysUTC(first, w * 7);
    if (HOLIDAY_FRIDAYS.has(ymd(d))) d = addDaysUTC(d, -1);
    out.push(ymd(d));
  }
  return out;
}
const dteDays = (e) => Math.max(0, Math.round((new Date(e + 'T21:00:00Z') - Date.now()) / 86_400_000));
const spreadPct = (bid, ask) => (bid > 0 && ask > 0 && ask > bid) ? ((ask - bid) / ((ask + bid) / 2)) * 100 : 0;
function fillPrice(bid, ask) {
  const mid = (bid + ask) / 2;
  if (!(ask > bid) || mid <= 0) return Math.max(0, mid);
  return Math.max(0, mid - SLIPPAGE_FRACTION * (ask - bid) / 2);
}

// ── candidate schemes (all 0–10) ────────────────────────────────────────────────
const tier = (v, tiers, dflt) => { for (const [bound, pts] of tiers) if (v >= bound) return pts; return dflt; };
const tierLte = (v, tiers, dflt) => { for (const [bound, pts] of tiers) if (v <= bound) return pts; return dflt; };

const SCHEMES = {
  // Shipped today — three binary gates.
  current: (c) => (c.oi >= 50 ? 4 : 0) + (c.spread <= 5 ? 4 : 0) + (c.volume >= 50 ? 2 : 0),

  // Strategy Lab's tier shape (0–15) rescaled to 0–10. The lab rates the same contracts sanely,
  // so this is the obvious reference candidate.
  labScaled: (c) => {
    const s = tierLte(c.spread, [[5, 8], [15, 5]], 1);
    const o = tier(c.oi, [[500, 4], [100, 2.5]], 0.5);
    const v = tier(c.volume, [[100, 3], [10, 1.5]], 0);
    return ((s + o + v) / 15) * 10;
  },

  // Graded, but retuned for the wheel's own distribution: spread bands widened to where real
  // 25-delta puts actually sit, OI given a top band that mega-caps can reach, volume softened.
  graded: (c) =>
    tierLte(c.spread, [[5, 4], [15, 3], [30, 1.5]], 0) +
    tier(c.oi, [[1000, 4], [250, 3], [50, 1.5]], 0) +
    tier(c.volume, [[100, 2], [10, 1]], 0),

  // Continuous — no cliffs at all. log-scaled OI, decaying spread credit.
  continuous: (c) => {
    const s = 4 * Math.max(0, Math.min(1, 1 - (c.spread - 5) / 35));            // 5% -> 4, 40% -> 0
    const o = 4 * Math.max(0, Math.min(1, Math.log10(Math.max(c.oi, 1)) / 3.3)); // 1 -> 0, 2000 -> ~4
    const v = 2 * Math.max(0, Math.min(1, Math.log10(Math.max(c.volume, 1)) / 2));
    return s + o + v;
  },
};

// ── stats ───────────────────────────────────────────────────────────────────────
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));
function rankOf(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(arr.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function spearman(x, y) {
  const rx = rankOf(x), ry = rankOf(y), n = x.length;
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : 0;
}
/** Normalised Shannon entropy over rounded score buckets — 1 = perfectly spread, 0 = constant. */
function entropy(vals) {
  const h = {};
  for (const v of vals) { const k = (Math.round(v * 2) / 2).toFixed(1); h[k] = (h[k] ?? 0) + 1; }
  const n = vals.length, ks = Object.keys(h);
  if (ks.length <= 1) return 0;
  let e = 0;
  for (const k of ks) { const p = h[k] / n; e -= p * Math.log(p); }
  return e / Math.log(ks.length);
}

// ── sample + collect ────────────────────────────────────────────────────────────
async function sampleTickers() {
  // Latest batch wheel snapshot, through the API (v1.1.220 route), never the SQLite file.
  const snap = await apiGet('/analysis/snapshots/latest?mode=wheel');
  const list = Array.isArray(snap?.results) ? snap.results : [];
  return list.filter((r) => r.recommendedStrike != null && r.ivRank != null)
    .sort((a, b) => b.ivRank - a.ivRank).slice(0, LIMIT).map((r) => r.ticker);
}

/** Build an observation from a quote (shared by both sources). */
function observe(base, bid, ask, oi, volume) {
  const premium = fillPrice(bid, ask);
  const friction = SLIPPAGE_FRACTION * (ask - bid) / 2;
  return {
    ...base, bid, ask, oi: oi ?? 0, volume: volume ?? 0, spread: spreadPct(bid, ask),
    costPct: premium > 0 ? (friction / premium) * 100 : null,   // ground truth: entry cost as % of credit
  };
}

/** Real short-put legs in the wheel delta band, from stored brief structures (market-hours quotes). */
async function collectFromDb() {
  const { briefs } = await loadBriefHistory();
  const seen = new Set(), out = [];
  for (const b of briefs) {
    const day = etDate(b.generated_at);
    let picks; try { picks = JSON.parse(b.picks); } catch { continue; }
    for (const p of picks) {
      for (const s of (p.strategyLabResult?.scores ?? [])) {
        if (!s.setup || s.setup.unavailableReason) continue;
        for (const l of (s.setup.legs ?? [])) {
          // A wheel CSP is a SHORT PUT in the 0.20–0.30 delta band with a live bid.
          if (l.side !== 'put' || l.action !== 'sell' || l.delta == null) continue;
          const d = Math.abs(l.delta);
          if (d < DELTA_MIN || d > DELTA_MAX || !(l.bid > 0)) continue;
          const key = `${day}|${p.ticker}|${l.strike}|${l.expiration}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(observe(
            { ticker: p.ticker, day, expiration: l.expiration, strike: l.strike, monthly: isMonthly(l.expiration) },
            l.bid, l.ask, l.openInterest, l.volume
          ));
        }
      }
    }
  }
  return out;
}

/** Live chain poll — requires RTH. */
async function collectLive() {
  const health = await fetch(`${API}/health`, { headers: { 'X-Agent-Token': TOKEN } }).catch(() => null);
  if (!health?.ok) { console.error('API server unreachable — the app must be RUNNING for --source live.'); process.exit(1); }
  const tickers = await sampleTickers();
  const expirations = nearTermExpirations(Math.ceil(WINDOW.maxDTE / 7) + 2);
  const inWin = expirations.filter((e) => { const d = dteDays(e); return d >= WINDOW.minDTE && d <= WINDOW.maxDTE; }).sort();
  const tryOrder = [...inWin.filter(isMonthly), ...inWin.filter((e) => !isMonthly(e))];
  const out = [];
  for (const [i, ticker] of tickers.entries()) {
    for (const exp of tryOrder) {
      const chain = await getChain(ticker, exp);
      if (!chain?.length) continue;
      const inBand = (c) => c.delta != null && Math.abs(c.delta) >= DELTA_MIN && Math.abs(c.delta) <= DELTA_MAX && c.bid > 0;
      const pool = chain.filter((c) => c.type === 'put' && inBand(c));
      if (!pool.length) continue;
      const c = pool.reduce((a, b) => Math.abs(Math.abs(a.delta) - DELTA_TARGET) < Math.abs(Math.abs(b.delta) - DELTA_TARGET) ? a : b);
      out.push(observe({ ticker, day: 'live', expiration: exp, strike: c.strike, monthly: isMonthly(exp) },
        c.bid, c.ask, c.openInterest, c.volume));
      break;
    }
    process.stdout.write(`\r  ${i + 1}/${tickers.length}   `);
  }
  process.stdout.write('\n');
  if (!out.length) {
    console.error('\n!! No contract had a live bid. The market is CLOSED (or E*Trade is not serving quotes).');
    console.error('!! Outside RTH every bid/ask/volume is 0, so spread and volume cannot be measured.');
    console.error('!! Use the default --source db, which reads market-hours quotes already captured in daily_briefs.');
    process.exit(1);
  }
  return out;
}

console.log(`\nWheel liquidity threshold calibration — source=${SOURCE}, ${new Date().toISOString()}`);
console.log(`observations = short puts, ${DELTA_MIN}–${DELTA_MAX} delta, live bid` +
            (SOURCE === 'live' ? `, monthly-first pick in [${WINDOW.minDTE},${WINDOW.maxDTE}] DTE\n` : `, from stored brief structures\n`));

const rows = SOURCE === 'live' ? await collectLive() : await collectFromDb();

const usable = rows.filter((r) => r.costPct != null);
console.log(`\n${usable.length} contracts with a usable quote.`);
console.log(`  median OI ${f(med(usable.map((r) => r.oi)), 0)}  ·  median spread ${f(med(usable.map((r) => r.spread)))}%  ·  ` +
            `median volume ${f(med(usable.map((r) => r.volume)), 0)}  ·  median entry cost ${f(med(usable.map((r) => r.costPct)))}% of credit`);

// ── compare schemes ─────────────────────────────────────────────────────────────
console.log('\nscheme        median  mean   distinct  %at 0   %at max  entropy  Spearman(score, cost%)');
console.log('─'.repeat(92));
const results = {};
for (const [name, fn] of Object.entries(SCHEMES)) {
  const vals = usable.map((r) => fn(r));
  const distinct = new Set(vals.map((v) => (Math.round(v * 2) / 2).toFixed(1))).size;
  const atZero = (vals.filter((v) => v < 0.5).length / vals.length) * 100;
  const atMax = (vals.filter((v) => v >= 9.5).length / vals.length) * 100;
  const rho = spearman(vals, usable.map((r) => r.costPct));
  results[name] = { median: med(vals), mean: mean(vals), distinct, atZero, atMax, entropy: entropy(vals), rho };
  console.log(
    `${name.padEnd(13)} ${f(med(vals), 1).padStart(6)} ${f(mean(vals), 1).padStart(6)} ${String(distinct).padStart(9)} ` +
    `${f(atZero, 0).padStart(6)}% ${f(atMax, 0).padStart(8)}% ${f(entropy(vals), 2).padStart(8)} ${f(rho, 3).padStart(12)}`
  );
}
console.log('\n  distinct = distinct half-point values used   ·   entropy 1.0 = perfectly spread, 0 = constant');
console.log('  Spearman: want strongly NEGATIVE (higher score ⇒ cheaper to trade).');

// ── sanity: the contracts that motivated this ───────────────────────────────────
const spotlight = ['WMT', 'PG', 'DIS', 'JPM', 'KO', 'V', 'AAPL', 'GOOGL'].filter((t) => usable.some((r) => r.ticker === t));
if (spotlight.length) {
  console.log('\nsanity check — scores for the contracts that motivated this:');
  console.log('ticker     OI    spread%  vol   cost%  │ ' + Object.keys(SCHEMES).map((s) => s.padStart(10)).join(' '));
  for (const t of spotlight) {
    const r = usable.find((x) => x.ticker === t);
    console.log(
      `${t.padEnd(7)} ${String(r.oi).padStart(6)} ${f(r.spread).padStart(8)} ${String(r.volume).padStart(5)} ${f(r.costPct).padStart(6)}  │ ` +
      Object.values(SCHEMES).map((fn) => f(fn(r), 1).padStart(10)).join(' ')
    );
  }
}

if (OUT) { writeFileSync(OUT, JSON.stringify({ runAt: new Date().toISOString(), rows: usable, results }, null, 2)); console.log(`\nwrote ${OUT}`); }
