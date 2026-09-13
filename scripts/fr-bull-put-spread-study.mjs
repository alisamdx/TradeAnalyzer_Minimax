// Bull put credit spread vs cash-secured put — the operator's profile, on the wheel replay (TODO #43).
//
// QUESTION. The wheel is slow and ties up capital. Does a bull put credit spread on the SAME entries earn
// more per dollar of capital — and which entry/exit settings survive realistic costs? Operator decisions
// 2026-09-12: credit spread (premium, not direction), 5–15 day hold, risk as fixed dollars, a brief mode
// alongside wheel.
//
// WHAT WAS ALREADY KNOWN. v1.1.54 (`scripts/fr-wheel-spread-study.mjs`) validated wheel picks as a
// budget-sized put credit spread with no costs, no skew, no time stop and no CSP comparison. Runs of this
// script on 2026-09-13 (471 episodes, 2025-06…2026-08) found: the spread beats the CSP per capital, but
// slippage of $0.05/leg/fill cuts its mean return from +6.3% to +1.5%, reverses the exit finding (fewer
// paid closes win) and favours bigger credits. NewApp/TODO.md #43 has the numbers.
//
// METHOD (per replay entry, per configuration):
//   short put at the target delta, long put `wing` × spot lower (rounded to the strike increment)
//   Black-Scholes at iv_history ATM IV plus a STICKY-MONEYNESS SKEW of `skew` vol points per 10% OTM — a
//   sensitivity, not a measurement, until spread_chain_capture (v1.1.243) holds real wing quotes
//   marked daily on closes; exits: profit target (fraction of credit), loss stop (multiple of credit),
//   time stop (calendar days held), else settled at intrinsic on expiry (no closing cost at expiry)
//   slippage per leg per fill, either flat (`--slip`) or per ticker from real quotes (`--slip-model quoted`)
//   the CSP is the same short put with the same exits, capital = strike − premium
//
// PORTFOLIO SIMULATION (§7). Per-trade return ignores the only real advantage of a short hold — recycling
// capital — and both per-trade summaries mislead (equal-weighted per-day favours 1-day exits; dollar-
// weighted swings on one expensive name). §7 runs a fixed pot through every replay day in pick-rank order:
// spreads sized by a fixed max-loss budget (`--risk`), CSPs by a fixed cash allocation (`--csp-alloc`),
// one position per ticker, `--max-positions` cap, capital reserved until exit. Reports final equity,
// annualised return, realised max drawdown, utilisation and why picks were skipped.
//
// DE-BIASING (CLAUDE.md quirks):
//   episodes — entries of one ticker within 14 days of a kept entry are collapsed in §1–6
//   discontinuities — a >35% daily step is classified, not blanket-excluded: SPLIT (price ratio within
//              3% of a split ratio AND step-day dollar volume ≤ 2.5× its prior median — a split leaves
//              dollar volume unchanged) or TICKER REUSE (20-day median dollar volume shifts ≥ 15×) are
//              excluded; anything else is a GENUINE MOVE and is KEPT. The first version excluded every
//              >35% step and so dropped SNPS's −36% earnings crash — the exact tail a put spread must eat.
//   settled only — an entry is used only if bars reach its longest possible expiry
//   paired — spread and CSP are always compared on the identical entry set
//
// LIMITS. One replay sample. Closes only — an intraday stop fires late. Quoted slippage uses each ticker's
// median quoted half-spread across ALL stored dates (not point-in-time) and the short leg's spread for
// both legs. IV rank uses iv_history, which splices two sources with zero overlap. FR-SEY-5: this shapes
// criteria; it cannot by itself enable a live gate.
//
// RUN from a normal terminal (NOT from inside a packaged app's shell):
//   npm run rebuild:node
//   node scripts/fr-bull-put-spread-study.mjs --out bull-put-spread-study.md
//       [--slip 0.05] [--slip-model quoted] [--capital 25000] [--risk 500] [--csp-alloc 0.25]
//       [--max-positions 10] [--strategy wheel]
//   node scripts/fr-bull-put-spread-study.mjs --selftest   (no database)

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const SELFTEST = argv.includes('--selftest');
const STRATEGY = argOf('--strategy', 'wheel');
const SLIP = Number(argOf('--slip', '0'));                 // $/share per leg per fill (flat, and the quoted fallback)
const SLIP_MODEL = argOf('--slip-model', 'flat');          // 'flat' | 'quoted'
const CAPITAL = Number(argOf('--capital', '25000'));
const RISK = Number(argOf('--risk', '500'));               // max loss per spread position, $
const CSP_ALLOC = Number(argOf('--csp-alloc', '0.25'));    // cash per CSP position, fraction of the pot
const MAX_POSITIONS = Number(argOf('--max-positions', '10'));
// Same convention as src/main/services/options-fill.ts: a fill sits halfway between mid and the far side.
const SLIP_FRACTION = 0.5;
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
const ivAt = (K, S, atm, skewPts) => Math.max(0.05, atm + (skewPts / 100) * ((1 - K / S) / 0.10));
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
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

