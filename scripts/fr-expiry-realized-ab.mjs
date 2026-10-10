// FR-SEY-5 validation — EXPIRY SELECTION: should selectExpiration prefer the nearest
// MONTHLY (3rd Friday) over the ~30-DTE weekly it lands on today?
//
// Background (NEW_FRONTIER §12): selectExpiration (strategy-lab-service.ts) takes the
// expiration in [20,50] DTE closest to 30 with NO liquidity awareness, landing on a thin
// WEEKLY ~54% of the time. Monthlies carry far more OI and tighter spreads. Snapping to the
// monthly, however, CHANGES THE DTE (a monthly may sit at 16 or 50 DTE when the weekly sits
// at 30), which changes credit/theta economics. FR-SEY-5 therefore requires the acceptance
// test to be REALIZED NET OUTCOME, not the liquidity improvement.
//
// STAGE 1 — execution friction, measured on REAL stored quotes (no model).
//   Matched design: pair a ticker|slug's MONTHLY-landed observations against its own
//   WEEKLY-landed observations, holding DTE inside a narrow band. Matching on ticker+slug
//   removes the composition confound (which names carry weeklies at all) and the DTE band
//   removes the tenor confound. A naive pooled weekly-vs-monthly split INVERTS the result —
//   monthly-landed rows are dominated by no-weekly names at off-30 DTE — so the matched
//   design is load-bearing, not cosmetic.
//   Friction convention mirrors the app's own fill model (options-fill.ts,
//   SLIPPAGE_FRACTION = 0.5): per-leg cost = 0.5 x (ask-bid)/2, charged on every leg.
//
// STAGE 2 — realized P&L of the DTE shift, simulated over ~12 months.
//   The stored-brief sample only spans 24 settled entry dates in one regime, and holds no
//   chain for the counterfactual monthly, so the tenor question cannot be answered from it.
//   Stage 2 instead replicates BacktestEngine.simulateSingleSpread (same replica the
//   budget-width / wheel / iron-condor FR-SEY studies used): entry priced by Black-Scholes
//   off iv_history ATM IV, exits at 50% profit target / 200% stop, otherwise settled at real
//   expiry intrinsic from historical_prices. Both arms are priced by the SAME model on the
//   SAME (ticker, entry date) panel, so the model bias cancels and the delta is pure tenor.
//   Friction from Stage 1 is then applied per arm.
//
// Usage: node scripts/fr-expiry-realized-ab.mjs [budget=500]
import { latestPriceDate, loadBriefHistory, loadPriceSeries } from './lib/app-api.mjs';
import { etDate } from './lib/et-time.mjs';

// Reads through the running app's API (scripts/lib/app-api.mjs), never the SQLite file.
const { briefs: BRIEFS } = await loadBriefHistory();

const BUDGET = Number(process.argv[2] ?? 500);   // per-trade risk budget $ (5% of $10k)
const MAX_WIDTH_PTS = 25;                        // mirror findBudgetWidthHedge maxWidth default
const R = 0.02;                                  // same risk-free as the sibling FR-SEY studies
const PT_PCT = 50, STOP_PCT = 200;               // engine exit policy
const DTE_LO = 27, DTE_HI = 33;                  // Stage-1 matched band
const ENGINE_SLUGS = new Set(['short-put-vertical', 'short-call-vertical', 'iron-condor']);

// ── date / calendar helpers (all UTC — see CLAUDE.md weekly-expiration quirk) ────
function thirdFriday(y, m0) {
  const first = new Date(Date.UTC(y, m0, 1));
  const firstFri = 1 + ((5 - first.getUTCDay() + 7) % 7);
  return new Date(Date.UTC(y, m0, firstFri + 14)).toISOString().slice(0, 10);
}
const isMonthly = (iso) => { const [y, m] = iso.split('-').map(Number); return thirdFriday(y, m - 1) === iso; };
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86_400_000;

