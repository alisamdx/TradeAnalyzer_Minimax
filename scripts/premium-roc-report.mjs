#!/usr/bin/env node
/**
 * Real income/wheel return on capital — every stored CSP in options_premium_history settled at
 * expiry on its real premium, beside Brief Replay's 0.85×-entry proxy on the same rows.
 *
 *   node scripts/premium-roc-report.mjs [--strategy income|wheel|both] [--json]
 *
 * Reads GET /api/v1/diagnostics/premium-roc from the RUNNING app (v1.1.336+); never opens SQLite.
 * see src/main/services/premium-roc.ts, docs/formulas.md#premium-roc
 *
 * Read the population before the numbers: options_premium_history holds the recommended CSP for
 * EVERY analysed ticker each day, not only the brief's picks. This measures the universe the
 * wheel/income analysis would hand you, held to expiry at intrinsic — no management, no rolls,
 * no assignment-then-covered-call leg.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const which = argOf('--strategy', 'both');
const strategies = which === 'both' ? ['income', 'wheel'] : [which];

const DATA_DIR = join(homedir(), '.tradeanalyzer');
const TOKEN = readFileSync(join(DATA_DIR, 'agent.token'), 'utf8').trim();
let PORT = '7432';
try { PORT = readFileSync(join(DATA_DIR, 'api.port'), 'utf8').trim() || PORT; } catch { /* default */ }

async function load(strategy) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/diagnostics/premium-roc?strategy=${strategy}`, {
    headers: { 'X-Agent-Token': TOKEN }
  }).catch((err) => {
    console.error(`API server not reachable on 127.0.0.1:${PORT} — the app must be RUNNING. (${err.message})`);
    process.exit(1);
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    console.error(`premium-roc failed: HTTP ${res.status} ${body?.error ?? ''}`);
    if (res.status === 404) console.error('This app build predates the route (v1.1.336). Install the new build.');
    process.exit(1);
  }
  return body.data;
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]; };
const pct = (x, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(d)}%` : '—');
const share = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
const pad = (s, n) => String(s).padStart(n);

function line(label, rows) {
  const r = rows.map((x) => x.rocPct);
  const assigned = rows.filter((x) => x.assigned).length;
  return `${label.padEnd(16)} ${pad(rows.length, 6)}  assigned ${pad(share(assigned, rows.length), 6)}  mean ${pad(pct(mean(r)), 7)}  median ${pad(pct(q(r, 0.5)), 7)}  win ${pad(share(r.filter((x) => x > 0).length, rows.length), 6)}`;
}

