#!/usr/bin/env node
/**
 * QC-410 study — why does E*Trade's delta disagree with our Black-Scholes?
 *
 *   node packages/core/scripts/qc410-study.mjs [yyyy-mm-dd]
 *
 * READ ONLY. Writes nothing to the generation. Run it from a normal terminal
 * (not a Claude Code shell, which is MSIX-containerised) with BOTH applications
 * closed, after `npm run rebuild:node`.
 *
 * QC-410's tolerance (0.05) was calibrated on one SPY chain at 11 DTE. On
 * 2026-09-16 it breached on 5,135 of 62,814 ATM contracts, with gaps like ADP
 * 0.476 vs 0.696 — far larger than the model difference it was sized for. This
 * script re-runs the check's exact computation and splits the breaches along
 * every axis that could explain them, so the cause is measured, not inferred:
 *
 *   H1  days to expiry  — near expiry, delta is hypersensitive to spot and vol
 *   H2  spot            — the spot that reproduces E*Trade's delta, vs nearPrice
 *                         and vs Polygon's last; clusters per ticker mean the
 *                         provider priced off a different underlying price
 *   H3  quote age       — provider_timestamp against the day's close
 *   H4  put/call        — E*Trade's own call delta minus put delta at one strike
 *   H5  dividends       — an ex-dividend date inside the option's life
 *   H6  liquidity       — breach rate by spread width and open interest
 */
import {
  checkpointAndClose,
  openGenerationExclusively,
  resolveGenerationPointer
} from './lib/generation-access.mjs';

const { bsDelta } = await import('../dist/qa/black-scholes.js');

const TOLERANCE = 0.05; // QC-410's maxAbsDeltaDifference
const ATM_BAND = 0.05; // QC-410's ATM band

const { dbPath } = await resolveGenerationPointer();
const db = await openGenerationExclusively(dbPath, 'qc410-study.mjs');

