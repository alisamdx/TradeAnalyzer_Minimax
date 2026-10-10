// Read-only access to the running TradeAnalyzer's local API, for the analysis scripts.
//
// Scripts must never open trade-analyzer.sqlite themselves. Claude Code's shell is
// MSIX-redirected, and opening a WAL database from a redirected shell MOVES it (CLAUDE.md).
// Everything here goes through 127.0.0.1 with the agent token instead.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = join(homedir(), '.tradeanalyzer');
let PORT = '7432';
try { PORT = readFileSync(join(DATA_DIR, 'api.port'), 'utf8').trim() || PORT; } catch { /* default */ }
const API = `http://127.0.0.1:${PORT}/api/v1`;

function token() {
  try { return readFileSync(join(DATA_DIR, 'agent.token'), 'utf8').trim(); }
  catch { console.error(`No agent token at ${join(DATA_DIR, 'agent.token')} — start TradeAnalyzer once.`); process.exit(1); }
}

/** GET an API path and return `data`. Exits with a clear message when the app is not running. */
export async function apiGet(path) {
  const res = await fetch(`${API}${path}`, { headers: { 'X-Agent-Token': token() } }).catch((err) => {
    console.error(`API server not reachable on 127.0.0.1:${PORT} — TradeAnalyzer must be RUNNING. (${err.message})`);
    process.exit(1);
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    console.error(`GET ${path} failed: HTTP ${res.status} ${body?.error ?? ''}`);
    if (res.status === 404 && body?.code !== 'NOT_FOUND') console.error('The running app predates this route — install the current build.');
    process.exit(1);
  }
  return body.data;
}

/**
 * Stored daily_briefs rows, shaped like the old `SELECT strategy, generated_at, picks` so the
 * scripts' loops are unchanged. With `liquidityLog: true` also returns structure_liquidity_log
 * (null when the table cannot be read).
 */
export async function loadBriefHistory({ strategy, liquidityLog = false } = {}) {
  const q = new URLSearchParams();
  if (strategy) q.set('strategy', strategy);
  if (liquidityLog) q.set('liquidityLog', '1');
  const data = await apiGet(`/diagnostics/brief-history-panel${q.size ? `?${q}` : ''}`);
  return {
    briefs: data.briefs.map((b) => ({ strategy: b.strategy, generated_at: b.generatedAt, picks: b.picks })),
    liquidityLog: data.liquidityLog === null ? null : data.liquidityLog.map((r) => ({
      captured_at: r.capturedAt, date_et: r.dateEt, ticker: r.ticker, slug: r.slug,
      liquidity_score: r.liquidityScore, no_bid_leg: r.noBidLeg,
    })),
  };
}

/**
 * Daily closes per ticker in [from, to] (and iv_history with `iv: true`), as
 * `{ maxPx, bars: { T: [{date, close}] }, iv: { T: [{date, atm_iv}] } | null }`. Tickers are
 * sent in batches so a long panel never builds an oversized URL.
 */
export async function loadPriceSeries(tickers, { from, to, iv = false } = {}) {
  const out = { maxPx: null, bars: {}, iv: iv ? {} : null };
  const list = [...new Set(tickers)];
  for (let i = 0; i < list.length; i += 200) {
    const q = new URLSearchParams({ tickers: list.slice(i, i + 200).join(',') });
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (iv) q.set('iv', '1');
    const data = await apiGet(`/diagnostics/price-series?${q}`);
    out.maxPx = data.maxPx;
    for (const [t, rows] of Object.entries(data.bars)) out.bars[t] = rows.map(([date, close]) => ({ date, close }));
    if (iv) for (const [t, rows] of Object.entries(data.iv)) out.iv[t] = rows.map(([date, atm_iv]) => ({ date, atm_iv }));
  }
  return out;
}

/** MAX(date) in historical_prices, without fetching any series. */
export async function latestPriceDate() {
  return (await apiGet('/diagnostics/price-series?tickers=SPY&from=9999-01-01')).maxPx;
}