function report(d) {
  const rows = d.rows;
  const out = [];
  const p = (s = '') => out.push(s);
  const dates = [...new Set(rows.map((r) => r.asOfDate))].sort();

  p(`\n══════ ${d.strategy.toUpperCase()} — real return on capital, held to expiry ══════`);
  p(`prices through ${d.maxPriceDate} · ${d.eligible} expired CSPs stored · ${rows.length} settled · ` +
    `${d.excluded.length} excluded · ${d.coveredCallsSkipped} covered calls not settled`);
  if (!rows.length) { p('nothing settled yet'); return out.join('\n'); }
  p(`${dates.length} entry dates ${dates[0]} → ${dates.at(-1)} · ${new Set(rows.map((r) => r.ticker)).size} tickers`);

  const byReason = {};
  for (const e of d.excluded) (byReason[e.reason] ??= []).push(e);
  for (const [reason, list] of Object.entries(byReason)) {
    const tick = [...new Set(list.map((e) => e.ticker))];
    p(`  excluded ${reason}: ${list.length} rows on ${tick.length} tickers — ${tick.slice(0, 12).join(', ')}${tick.length > 12 ? ', …' : ''}`);
  }

  const roc = rows.map((r) => r.rocPct);
  p('\n— Per trade (capital = strike) —');
  p(line('all', rows));
  p(`tails: p5 ${pct(q(roc, 0.05))}  p25 ${pct(q(roc, 0.25))}  p75 ${pct(q(roc, 0.75))}  p95 ${pct(q(roc, 0.95))}  worst ${pct(q(roc, 0))}`);
  const kept = rows.filter((r) => !r.assigned).map((r) => r.rocPct);
  const lost = rows.filter((r) => r.assigned).map((r) => r.rocPct);
  p(`not assigned: mean ${pct(mean(kept))}  ·  assigned: mean ${pct(mean(lost))}, median ${pct(q(lost, 0.5))}`);

  // Each entry date weighted once, so a day with 900 rows cannot outvote one with 300.
  const perDate = dates.map((dt) => mean(rows.filter((r) => r.asOfDate === dt).map((r) => r.rocPct)));
  p(`date-weighted mean ${pct(mean(perDate))} · dates with a negative mean: ${perDate.filter((x) => x < 0).length} of ${dates.length}`);

  p('\n— Promised vs realized (annualized) —');
  const exp = rows.map((r) => r.expectedAnnualizedPct).filter((x) => x != null);
  const ann = rows.map((r) => r.annualizedRocPct);
  p(`promised at capture: median ${pct(q(exp, 0.5), 1)}   realized: median ${pct(q(ann, 0.5), 1)}, mean ${pct(mean(ann), 1)}`);

  p('\n— By entry month —');
  const months = [...new Set(rows.map((r) => r.asOfDate.slice(0, 7)))].sort();
  for (const m of months) p(line(m, rows.filter((r) => r.asOfDate.startsWith(m))));

  p('\n— By IV rank at capture —');
  for (const [lab, lo, hi] of [['ivRank < 30', -1, 30], ['ivRank 30–60', 30, 60], ['ivRank ≥ 60', 60, 1e9]]) {
    p(line(lab, rows.filter((r) => r.ivRank != null && r.ivRank >= lo && r.ivRank < hi)));
  }
  const noIv = rows.filter((r) => r.ivRank == null).length;
  if (noIv) p(`(${noIv} rows have no IV rank)`);

  p('\n— Brief Replay proxy vs the real outcome, same rows —');
  const both = rows.filter((r) => r.proxyKept != null);
  const cell = (pk, asg) => both.filter((r) => r.proxyKept === pk && r.assigned === asg);
  const kk = cell(true, false), ka = cell(true, true), bk = cell(false, false), ba = cell(false, true);
  p(`${both.length} rows with 21 forward sessions`);
  p(`                       real: not assigned   real: assigned`);
  p(`proxy says kept        ${pad(kk.length, 18)}   ${pad(ka.length, 14)}`);
  p(`proxy says breached    ${pad(bk.length, 18)}   ${pad(ba.length, 14)}`);
  p(`agreement ${share(kk.length + ba.length, both.length)} · proxy "kept" rate ${share(kk.length + ka.length, both.length)} vs real not-assigned rate ${share(kk.length + bk.length, both.length)}`);
  p(`real ROC where proxy said kept: mean ${pct(mean([...kk, ...ka].map((r) => r.rocPct)))} · where it said breached: mean ${pct(mean([...bk, ...ba].map((r) => r.rocPct)))}`);

  return out.join('\n');
}

const results = [];
for (const s of strategies) {
  const d = await load(s);
  results.push(d);
  console.log(report(d));
}

console.log(`
═══ READ THIS BEFORE ACTING ═══
• Population: options_premium_history is the recommended CSP for EVERY analysed ticker, not the
  brief's picks. It says what the wheel/income analysis hands you, not what the brief selected.
• Regime: settlement lags capture by a full option cycle, so every settled row comes from the
  window shown above — a sample of that market, however large n looks. Compare months before
  generalising, and never read one window as an edge (FR-SEY-5).
• Held to expiry at intrinsic: no early close, no roll, no covered call after assignment, so an
  assigned row's loss is marked at expiry, not realised. Premium is the modelled fill.
• Excluded rows are split-scale mismatches or missing bars; they are listed above, not settled.`);

if (args.includes('--json')) {
  const dir = join(DATA_DIR, 'premium-roc');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `premium-roc-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify(results));
  console.log(`\nSaved ${file}`);
}
