#!/usr/bin/env node
/**
 * Wheel CSP strike selection: E*Trade's delta vs our own (QC-410 follow-up, v1.1.318).
 *
 *   node scripts/wheel-delta-selection-study.mjs <path-to-generation-COPY.sqlite>
 *
 * Replays TradeAnalyzer's wheel rule (`AnalysisService.findSuitableChain`: first expiration
 * 30-45 DTE by date, puts with |delta| in [0.20, 0.30] and bid > 0, the one nearest 0.25) on
 * every stored E*Trade chain in a TradeAnalyzer 2 generation, three ways:
 *
 *   provider   E*Trade's delta, exactly as the live code does today
 *   model      Black-Scholes delta at the chain's own underlying price, E*Trade's IV
 *   model-mid  Black-Scholes delta at the chain's price, IV solved from the contract's own mid
 *
 * and reports how often the chosen contract differs, split by QC-410's per-ticker verdict.
 *
 * Read a COPY only — `POST /api/v1/diagnostics/generation-snapshot` writes one under
 * ~/.tradeanalyzer/rehearsal. Never point this at the live generation.
 */
import { createRequire } from 'node:module';
import { bsDelta } from '../packages/core/dist/qa/black-scholes.js';
import { greekConsistencyFor } from '../packages/core/dist/qa/checks/chains.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const path = process.argv[2];
if (!path || !/rehearsal/.test(path)) {
  console.error('usage: node scripts/wheel-delta-selection-study.mjs <~/.tradeanalyzer/rehearsal/gen-*.sqlite>');
  process.exit(1);
}
const db = new Database(path, { readonly: true });

const MIN_DTE = 30, MAX_DTE = 45, LO = 0.20, HI = 0.30, TARGET = 0.25;
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

function normCdf(x) {
  const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}
function bsPut(S, K, T, v, r) {
  const d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * Math.sqrt(T)), d2 = d1 - v * Math.sqrt(T);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}
function ivFromPut(price, S, K, T, r) {
  if (!(price > 0) || price < Math.max(0, K * Math.exp(-r * T) - S)) return null;
  let lo = 0.01, hi = 5;
  if (bsPut(S, K, T, hi, r) < price) return null;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (bsPut(S, K, T, m, r) > price) hi = m; else lo = m; }
  return (lo + hi) / 2;
}

const dates = db.prepare(`SELECT DISTINCT as_of_date d FROM raw_option_contract_snapshot ORDER BY 1`).all().map((r) => r.d);
const rateOn = db.prepare(`SELECT yield FROM raw_treasury_yield WHERE tenor = '3M' AND curve_date <= ? ORDER BY curve_date DESC LIMIT 1`);
const puts = db.prepare(
  `SELECT s.ticker, s.expiration_date exp, s.strike, s.delta, s.iv, s.bid, s.ask, s.underlying_price u
     FROM raw_option_contract_snapshot s
     JOIN (SELECT osi_symbol, MAX(observed_at) latest FROM raw_option_contract_snapshot
            WHERE as_of_date = ? AND "right" = 'put' GROUP BY osi_symbol) m
       ON m.osi_symbol = s.osi_symbol AND m.latest = s.observed_at
    WHERE s.as_of_date = ? AND s."right" = 'put' AND s.price_status = 'ok' AND s.bid > 0
      AND s.iv_status = 'ok' AND s.greeks_status = 'ok' AND s.delta IS NOT NULL`
);

function pick(list, deltaOf) {
  const byExp = new Map();
  for (const c of list) (byExp.get(c.exp) ?? byExp.set(c.exp, []).get(c.exp)).push(c);
  for (const exp of [...byExp.keys()].sort()) {
    const cands = byExp.get(exp).map((c) => ({ c, d: deltaOf(c) })).filter((x) => x.d !== null && Math.abs(x.d) >= LO && Math.abs(x.d) <= HI);
    if (cands.length) return cands.reduce((a, b) => (Math.abs(Math.abs(a.d) - TARGET) < Math.abs(Math.abs(b.d) - TARGET) ? a : b));
  }
  return null;
}