/** Every Friday in (from, from+horizon] — the weekly grid a liquid optionable name carries. */
function fridaysAfter(from, horizon = 80) {
  const out = [];
  for (let i = 1; i <= horizon; i++) {
    const d = addDays(from, i);
    if (new Date(d + 'T00:00:00Z').getUTCDay() === 5) out.push(d);
  }
  return out;
}
/** Monthlies (3rd Friday) in (from, from+horizon]. */
function monthliesAfter(from, horizon = 80) {
  const [y, m] = from.split('-').map(Number);
  const out = [];
  for (let k = 0; k <= 4; k++) {
    const mi = (m - 1) + k, yy = y + Math.floor(mi / 12), mm = ((mi % 12) + 12) % 12;
    const tf = thirdFriday(yy, mm);
    const dte = daysBetween(from, tf);
    if (dte >= 1 && dte <= horizon) out.push(tf);
  }
  return out;
}

// ── the policies under test ─────────────────────────────────────────────────────
/** TODAY: [20,50] DTE closest to 30; fallback nearest >= 14. Verbatim selectExpiration. */
function selectCurrent(from, expirations) {
  const withDte = expirations.map((e) => ({ expiration: e, dte: Math.round(daysBetween(from, e)) }));
  const inBand = withDte.filter(({ dte }) => dte >= 20 && dte <= 50)
    .sort((a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30));
  if (inBand[0]) return inBand[0];
  const fb = withDte.filter(({ dte }) => dte >= 14).sort((a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30));
  return fb[0] ?? null;
}
/** PROPOSED: nearest monthly whose DTE falls in [lo,hi]; else fall back to today's rule. */
function selectMonthlyPreferring(from, expirations, lo, hi) {
  const monthlies = expirations
    .filter(isMonthly)
    .map((e) => ({ expiration: e, dte: Math.round(daysBetween(from, e)) }))
    .filter(({ dte }) => dte >= lo && dte <= hi)
    .sort((a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30));
  return monthlies[0] ?? selectCurrent(from, expirations);
}

// ── Black-Scholes (same closed forms as the sibling studies) ────────────────────
function cdfNorm(x) { const s = x < 0 ? -1 : 1; const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429]; const p = 0.3275911, ax = Math.abs(x) / Math.SQRT2, t = 1 / (1 + p * ax); const poly = ((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t; return 0.5 * (1 + s * (1 - poly * Math.exp(-ax * ax))); }
function bsPrice(S, K, T, r, sig, side) { if (T <= 0 || sig <= 0) return Math.max(0, side === 'call' ? S - K : K - S); const d1 = (Math.log(S / K) + (r + 0.5 * sig * sig) * T) / (sig * Math.sqrt(T)), d2 = d1 - sig * Math.sqrt(T); return side === 'call' ? S * cdfNorm(d1) - K * Math.exp(-r * T) * cdfNorm(d2) : K * Math.exp(-r * T) * cdfNorm(-d2) - S * cdfNorm(-d1); }
function bsDelta(S, K, T, r, sig, side) { if (T <= 0 || sig <= 0) return side === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0); const d1 = (Math.log(S / K) + (r + 0.5 * sig * sig) * T) / (sig * Math.sqrt(T)); return side === 'call' ? cdfNorm(d1) : cdfNorm(d1) - 1; }
function findStrikeForDelta(S, T, sig, td, side, r = R) { let best = S, bd = Infinity; for (let i = 0; i <= 160; i++) { const k = Math.round(S * (0.60 + (i / 160) * 0.80) * 2) / 2; const diff = Math.abs(Math.abs(bsDelta(S, k, T, r, sig, side)) - td); if (diff < bd) { bd = diff; best = k; } } return best; }
function rollingVol(closes, w = 20) { const s = closes.slice(-Math.min(w + 1, closes.length)); if (s.length < 3) return 0.30; const r = []; for (let i = 1; i < s.length; i++) r.push(Math.log(s[i] / s[i - 1])); const m = r.reduce((a, b) => a + b, 0) / r.length; return Math.max(0.05, Math.sqrt(r.reduce((q, x) => q + (x - m) ** 2, 0) / (r.length - 1) * 252)); }
const strikeInc = (S) => (S >= 200 ? 5 : S >= 50 ? 2.5 : S >= 25 ? 1 : 0.5);

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));

