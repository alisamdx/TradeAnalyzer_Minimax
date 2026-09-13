// Bull put credit spread vs cash-secured put — the operator's profile, on the wheel replay (TODO #43).
//
// QUESTION. The wheel is slow and ties up capital. Does a bull put credit spread on the SAME entries,
// held 5–15 days, earn more per dollar of capital per day — and which entry/exit settings get it
// there? Operator decisions 2026-09-12: credit spread (premium, not direction), 5–15 day hold, risk
// as fixed dollars or % of the trade, delivered as a brief mode alongside wheel.
//
// WHAT WAS ALREADY KNOWN. v1.1.54 (`scripts/fr-wheel-spread-study.mjs`) validated wheel picks as a
// budget-sized put credit spread: 79.8% win / 8.2% return on max loss vs a random-day baseline of
// 74.3% / 3.7%, and wheel has been an eligible v2-engine strategy since. That run fixed 30 DTE, 0.30Δ,
// 50% target / value-at-2×-credit stop, NO time stop, priced both legs at ATM IV (no skew), and never
// compared against the naked CSP on the same entries. This study adds exactly those four things.
//
// METHOD (per replay entry, per configuration):
//   short put at the target delta, long put ~5% of spot lower (rounded to the strike increment)
//   priced Black-Scholes at iv_history ATM IV plus a STICKY-MONEYNESS SKEW of `skew` vol points per
//   10% out of the money — the skew grid is a sensitivity, not a measurement: nothing stored yet
//   holds a real wing quote (that is what v1.1.243's spread_chain_capture starts recording)
//   marked daily on closes; exits: profit target (fraction of entry credit), loss stop (loss as a
//   multiple of entry credit), time stop (calendar days held), else settled at intrinsic on expiry
//   the CSP is the same short put with the same exits, capital = strike − premium (cash secured)
//   capital efficiency = Σ P&L ÷ Σ (capital × days held) × 365 — the "capital optimisation" metric
//
// DE-BIASING, all mandatory here (CLAUDE.md quirks):
//   episodes — the replay picks the same ticker on consecutive days; entries of one ticker within
//              14 days of a kept entry are collapsed, so one move is not counted many times
//   discontinuity guard — any |daily close change| > 35% in the window excludes the entry (an
//              unadjusted split or ticker reuse would manufacture fake P&L); counted and printed
//   settled only — an entry is used only if bars reach its longest possible expiry, so early exits
//              near the end of the data cannot bias the sample toward winners
//   paired — spread and CSP are always compared on the identical entry set
//
// LIMITS. One replay sample (one regime, whatever n says). Closes only — an intraday stop fires late.
// Mid pricing, no slippage by default (operator decision for backtests; `--slip` exists). IV rank uses
// iv_history, which splices IVolatility and E*Trade with zero overlap (CLAUDE.md). FR-SEY-5: this can
// shape the criteria; it cannot by itself enable a live gate.
//
// RUN from a normal terminal (NOT from inside a packaged app's shell), with core built and the
// Node ABI of better-sqlite3:
//   npm run rebuild:node
//   node scripts/fr-bull-put-spread-study.mjs            [--strategy wheel] [--slip 0.03]
//   node scripts/fr-bull-put-spread-study.mjs --selftest (no database; checks the simulator)

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const SELFTEST = argv.includes('--selftest');
const STRATEGY = argOf('--strategy', 'wheel');
const SLIP = Number(argOf('--slip', '0'));   // $/share per leg per fill
const R = 0.02;
const JUMP_LIMIT = 0.35;
const EPISODE_GAP_DAYS = 14;
const MAX_DTE = 35;