// ── discontinuity classifier ──────────────────────────────────────────────────────────────────
// 1.5 is listed for reverse 2:3 (+50%) only: a forward 3:2 split is a −33% step, inside JUMP_LIMIT, so it
// never reaches this test — split-repair.ts is the defence for that one, and here it simply stays in.
const SPLIT_RATIOS = [1.5, 2, 3, 4, 5, 8, 10, 20];
/**
 * Classify the close-to-close step INTO bars[i]. null = not a >35% step; 'split' / 'reuse' = a data
 * artefact to exclude; 'move' = a genuine repricing to keep. bars need { close, volume }.
 */
function classifyStep(bars, i) {
  const ratio = bars[i].close / bars[i - 1].close;
  if (Math.abs(ratio - 1) <= JUMP_LIMIT) return null;
  const dv = b => (b.volume > 0 && b.close > 0 ? b.close * b.volume : null);
  const before = median(bars.slice(Math.max(0, i - 20), i).map(dv).filter(x => x != null));
  const after = median(bars.slice(i + 1, i + 21).map(dv).filter(x => x != null));
  if (before && after && (after / before >= 15 || after / before <= 1 / 15)) return 'reuse';
  const nearSplit = SPLIT_RATIOS.some(r => Math.abs(ratio * r - 1) <= 0.03 || Math.abs(ratio / r - 1) <= 0.03);
  const dayDv = dv(bars[i]);
  if (nearSplit && (before == null || dayDv == null || dayDv / before <= 2.5)) return 'split';
  return 'move';
}

// ── the simulator ─────────────────────────────────────────────────────────────────────────────
/**
 * entry: { date, bars:[{date,close}] ascending, ei (index of the entry bar), sig0, ivAsOf(date), slip? }
 * cfg:   { dte, delta, wing, skew, pt|null, sl|null, ts|null }
 * → { spread:{pnl,cap,days,exit}, csp:{…}, creditPctWidth, … } per contract, or null
 */