// ════════════════════════════════════════════════════════════════════════════════
// STAGE 1 — real-quote execution friction, matched ticker|slug, DTE held fixed
// ════════════════════════════════════════════════════════════════════════════════
function stage1() {
  const rows = BRIEFS;
  const seen = new Set();
  const cell = new Map();       // ticker|slug -> { mo:[], wk:[] }
  const gate = { mo: [0, 0], wk: [0, 0] };   // [clears>=8, total]
  const tradeable = { mo: [], wk: [] };      // friction% for gate-clearing engine structures

  for (const row of rows) {
    const dEt = etDate(row.generated_at);
    let picks; try { picks = JSON.parse(row.picks); } catch { continue; }
    for (const p of picks) {
      const scores = p.strategyLabResult?.scores;
      if (!Array.isArray(scores)) continue;
      for (const s of scores) {
        const exp = s.setup?.expiration;
        if (!s.setup || s.setup.unavailableReason || !exp) continue;
        const dte = Math.round(daysBetween(dEt, exp));
        if (dte < DTE_LO || dte > DTE_HI) continue;
        const k0 = `${dEt}|${p.ticker}|${s.slug}|${exp}`;
        if (seen.has(k0)) continue;
        seen.add(k0);
        const arm = isMonthly(exp) ? 'mo' : 'wk';
        if (s.liquidityScore != null) { gate[arm][1]++; if (s.liquidityScore >= 8) gate[arm][0]++; }
        const legs = (s.setup.legs ?? []).filter((l) => l.expiration === exp);
        if (!legs.length) continue;
        const credit = s.setup.netCredit ?? (s.setup.netDebit != null ? -s.setup.netDebit : null);
        if (credit == null || Math.abs(credit) < 5) continue;
        const fric = legs.reduce((sum, l) => { const sp = (l.ask ?? 0) - (l.bid ?? 0); return sum + (sp > 0 ? (sp / 4) * 100 * (l.qty ?? 1) : 0); }, 0);
        const spr = legs.map((l) => (l.bid > 0 ? ((l.ask - l.bid) / ((l.ask + l.bid) / 2)) * 100 : null)).filter((x) => x != null);
        const ois = legs.map((l) => l.openInterest).filter((x) => typeof x === 'number');
        const c = cell.get(`${p.ticker}|${s.slug}`) ?? { mo: [], wk: [] };
        const obs = {
          pct: (fric / Math.abs(credit)) * 100,
          spread: spr.length ? mean(spr) : null,
          oi: ois.length ? mean(ois) : null,
          liq: s.liquidityScore ?? null,
        };
        c[arm].push(obs);
        cell.set(`${p.ticker}|${s.slug}`, c);
        // Population the engine ACTUALLY trades: engine slug + clears the liquidity gate.
        if (ENGINE_SLUGS.has(s.slug) && obs.liq != null && obs.liq >= 8) tradeable[arm].push(obs.pct);
      }
    }
  }

  const pairs = [];
  for (const [k, c] of cell) {
    if (!c.mo.length || !c.wk.length) continue;
    const a = (arr, key) => mean(arr.map((o) => o[key]).filter((x) => x != null));
    pairs.push({
      ticker: k.split('|')[0], slug: k.split('|')[1],
      dPct: a(c.mo, 'pct') - a(c.wk, 'pct'), dSpread: a(c.mo, 'spread') - a(c.wk, 'spread'),
      moPct: a(c.mo, 'pct'), wkPct: a(c.wk, 'pct'), moLiq: a(c.mo, 'liq'), wkLiq: a(c.wk, 'liq'),
      moOi: a(c.mo, 'oi'), wkOi: a(c.wk, 'oi'),
    });
  }

  console.log('═══ STAGE 1 — execution friction on REAL stored quotes ═══');
  console.log(`matched ticker|slug cells observed on BOTH a monthly and a weekly at ${DTE_LO}-${DTE_HI} DTE: ${pairs.length}`);
  console.log(`  ${new Set(pairs.map((p) => p.ticker)).size} tickers, ${new Set(pairs.map((p) => p.slug)).size} structure types`);
  const lv = (k) => f(mean(pairs.map((p) => p[k]).filter((x) => x != null)), 1);
  console.log(`\n  friction (% of credit collected)   monthly ${lv('moPct')}%   weekly ${lv('wkPct')}%`);
  console.log(`  open interest / leg                monthly ${lv('moOi')}      weekly ${lv('wkOi')}`);
  console.log(`  liquidityScore (lab, 0-15)         monthly ${lv('moLiq')}      weekly ${lv('wkLiq')}`);
  const byT = {};
  for (const p of pairs) (byT[p.ticker] ??= []).push(p);
  const tR = Object.entries(byT).map(([t, ps]) => ({ t, dPct: mean(ps.map((p) => p.dPct).filter((x) => x != null && !Number.isNaN(x))) }));
  console.log(`  monthly cheaper on ${tR.filter((r) => r.dPct < 0).length}/${tR.length} tickers (each ticker one vote)`);
  console.log(`\n  ENGINE TRADABILITY GATE (lab liquidityScore >= 8, the bar EntryPolicy enforces):`);
  console.log(`    monthly clears ${gate.mo[0]}/${gate.mo[1]} (${f((gate.mo[0] / gate.mo[1]) * 100, 0)}%)   weekly clears ${gate.wk[0]}/${gate.wk[1]} (${f((gate.wk[0] / gate.wk[1]) * 100, 0)}%)`);

  // The 27-33 DTE gate rates above are measured at the tenor the CURRENT rule lands on. A
  // monthly tie-break inside [20,50] can land at 20 or 50 DTE, so the advantage must hold
  // across the whole band or the deployment gain is overstated.
  const byBand = BRIEFS;
  const band = {};   // "arm|bucket" -> [clears, total]
  const seen2 = new Set();
  for (const row of byBand) {
    const dEt = etDate(row.generated_at);
    let picks; try { picks = JSON.parse(row.picks); } catch { continue; }
    for (const p of picks) {
      for (const s of (p.strategyLabResult?.scores ?? [])) {
        const exp = s.setup?.expiration;
        if (!s.setup || s.setup.unavailableReason || !exp || s.liquidityScore == null) continue;
        const k0 = `${dEt}|${p.ticker}|${s.slug}|${exp}`;
        if (seen2.has(k0)) continue;
        seen2.add(k0);
        const dte = Math.round(daysBetween(dEt, exp));
        if (dte < 14 || dte > 55) continue;
        const bucket = dte <= 22 ? '14-22' : dte <= 33 ? '23-33' : dte <= 44 ? '34-44' : '45-55';
        const key = `${isMonthly(exp) ? 'mo' : 'wk'}|${bucket}`;
        const e = band[key] ?? [0, 0];
        e[1]++; if (s.liquidityScore >= 8) e[0]++;
        band[key] = e;
      }
    }
  }
  console.log(`    by DTE bucket (clears>=8 / total):`);
  console.log(`      bucket    MONTHLY            WEEKLY`);
  for (const b of ['14-22', '23-33', '34-44', '45-55']) {
    const m = band[`mo|${b}`] ?? [0, 0], w = band[`wk|${b}`] ?? [0, 0];
    const pc = (e) => (e[1] ? `${f((e[0] / e[1]) * 100, 0)}% (n=${e[1]})` : '—');
    console.log(`      ${b.padEnd(9)} ${pc(m).padEnd(18)} ${pc(w)}`);
  }

  // Per-arm friction rates for Stage 2. Measured on the population the engine actually
  // trades — engine slugs that CLEAR the liquidity gate — because charging the unfiltered
  // weekly rate to every simulated trade would bill the engine for thin weeklies it already
  // refuses. Median, so the near-zero-credit tail can't drive it.
  const rateMo = med(tradeable.mo);
  const rateWk = med(tradeable.wk);
  const eng = pairs.filter((p) => ENGINE_SLUGS.has(p.slug));
  const rawMo = med(eng.map((p) => p.moPct).filter((x) => x != null));
  const rawWk = med(eng.map((p) => p.wkPct).filter((x) => x != null));
  console.log(`\n  friction on engine slugs, UNFILTERED:         monthly ${f(rawMo, 1)}%  weekly ${f(rawWk, 1)}%  (n=${eng.length} matched cells)`);
  console.log(`  friction on engine slugs that CLEAR the gate: monthly ${f(rateMo, 1)}%  weekly ${f(rateWk, 1)}%  ` +
              `(n=${tradeable.mo.length}/${tradeable.wk.length}) ← used by Stage 2`);
  // Gate-clear probability is strongly DTE-dependent (front-month monthlies carry the OI;
  // a 45-DTE monthly is THINNER than the 30-DTE weekly it would replace), so Stage 2 must
  // weight deployment by the bucket the policy actually lands in, not a flat per-arm rate.
  const bucketOf = (dte) => (dte <= 22 ? '14-22' : dte <= 33 ? '23-33' : dte <= 44 ? '34-44' : '45-55');
  const gateRate = (monthly, dte) => {
    const e = band[`${monthly ? 'mo' : 'wk'}|${bucketOf(dte)}`];
    if (e && e[1] >= 100) return e[0] / e[1];
    return monthly ? gate.mo[0] / gate.mo[1] : gate.wk[0] / gate.wk[1];
  };
  return { rateMo: rateMo / 100, rateWk: rateWk / 100, gateRate };
}