// ── Black-Scholes (puts) ────────────────────────────────────────────────────────────────────────
function cdfNorm(x) {
  const sign = x < 0 ? -1 : 1;
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const p = 0.3275911, ax = Math.abs(x) / Math.SQRT2, t = 1 / (1 + p * ax);
  const poly = ((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t;
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-ax * ax)));
}
function bsPut(S, K, T, sig) {
  if (T <= 0 || sig <= 0) return Math.max(0, K - S);
  const sq = sig * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (R + 0.5 * sig * sig) * T) / sq, d2 = d1 - sq;
  return K * Math.exp(-R * T) * cdfNorm(-d2) - S * cdfNorm(-d1);
}
function bsPutDelta(S, K, T, sig) {
  if (T <= 0 || sig <= 0) return S < K ? -1 : 0;
  const d1 = (Math.log(S / K) + (R + 0.5 * sig * sig) * T) / (sig * Math.sqrt(T));
  return cdfNorm(d1) - 1;
}

/** Sticky-moneyness put skew: +skewPts vol points per 10% out of the money (fewer in the money). */
export const ivAt = (K, S, atm, skewPts) => Math.max(0.05, atm + (skewPts / 100) * ((1 - K / S) / 0.10));
const putAt = (S, K, T, atm, skew) => bsPut(S, K, T, ivAt(K, S, atm, skew));
const strikeInc = S => (S >= 200 ? 5 : S >= 50 ? 2.5 : S >= 25 ? 1 : 0.5);
const roundC = x => Math.round(x * 100) / 100;

function strikeForDelta(S, T, atm, target, skew) {
  const inc = strikeInc(S);
  let best = null, bestDiff = Infinity;
  for (let k = Math.floor(S / inc) * inc; k >= S * 0.6; k = roundC(k - inc)) {
    const diff = Math.abs(Math.abs(bsPutDelta(S, k, T, ivAt(k, S, atm, skew))) - target);
    if (diff < bestDiff) { bestDiff = diff; best = roundC(k); }
  }
  return best;
}

// ── dates (UTC throughout — one time base) ────────────────────────────────────────────────────
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

// ── the simulator ─────────────────────────────────────────────────────────────────────────────
/**
 * entry: { date, bars:[{date,close}] ascending, ei (index of the entry bar), sig0, ivAsOf(date) }
 * cfg:   { dte, delta, skew, pt|null, sl|null, ts|null }
 * → { spread:{pnl,cap,days,exit}, csp:{…}, creditPctWidth } or null when unconstructible/unsettled
 */
function simulate(entry, cfg) {
  const { bars, ei, sig0 } = entry;
  const S0 = bars[ei].close, T0 = cfg.dte / 365;
  const shortK = strikeForDelta(S0, T0, sig0, cfg.delta, cfg.skew);
  if (shortK == null) return null;
  const inc = strikeInc(S0);
  const width = Math.max(inc, Math.round((0.05 * S0) / inc) * inc);
  const longK = roundC(shortK - width);
  if (longK <= 0) return null;

  const pS0 = putAt(S0, shortK, T0, sig0, cfg.skew), pL0 = putAt(S0, longK, T0, sig0, cfg.skew);
  const credit = pS0 - pL0 - 2 * SLIP, premium = pS0 - SLIP;
  if (credit < 0.05 || premium < 0.05) return null;
  const expiry = addDays(entry.date, cfg.dte);

  const sides = {
    spread: {
      open: credit, cap: (width - credit) * 100,
      close: (S, T, atm) => putAt(S, shortK, T, atm, cfg.skew) - putAt(S, longK, T, atm, cfg.skew) + 2 * SLIP,
      intrinsic: S => Math.max(0, shortK - S) - Math.max(0, longK - S),
    },
    csp: {
      open: premium, cap: (shortK - premium) * 100,
      close: (S, T, atm) => putAt(S, shortK, T, atm, cfg.skew) + SLIP,
      intrinsic: S => Math.max(0, shortK - S),
    },
  };

  const out = { creditPctWidth: credit / width, shortK, longK, width };
  for (const [name, side] of Object.entries(sides)) {
    let res = null;
    for (let i = ei + 1; i < bars.length; i++) {
      const bar = bars[i];
      if (bar.date >= expiry) {
        const px = bar.date === expiry ? bar.close : bars[i - 1].close;
        res = { pnl: (side.open - side.intrinsic(px)) * 100, cap: side.cap, days: cfg.dte, exit: 'expiry' };
        break;
      }
      const held = daysBetween(entry.date, bar.date);
      const atm = entry.ivAsOf(bar.date) ?? sig0;
      const pnl = side.open - side.close(bar.close, daysBetween(bar.date, expiry) / 365, atm);
      let exit = null;
      if (cfg.pt != null && pnl >= side.open * cfg.pt) exit = 'target';
      else if (cfg.sl != null && pnl <= -side.open * cfg.sl) exit = 'stop';
      else if (cfg.ts != null && held >= cfg.ts) exit = 'time';
      if (exit) { res = { pnl: pnl * 100, cap: side.cap, days: held, exit }; break; }
    }
    if (!res) return null;
    out[name] = res;
  }
  return out;
}