const totals = { flagged: { n: 0, same: 0, diff: 0, provOnly: 0, modelOnly: 0, offBand: 0 }, clean: { n: 0, same: 0, diff: 0, provOnly: 0, modelOnly: 0, offBand: 0 } };
const midAgree = { n: 0, same: 0 };
const examples = [];

for (const d of dates) {
  const rate = rateOn.get(d)?.yield;
  if (rate === undefined) continue;
  const byTicker = new Map();
  for (const c of puts.all(d, d)) {
    const dte = days(d, c.exp);
    if (dte < MIN_DTE || dte > MAX_DTE) continue;
    c.dte = dte;
    (byTicker.get(c.ticker) ?? byTicker.set(c.ticker, []).get(c.ticker)).push(c);
  }
  for (const [ticker, list] of byTicker) {
    const model = (c) => bsDelta({ spot: c.u, strike: c.strike, dteDays: c.dte, iv: c.iv, rate, right: 'put' });
    const modelMid = (c) => {
      const v = ivFromPut((c.bid + c.ask) / 2, c.u, c.strike, c.dte / 365, rate);
      return v === null ? null : bsDelta({ spot: c.u, strike: c.strike, dteDays: c.dte, iv: v, rate, right: 'put' });
    };
    const p = pick(list, (c) => c.delta);
    const m = pick(list, model);
    const mm = pick(list, modelMid);
    if (!p && !m) continue;
    const verdict = greekConsistencyFor(db, d, ticker);
    const bucket = verdict && !verdict.usable ? totals.flagged : totals.clean;
    bucket.n++;
    if (p && m) {
      const same = p.c.exp === m.c.exp && p.c.strike === m.c.strike;
      same ? bucket.same++ : bucket.diff++;
      const trueDelta = model(p.c);
      if (trueDelta !== null && (Math.abs(trueDelta) < LO || Math.abs(trueDelta) > HI)) bucket.offBand++;
      if (!same) examples.push({
        d, ticker, flagged: bucket === totals.flagged, u: p.c.u,
        provider: `${p.c.exp} ${p.c.strike}P Δ${p.c.delta.toFixed(2)} (model ${trueDelta?.toFixed(2)}) ${(100 * (p.c.strike / p.c.u - 1)).toFixed(1)}%`,
        model: `${m.c.exp} ${m.c.strike}P Δ${m.d.toFixed(2)} ${(100 * (m.c.strike / m.c.u - 1)).toFixed(1)}%`,
        gap: trueDelta === null ? 99 : Math.abs(Math.abs(trueDelta) - TARGET)
      });
    } else if (p) bucket.provOnly++;
    else bucket.modelOnly++;
    if (m && mm) { midAgree.n++; if (m.c.exp === mm.c.exp && m.c.strike === mm.c.strike) midAgree.same++; }
  }
}

console.log(`dates: ${dates[0]} .. ${dates[dates.length - 1]} (${dates.length})\n`);
for (const [k, t] of Object.entries(totals)) {
  console.log(
    `${k.padEnd(8)} ticker-days ${t.n}: same contract ${t.same}, different ${t.diff}, ` +
    `provider-only pick ${t.provOnly}, model-only pick ${t.modelOnly}; ` +
    `provider pick OUTSIDE 0.20-0.30 by our model: ${t.offBand}`
  );
}
console.log(`\nmodel (E*Trade IV) vs model (IV from mid): same contract on ${midAgree.same} of ${midAgree.n}`);
console.log('\nlargest mis-targets (provider pick, with its delta by our model):');
for (const e of examples.sort((a, b) => b.gap - a.gap).slice(0, 20)) {
  console.log(`  ${e.d} ${e.ticker.padEnd(5)} ${e.flagged ? 'QC-410' : '      '} spot ${e.u}  provider ${e.provider}  →  model ${e.model}`);
}
