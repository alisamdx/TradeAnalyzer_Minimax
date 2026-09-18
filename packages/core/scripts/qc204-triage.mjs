#!/usr/bin/env node
/**
 * Triage the open QC-204 discontinuities — the evidence for a ruling, per finding.
 *
 *   node packages/core/scripts/qc204-triage.mjs --latest [--csv out.csv] [--all]
 *   node packages/core/scripts/qc204-triage.mjs --snapshot PATH
 *
 * A price step has THREE causes and only one is repairable, so the ruling needs
 * different evidence for each (CLAUDE.md, v1.1.139-141):
 *
 *   1. UNADJUSTED SPLIT  — re-fetch the whole range. The step-day intraday RANGE
 *      is normal (~2-5 %), because open/high/low/close are all already in the new
 *      scale, and the ratio sits on a clean split fraction.
 *   2. GENUINE MOVE      — the data is correct; accept with a 30-day TTL, because
 *      providers backfill corporate actions late. Wide step-day range.
 *   3. TICKER REUSE      — no re-fetch can fix it; truncate before the splice.
 *      Volume regime shifts >= 15x permanently.
 *
 * **Discriminate with VOLUME, not price.** Reuse moves the volume regime by
 * orders of magnitude (BNY 76x, SPCX 53,592x) while a genuine move stays <= 5x.
 * And note what is NOT evidence: "steps and stays" does not imply a split — a
 * permanent repricing on news looks identical on price alone, which is how MRNA
 * was once called a reverse split and was wrong.
 *
 * So this prints the numbers and suggests a bucket; it does not rule. The
 * `suggests` column is a sort order for a human, never a verdict, and every
 * number behind it is on the same line.
 *
 * READ ONLY, and only ever against a SNAPSHOT (`POST /diagnostics/generation-snapshot`,
 * or `rehearse-gate.mjs` leaves one behind). It refuses a live generation.
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const SNAP_DIR = join(homedir(), '.tradeanalyzer', 'rehearsal');
let snapshotPath = argOf('--snapshot');
if (!snapshotPath && args.includes('--latest')) {
  const files = existsSync(SNAP_DIR)
    ? readdirSync(SNAP_DIR).filter((f) => /^gen-\d{3}-.*\.sqlite$/.test(f)).sort()
    : [];
  if (files.length === 0) {
    console.error(`No snapshot in ${SNAP_DIR}. Take one with rehearse-gate.mjs, or pass --snapshot.`);
    process.exit(1);
  }
  snapshotPath = join(SNAP_DIR, files[files.length - 1]);
}
if (!snapshotPath) {
  console.error('Usage: node packages/core/scripts/qc204-triage.mjs --latest | --snapshot PATH');
  process.exit(2);
}
// Never the live generation: this shell may be containerised, and opening it there
// moves it rather than reading it.
if (/[\\/]AppData[\\/]/i.test(snapshotPath) || basename(snapshotPath) === 'data.sqlite') {
  console.error(`Refusing ${snapshotPath}: that looks like a live generation. Triage only a snapshot.`);
  process.exit(2);
}
if (!existsSync(snapshotPath)) {
  console.error(`No file at ${snapshotPath}.`);
  process.exit(1);
}

let db;
try {
  const Database = createRequire(import.meta.url)('better-sqlite3');
  db = new Database(snapshotPath, { fileMustExist: true, readonly: true });
} catch (err) {
  if (/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED/.test(String(err?.message ?? err))) {
    console.error('better-sqlite3 is built for Electron right now. Run `npm run rebuild:node`, then this again.');
    process.exit(6);
  }
  throw err;
}

/** The ratios a real split actually takes. A free-floating fraction fits anything. */
const SPLIT_RATIOS = [
  [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [10, 1], [20, 1],
  [3, 2], [5, 4], [5, 2], [7, 5], [4, 3]
];
const CANDIDATES = SPLIT_RATIOS.flatMap(([a, b]) => [
  { label: `${a}:${b}`, value: a / b },
  { label: `1:${a / b === Math.round(a / b) ? a / b : `${a}/${b}`}`, value: b / a }
]);

function nearestSplitRatio(r) {
  let best = null;
  for (const c of CANDIDATES) {
    const err = Math.abs(r - c.value) / c.value;
    if (best === null || err < best.err) best = { label: c.label, value: c.value, err };
  }
  return best;
}

const fmt = (v, d = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
const fmtVol = (v) =>
  v === null || v === undefined ? '—' : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : String(Math.round(v));

const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

try {
  const findings = db
    .prepare(
      `SELECT key, detail FROM qa_exception
        WHERE check_id = 'QC-204' AND state = 'open' AND still_firing = 1
        ORDER BY key`
    )
    .all();

  if (findings.length === 0) {
    console.log('No open QC-204 findings in this snapshot.');
    process.exit(0);
  }

  // Which STEPS QC-205 / QC-209 independently flagged. Those checks measure the
  // reuse and dormancy signatures directly, so agreement is worth far more than
  // this script's own arithmetic.
  //
  // Keyed on `ticker date`, never on ticker alone. A reuse event happens on ONE
  // date: keying by ticker let BMNR's single splice mark all 26 of its steps as
  // reuse, when their own volume ratios run 0.27-3.94. The other 25 are the
  // shell's internal volatility, which is the SOLS shape — and calling them
  // reuse is the over-broad inference this triage exists to avoid.
  const flaggedKeys = (checkId) =>
    new Set(
      db
        .prepare(
          `SELECT key FROM qa_exception WHERE check_id = ? AND state = 'open' AND still_firing = 1`
        )
        .all(checkId)
        .map((r) => String(r.key))
    );
  const reuseKeys = flaggedKeys('QC-205');
  const dormantKeys = flaggedKeys('QC-209');
  const tickersWithReuse = new Set([...reuseKeys].map((k) => k.split(' ')[0]));
  const tickersWithDormancy = new Set([...dormantKeys].map((k) => k.split(' ')[0]));

  /**
   * Below this the security barely trades, so a price step in it is not data
   * about a company — it is the bid-ask of a shell. BMNR printed 18 shares a
   * day before it became an Ethereum treasury; SOLS was a $0.0001 shell until
   * Solstice listed into it. No re-fetch changes either, and they should be
   * ruled as one class rather than 47 times.
   */
  const SHELL_VOLUME = 5000;

  const tickers = [...new Set(findings.map((f) => String(f.key).split(' ')[0]))];
  const sessions = db
    .prepare('SELECT date FROM ref_trading_day WHERE is_trading_day = 1 ORDER BY date')
    .all()
    .map((r) => r.date);
  const sessionIndex = new Map(sessions.map((d, i) => [d, i]));

  // Latest observation per (ticker, trade_date) — a re-fetched series is read at
  // its current version, exactly as QC-204 reads it.
  const barsFor = db.prepare(
    `SELECT b.trade_date, b.open, b.high, b.low, b.close, b.volume
       FROM raw_daily_bar b
       JOIN (SELECT ticker, trade_date, MAX(observed_at) AS latest
               FROM raw_daily_bar WHERE ticker = ? GROUP BY ticker, trade_date) m
         ON m.trade_date = b.trade_date AND m.latest = b.observed_at
      WHERE b.ticker = ?
      ORDER BY b.trade_date`
  );

  const series = new Map();
  for (const t of tickers) series.set(t, barsFor.all(t, t));

  const rows = [];
  for (const f of findings) {
    const [ticker, date] = String(f.key).split(' ');
    const bars = series.get(ticker) ?? [];
    const i = bars.findIndex((b) => b.trade_date === date);
    if (i <= 0) {
      rows.push({ ticker, date, note: 'step bar not found in the stored series' });
      continue;
    }
    const cur = bars[i];
    const prev = bars[i - 1];
    const ratio = cur.close / prev.close;
    const near = nearestSplitRatio(ratio);

    // The split tell: OHLC are all already in the new scale on the step day, so
    // the day's own range is ordinary. A wide range means the move happened.
    const rangePct = cur.close > 0 ? (cur.high - cur.low) / cur.close : null;

    const before = bars.slice(Math.max(0, i - 20), i).map((b) => b.volume).filter((v) => typeof v === 'number');
    // The step day itself belongs to the AFTER regime: under reuse the new
    // entity's first session is the step.
    const after = bars.slice(i, i + 20).map((b) => b.volume).filter((v) => typeof v === 'number');
    const medBefore = median(before);
    const medAfter = median(after);
    const volRatio = medBefore && medBefore > 0 && medAfter !== null ? medAfter / medBefore : null;

    // Dormancy: sessions the exchange held between the two bars, and how much of
    // the preceding window actually traded.
    const gapSessions =
      sessionIndex.has(prev.trade_date) && sessionIndex.has(date)
        ? sessionIndex.get(date) - sessionIndex.get(prev.trade_date) - 1
        : null;
    const priorWindow = sessionIndex.has(date)
      ? sessions.slice(Math.max(0, sessionIndex.get(date) - 20), sessionIndex.get(date))
      : [];
    const priorTraded = priorWindow.filter((d) => bars.some((b) => b.trade_date === d)).length;

    const splitKnown = db
      .prepare('SELECT COUNT(*) AS n FROM raw_split WHERE ticker = ?')
      .get(ticker).n;

    // Order matters: the two checks that measure their signature directly are
    // believed first, and only on the step they actually flagged.
    const key = `${ticker} ${date}`;
    const thinBefore = medBefore !== null && medBefore < SHELL_VOLUME;
    const thinAfter = medAfter !== null && medAfter < SHELL_VOLUME;

    let suggests;
    if (reuseKeys.has(key)) suggests = 'reuse (QC-205)';
    else if (dormantKeys.has(key)) suggests = 'dormant-resume (QC-209)';
    else if (volRatio !== null && volRatio >= 15) suggests = 'reuse?';
    else if (gapSessions !== null && gapSessions >= 20) suggests = 'dormant-resume?';
    else if (thinBefore && thinAfter) suggests = 'illiquid-shell';
    else if (near.err <= 0.02 && rangePct !== null && rangePct <= 0.08 &&
             volRatio !== null && volRatio >= 1 / 3 && volRatio <= 3) suggests = 'split?';
    else if (rangePct !== null && rangePct >= 0.15) suggests = 'move?';
    else if (volRatio !== null && volRatio <= 5) suggests = 'move?';
    else suggests = 'unclear';

    rows.push({
      ticker, date,
      prevClose: prev.close, close: cur.close,
      stepPct: (ratio - 1) * 100,
      ratio,
      nearestSplit: near.label,
      splitErrPct: near.err * 100,
      rangePct: rangePct === null ? null : rangePct * 100,
      medVolBefore: medBefore, medVolAfter: medAfter, volRatio,
      gapSessions, priorTraded,
      splitsOnRecord: splitKnown,
      alsoQc205: tickersWithReuse.has(ticker), alsoQc209: tickersWithDormancy.has(ticker),
      suggests
    });
  }

  console.log(`# QC-204 triage — ${findings.length} open findings, ${tickers.length} tickers`);
  console.log(`snapshot ${snapshotPath}\n`);

  const buckets = new Map();
  for (const r of rows) buckets.set(r.suggests, (buckets.get(r.suggests) ?? 0) + 1);
  console.log('## What the evidence suggests (a sort order, not a ruling)');
  for (const [k, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(k).padEnd(16)} ${String(n).padStart(4)}`);
  }

  const byTicker = new Map();
  for (const r of rows) {
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    byTicker.get(r.ticker).push(r);
  }
  console.log(`\n## Tickers with the most steps (one ruling may cover the lot)`);
  for (const [t, rs] of [...byTicker.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 14)) {
    const typical = median(rs.map((r) => r.medVolBefore).filter((v) => typeof v === 'number'));
    console.log(
      `  ${t.padEnd(8)} ${String(rs.length).padStart(3)} steps   median vol ${String(fmtVol(typical)).padStart(7)}   ` +
        `${[...new Set(rs.map((r) => r.suggests))].join(', ')}`
    );
  }

  const show = args.includes('--all') ? rows : rows.slice(0, 40);
  console.log(`\n## Findings${args.includes('--all') ? '' : ' (first 40; --all for every one)'}\n`);
  console.log(
    'ticker   date         step%    ratio  ~split  err%  rng%   vol before→after   ratio  gap  20d  suggests'
  );
  for (const r of show) {
    if (r.note) { console.log(`${r.ticker.padEnd(8)} ${r.date}   ${r.note}`); continue; }
    console.log(
      `${r.ticker.padEnd(8)} ${r.date}  ${fmt(r.stepPct, 1).padStart(7)}  ${fmt(r.ratio, 3).padStart(6)}  ` +
      `${String(r.nearestSplit).padStart(6)} ${fmt(r.splitErrPct, 1).padStart(5)} ${fmt(r.rangePct, 1).padStart(5)}  ` +
      `${fmtVol(r.medVolBefore).padStart(7)}→${fmtVol(r.medVolAfter).padEnd(7)} ${fmt(r.volRatio, 2).padStart(7)}  ` +
      `${String(r.gapSessions ?? '—').padStart(3)}  ${String(r.priorTraded).padStart(3)}  ${r.suggests}` +
      `${r.alsoQc205 ? ' +QC205' : ''}${r.alsoQc209 ? ' +QC209' : ''}`
    );
  }

  const csv = argOf('--csv');
  if (csv) {
    const cols = Object.keys(rows.find((r) => !r.note) ?? rows[0]);
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map((c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))).join(','));
    writeFileSync(csv, lines.join('\n'), 'utf8');
    console.log(`\nwrote ${csv}`);
  }

  console.log(
    '\nColumns: rng% = the step day\'s own high-low range over its close — narrow means the OHLC were\n' +
    'already in the new scale (split), wide means the move happened. vol ratio = median volume of the\n' +
    '20 bars from the step onward over the 20 before; >= 15 is the reuse signature, <= 5 a genuine move.\n' +
    'gap = exchange sessions with no bar before the step. 20d = how many of the previous 20 sessions traded.'
  );
} finally {
  db.close();
}