// ── statistics ────────────────────────────────────────────────────────────────────────────────
function stats(rows, side) {
  const r = rows.map(x => x[side]);
  const n = r.length;
  if (n === 0) return null;
  const rets = r.map(x => (x.pnl / x.cap) * 100).sort((a, b) => a - b);
  const sumPnl = r.reduce((s, x) => s + x.pnl, 0);
  const sumCapDays = r.reduce((s, x) => s + x.cap * Math.max(1, x.days), 0);
  return {
    n,
    win: (r.filter(x => x.pnl > 0).length / n) * 100,
    mean: rets.reduce((s, x) => s + x, 0) / n,
    median: rets[Math.floor(n / 2)],
    p5: rets[Math.floor(n * 0.05)],
    worst: Math.min(...r.map(x => x.pnl)),
    avgPnl: sumPnl / n,
    // Equal-weighted return per day held. Preferred over capEff, which is DOLLAR-weighted and was
    // shown on the first run (2026-09-12) to swing on one or two high-priced names: Q2 391 vs Q3 19
    // %/yr at near-identical mean returns (9.9% vs 9.3%), and −500 %/yr on a 3-trade split with a
    // positive mean.
    perDay: r.reduce((s, x) => s + ((x.pnl / x.cap) * 100) / Math.max(1, x.days), 0) / n,
    days: r.reduce((s, x) => s + x.days, 0) / n,
    capEff: (sumPnl / sumCapDays) * 365 * 100,
    exits: r.reduce((acc, x) => { acc[x.exit] = (acc[x.exit] ?? 0) + 1; return acc; }, {}),
  };
}
const f = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
const EXIT_CODES = { target: 'T', stop: 'S', time: 'H', expiry: 'E' };
const exitMix = s => Object.entries(EXIT_CODES).map(([k, code]) => `${code}${Math.round(((s.exits[k] ?? 0) / s.n) * 100)}`).join(' ');

function runAll(entries, cfg) {
  const rows = [];
  for (const e of entries) {
    const s = simulate(e, cfg);
    if (s) rows.push({ e, ...s });
  }
  return rows;
}

const HEAD = '| config | n | SPREAD win% | mean ret% | median | ret%/day | days | exits | $-wt %/yr | CSP win% | mean ret% | median | ret%/day | days | $-wt %/yr |';
const SEP = '|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|--:|--:|';
function line(label, rows) {
  const s = stats(rows, 'spread'), c = stats(rows, 'csp');
  if (!s) return `| ${label} | 0 | | | | | | | | | | | | | |`;
  return `| ${label} | ${s.n} | ${f(s.win)} | ${f(s.mean, 2)} | ${f(s.median, 2)} | **${f(s.perDay, 2)}** | ${f(s.days)} | ${exitMix(s)} | ${f(s.capEff)} | ${f(c.win)} | ${f(c.mean, 2)} | ${f(c.median, 2)} | **${f(c.perDay, 2)}** | ${f(c.days)} | ${f(c.capEff)} |`;
}
const cfgLabel = c => `${c.dte}d Δ${c.delta} skew${c.skew} pt${c.pt ?? '–'} sl${c.sl ?? '–'} ts${c.ts ?? '–'}`;

