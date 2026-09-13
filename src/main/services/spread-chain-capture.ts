// Spread chain capture — the put-side quotes a bull put spread would be built from, both legs.
//
// Data collection ONLY: nothing reads this table to decide a trade. It exists because the bull put
// spread study (NewApp/TODO.md #42–44) cannot be run honestly on what is stored today — every table
// holds the short leg alone, so the bought wing would be priced with Black-Scholes at ATM IV, and put
// skew makes that systematically too cheap, overstating exactly the credit being measured. What is
// not captured today cannot be recovered, so this starts before the study rather than after it.
//
// Two kinds of row per run (migration 083):
//   entry — tickers in this run's validated wheel/income/bullish pools, every expiry at 14–45 DTE
//   track — ticker+expiries that had an entry in the last 21 days and are unexpired, re-quoted so a
//           spread opened then can be marked daily on real quotes (the 50%-profit / loss-stop exits)
//
// Never throws: a study convenience must not be able to fail the brief it runs after.
// see migrations/083_spread_chain_capture.sql

import type { DbHandle } from '../db/connection.js';
import type { OptionContract, OptionsProvider } from './options-provider.js';
import type { BriefCandidateSlot } from './brief-candidates.js';

type ChainSource = Pick<OptionsProvider, 'getOptionsExpirations' | 'getOptionsChain'>;

export const SPREAD_CAPTURE = {
  /** Pools whose validated candidates are spread-entry candidates. */
  strategies: ['wheel', 'income', 'bullish'] as const,
  entryDteMin: 14,
  entryDteMax: 45,
  /** How long after an entry capture a ticker+expiry keeps being re-quoted (calendar days) —
   *  covers a 15-trading-day hold with room. */
  trackDays: 21,
  deltaMin: 0.03,
  deltaMax: 0.50,
  /** Fallback band when a contract has no delta: strike as a fraction of spot. */
  noDeltaStrikeMin: 0.65,
  noDeltaStrikeMax: 1.0,
  retentionDays: 730,
} as const;

/** One stored put: [strike, bid, ask, delta, ivPct, openInterest, volume]. */
export type CapturedPut = [number, number, number, number | null, number | null, number | null, number | null];

export interface SpreadCaptureResult {
  entryTickers: number;
  trackedSeries: number;
  rowsWritten: number;
  failures: Array<{ ticker: string; step: string; message: string }>;
}

/** Calendar days between two ISO dates (UTC midnight both sides — no local/UTC mixing). */
function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/**
 * The puts worth keeping from one chain. Delta band when delta is reported; a moneyness band when it
 * is not (E*Trade greeks are sometimes absent, and a missing greek must not silently drop a strike);
 * plus every strike inside `strikeRange` when the series is being tracked.
 */