function simulate(entry, cfg) {
  const { bars, ei, sig0 } = entry;
  const slip = entry.slip ?? SLIP;
  const S0 = bars[ei].close, T0 = cfg.dte / 365;
  const shortK = strikeForDelta(S0, T0, sig0, cfg.delta, cfg.skew);
  if (shortK == null) return null;
  const inc = strikeInc(S0);
  const width = Math.max(inc, Math.round(((cfg.wing ?? 0.05) * S0) / inc) * inc);
  const longK = roundC(shortK - width);
  if (longK <= 0) return null;

  const pS0 = putAt(S0, shortK, T0, sig0, cfg.skew), pL0 = putAt(S0, longK, T0, sig0, cfg.skew);
  const credit = pS0 - pL0 - 2 * slip, premium = pS0 - slip;
  if (credit < 0.05 || premium < 0.05) return null;
  const expiry = addDays(entry.date, cfg.dte);

  const sides = {
    spread: {
      open: credit, cap: (width - credit) * 100,
      close: (S, T, atm) => putAt(S, shortK, T, atm, cfg.skew) - putAt(S, longK, T, atm, cfg.skew) + 2 * slip,
      intrinsic: S => Math.max(0, shortK - S) - Math.max(0, longK - S),
    },
    csp: {
      open: premium, cap: (shortK - premium) * 100,
      close: (S, T, atm) => putAt(S, shortK, T, atm, cfg.skew) + slip,
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

// ── portfolio simulation ──────────────────────────────────────────────────────────────────────
/**
 * rows: [{ e:{date,ticker,rank}, spread:{pnl,cap,days}, csp:{…} }] — per-contract results.
 * One pot, every replay day in rank order, capital reserved until exit, P&L realised at exit.
 */
function simulatePortfolio(rows, side, o) {
  const byDate = new Map();
  for (const r of rows) {
    if (!r[side]) continue;
    (byDate.get(r.e.date) ?? byDate.set(r.e.date, []).get(r.e.date)).push(r);
  }
  for (const list of byDate.values()) list.sort((a, b) => (a.e.rank ?? 0) - (b.e.rank ?? 0));
  const dates = [...byDate.keys()].sort();
  const res = { final: o.capital, retPct: 0, annPct: null, maxDd: 0, maxDdPct: 0, taken: 0, util: 0,
    skipped: { size: 0, capital: 0, dup: 0, full: 0 } };
  if (dates.length === 0) return res;

  let cash = o.capital, equity = o.capital, peak = o.capital, deployedDays = 0, dayCount = 0;
  const open = [];
  const lastExit = rows.reduce((m, r) => (r[side] ? (addDays(r.e.date, Math.max(1, r[side].days)) > m ? addDays(r.e.date, Math.max(1, r[side].days)) : m) : m), dates[0]);
  for (let d = dates[0]; d <= lastExit; d = addDays(d, 1)) {
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].exitDate > d) continue;
      cash += open[k].reserve + open[k].pnl;
      equity += open[k].pnl;
      open.splice(k, 1);
      peak = Math.max(peak, equity);
      const dd = peak - equity;
      if (dd > res.maxDd) { res.maxDd = dd; res.maxDdPct = (dd / peak) * 100; }
    }
    for (const r of byDate.get(d) ?? []) {
      const t = r[side];
      if (open.length >= o.maxPositions) { res.skipped.full++; continue; }
      if (open.some(p => p.ticker === r.e.ticker)) { res.skipped.dup++; continue; }
      if (!(t.cap > 0)) { res.skipped.size++; continue; }
      const budget = side === 'spread' ? o.risk : o.capital * o.cspAlloc;
      const wanted = Math.floor(budget / t.cap);
      if (wanted < 1) { res.skipped.size++; continue; }
      const n = Math.min(wanted, Math.floor(cash / t.cap));
      if (n < 1) { res.skipped.capital++; continue; }
      const reserve = n * t.cap;
      cash -= reserve;
      open.push({ ticker: r.e.ticker, exitDate: addDays(d, Math.max(1, t.days)), reserve, pnl: n * t.pnl });
      res.taken++;
    }
    deployedDays += open.reduce((s, p) => s + p.reserve, 0);
    dayCount++;
  }
  res.final = equity;
  res.retPct = (equity / o.capital - 1) * 100;
  const span = daysBetween(dates[0], lastExit);
  res.annPct = equity > 0 && span > 0 ? ((equity / o.capital) ** (365 / span) - 1) * 100 : null;
  res.util = dayCount ? (deployedDays / dayCount / o.capital) * 100 : 0;
  return res;
}

// ── statistics ────────────────────────────────────────────────────────────────────────────────
function stats(rows, side) {
  const r = rows.map(x => x[side]);
  const n = r.length;
  if (n === 0) return null;
  const rets = r.map(x => (x.pnl / x.cap) * 100).sort((a, b) => a - b);
  const sumPnl = r.reduce((s, x) => s + x.pnl, 0);
  const sumCapDays = r.reduce((s, x) => s + x.cap * Math.max(1, x.days), 0);
  const meanRet = rets.reduce((s, x) => s + x, 0) / n;
  const meanDays = r.reduce((s, x) => s + x.days, 0) / n;
  return {
    n,
    win: (r.filter(x => x.pnl > 0).length / n) * 100,
    mean: meanRet,
    median: rets[Math.floor(n / 2)],
    p5: rets[Math.floor(n * 0.05)],
    worst: Math.min(...r.map(x => x.pnl)),
    avgPnl: sumPnl / n,
    days: meanDays,
    // Mean return ÷ mean days held — neither the equal-weighted per-trade ratio (favours 1-day exits)
    // nor dollar-weighted (swings on one expensive name).
    perDay: meanDays > 0 ? meanRet / meanDays : null,
    capEff: (sumPnl / sumCapDays) * 365 * 100,
    exits: r.reduce((acc, x) => { acc[x.exit] = (acc[x.exit] ?? 0) + 1; return acc; }, {}),
  };
}
const f = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
const money = x => (x == null || !Number.isFinite(x) ? '—' : `$${Math.round(x).toLocaleString('en-US')}`);
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