// ── self-test (no database) ───────────────────────────────────────────────────────────────────
function syntheticEntry(pathFn, iv = 0.35) {
  const start = '2025-01-01', bars = [];
  for (let i = 0; i < 60; i++) bars.push({ date: addDays(start, i), close: 100 });
  const ei = 59;
  for (let i = 1; i <= MAX_DTE + 10; i++) bars.push({ date: addDays(bars[ei].date, i), close: pathFn(i) });
  return { ticker: 'SYN', date: bars[ei].date, bars, ei, sig0: iv, ivAsOf: () => iv };
}
function selftest() {
  const fails = [];
  const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fails.push(name); };
  const base = { dte: 30, delta: 0.25, skew: 0, pt: null, sl: null, ts: null };

  check('skew adds vol out of the money, removes it in the money',
    Math.abs(ivAt(90, 100, 0.30, 6) - 0.36) < 1e-9 && Math.abs(ivAt(110, 100, 0.30, 6) - 0.24) < 1e-9);

  const flat = simulate(syntheticEntry(() => 100), base);
  check('flat stock held to expiry: both expire worthless and keep the whole credit',
    flat && flat.spread.exit === 'expiry' && flat.csp.exit === 'expiry'
    && Math.abs(flat.spread.pnl - (flat.width * 100 - flat.spread.cap)) < 1e-6 && flat.csp.pnl > 0);
  check('spread ties up less capital than the CSP', flat && flat.spread.cap < flat.csp.cap);
  check('short strike is below spot and the wing below it', flat && flat.shortK < 100 && flat.longK < flat.shortK);

  const crash = simulate(syntheticEntry(() => 70), base);
  check('crash held to expiry: spread loses exactly its capital (max loss)', crash && Math.abs(crash.spread.pnl + crash.spread.cap) < 1e-6);
  check('crash held to expiry: CSP loses more dollars than the spread', crash && crash.csp.pnl < crash.spread.pnl);

  const timed = simulate(syntheticEntry(() => 100), { ...base, ts: 10 });
  check('time stop exits at 10 days held', timed && timed.spread.exit === 'time' && timed.spread.days === 10);

  const stopped = simulate(syntheticEntry(i => 100 - i * 2), { ...base, sl: 2 });
  check('loss stop fires before expiry on a steady decline', stopped && stopped.spread.exit === 'stop'
    && stopped.spread.days < 30 && stopped.spread.pnl < 0);

  const target = simulate(syntheticEntry(i => 100 + i), { ...base, pt: 0.5 });
  check('profit target fires on a rally', target && target.spread.exit === 'target' && target.spread.days < 30);

  const noData = simulate({ ...syntheticEntry(() => 100), bars: syntheticEntry(() => 100).bars.slice(0, 70) }, base);
  check('an entry whose bars stop before expiry is unsettled (null), never a partial result', noData === null);

  console.log(fails.length ? `\n${fails.length} FAILED` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
}