export function selectPuts(
  contracts: readonly OptionContract[],
  underlying: number | null,
  strikeRange: { min: number; max: number } | null,
): CapturedPut[] {
  const P = SPREAD_CAPTURE;
  const out: CapturedPut[] = [];
  for (const c of contracts) {
    if (c.side !== 'put' || !(c.strike > 0)) continue;
    let keep = false;
    if (c.delta != null && Number.isFinite(c.delta)) {
      const d = Math.abs(c.delta);
      keep = d >= P.deltaMin && d <= P.deltaMax;
    } else if (underlying != null && underlying > 0) {
      const m = c.strike / underlying;
      keep = m >= P.noDeltaStrikeMin && m <= P.noDeltaStrikeMax;
    }
    if (!keep && strikeRange) keep = c.strike >= strikeRange.min && c.strike <= strikeRange.max;
    if (!keep) continue;
    // E*Trade IV arrives as a decimal fraction; stored as a percentage (CLAUDE.md financial conventions).
    const ivPct = Number.isFinite(c.iv) && c.iv > 0 ? Math.round(c.iv * 100 * 100) / 100 : null;
    out.push([c.strike, c.bid, c.ask, c.delta ?? null, ivPct, c.openInterest ?? null, c.volume ?? null]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Capture this run's spread chains. Reads the latest brief run's candidate pools and the recent
 * entry captures, fetches each chain once, and replaces this slot's rows.
 */
export async function captureSpreadChains(deps: {
  readonly db: DbHandle;
  readonly provider: ChainSource;
  readonly slot: BriefCandidateSlot;
  readonly now?: Date;
}): Promise<SpreadCaptureResult> {
  const { db, provider, slot } = deps;
  const P = SPREAD_CAPTURE;
  const now = deps.now ?? new Date();
  const todayEt = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const result: SpreadCaptureResult = { entryTickers: 0, trackedSeries: 0, rowsWritten: 0, failures: [] };

  try {
    // ── entry pool: the latest brief run's validated candidates ─────────────────────────────────
    const marks = P.strategies.map(() => '?').join(',');
    const latest = db.prepare(
      `SELECT generated_at FROM brief_candidates WHERE strategy IN (${marks}) ORDER BY generated_at DESC LIMIT 1`,
    ).get(...P.strategies) as { generated_at: string } | undefined;
    const entryTickers = latest
      ? (db.prepare(
          `SELECT DISTINCT ticker FROM brief_candidates
            WHERE generated_at = ? AND strategy IN (${marks}) AND disposition IN ('picked', 'capped_out')
            ORDER BY ticker`,
        ).all(latest.generated_at, ...P.strategies) as Array<{ ticker: string }>).map(r => r.ticker)
      : [];
    result.entryTickers = entryTickers.length;

    // ── track set: recent entry series that have not expired ───────────────────────────────────
    const since = new Date(Date.parse(`${todayEt}T00:00:00Z`) - P.trackDays * 86_400_000).toISOString().slice(0, 10);
    const tracked = db.prepare(
      `SELECT ticker, expiration, puts_json FROM spread_chain_capture
        WHERE reason = 'entry' AND as_of_date >= ? AND as_of_date < ? AND expiration >= ?
        ORDER BY as_of_date`,
    ).all(since, todayEt, todayEt) as Array<{ ticker: string; expiration: string; puts_json: string }>;

    // ticker+expiry → the widest strike range any entry capture held
    const trackRange = new Map<string, { min: number; max: number }>();
    for (const t of tracked) {
      let puts: CapturedPut[] = [];
      try { puts = JSON.parse(t.puts_json) as CapturedPut[]; } catch { continue; }
      if (puts.length === 0) continue;
      const key = `${t.ticker}|${t.expiration}`;
      const lo = Math.min(...puts.map(p => p[0]));
      const hi = Math.max(...puts.map(p => p[0]));
      const cur = trackRange.get(key);
      trackRange.set(key, cur ? { min: Math.min(cur.min, lo), max: Math.max(cur.max, hi) } : { min: lo, max: hi });
    }
    result.trackedSeries = trackRange.size;

    // ── work list: ticker → expiries (entry expiries need a listing call; tracked ones do not) ──
    const work = new Map<string, Map<string, 'entry' | 'track'>>();
    for (const ticker of entryTickers) {
      try {
        const exps = await provider.getOptionsExpirations(ticker);
        const inWindow = exps.filter(e => {
          const d = daysBetween(todayEt, e);
          return d >= P.entryDteMin && d <= P.entryDteMax;
        });
        if (inWindow.length === 0) continue;
        const m = work.get(ticker) ?? new Map<string, 'entry' | 'track'>();
        for (const e of inWindow) m.set(e, 'entry');
        work.set(ticker, m);
      } catch (e) {
        result.failures.push({ ticker, step: 'expirations', message: errText(e) });
      }
    }
    for (const key of trackRange.keys()) {
      const [ticker, expiration] = key.split('|') as [string, string];
      const m = work.get(ticker) ?? new Map<string, 'entry' | 'track'>();
      if (!m.has(expiration)) m.set(expiration, 'track'); // an entry today wins the label
      work.set(ticker, m);
    }

    // ── fetch + store ────────────────────────────────────────────────────────────────────────
    const insert = db.prepare(`
      INSERT OR REPLACE INTO spread_chain_capture
        (as_of_date, slot, captured_at, ticker, expiration, dte, reason, underlying_price, contract_count, puts_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [ticker, exps] of work) {
      for (const [expiration, reason] of exps) {
        try {
          const chain = await provider.getOptionsChain(ticker, expiration);
          const puts = selectPuts(chain.contracts, chain.underlyingPrice, trackRange.get(`${ticker}|${expiration}`) ?? null);
          if (puts.length === 0) continue;
          insert.run(
            todayEt, slot, new Date().toISOString(), ticker, expiration, daysBetween(todayEt, expiration), reason,
            chain.underlyingPrice, puts.length, JSON.stringify(puts),
          );
          result.rowsWritten++;
        } catch (e) {
          result.failures.push({ ticker, step: `chain ${expiration}`, message: errText(e) });
        }
      }
    }

    const cutoff = new Date(Date.parse(`${todayEt}T00:00:00Z`) - P.retentionDays * 86_400_000).toISOString().slice(0, 10);
    db.prepare('DELETE FROM spread_chain_capture WHERE as_of_date < ?').run(cutoff);
  } catch (e) {
    result.failures.push({ ticker: '*', step: 'capture', message: errText(e) });
  }
  return result;
}