const HEAD = '| config | n | SPREAD win% | mean ret% | median | %/day | days | exits | CSP win% | mean ret% | median | %/day | days |';
const SEP = '|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|';
function line(label, rows) {
  const s = stats(rows, 'spread'), c = stats(rows, 'csp');
  if (!s) return `| ${label} | 0 | | | | | | | | | | | |`;
  return `| ${label} | ${s.n} | ${f(s.win)} | ${f(s.mean, 2)} | ${f(s.median, 2)} | **${f(s.perDay, 3)}** | ${f(s.days)} | ${exitMix(s)} | ${f(c.win)} | ${f(c.mean, 2)} | ${f(c.median, 2)} | **${f(c.perDay, 3)}** | ${f(c.days)} |`;
}
const cfgLabel = c => `${c.dte}d Δ${c.delta} w${f((c.wing ?? 0.05) * 100, 1)}% skew${c.skew} pt${c.pt ?? '–'} sl${c.sl ?? '–'} ts${c.ts ?? '–'}`;

// ── self-test (no database) ───────────────────────────────────────────────────────────────────
function syntheticEntry(pathFn, iv = 0.35) {
  const start = '2025-01-01', bars = [];
  for (let i = 0; i < 60; i++) bars.push({ date: addDays(start, i), close: 100, volume: 1e6 });
  const ei = 59;
  for (let i = 1; i <= MAX_DTE + 10; i++) bars.push({ date: addDays(bars[ei].date, i), close: pathFn(i), volume: 1e6 });
  return { ticker: 'SYN', date: bars[ei].date, bars, ei, sig0: iv, ivAsOf: () => iv };
}
function stepBars(ratio, dayVolMult, afterVolMult) {
  const bars = [];
  for (let i = 0; i < 25; i++) bars.push({ close: 100, volume: 1e6 });
  bars.push({ close: 100 * ratio, volume: 1e6 * dayVolMult });
  for (let i = 0; i < 25; i++) bars.push({ close: 100 * ratio, volume: 1e6 * afterVolMult });
  return bars;
}
function selftest() {
  const fails = [];
  const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fails.push(name); };
  const base = { dte: 30, delta: 0.25, wing: 0.05, skew: 0, pt: null, sl: null, ts: null };

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

  const wide = simulate(syntheticEntry(() => 100), { ...base, wing: 0.10 });
  check('a 10% wing is wider and collects more credit than a 5% wing',
    wide && flat && wide.width > flat.width && wide.spread.pnl > flat.spread.pnl);

  const slipped = simulate({ ...syntheticEntry(() => 100), slip: 0.05 }, base);
  check('per-entry slippage lowers the spread credit by two legs', slipped && flat
    && Math.abs((flat.spread.pnl - slipped.spread.pnl) - 0.05 * 2 * 100) < 1e-6);

  check('2:1 split with flat dollar volume → split', classifyStep(stepBars(0.5, 2, 2), 25) === 'split');
  check('−36% earnings crash on 8× volume → genuine move (kept)', classifyStep(stepBars(0.64, 8, 2), 25) === 'move');
  check('−50% (a 2:1 split ratio) on a 5× dollar-volume spike → genuine move', classifyStep(stepBars(0.5, 10, 2), 25) === 'move');
  check('dollar volume shifts 50× → ticker reuse', classifyStep(stepBars(3, 1, 50), 25) === 'reuse');
  check('a 10% day is not a step at all', classifyStep(stepBars(0.9, 3, 1), 25) === null);

  const mk = (date, ticker, rank, cap, pnl, days) => ({ e: { date, ticker, rank }, spread: { cap, pnl, days }, csp: { cap: cap * 10, pnl, days } });
  const port = simulatePortfolio([
    mk('2025-01-01', 'AAA', 1, 400, 100, 10),
    mk('2025-01-01', 'BBB', 2, 400, -50, 5),
    mk('2025-01-02', 'CCC', 1, 400, 20, 5),   // only $200 cash left → skipped for capital
    mk('2025-01-03', 'AAA', 1, 400, 20, 5),   // AAA already open → skipped as duplicate
    mk('2025-01-08', 'CCC', 1, 400, 30, 5),   // BBB closed on 01-06 → cash back
  ], 'spread', { capital: 1000, risk: 500, cspAlloc: 0.25, maxPositions: 10 });
  check('portfolio: sizes by max-loss budget, reserves capital, skips duplicates and unaffordable picks',
    port.taken === 3 && port.skipped.capital === 1 && port.skipped.dup === 1 && Math.abs(port.final - 1080) < 1e-6);
  check('portfolio: drawdown is measured on realised equity', Math.abs(port.maxDd - 50) < 1e-6);
  const cspPort = simulatePortfolio([mk('2025-01-01', 'AAA', 1, 400, 100, 10)], 'csp', { capital: 1000, risk: 500, cspAlloc: 0.25, maxPositions: 10 });
  check('portfolio: a CSP needing more cash than its allocation is skipped for size', cspPort.taken === 0 && cspPort.skipped.size === 1);

  console.log(fails.length ? `\n${fails.length} FAILED` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
}