// ── loading ───────────────────────────────────────────────────────────────────────────────────
function loadEntries(db) {
  const picks = db.prepare(
    `SELECT DISTINCT ro.ticker AS ticker, rb.as_of_date AS date
       FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id = ro.replay_brief_id
      WHERE rb.strategy = ? ORDER BY ro.ticker, rb.as_of_date`,
  ).all(STRATEGY);
  const maxPx = db.prepare('SELECT MAX(date) d FROM historical_prices').get().d;
  const barsStmt = db.prepare(
    'SELECT date, close FROM historical_prices WHERE ticker = ? AND date >= ? AND date <= ? AND close > 0 ORDER BY date');
  const ivStmt = db.prepare('SELECT date, atm_iv FROM iv_history WHERE ticker = ? AND atm_iv > 0 ORDER BY date');
  const ivCache = new Map();
  const counts = { picks: picks.length, unsettled: 0, noBars: 0, discontinuity: 0, ivFallback: 0, collapsed: 0 };
  const discontinuities = [];
  const pooled = [];

  for (const p of picks) {
    if (addDays(p.date, MAX_DTE + 3) > maxPx) { counts.unsettled++; continue; }
    const bars = barsStmt.all(p.ticker, addDays(p.date, -90), addDays(p.date, MAX_DTE + 10));
    const ei = bars.findIndex(b => b.date >= p.date);
    if (ei < 1 || daysBetween(p.date, bars[ei].date) > 4 || bars[bars.length - 1].date < addDays(p.date, MAX_DTE)) {
      counts.noBars++; continue;
    }
    let jump = null;
    for (let i = 1; i < bars.length; i++) {
      const ch = bars[i].close / bars[i - 1].close - 1;
      if (Math.abs(ch) > JUMP_LIMIT) { jump = { date: bars[i].date, ch }; break; }
    }
    if (jump) { counts.discontinuity++; discontinuities.push(`${p.ticker} ${p.date} (step ${f(jump.ch * 100, 0)}% on ${jump.date})`); continue; }

    if (!ivCache.has(p.ticker)) {
      // iv_history is documented as a decimal but the app writes percentages; accept either per row.
      ivCache.set(p.ticker, ivStmt.all(p.ticker).map(r => ({ date: r.date, iv: r.atm_iv > 3 ? r.atm_iv / 100 : r.atm_iv })));
    }
    const ivRows = ivCache.get(p.ticker);
    const ivAsOf = d => {
      let lo = 0, hi = ivRows.length - 1, a = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (ivRows[m].date <= d) { a = m; lo = m + 1; } else hi = m - 1; }
      return a >= 0 && daysBetween(ivRows[a].date, d) <= 10 ? ivRows[a].iv : null;
    };
    const entryDate = bars[ei].date;
    let sig0 = ivAsOf(entryDate);
    if (sig0 == null) {
      counts.ivFallback++;
      const closes = bars.slice(Math.max(0, ei - 20), ei + 1).map(b => b.close), lr = [];
      for (let i = 1; i < closes.length; i++) lr.push(Math.log(closes[i] / closes[i - 1]));
      const m = lr.reduce((s, x) => s + x, 0) / (lr.length || 1);
      sig0 = lr.length > 2 ? Math.max(0.05, Math.sqrt(lr.reduce((s, x) => s + (x - m) ** 2, 0) / (lr.length - 1) * 252)) : 0.30;
    }
    const yearAgo = addDays(entryDate, -365);
    const window = ivRows.filter(r => r.date >= yearAgo && r.date <= entryDate).map(r => r.iv);
    const ivRank = window.length >= 120 && sig0 != null
      ? ((sig0 - Math.min(...window)) / ((Math.max(...window) - Math.min(...window)) || 1)) * 100 : null;
    const sma50 = ei >= 49 ? bars.slice(ei - 49, ei + 1).reduce((s, b) => s + b.close, 0) / 50 : null;
    pooled.push({
      ticker: p.ticker, date: entryDate, bars, ei, sig0, ivAsOf, ivRank,
      aboveSma50: sma50 == null ? null : bars[ei].close > sma50,
    });
  }

  const episodes = [], lastKept = new Map();
  for (const e of pooled) {
    const prev = lastKept.get(e.ticker);
    if (prev && daysBetween(prev, e.date) < EPISODE_GAP_DAYS) { counts.collapsed++; continue; }
    lastKept.set(e.ticker, e.date);
    episodes.push(e);
  }
  return { pooled, episodes, counts, discontinuities, maxPx };
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────
async function main() {
  if (SELFTEST) return selftest();

  // --out writes UTF-8 directly. A PowerShell 5.1 `>` redirect writes UTF-16, which is what the
  // first run produced.
  const OUT = argOf('--out', null);
  const captured = [];
  if (OUT) {
    const log = console.log.bind(console);
    console.log = (...a) => { captured.push(a.join(' ')); log(...a); };
    process.on('exit', () => { try { writeFileSync(OUT, `${captured.join('\n')}\n`, 'utf8'); } catch { /* best effort */ } });
  }

  const dir = join(process.env.APPDATA ?? '', 'trade-analyzer');
  const dbPath = join(dir, 'trade-analyzer.sqlite');
  let guard;
  try {
    guard = await import('../packages/core/dist/db/appdata-redirect.js');
  } catch {
    console.error('packages/core is not built, so the redirect guard cannot load. Run: npm run build --prefix packages/core');
    process.exit(2);
  }
  try {
    guard.assertNotRedirected([dir], 'fr-bull-put-spread-study');
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(3);
  }
  if (!existsSync(dbPath)) { console.error(`No database at ${dbPath} — refusing to create one.`); process.exit(4); }

  let db;
  try {
    const { default: Database } = await import('better-sqlite3');
    // Write-capable on purpose: a readonly connection on Windows cannot attach the live WAL index
    // and silently reads a stale checkpoint (CLAUDE.md). Only SELECTs are issued.
    db = new Database(dbPath, { fileMustExist: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(/NODE_MODULE_VERSION/.test(msg)
      ? 'better-sqlite3 is built for Electron (after npm run package). Run: npm run rebuild:node'
      : msg);
    process.exit(6);
  }

  const { pooled, episodes, counts, discontinuities, maxPx } = loadEntries(db);
  db.close();

  console.log(`# Bull put spread vs CSP — ${STRATEGY} replay entries (prices to ${maxPx}, slip $${SLIP}/leg)\n`);
  console.log(`Replay picks ${counts.picks} → unsettled ${counts.unsettled}, no bars ${counts.noBars}, `
    + `discontinuity-excluded ${counts.discontinuity}, usable ${pooled.length} → **${episodes.length} episodes** `
    + `(${counts.collapsed} repeat entries collapsed). IV from rolling vol (no iv_history): ${counts.ivFallback}.`);
  const dates = episodes.map(e => e.date).sort();
  if (dates.length) console.log(`Entry dates ${dates[0]} … ${dates[dates.length - 1]}.`);
  if (discontinuities.length) console.log(`\nExcluded for a >35% daily step: ${discontinuities.slice(0, 20).join('; ')}${discontinuities.length > 20 ? ` … +${discontinuities.length - 20}` : ''}`);
  console.log('\nret% = P&L ÷ capital (spread: max loss; CSP: strike − premium). ret%/day = mean over trades of ret% ÷ days held '
    + '(equal-weighted — the comparison to read). $-wt %/yr = Σ P&L ÷ Σ(capital × days) × 365 (dollar-weighted; one expensive name can swing it). '
    + 'exits (spread): T=profit target S=loss stop H=time stop (days held) E=expiry, % of trades.\n');

  const BASE = { dte: 30, delta: 0.25, skew: 3, pt: 0.5, sl: 2, ts: 15 };

  console.log(`## 1. Draft profile — ${cfgLabel(BASE)}\n`);
  console.log(HEAD); console.log(SEP);
  const baseEp = runAll(episodes, BASE);
  console.log(line('episodes', baseEp));
  console.log(line('pooled (every replay day)', runAll(pooled, BASE)));
  const sb = stats(baseEp, 'spread'), cb = stats(baseEp, 'csp');
  if (sb) {
    console.log(`\nTails (episodes): spread p5 ${f(sb.p5, 1)}% / worst $${f(sb.worst, 0)} per contract; `
      + `CSP p5 ${f(cb.p5, 1)}% / worst $${f(cb.worst, 0)}. Avg P&L per contract: spread $${f(sb.avgPnl, 0)}, CSP $${f(cb.avgPnl, 0)}.`);
    const q = [...baseEp.map(r => r.creditPctWidth)].sort((a, b) => a - b);
    const at = p => f(q[Math.min(q.length - 1, Math.floor(q.length * p))] * 100, 0);
    console.log(`Credit as % of width (5%-of-spot wing): p10 ${at(0.1)} · p25 ${at(0.25)} · median ${at(0.5)} · p75 ${at(0.75)} · p90 ${at(0.9)} `
      + `— a "credit ≥ X% of width" gate should be set against this distribution, not guessed.`);
  }
  // IV rank sanity: iv_history splices IVolatility (to 2026-05-29) and E*Trade (from 2026-06-01) with no
  // overlap and ~1.3x the range after the join (CLAUDE.md), so a rank against a window spanning the
  // splice is not a measurement. Say so when the ranks bunch.
  const ranks = episodes.map(e => e.ivRank).filter(x => x != null);
  const buckets = { '<30': 0, '30–50': 0, '50–80': 0, '≥80': 0 };
  for (const r of ranks) buckets[r < 30 ? '<30' : r < 50 ? '30–50' : r < 80 ? '50–80' : '≥80']++;
  console.log(`IV rank at entry (episodes with a rank, ${ranks.length}): ${Object.entries(buckets).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (ranks.length && Math.max(...Object.values(buckets)) / ranks.length >= 0.9) {
    console.log('WARNING: ≥90% of entries fall in one IV-rank bucket — likely the iv_history source splice, not the market. '
      + 'The IV-rank split in §5 is not interpretable on this sample.');
  }

  console.log('\n## 2. Exit grid (30d Δ0.25 skew3)\n');
  console.log(HEAD); console.log(SEP);
  for (const pt of [0.5, 0.75, null]) for (const sl of [1, 2, null]) for (const ts of [10, 15, null]) {
    const cfg = { ...BASE, pt, sl, ts };
    console.log(line(cfgLabel(cfg), runAll(episodes, cfg)));
  }

  console.log('\n## 3. Skew sensitivity (draft exits) — if the answer flips across this range, it cannot be trusted until real wing quotes exist\n');
  console.log(HEAD); console.log(SEP);
  for (const skew of [0, 3, 6]) { const cfg = { ...BASE, skew }; console.log(line(cfgLabel(cfg), runAll(episodes, cfg))); }

  console.log('\n## 4. Entry DTE × short delta (draft exits, skew3)\n');
  console.log(HEAD); console.log(SEP);
  for (const dte of [21, 30, 35]) for (const delta of [0.2, 0.25, 0.3]) {
    const cfg = { ...BASE, dte, delta };
    console.log(line(cfgLabel(cfg), runAll(episodes, cfg)));
  }

  console.log('\n## 5. Candidate gates, draft profile (episodes) — observational splits, not A/Bs\n');
  console.log(HEAD); console.log(SEP);
  const by = (label, pred) => console.log(line(label, baseEp.filter(pred)));
  by('credit ≥ 30% of width', r => r.creditPctWidth >= 0.30);
  by('credit < 30% of width', r => r.creditPctWidth < 0.30);
  by('IV rank ≥ 30', r => r.e.ivRank != null && r.e.ivRank >= 30);
  by('IV rank < 30', r => r.e.ivRank != null && r.e.ivRank < 30);
  by('IV rank unknown', r => r.e.ivRank == null);
  by('close above SMA50', r => r.e.aboveSma50 === true);
  by('close below SMA50', r => r.e.aboveSma50 === false);

  console.log('\n## 6. By entry quarter, draft profile (episodes) — does it hold outside one stretch?\n');
  console.log(HEAD); console.log(SEP);
  const quarters = [...new Set(baseEp.map(r => `${r.e.date.slice(0, 4)}-Q${Math.floor((Number(r.e.date.slice(5, 7)) - 1) / 3) + 1}`))].sort();
  for (const q of quarters) {
    by(q, r => `${r.e.date.slice(0, 4)}-Q${Math.floor((Number(r.e.date.slice(5, 7)) - 1) / 3) + 1}` === q);
  }
  console.log('\n39 configurations were compared in §2–4; expect the best of them to look better than it is. '
    + 'Prefer a setting that is good across neighbours over the single top row.');
}

main();