try {
  const date =
    process.argv[2] ??
    db.prepare('SELECT MAX(as_of_date) AS d FROM raw_option_contract_snapshot').get().d;
  const rate = db
    .prepare(
      `SELECT yield, curve_date FROM raw_treasury_yield
        WHERE tenor = '3M' AND curve_date <= ? ORDER BY curve_date DESC LIMIT 1`
    )
    .get(date);
  if (!rate) throw new Error(`no 3M yield on or before ${date}; QC-410 would have skipped`);

  console.log(`# QC-410 study — ${date}`);
  console.log(`3M rate ${rate.yield} (curve ${rate.curve_date}) — stored as a fraction? ${rate.yield < 1 ? 'yes' : 'NO, looks like percent'}\n`);

  // Latest observation per contract, as the gate's reader would see it.
  const rows = db
    .prepare(
      `SELECT s.osi_symbol, s.ticker, s.strike, s."right" AS right, s.iv, s.delta, s.bid, s.ask,
              s.open_interest, s.volume, s.underlying_price, s.expiration_date, s.provider_timestamp,
              s.observed_at
         FROM raw_option_contract_snapshot s
        WHERE s.as_of_date = ? AND s.iv_status = 'ok' AND s.greeks_status = 'ok'
          AND s.delta IS NOT NULL AND s.underlying_price > 0
          AND ABS(s.strike - s.underlying_price) <= s.underlying_price * ?`
    )
    .all(date, ATM_BAND);

  const polygonLast = new Map(
    db
      .prepare(
        // SQLite returns the bare columns of the MAX() row.
        `SELECT ticker, last, MAX(observed_at) AS latest FROM raw_eod_quote
          WHERE as_of_date = ? AND last IS NOT NULL
          GROUP BY ticker`
      )
      .all(date)
      .map((r) => [r.ticker, r.last])
  );
  const exDivInLife = db.prepare(
    `SELECT 1 FROM raw_dividend WHERE ticker = ? AND ex_dividend_date > ? AND ex_dividend_date <= ? LIMIT 1`
  );

  const measured = [];
  for (const r of rows) {
    const dteDays = Math.round((Date.parse(`${r.expiration_date}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
    const model = bsDelta({ spot: r.underlying_price, strike: r.strike, dteDays, iv: r.iv, rate: rate.yield, right: r.right });
    if (model === null) continue;
    measured.push({ ...r, dteDays, model, diff: Math.abs(model - r.delta), signed: r.delta - model });
  }
  const breach = (m) => m.diff > TOLERANCE;
  const total = measured.length;
  const nBreach = measured.filter(breach).length;
  console.log(`ATM contracts measured ${total}, breaching ${nBreach} (${pct(nBreach, total)})`);
  // Every run that day contributes its own observation, exactly as the gate reads them —
  // three runs on one date would count each contract three times.
  console.log(`distinct contracts ${new Set(measured.map((m) => m.osi_symbol)).size}, observations per run: ${[...groupBy(measured, (m) => m.observed_at.slice(0, 16))].map(([k, v]) => `${k} ${v.length}`).join(', ')}`);
  console.log(`(the gate reported 5135 of 62814 on 2026-09-16 — if these differ, the rows differ)\n`);

  // ── H1 days to expiry ─────────────────────────────────────────────────────
  section('H1 — days to expiry', bucketTable(measured, (m) =>
    m.dteDays <= 2 ? 'a  0-2' : m.dteDays <= 7 ? 'b  3-7' : m.dteDays <= 14 ? 'c  8-14' : m.dteDays <= 45 ? 'd 15-45' : 'e 46+'));

  // Distance from the strike in standard deviations, which is what delta actually responds to.
  section('H1b — distance from strike in σ√t units', bucketTable(measured, (m) => {
    const z = Math.abs(Math.log(m.underlying_price / m.strike)) / (m.iv * Math.sqrt(m.dteDays / 365));
    return z < 0.1 ? 'a <0.1σ' : z < 0.5 ? 'b 0.1-0.5σ' : z < 1 ? 'c 0.5-1σ' : z < 2 ? 'd 1-2σ' : 'e 2σ+';
  }));

  // ── H2 spot ───────────────────────────────────────────────────────────────
  // Delta is monotone increasing in spot for calls and puts alike, so bisection
  // finds the one spot at which our model agrees with E*Trade.
  const implied = [];
  for (const m of measured.filter(breach)) {
    let lo = m.underlying_price * 0.5, hi = m.underlying_price * 1.5;
    const f = (s) => bsDelta({ spot: s, strike: m.strike, dteDays: m.dteDays, iv: m.iv, rate: rate.yield, right: m.right }) - m.delta;
    if (f(lo) > 0 || f(hi) < 0) continue;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (f(mid) > 0) hi = mid; else lo = mid; }
    implied.push({ ...m, impliedSpot: (lo + hi) / 2 });
  }
  const spotRatio = implied.map((m) => m.impliedSpot / m.underlying_price - 1);
  console.log(`## H2 — the spot that reproduces E*Trade's delta\n`);
  console.log(`solvable ${implied.length} of ${nBreach} breaches`);
  console.log(`implied spot vs nearPrice, % — ${quantiles(spotRatio.map((x) => x * 100))}`);
  // If the provider priced off one different spot per ticker, the implied spot is
  // consistent ACROSS that ticker's strikes; model noise would scatter it.
  const perTicker = groupBy(implied, (m) => m.ticker);
  const spreads = [...perTicker.values()].filter((g) => g.length >= 3).map((g) => {
    const xs = g.map((m) => m.impliedSpot / m.underlying_price - 1);
    return (Math.max(...xs) - Math.min(...xs)) * 100;
  });
  console.log(`within-ticker range of implied spot, % (tickers with >=3 breaches: ${spreads.length}) — ${quantiles(spreads)}`);
  const vsPolygon = implied.filter((m) => polygonLast.has(m.ticker)).map((m) => ({
    near: (m.underlying_price / polygonLast.get(m.ticker) - 1) * 100,
    impl: (m.impliedSpot / polygonLast.get(m.ticker) - 1) * 100
  }));
  console.log(`nearPrice vs Polygon last, % — ${quantiles(vsPolygon.map((x) => x.near))}`);
  console.log(`implied spot vs Polygon last, % — ${quantiles(vsPolygon.map((x) => x.impl))}`);
  console.log('');
  console.log('worst 15 by gap:');
  for (const m of [...implied].sort((a, b) => b.diff - a.diff).slice(0, 15)) {
    const pl = polygonLast.get(m.ticker);
    console.log(
      `  ${m.osi_symbol.padEnd(22)} dte ${String(m.dteDays).padStart(3)} iv ${m.iv.toFixed(3)} ` +
      `etrade ${m.delta.toFixed(3)} model ${m.model.toFixed(3)} | near ${m.underlying_price} ` +
      `polygon ${pl ?? '—'} implied ${m.impliedSpot.toFixed(2)} | quote ${m.provider_timestamp ?? '—'}`
    );
  }
  console.log('');

  // ── H3 quote age ──────────────────────────────────────────────────────────
  section('H3 — provider timestamp (ET hour of the quote)', bucketTable(measured, (m) =>
    m.provider_timestamp ? `${m.provider_timestamp.slice(0, 10)} ${m.provider_timestamp.slice(11, 13)}h` : 'none'));

  // ── H4 put/call consistency ───────────────────────────────────────────────
  // With no dividend, European call delta − put delta = 1 exactly. E*Trade's own
  // pair drifting far from 1 says their Greeks are internally inconsistent, which
  // no choice of OUR model inputs could fix.
  const pairs = groupBy(measured, (m) => `${m.ticker}|${m.expiration_date}|${m.strike}`);
  const pcGap = [];
  for (const g of pairs.values()) {
    const c = g.find((m) => m.right === 'call'), p = g.find((m) => m.right === 'put');
    if (c && p) pcGap.push({ gap: c.delta - p.delta - 1, dte: c.dteDays, breach: breach(c) || breach(p) });
  }
  console.log(`## H4 — E*Trade call delta − put delta − 1 (should be ~0)\n`);
  console.log(`pairs ${pcGap.length}`);
  console.log(`all pairs — ${quantiles(pcGap.map((x) => x.gap))}`);
  console.log(`pairs with a breach — ${quantiles(pcGap.filter((x) => x.breach).map((x) => x.gap))}`);
  console.log(`pairs without — ${quantiles(pcGap.filter((x) => !x.breach).map((x) => x.gap))}\n`);

  // ── H5 dividends ──────────────────────────────────────────────────────────
  section('H5 — ex-dividend date inside the option life', bucketTable(measured, (m) =>
    exDivInLife.get(m.ticker, date, m.expiration_date) ? 'yes' : 'no'));

  // ── right, signed direction ───────────────────────────────────────────────
  section('right', bucketTable(measured, (m) => m.right));
  console.log(`signed gap (etrade − model) on breaches, calls — ${quantiles(measured.filter((m) => breach(m) && m.right === 'call').map((m) => m.signed))}`);
  console.log(`signed gap (etrade − model) on breaches, puts  — ${quantiles(measured.filter((m) => breach(m) && m.right === 'put').map((m) => m.signed))}\n`);

  // ── H6 liquidity ──────────────────────────────────────────────────────────
  section('H6a — bid/ask spread as % of mid', bucketTable(measured, (m) => {
    if (m.bid == null || m.ask == null || m.ask <= 0) return 'no quote';
    const mid = (m.bid + m.ask) / 2, w = mid > 0 ? (m.ask - m.bid) / mid : Infinity;
    return w <= 0.05 ? 'a <=5%' : w <= 0.15 ? 'b 5-15%' : w <= 0.5 ? 'c 15-50%' : 'd >50%';
  }));
  section('H6b — open interest', bucketTable(measured, (m) =>
    m.open_interest == null ? 'null' : m.open_interest === 0 ? 'a 0' : m.open_interest < 100 ? 'b 1-99' : m.open_interest < 1000 ? 'c 100-999' : 'd 1000+'));

  // ── H7 which spot did E*Trade price with? ─────────────────────────────────
  // Run 1 showed the implied spot is tight WITHIN a ticker (median range 0.2 %)
  // but ~1 % off nearPrice across tickers, and some tickers breach on nearly every
  // contract (LEN 111/112). That is a per-ticker spot offset. nearPrice is read at
  // collection time (18:05-18:47 ET, after hours); the option quotes and Greeks are
  // stamped 15:55-16:15. So compare both against the regular-session close.
  const eodCounts = db
    .prepare(`SELECT as_of_date, COUNT(*) AS n, SUM(last IS NOT NULL) AS with_last FROM raw_eod_quote
              WHERE as_of_date >= date(?, '-5 days') GROUP BY as_of_date ORDER BY as_of_date`)
    .all(date);
  console.log('## raw_eod_quote coverage (H2 found n=0 against it)\n');
  console.log(eodCounts.length
    ? eodCounts.map((r) => `  ${r.as_of_date}  rows ${r.n}  with last ${r.with_last}`).join('\n')
    : '  no rows in the last 5 days');
  console.log('');
  const divRange = db.prepare('SELECT COUNT(*) AS n, MIN(ex_dividend_date) AS lo, MAX(ex_dividend_date) AS hi FROM raw_dividend').get();
  console.log('## raw_dividend coverage (H5 found no ex-date in any option life)\n');
  console.log(`  rows ${divRange.n}, ex-dates ${divRange.lo} .. ${divRange.hi}\n`);

  const closeOf = new Map(
    db.prepare(
      // Latest observation of the session bar; SQLite returns the bare columns of the MAX() row.
      `SELECT ticker, close, MAX(observed_at) AS latest FROM raw_daily_bar WHERE trade_date = ? GROUP BY ticker`
    ).all(date).map((r) => [r.ticker, r.close])
  );
  // Implied spot on EVERY unsaturated contract, not only breaches: a saturated
  // delta (0/1) is flat in spot, so its implied spot is arbitrary — run 1's
  // AMG call and put at one strike implied 514 and 408.
  const solveSpot = (m) => {
    if (Math.abs(m.delta) < 0.05 || Math.abs(m.delta) > 0.95) return null;
    let lo = m.underlying_price * 0.5, hi = m.underlying_price * 1.5;
    const f = (x) => bsDelta({ spot: x, strike: m.strike, dteDays: m.dteDays, iv: m.iv, rate: rate.yield, right: m.right }) - m.delta;
    if (f(lo) > 0 || f(hi) < 0) return null;
    for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (f(mid) > 0) hi = mid; else lo = mid; }
    return (lo + hi) / 2;
  };
  const tickers = [];
  for (const [t, xs] of groupBy(measured, (m) => m.ticker)) {
    const close = closeOf.get(t);
    if (!close) continue;
    const imp = xs.map(solveSpot).filter((v) => v !== null);
    if (imp.length < 5) continue;
    tickers.push({
      t, n: xs.length, rate: xs.filter(breach).length / xs.length, close,
      near: median(xs.map((m) => m.underlying_price)), implied: median(imp)
    });
  }
  const pctOff = (a, b) => (a / b - 1) * 100;
  console.log('## H7 — nearPrice, implied spot and the session close, per ticker\n');
  console.log(`tickers with a close and >=5 solvable contracts: ${tickers.length} (closes found for ${closeOf.size})`);
  console.log(`nearPrice vs close, %      — ${quantiles(tickers.map((x) => pctOff(x.near, x.close)))}`);
  console.log(`implied spot vs close, %   — ${quantiles(tickers.map((x) => pctOff(x.implied, x.close)))}`);
  console.log(`implied spot vs nearPrice, % — ${quantiles(tickers.map((x) => pctOff(x.implied, x.near)))}\n`);
  const bucketBy = (label, fn) => {
    const g = groupBy(tickers, (x) => { const v = Math.abs(fn(x)); return v < 0.1 ? 'a <0.1%' : v < 0.25 ? 'b 0.1-0.25%' : v < 0.5 ? 'c 0.25-0.5%' : v < 1 ? 'd 0.5-1%' : v < 3 ? 'e 1-3%' : 'f 3%+'; });
    console.log(`breach rate by |${label}|:`);
    for (const [k, v] of [...g].sort((a, b) => a[0].localeCompare(b[0]))) {
      const n = v.reduce((a, x) => a + x.n, 0), b = v.reduce((a, x) => a + x.rate * x.n, 0);
      console.log(`  ${k.padEnd(12)} tickers ${String(v.length).padStart(4)}  contracts ${String(n).padStart(6)}  breach ${pct(b, n).padStart(6)}`);
    }
    console.log('');
  };
  bucketBy('nearPrice − close', (x) => pctOff(x.near, x.close));
  bucketBy('implied − close', (x) => pctOff(x.implied, x.close));
  console.log('top 15 tickers by breach rate (n >= 20):');
  for (const x of tickers.filter((x) => x.n >= 20).sort((a, b) => b.rate - a.rate).slice(0, 15)) {
    console.log(`  ${x.t.padEnd(6)} breach ${(x.rate * 100).toFixed(0).padStart(3)}% of ${String(x.n).padStart(4)}  close ${x.close}  near ${x.near} (${pctOff(x.near, x.close).toFixed(2)}%)  implied ${x.implied.toFixed(2)} (${pctOff(x.implied, x.close).toFixed(2)}%)`);
  }
  console.log('');

  // ── H8 are the Greeks stale, or are the prices? ───────────────────────────
  // Run 2: nearPrice equals the session close exactly, and the breach rate is a
  // function of how far E*Trade's delta-implied spot sits from that close (1.4 %
  // under 0.25 % off, 94 % over 3 % off). PCTY's Greeks imply 113.58 against a
  // 147.32 close. Two readings: E*Trade's Greeks were computed off a stale
  // underlying, or the option prices themselves are off. Put-call parity on the
  // quoted mids gives the spot the PRICES imply, independent of any Greek, and
  // the ticker's recent closes say whether the delta-implied spot is a price the
  // stock actually traded at on an earlier day.
  const barsBefore = db.prepare(
    `SELECT trade_date, close, low, high, MAX(observed_at) AS latest FROM raw_daily_bar
      WHERE ticker = ? AND trade_date <= ? AND trade_date >= date(?, '-45 days')
      GROUP BY trade_date ORDER BY trade_date DESC`
  );
  const paritySpot = (xs) => {
    const spots = [];
    for (const g of groupBy(xs, (m) => `${m.expiration_date}|${m.strike}`).values()) {
      const c = g.find((m) => m.right === 'call'), p = g.find((m) => m.right === 'put');
      if (!c || !p || c.dteDays < 1) continue;
      const ok = (m) => m.bid > 0 && m.ask > m.bid && (m.ask - m.bid) / ((m.ask + m.bid) / 2) <= 0.5;
      if (!ok(c) || !ok(p)) continue;
      const t = c.dteDays / 365;
      spots.push((c.bid + c.ask) / 2 - (p.bid + p.ask) / 2 + c.strike * Math.exp(-rate.yield * t));
    }
    return spots.length >= 3 ? median(spots) : null;
  };
  const withParity = tickers.map((x) => ({ ...x, parity: paritySpot(measured.filter((m) => m.ticker === x.t)) }))
    .filter((x) => x.parity !== null);
  console.log('## H8 — stale Greeks or stale prices?\n');
  console.log(`tickers with >=3 usable call/put pairs: ${withParity.length}`);
  console.log(`parity spot (from quoted mids) vs close, %  — ${quantiles(withParity.map((x) => pctOff(x.parity, x.close)))}`);
  const far = withParity.filter((x) => Math.abs(pctOff(x.implied, x.close)) >= 1);
  console.log(`  ... only tickers whose delta-implied spot is >=1% off the close (${far.length}) — ${quantiles(far.map((x) => pctOff(x.parity, x.close)))}`);
  console.log(`delta-implied spot vs parity spot, % (same tickers) — ${quantiles(far.map((x) => pctOff(x.implied, x.parity)))}\n`);

  // For each far-off ticker: the most recent earlier session whose close (or
  // intraday range) contains the delta-implied spot. A consistent lag across
  // tickers means E*Trade's Greek engine runs on an old underlying price.
  const lags = [];
  console.log('tickers whose delta-implied spot is >=1% off the close (worst 25):');
  console.log('  ticker  close      implied    parity     today low-high        nearest earlier close           sessions back');
  for (const x of [...far].sort((a, b) => Math.abs(pctOff(b.implied, b.close)) - Math.abs(pctOff(a.implied, a.close))).slice(0, 25)) {
    const bars = barsBefore.all(x.t, date, date);
    const today = bars[0]?.trade_date === date ? bars[0] : null;
    let best = null;
    bars.forEach((b, i) => {
      if (i === 0) return;
      const off = Math.abs(pctOff(x.implied, b.close));
      if (!best || off < best.off) best = { date: b.trade_date, close: b.close, off, back: i };
    });
    const inToday = today && x.implied >= today.low && x.implied <= today.high;
    if (best && best.off < 1) lags.push(best.back);
    console.log(
      `  ${x.t.padEnd(7)} ${String(x.close).padEnd(10)} ${x.implied.toFixed(2).padEnd(10)} ${x.parity.toFixed(2).padEnd(10)} ` +
      `${today ? `${today.low}-${today.high}${inToday ? ' (inside)' : ''}` : '—'}`.padEnd(22) +
      `${best ? `${best.date} ${best.close} (${best.off.toFixed(2)}% away)` : '—'}`.padEnd(32) +
      `${best ? best.back : '—'}`
    );
  }
  const lagCounts = [...groupBy(lags, (v) => v)].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k} back: ${v.length}`);
  console.log(`\nmatched an earlier close within 1%: ${lags.length} of ${Math.min(far.length, 25)} — ${lagCounts.join(', ') || 'none'}\n`);

  section('concentration — top 10 tickers by breaches', (() => {
    const g = [...groupBy(measured.filter(breach), (m) => m.ticker)].sort((a, b) => b[1].length - a[1].length).slice(0, 10);
    return g.map(([t, xs]) => `  ${t.padEnd(8)} ${xs.length} of ${measured.filter((m) => m.ticker === t).length}`).join('\n');
  })());
} finally {
  // Nothing was written; the checkpoint is a no-op, and closing through the
  // shared helper keeps this script on the same path as every other.
  checkpointAndClose(db);
}

function section(title, body) {
  console.log(`## ${title}\n\n${body}\n`);
}

function bucketTable(xs, key) {
  const g = groupBy(xs, key);
  const lines = ['  bucket          n       breach   rate    median |gap|'];
  for (const [k, v] of [...g].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    const b = v.filter((m) => m.diff > TOLERANCE).length;
    const med = median(v.map((m) => m.diff));
    lines.push(`  ${String(k).padEnd(14)} ${String(v.length).padStart(6)} ${String(b).padStart(8)}   ${pct(b, v.length).padStart(6)}  ${med.toFixed(4)}`);
  }
  return lines.join('\n');
}

function groupBy(xs, key) {
  const m = new Map();
  for (const x of xs) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

function median(xs) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function quantiles(xs) {
  if (xs.length === 0) return 'n=0';
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const f = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3));
  return `n=${s.length} p5 ${f(q(0.05))} p25 ${f(q(0.25))} median ${f(q(0.5))} p75 ${f(q(0.75))} p95 ${f(q(0.95))}`;
}

function pct(a, b) {
  return b === 0 ? '—' : `${((100 * a) / b).toFixed(1)}%`;
}