// ── loading ───────────────────────────────────────────────────────────────────────────────────
/** Per-ticker slippage = SLIP_FRACTION × median quoted half-spread, from every stored quote. */
function loadQuotedSlip(db) {
  const halves = new Map();
  const push = (t, bid, ask) => {
    if (!(bid > 0) || !(ask >= bid)) return;
    if (!halves.has(t)) halves.set(t, []);
    halves.get(t).push((ask - bid) / 2);
  };
  const sources = { premiumHistory: 0, spreadChains: 0 };
  try {
    for (const r of db.prepare('SELECT ticker, bid, ask FROM options_premium_history WHERE bid > 0 AND ask > 0').all()) {
      push(r.ticker, r.bid, r.ask); sources.premiumHistory++;
    }
  } catch { sources.premiumHistory = 'unavailable'; }
  try {
    for (const r of db.prepare('SELECT ticker, puts_json FROM spread_chain_capture').all()) {
      let puts = [];
      try { puts = JSON.parse(r.puts_json); } catch { continue; }
      for (const p of puts) {
        if (p[3] == null || Math.abs(p[3]) < 0.1 || Math.abs(p[3]) > 0.4) continue;
        push(r.ticker, p[1], p[2]); sources.spreadChains++;
      }
    }
  } catch { sources.spreadChains = 'unavailable (table not created yet)'; }
  const perTicker = new Map();
  for (const [t, a] of halves) if (a.length >= 3) perTicker.set(t, SLIP_FRACTION * median(a));
  return { perTicker, sources };
}