// ════════════════════════════════════════════════════════════════════════════════
// STAGE 2 — realized P&L of the tenor shift, 12-month simulated panel
// ════════════════════════════════════════════════════════════════════════════════

/** Widest wing on a realistic strike grid whose max loss fits the budget (findBudgetWidthHedge). */
function chooseWing(S0, T, sigma0, shortK, side) {
  const creditFor = (L) => (bsPrice(S0, shortK, T, R, sigma0, side) - bsPrice(S0, L, T, R, sigma0, side)) * 100;
  const inc = strikeInc(S0);
  let best = null;
  for (let w = inc; w <= MAX_WIDTH_PTS + 1e-9; w += inc) {
    const L = side === 'put' ? shortK - w : shortK + w;
    if (L <= 0) break;
    const credit = creditFor(L), maxLoss = w * 100 - credit;
    if (maxLoss <= 0 || credit < 5) continue;
    if (maxLoss <= BUDGET) best = { longK: L, credit, maxLoss }; else break;
  }
  return best;
}

/** One short vertical, entered `entryDate`, expiring `exp`. Returns realized P&L or null. */
function simSpread(bars, ivRows, entryDate, exp, side, fricRate) {
  const ei = bars.findIndex((b) => b.date >= entryDate);
  if (ei < 0) return null;
  const ivAsOf = (d) => { let lo = 0, hi = ivRows.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ivRows[m].date <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a >= 0 ? ivRows[a].atm_iv / 100 : null; };
  const S0 = bars[ei].close;
  if (!(S0 > 0)) return null;
  const dte = daysBetween(entryDate, exp);
  if (dte < 5) return null;
  const sigma0 = ivAsOf(entryDate) ?? rollingVol(bars.slice(0, ei + 1).map((b) => b.close), 20);
  const T = dte / 365;
  const shortK = findStrikeForDelta(S0, T, sigma0, 0.30, side);
  const wing = chooseWing(S0, T, sigma0, shortK, side);
  if (!wing) return null;
  const { longK, credit, maxLoss } = wing;
  const entryFric = fricRate * credit;

  for (let i = ei + 1; i < bars.length; i++) {
    const bar = bars[i];
    const out = (gross, exitFric) => {
      const net = gross - entryFric - exitFric;
      return { gross, net, credit, maxLoss, dte,
               grossPct: (gross / maxLoss) * 100, netPct: (net / maxLoss) * 100 };
    };
    if (bar.date >= exp) {
      const intr = side === 'put'
        ? (Math.max(0, shortK - bar.close) - Math.max(0, longK - bar.close)) * 100
        : (Math.max(0, bar.close - shortK) - Math.max(0, bar.close - longK)) * 100;
      return out(credit - intr, 0);           // held to expiry — settles, no closing spread paid
    }
    const sig = ivAsOf(bar.date) ?? sigma0;
    const Tr = Math.max(0, daysBetween(bar.date, exp)) / 365;
    const val = (bsPrice(bar.close, shortK, Tr, R, sig, side) - bsPrice(bar.close, longK, Tr, R, sig, side)) * 100;
    const pnlSoFar = credit - val;
    if (pnlSoFar >= credit * (PT_PCT / 100)) return out(pnlSoFar, fricRate * val);   // closed early → pay the spread again
    if (val >= credit * (STOP_PCT / 100)) return out(pnlSoFar, fricRate * val);
  }
  return null;
}

