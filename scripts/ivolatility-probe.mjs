// IVolatility IVX endpoint probe — the pre-purchase checks for NewApp's
// `bootstrap_iv` one-shot job (NewApp 04 §7.3, §11).
//
//   IVOL_API_KEY=<key> node scripts/ivolatility-probe.mjs [SYMBOL ...]
//
// The key comes from the environment, never from an argument: a command line is
// visible to every process on the machine and lands in shell history, while an
// env var set for one invocation does neither. It is used and never printed —
// every response body is scrubbed of it before display, so an error echoing the
// request URL cannot leak it either.
//
// Why not read the stored key from the app's settings? It is encrypted with
// Electron's safeStorage, whose OSCrypt master key resolves per app identity —
// a bare `electron.exe` gets a different one and fails to decrypt, even pointed
// at the same userData directory. Measured 2026-09-07: the stored ciphertext is
// intact (v10 header, 47 bytes -> a 16-character key) and a self round-trip in
// the probe process succeeds, so the value is fine and simply unreadable from
// outside the packaged app. The app's own Test API screen reads it natively.

const BASE = 'https://restapi.ivolatility.com';
const KEY = process.env.IVOL_API_KEY ?? '';

if (!KEY) {
  console.error('Set IVOL_API_KEY. Example:\n  IVOL_API_KEY=xxxx node scripts/ivolatility-probe.mjs SPY AAPL DINO');
  process.exit(2);
}

const scrub = (t) => String(t).split(KEY).join('<APIKEY>');
const iso = (d) => d.toISOString().slice(0, 10);

async function get(path, params) {
  const qs = new URLSearchParams({ ...params, apiKey: KEY }).toString();
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${path}?${qs}`);
    const text = await res.text();
    return { status: res.status, ms: Date.now() - t0, text };
  } catch (err) {
    return { status: null, ms: Date.now() - t0, text: scrub(err.message) };
  }
}

/** The row list, whether the payload is a bare array or wrapped. */
function rowsOf(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { rows: null, note: 'not JSON' }; }
  if (Array.isArray(parsed)) return { rows: parsed, note: 'bare array' };
  for (const k of ['data', 'rows', 'result', 'records']) {
    if (Array.isArray(parsed[k])) return { rows: parsed[k], note: `wrapped in .${k}` };
  }
  return { rows: null, note: `object with keys ${JSON.stringify(Object.keys(parsed).slice(0, 10))}` };
}

const dateOf = (r) => r.date ?? r.Date ?? r.tradeDate ?? r.trade_date ?? null;

const symbols = process.argv.slice(2).length ? process.argv.slice(2) : ['SPY', 'AAPL', 'DINO'];
const today = new Date();
const from = iso(new Date(today.getTime() - 400 * 86_400_000));
const to = iso(today);

console.log(`IVolatility IVX probe — ${from} .. ${to}\n`);

let first = true;
for (const symbol of symbols) {
  const r = await get('/equities/eod/ivx', { symbol, from, to });
  const { rows, note } = rowsOf(r.text);

  if (!Array.isArray(rows)) {
    console.log(`${symbol.padEnd(6)} status ${r.status} (${r.ms}ms) — ${note}`);
    console.log(`        body: ${scrub(r.text).slice(0, 300)}\n`);
    continue;
  }

  const dates = rows.map(dateOf).filter(Boolean).sort();
  const newest = dates[dates.length - 1];
  // The number the purchase decision turns on: an EOD series that lags by days
  // cannot supply the tail of an overlap window that ends today.
  const lag = newest
    ? Math.round((Date.parse(to) - Date.parse(newest)) / 86_400_000)
    : null;

  console.log(
    `${symbol.padEnd(6)} status ${r.status} (${r.ms}ms) ${String(rows.length).padStart(4)} rows, ` +
      `${dates[0]} .. ${newest}, lag ${lag}d, ${note}`
  );

  if (first && rows.length) {
    first = false;
    console.log(`\n  fields: ${JSON.stringify(Object.keys(rows[0]))}`);
    console.log(`  newest row: ${JSON.stringify(rows[rows.length - 1])}`);

    const vals = rows.map((x) => x.iv30 ?? x.IV30).filter((v) => typeof v === 'number');
    if (vals.length) {
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      // NewApp stores fractions (02 §0.1). The EXISTING app multiplies by 100
      // because it stores percentages — carrying that habit across would
      // inflate every bootstrap row a hundredfold, so the scale is asserted
      // here rather than assumed.
      console.log(
        `  iv30: n=${vals.length} min=${min} max=${max} -> ` +
          `${max <= 3 ? 'DECIMAL FRACTION (store as-is, NO x100)' : 'PERCENTAGE (divide by 100)'}`
      );
    } else {
      console.log('  iv30: no numeric iv30 field — check the field names above');
    }

    // Internal gaps say whether one call really covers a year, or whether the
    // plan silently truncates the window the way bulk endpoints tend to.
    const uniq = [...new Set(dates)];
    console.log(`  distinct dates: ${uniq.length} over ${dates.length} rows\n`);
  }
}

console.log('\n--- unknown symbol, to see how "no data" presents ---');
const bad = await get('/equities/eod/ivx', { symbol: 'ZZZZQQ', from, to });
console.log(`status ${bad.status}: ${scrub(bad.text).slice(0, 200)}`);