function loadEntries(db, quoted) {
  const picks = db.prepare(
    `SELECT ro.ticker AS ticker, rb.as_of_date AS date, MIN(ro.rank) AS rank
       FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id = ro.replay_brief_id
      WHERE rb.strategy = ? GROUP BY ro.ticker, rb.as_of_date ORDER BY ro.ticker, rb.as_of_date`,
  ).all(STRATEGY);
  const maxPx = db.prepare('SELECT MAX(date) d FROM historical_prices').get().d;
  const barsStmt = db.prepare(
    'SELECT date, close, volume FROM historical_prices WHERE ticker = ? AND date >= ? AND date <= ? AND close > 0 ORDER BY date');
  const ivStmt = db.prepare('SELECT date, atm_iv FROM iv_history WHERE ticker = ? AND atm_iv > 0 ORDER BY date');
  const ivCache = new Map();
  const counts = { picks: picks.length, unsettled: 0, noBars: 0, split: 0, reuse: 0, ivFallback: 0, collapsed: 0, quotedSlip: 0 };
  const excluded = [], movesKept = new Set();
  const pooled = [];

  for (const p of picks) {
    if (addDays(p.date, MAX_DTE + 3) > maxPx) { counts.unsettled++; continue; }
    // 20 bars past the window so the reuse test can see the volume regime after a late step.
    const bars = barsStmt.all(p.ticker, addDays(p.date, -90), addDays(p.date, MAX_DTE + 40));
    const ei = bars.findIndex(b => b.date >= p.date);
    if (ei < 1 || daysBetween(p.date, bars[ei].date) > 4 || bars[bars.length - 1].date < addDays(p.date, MAX_DTE)) {
      counts.noBars++; continue;
    }
    const lastUsed = addDays(p.date, MAX_DTE + 10);
    let artefact = null;
    for (let i = 1; i < bars.length && bars[i].date <= lastUsed; i++) {
      const kind = classifyStep(bars, i);
      if (kind === 'split' || kind === 'reuse') { artefact = { kind, date: bars[i].date, ch: bars[i].close / bars[i - 1].close - 1 }; break; }
      if (kind === 'move') movesKept.add(`${p.ticker} ${bars[i].date} (${f((bars[i].close / bars[i - 1].close - 1) * 100, 0)}%)`);
    }
    if (artefact) {
      counts[artefact.kind]++;
      excluded.push(`${p.ticker} ${p.date} (${artefact.kind}, ${f(artefact.ch * 100, 0)}% on ${artefact.date})`);
      continue;
    }
    const simBars = bars.filter(b => b.date <= lastUsed);

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
    const entryDate = simBars[ei].date;
    let sig0 = ivAsOf(entryDate);
    if (sig0 == null) {
      counts.ivFallback++;
      const closes = simBars.slice(Math.max(0, ei - 20), ei + 1).map(b => b.close), lr = [];
      for (let i = 1; i < closes.length; i++) lr.push(Math.log(closes[i] / closes[i - 1]));
      const m = lr.reduce((s, x) => s + x, 0) / (lr.length || 1);
      sig0 = lr.length > 2 ? Math.max(0.05, Math.sqrt(lr.reduce((s, x) => s + (x - m) ** 2, 0) / (lr.length - 1) * 252)) : 0.30;
    }
    const yearAgo = addDays(entryDate, -365);
    const window = ivRows.filter(r => r.date >= yearAgo && r.date <= entryDate).map(r => r.iv);
    const ivRank = window.length >= 120
      ? ((sig0 - Math.min(...window)) / ((Math.max(...window) - Math.min(...window)) || 1)) * 100 : null;
    const sma50 = ei >= 49 ? simBars.slice(ei - 49, ei + 1).reduce((s, b) => s + b.close, 0) / 50 : null;
    let slip;
    if (quoted) {
      const q = quoted.perTicker.get(p.ticker);
      if (q != null) { slip = q; counts.quotedSlip++; } else slip = SLIP;
    }
    pooled.push({
      ticker: p.ticker, date: entryDate, rank: p.rank, bars: simBars, ei, sig0, ivAsOf, ivRank, slip,
      aboveSma50: sma50 == null ? null : simBars[ei].close > sma50,
    });
  }

  const episodes = [], lastKept = new Map();
  for (const e of pooled) {
    const prev = lastKept.get(e.ticker);
    if (prev && daysBetween(prev, e.date) < EPISODE_GAP_DAYS) { counts.collapsed++; continue; }
    lastKept.set(e.ticker, e.date);
    episodes.push(e);
  }
  return { pooled, episodes, counts, excluded, movesKept: [...movesKept], maxPx };
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────
async function main() {
  if (SELFTEST) return selftest();

  // --out writes UTF-8 directly (a PowerShell 5.1 `>` redirect writes UTF-16).
  const OUT = argOf('--out', null);
  const captured = [];
  if (OUT) {
    const log = console.log.bind(console);
    console.log = (...a) => { captured.push(a.join(' ')); log(...a); };
    process.on('exit', () => { try { writeFileSync(OUT, `${captured.join('\n')}\n`, 'utf8'); } catch { /* best effort */ } });
  }
  if (SLIP_MODEL !== 'flat' && SLIP_MODEL !== 'quoted') { console.error('--slip-model must be flat or quoted'); process.exit(1); }

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

  const quoted = SLIP_MODEL === 'quoted' ? loadQuotedSlip(db) : null;
  const { pooled, episodes, counts, excluded, movesKept, maxPx } = loadEntries(db, quoted);
  db.close();

  const slipText = quoted ? `slip: quoted per ticker (${SLIP_FRACTION} × median half-spread), fallback $${SLIP}/leg` : `slip $${SLIP}/leg`;
  console.log(`# Bull put spread vs CSP — ${STRATEGY} replay entries (prices to ${maxPx}, ${slipText})\n`);
  console.log(`Replay picks ${counts.picks} → unsettled ${counts.unsettled}, no bars ${counts.noBars}, `
    + `excluded as split ${counts.split} / ticker reuse ${counts.reuse}, usable ${pooled.length} → **${episodes.length} episodes** `
    + `(${counts.collapsed} repeat entries collapsed). IV from rolling vol (no iv_history): ${counts.ivFallback}.`);
  const dates = episodes.map(e => e.date).sort();
  if (dates.length) console.log(`Entry dates ${dates[0]} … ${dates[dates.length - 1]}.`);
  if (excluded.length) console.log(`\nExcluded as data artefacts: ${excluded.slice(0, 20).join('; ')}${excluded.length > 20 ? ` … +${excluded.length - 20}` : ''}`);
  if (movesKept.length) console.log(`\nGenuine >35% moves KEPT in the sample (${movesKept.length}): ${movesKept.slice(0, 20).join('; ')}${movesKept.length > 20 ? ' …' : ''}`);
  if (quoted) {
    const slips = [...quoted.perTicker.values()].sort((a, b) => a - b);
    const at = q => f(slips[Math.min(slips.length - 1, Math.floor(slips.length * q))], 3);
    console.log(`\nQuoted slippage: ${quoted.perTicker.size} tickers with ≥3 quotes (options_premium_history rows ${quoted.sources.premiumHistory}, `
      + `spread_chain_capture legs ${quoted.sources.spreadChains}). Per leg: p10 $${at(0.1)} · median $${at(0.5)} · p90 $${at(0.9)}. `
      + `Entries priced from quotes: ${counts.quotedSlip} of ${pooled.length}; the rest use the $${SLIP} fallback.`);
  }
  console.log('\nret% = P&L ÷ capital (spread: max loss; CSP: strike − premium). %/day = mean ret% ÷ mean days held. '
    + 'exits (spread): T=profit target S=loss stop H=time stop E=expiry, % of trades. Per contract, per trade — §7 is the capital answer.\n');

  const BASE = { dte: 30, delta: 0.25, wing: 0.05, skew: 3, pt: 0.5, sl: 2, ts: 15 };

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
    console.log(`Credit as % of width (5%-of-spot wing): p10 ${at(0.1)} · p25 ${at(0.25)} · median ${at(0.5)} · p75 ${at(0.75)} · p90 ${at(0.9)}.`);
  }
  const ranks = episodes.map(e => e.ivRank).filter(x => x != null);
  const buckets = { '<30': 0, '30–50': 0, '50–80': 0, '≥80': 0 };
  for (const r of ranks) buckets[r < 30 ? '<30' : r < 50 ? '30–50' : r < 80 ? '50–80' : '≥80']++;
  console.log(`IV rank at entry (episodes with a rank, ${ranks.length}): ${Object.entries(buckets).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (ranks.length && Math.max(...Object.values(buckets)) / ranks.length >= 0.9) {
    console.log('WARNING: ≥90% of entries fall in one IV-rank bucket — likely the iv_history source splice, not the market.');
  }

  console.log('\n## 2. Exit grid (30d Δ0.25 w5% skew3)\n');
  console.log(HEAD); console.log(SEP);
  for (const pt of [0.5, 0.75, null]) for (const sl of [1, 2, null]) for (const ts of [10, 15, null]) {
    const cfg = { ...BASE, pt, sl, ts };
    console.log(line(cfgLabel(cfg), runAll(episodes, cfg)));
  }

  console.log('\n## 3. Skew sensitivity (draft exits) — if the answer flips across this range, it cannot be trusted until real wing quotes exist\n');
  console.log(HEAD); console.log(SEP);
  for (const skew of [0, 3, 6]) { const cfg = { ...BASE, skew }; console.log(line(cfgLabel(cfg), runAll(episodes, cfg))); }

  console.log('\n## 4. Entry DTE × short delta (draft exits, w5%, skew3)\n');
  console.log(HEAD); console.log(SEP);
  for (const dte of [21, 30, 35]) for (const delta of [0.2, 0.25, 0.3]) {
    const cfg = { ...BASE, dte, delta };
    console.log(line(cfgLabel(cfg), runAll(episodes, cfg)));
  }

  const LEAN = { ...BASE, pt: 0.5, sl: null, ts: null };
  console.log('\n## 4b. Wing width × short delta (50% target, no stop, no time stop — the exits costs favoured) — slippage is fixed $, so a larger credit should absorb it better\n');
  console.log(HEAD); console.log(SEP);
  for (const delta of [0.25, 0.3, 0.35]) for (const wing of [0.05, 0.075, 0.10]) {
    const cfg = { ...LEAN, delta, wing };
    console.log(line(cfgLabel(cfg), runAll(episodes, cfg)));
  }

  console.log('\n## 5. Candidate gates, draft profile (episodes) — observational splits, not A/Bs\n');
  console.log(HEAD); console.log(SEP);
  const by = (label, pred) => console.log(line(label, baseEp.filter(pred)));
  by('credit ≥ 20% of width', r => r.creditPctWidth >= 0.20);
  by('credit < 20% of width', r => r.creditPctWidth < 0.20);
  by('IV rank ≥ 30', r => r.e.ivRank != null && r.e.ivRank >= 30);
  by('IV rank < 30', r => r.e.ivRank != null && r.e.ivRank < 30);
  by('IV rank unknown', r => r.e.ivRank == null);
  by('close above SMA50', r => r.e.aboveSma50 === true);
  by('close below SMA50', r => r.e.aboveSma50 === false);
  if (quoted) {
    by('quoted slip ≤ $0.03/leg', r => r.e.slip != null && quoted.perTicker.has(r.e.ticker) && r.e.slip <= 0.03);
    by('quoted slip > $0.03/leg', r => r.e.slip != null && quoted.perTicker.has(r.e.ticker) && r.e.slip > 0.03);
    by('no quotes (fallback slip)', r => !quoted.perTicker.has(r.e.ticker));
  }

  console.log('\n## 6. By entry quarter, draft profile (episodes) — does it hold outside one stretch?\n');
  console.log(HEAD); console.log(SEP);
  const quarter = d => `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
  for (const q of [...new Set(baseEp.map(r => quarter(r.e.date)))].sort()) by(q, r => quarter(r.e.date) === q);

  const opts = { capital: CAPITAL, risk: RISK, cspAlloc: CSP_ALLOC, maxPositions: MAX_POSITIONS };
  console.log(`\n## 7. Portfolio — $${CAPITAL.toLocaleString('en-US')} pot, every replay day in pick-rank order, one position per ticker, ≤ ${MAX_POSITIONS} open`);
  console.log(`Spread sized to ≤ $${RISK} max loss per position; CSP to ≤ ${f(CSP_ALLOC * 100, 0)}% of the pot in cash per position. `
    + 'P&L realised at exit; drawdown on realised equity. Skipped: size = one contract exceeds the per-position budget, '
    + 'capital = no free cash, dup = ticker already open, full = position cap.\n');
  console.log('| config | SPREAD final | return % | ann. % | max DD | trades | util % | skipped size/cap/dup/full | CSP final | return % | ann. % | max DD | trades | util % | skipped size/cap/dup/full |');
  console.log('|---|--:|--:|--:|--:|--:|--:|---|--:|--:|--:|--:|--:|--:|---|');
  const portfolioConfigs = [
    BASE,
    LEAN,
    { ...LEAN, delta: 0.3 },
    { ...LEAN, delta: 0.3, wing: 0.10 },
    { ...LEAN, delta: 0.3, pt: 0.75 },
    { ...LEAN, dte: 21, delta: 0.3 },
    { ...BASE, delta: 0.3, pt: null, sl: null, ts: null },
  ];
  for (const cfg of portfolioConfigs) {
    const rows = runAll(pooled, cfg);
    const s = simulatePortfolio(rows, 'spread', opts), c = simulatePortfolio(rows, 'csp', opts);
    const sk = x => `${x.skipped.size}/${x.skipped.capital}/${x.skipped.dup}/${x.skipped.full}`;
    console.log(`| ${cfgLabel(cfg)} | ${money(s.final)} | **${f(s.retPct)}** | ${f(s.annPct)} | ${money(s.maxDd)} (${f(s.maxDdPct)}%) | ${s.taken} | ${f(s.util, 0)} | ${sk(s)} `
      + `| ${money(c.final)} | **${f(c.retPct)}** | ${f(c.annPct)} | ${money(c.maxDd)} (${f(c.maxDdPct)}%) | ${c.taken} | ${f(c.util, 0)} | ${sk(c)} |`);
  }

  console.log(`\n55 configurations were compared in §2–4b and ${portfolioConfigs.length} in §7; expect the best to look better than it is. `
    + 'Prefer a setting that is good across neighbours over the single top row.');
}

main();