async function stage2(rates) {
  const maxPx = await latestPriceDate();
  // panel tickers: brief names that actually carry weeklies (where the lever bites at all)
  const briefRows = BRIEFS;
  const tick = new Map();
  for (const r of briefRows) {
    let p; try { p = JSON.parse(r.picks); } catch { continue; }
    for (const x of p) {
      const e = x.strategyLabResult?.context?.expiration;
      if (!e) continue;
      const t = tick.get(x.ticker) ?? { wk: 0, mo: 0 };
      t[isMonthly(e) ? 'mo' : 'wk']++;
      tick.set(x.ticker, t);
    }
  }
  const panel = [...tick.entries()].filter(([, t]) => t.wk > 0).map(([t]) => t);

  // One fetch for the whole panel plus SPY (whose bars define the trading days).
  const series = await loadPriceSeries([...panel, 'SPY'], { from: '2025-06-01', to: maxPx, iv: true });
  const lastEntry = addDays(maxPx, -58);
  const tradingDays = (series.bars['SPY'] ?? []).map((r) => r.date).filter((d) => d >= '2025-08-01' && d <= lastEntry);

  const POLICIES = [
    ['current',        (d, e) => selectCurrent(d, e)],
    // Narrow tie-break: take the monthly ONLY when it already sits in the high-OI 23-33 DTE
    // bucket, so the tenor is never dragged into the thin 34-55 range. Best-case variant.
    ['monthly[23,33]', (d, e) => selectMonthlyPreferring(d, e, 23, 33)],
    ['monthly[20,50]', (d, e) => selectMonthlyPreferring(d, e, 20, 50)],
    ['monthly[14,55]', (d, e) => selectMonthlyPreferring(d, e, 14, 55)],
  ];

  const results = new Map(POLICIES.map(([n]) => [n, []]));
  let attempted = 0, sameAsCurrent = { 'monthly[23,33]': 0, 'monthly[20,50]': 0, 'monthly[14,55]': 0 };

  for (const ticker of panel) {
    const bars = series.bars[ticker] ?? [];
    if (bars.length < 100) continue;
    const barDates = new Set(bars.map((b) => b.date));
    const ivRows = series.iv[ticker] ?? [];
    if (ivRows.length < 50) continue;
    for (const d of tradingDays) {
      if (!barDates.has(d)) continue;
      const expirations = [...new Set([...fridaysAfter(d), ...monthliesAfter(d)])].sort();
      attempted++;
      const chosen = {};
      for (const [name, sel] of POLICIES) {
        const pick = sel(d, expirations);
        if (!pick) continue;
        chosen[name] = pick.expiration;
        const rate = isMonthly(pick.expiration) ? rates.rateMo : rates.rateWk;
        const r = simSpread(bars, ivRows, d, pick.expiration, 'put', rate);
        if (r) results.get(name).push({ ticker, d, exp: pick.expiration, monthly: isMonthly(pick.expiration), ...r });
      }
      for (const n of Object.keys(sameAsCurrent)) if (chosen[n] === chosen['current']) sameAsCurrent[n]++;
    }
  }

  console.log('\n═══ STAGE 2 — realized P&L of the tenor shift ═══');
  console.log(`panel: ${panel.length} weekly-carrying brief tickers x ${tradingDays.length} entry dates ` +
              `(${tradingDays[0]} .. ${tradingDays[tradingDays.length - 1]}), ${attempted} (ticker,date) cells`);
  console.log(`structure: short put vertical, 0.30Δ short + budget wing (<=$${BUDGET} max loss), ` +
              `${PT_PCT}% profit target / ${STOP_PCT}% stop / else expiry`);
  console.log('identical expiry to current: ' +
    Object.keys(sameAsCurrent).map((n) => `${n} ${f((sameAsCurrent[n] / attempted) * 100, 0)}%`).join(', ') + ' of cells');

  const agg = (label, rs, key) => {
    if (!rs.length) { console.log(`${label.padEnd(18)} n=0`); return; }
    const wins = rs.filter((r) => r[key] > 0).length;
    console.log(`${label.padEnd(18)} n=${String(rs.length).padStart(5)}  win=${f((wins / rs.length) * 100).padStart(5)}%  ` +
                `avgRet/maxLoss=${f(mean(rs.map((r) => r[key === 'net' ? 'netPct' : 'grossPct']))).padStart(6)}%  ` +
                `total=$${f(rs.reduce((s, r) => s + r[key], 0), 0).padStart(8)}  avgDTE=${f(mean(rs.map((r) => r.dte)), 0).padStart(3)}  ` +
                `monthly=${f((rs.filter((r) => r.monthly).length / rs.length) * 100, 0).padStart(3)}%`);
  };
  console.log('\n--- GROSS (theoretical mid, no execution cost — comparable to the sibling FR-SEY studies) ---');
  for (const [n] of POLICIES) agg(n, results.get(n), 'gross');
  console.log('\n--- NET of execution friction (Stage-1 rates applied per arm) ---');
  for (const [n] of POLICIES) agg(n, results.get(n), 'net');

  // paired: same (ticker, entry date) resolved under both policies
  console.log('\n--- PAIRED head-to-head vs current (same ticker+date resolved under both) ---');
  const idx = (rs) => new Map(rs.map((r) => [`${r.ticker}|${r.d}`, r]));
  const cur = idx(results.get('current'));
  for (const n of Object.keys(sameAsCurrent)) {
    const alt = idx(results.get(n));
    const both = [];
    for (const [k, a] of alt) { const c = cur.get(k); if (c) both.push({ c, a }); }
    const diff = both.filter(({ c, a }) => c.exp !== a.exp);
    const line = (label, set) => {
      if (!set.length) { console.log(`  ${label} n=0`); return; }
      const dGross = mean(set.map(({ c, a }) => a.grossPct - c.grossPct));
      const dNet = mean(set.map(({ c, a }) => a.netPct - c.netPct));
      const cw = set.filter(({ c }) => c.net > 0).length, aw = set.filter(({ a }) => a.net > 0).length;
      console.log(`  ${label.padEnd(28)} n=${String(set.length).padStart(5)}  ` +
                  `Δgross ${(dGross >= 0 ? '+' : '') + f(dGross, 2)}pts   Δnet ${(dNet >= 0 ? '+' : '') + f(dNet, 2)}pts   ` +
                  `win(net) ${f((cw / set.length) * 100)}% → ${f((aw / set.length) * 100)}%`);
    };
    console.log(` ${n}:`);
    line('all paired cells', both);
    line('cells where expiry differs', diff);
  }

  // Robustness: is the tenor-neutrality a single-regime artifact? Split by entry month.
  console.log('\n--- Δgross by entry month (tenor effect only — the FR-SEY-5 acceptance test) ---');
  const altNames = Object.keys(sameAsCurrent);
  console.log('month     n   ' + altNames.map((n) => `Δgross ${n.replace('monthly', '')}`.padStart(17)).join(''));
  const months = [...new Set(results.get('current').map((r) => r.d.slice(0, 7)))].sort();
  const altIdx = Object.fromEntries(altNames.map((n) => [n, idx(results.get(n))]));
  for (const m of months) {
    const curM = results.get('current').filter((r) => r.d.startsWith(m));
    const dOf = (n) => mean(curM.map((c) => { const a = altIdx[n].get(`${c.ticker}|${c.d}`); return a ? a.grossPct - c.grossPct : null; }).filter((x) => x != null));
    console.log(`${m}  ${String(curM.length).padStart(5)}   ` +
      altNames.map((n) => { const d = dOf(n); return ((d >= 0 ? '+' : '') + f(d, 2)).padStart(14); }).join(''));
  }

  // Deployment synthesis: the lever's real prize would be more structures clearing the gate.
  // Weight each simulated trade by the empirical gate-clear probability for the (arm, DTE)
  // bucket it actually lands in.
  console.log('\n--- Deployment: DTE-weighted gate-clear rate x realized return ---');
  for (const [n] of POLICIES) {
    const rs = results.get(n);
    const clears = rs.map((r) => rates.gateRate(r.monthly, r.dte));
    const clear = mean(clears);
    const netPct = mean(rs.map((r) => r.netPct));
    const expected = mean(rs.map((r, i) => clears[i] * r.netPct));
    console.log(`${n.padEnd(18)} monthly-share ${f((rs.filter((r) => r.monthly).length / rs.length) * 100, 0).padStart(3)}%  ` +
                `avgDTE ${f(mean(rs.map((r) => r.dte)), 0).padStart(2)}  → gate-clear ${f(clear * 100, 0).padStart(3)}%  ` +
                `x net ${f(netPct, 2).padStart(5)}%/trade  = ${f(expected, 3).padStart(6)} expected pts / candidate`);
  }
  return results;
}

const rates = stage1();
await stage2(rates);
