// Spread chain capture — the put-side quotes a bull put spread would be built from, both legs.
//
// Data collection ONLY: nothing reads this table to decide a trade. It exists because the bull put
// spread study (NewApp/TODO.md #42–44) cannot be run honestly on what is stored today — every table
// holds the short leg alone, so the bought wing would be priced with Black-Scholes at ATM IV, and put
// skew makes that systematically too cheap, overstating exactly the credit being measured. What is
// not captured today cannot be recovered, so this starts before the study rather than after it.
//
// Three kinds of row per run (migrations 083, 093):
//   entry — tickers in this run's validated wheel/income/bullish pools, every expiry at 14–45 DTE
//   track — ticker+expiries that had an entry in the last 21 days and are unexpired, re-quoted so a
//           spread opened then can be marked daily on real quotes (the 50%-profit / loss-stop exits);
//           plus every unexpired series a spread-mode pick opened, until it expires (v1.1.290)
//   coverage — intraday only: one chain for up to 15 wheel REPLAY tickers the bull put spread study
//           cannot yet price from real quotes (v1.1.357, BPS-14). The replay set is fixed, so the
//           pools alone stopped raising the study's quoted coverage. Never an entry, never tracked.
//
// Never throws: a study convenience must not be able to fail the brief it runs after.
// see migrations/083_spread_chain_capture.sql

import type { DbHandle } from '../db/connection.js';
import type { OptionContract, OptionsProvider } from './options-provider.js';
import type { BriefCandidateSlot } from './brief-candidates.js';
import { resolvePoolTickers } from './spread-pools.js';

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
  /** Coverage chains per intraday run (BPS-14) — about 2 E*Trade calls each. */
  coverageMaxTickers: 15,
  /** Coverage expiration lookups per run, so tickers E*Trade cannot serve cannot starve the rest. */
  coverageMaxAttempts: 25,
  /** A ticker given a coverage chain within this many calendar days is not asked again. */
  coverageRetryDays: 7,
  /** The study's quote rule: ≥ 3 intraday half-spreads, short-leg puts in this |delta| band. */
  coverageMinQuotes: 3,
  coverageDeltaMin: 0.1,
  coverageDeltaMax: 0.4,
} as const;

/**
 * Intraday quotes per ticker, counted exactly as `scripts/fr-bull-put-spread-study.mjs` counts them
 * (`loadQuotedSlip`): a `brief_candidates` intraday row with bid > 0 and ask ≥ bid, plus each
 * intraday captured put with |delta| 0.1–0.4 and a two-sided quote. If the two definitions drift,
 * coverage capture keeps asking for tickers the study already counts, or stops before it does.
 */
export function intradayQuoteCounts(db: DbHandle): Map<string, number> {
  const P = SPREAD_CAPTURE;
  const n = new Map<string, number>();
  const add = (t: string): void => { n.set(t, (n.get(t) ?? 0) + 1); };
  for (const r of db.prepare(
    `SELECT ticker, bid, ask FROM brief_candidates WHERE slot = 'intraday' AND bid > 0 AND ask > 0`,
  ).all() as Array<{ ticker: string; bid: number; ask: number }>) {
    if (r.ask >= r.bid) add(r.ticker);
  }
  for (const r of db.prepare(
    `SELECT ticker, puts_json FROM spread_chain_capture WHERE slot = 'intraday'`,
  ).all() as Array<{ ticker: string; puts_json: string }>) {
    let puts: CapturedPut[] = [];
    try { puts = JSON.parse(r.puts_json) as CapturedPut[]; } catch { continue; }
    for (const p of puts) {
      const d = p[3];
      if (d == null || Math.abs(d) < P.coverageDeltaMin || Math.abs(d) > P.coverageDeltaMax) continue;
      if (p[1] > 0 && p[2] >= p[1]) add(r.ticker);
    }
  }
  return n;
}

/**
 * Wheel replay tickers (the study's fixed entry set) with fewer than three intraday quotes, most
 * replay entries first — the order that moves the study's entry coverage fastest. Tickers given a
 * coverage chain in the last `coverageRetryDays` are left out: if that chain did not yield three
 * usable quotes, asking again tomorrow will not either.
 */
export function coverageCandidates(db: DbHandle, todayEt: string): string[] {
  const P = SPREAD_CAPTURE;
  let replay: Array<{ ticker: string; n: number }>;
  try {
    replay = db.prepare(
      `SELECT ro.ticker AS ticker, COUNT(DISTINCT rb.as_of_date) AS n
         FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id = ro.replay_brief_id
        WHERE rb.strategy = 'wheel' GROUP BY ro.ticker ORDER BY n DESC, ro.ticker`,
    ).all() as Array<{ ticker: string; n: number }>;
  } catch {
    return []; // no replay tables: nothing to cover
  }
  const counts = intradayQuoteCounts(db);
  const since = new Date(Date.parse(`${todayEt}T00:00:00Z`) - P.coverageRetryDays * 86_400_000).toISOString().slice(0, 10);
  const recent = new Set((db.prepare(
    `SELECT DISTINCT ticker FROM spread_chain_capture WHERE reason = 'coverage' AND as_of_date >= ?`,
  ).all(since) as Array<{ ticker: string }>).map(r => r.ticker));
  return replay
    .filter(r => (counts.get(r.ticker) ?? 0) < P.coverageMinQuotes && !recent.has(r.ticker))
    .map(r => r.ticker);
}

/** One stored put: [strike, bid, ask, delta, ivPct, openInterest, volume]. */
export type CapturedPut = [number, number, number, number | null, number | null, number | null, number | null];

export type CaptureReason = 'entry' | 'track' | 'coverage';

export interface SpreadCaptureResult {
  entryTickers: number;
  trackedSeries: number;
  /** Replay tickers given a 'coverage' chain this run (intraday only, BPS-14). */
  coverageTickers: number;
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
  const result: SpreadCaptureResult = { entryTickers: 0, trackedSeries: 0, coverageTickers: 0, rowsWritten: 0, failures: [] };

  try {
    // ── entry pool: the latest brief run's validated candidates ─────────────────────────────────
    const marks = P.strategies.map(() => '?').join(',');
    const latest = db.prepare(
      `SELECT generated_at FROM brief_candidates WHERE strategy IN (${marks}) ORDER BY generated_at DESC LIMIT 1`,
    ).get(...P.strategies) as { generated_at: string } | undefined;
    const briefTickers = latest
      ? (db.prepare(
          `SELECT DISTINCT ticker FROM brief_candidates
            WHERE generated_at = ? AND strategy IN (${marks}) AND disposition IN ('picked', 'capped_out')
            ORDER BY ticker`,
        ).all(latest.generated_at, ...P.strategies) as Array<{ ticker: string }>).map(r => r.ticker)
      : [];

    // The `premium` pool is not a brief strategy, so its tickers are not in `brief_candidates` and would
    // be missed here (08 S12, v1.1.302). Without their chains that arm builds nothing and reads as a
    // screen with no candidates rather than as the plumbing gap it would be — which is exactly why the
    // resolver is shared with `spread-mode.ts` rather than reimplemented on each side.
    // Union, so a name both a brief and the premium ranking like is fetched once.
    const entryTickers = [...new Set([...briefTickers, ...resolvePoolTickers(db, 'premium')])].sort();
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

    // Spread-mode picks are held to the profit target or EXPIRY (no time stop), at 21–35 DTE — longer
    // than `trackDays`. Their series are tracked until they expire, whenever they were picked, and
    // always across both legs' strikes, or a pick's last ~2 weeks could never be marked (v1.1.290).
    // The top-N cut's losers too (v1.1.327): they are settled as BPS-10's counterfactual, and a series
    // dropped from tracking after 21 days could not be marked for its last week or so.
    const picked = db.prepare(
      `SELECT ticker, expiration, MIN(long_strike) AS lo, MAX(short_strike) AS hi FROM spread_mode_picks
        WHERE (outcome = 'pick' OR (outcome = 'rejected' AND reason LIKE 'ranked below the top%'))
          AND expiration >= ? AND as_of_date <= ?
        GROUP BY ticker, expiration`,
    ).all(todayEt, todayEt) as Array<{ ticker: string; expiration: string; lo: number | null; hi: number | null }>;
    for (const p of picked) {
      if (p.lo == null || p.hi == null) continue;
      const key = `${p.ticker}|${p.expiration}`;
      const cur = trackRange.get(key);
      trackRange.set(key, cur ? { min: Math.min(cur.min, p.lo), max: Math.max(cur.max, p.hi) } : { min: p.lo, max: p.hi });
    }
    result.trackedSeries = trackRange.size;

    // ── work list: ticker → expiries (entry expiries need a listing call; tracked ones do not) ──
    const work = new Map<string, Map<string, CaptureReason>>();
    for (const ticker of entryTickers) {
      try {
        const exps = await provider.getOptionsExpirations(ticker);
        const inWindow = exps.filter(e => {
          const d = daysBetween(todayEt, e);
          return d >= P.entryDteMin && d <= P.entryDteMax;
        });
        if (inWindow.length === 0) continue;
        const m = work.get(ticker) ?? new Map<string, CaptureReason>();
        for (const e of inWindow) m.set(e, 'entry');
        work.set(ticker, m);
      } catch (e) {
        result.failures.push({ ticker, step: 'expirations', message: errText(e) });
      }
    }
    for (const key of trackRange.keys()) {
      const [ticker, expiration] = key.split('|') as [string, string];
      const m = work.get(ticker) ?? new Map<string, CaptureReason>();
      if (!m.has(expiration)) m.set(expiration, 'track'); // an entry today wins the label
      work.set(ticker, m);
    }

    // ── coverage: replay tickers the study cannot yet price from real quotes (BPS-14) ───────────
    // Intraday only, since the study reads intraday quotes only. One chain per ticker, nearest 30 DTE.
    // Tickers already in `work` are skipped: their entry/track rows quote them anyway.
    if (slot === 'intraday') {
      const candidates = coverageCandidates(db, todayEt).filter(t => !work.has(t));
      let attempts = 0;
      for (const ticker of candidates) {
        if (result.coverageTickers >= P.coverageMaxTickers || attempts >= P.coverageMaxAttempts) break;
        attempts++;
        try {
          const exps = await provider.getOptionsExpirations(ticker);
          const best = exps
            .map(e => ({ e, d: daysBetween(todayEt, e) }))
            .filter(x => x.d >= P.entryDteMin && x.d <= P.entryDteMax)
            .sort((a, b) => Math.abs(a.d - 30) - Math.abs(b.d - 30) || a.d - b.d)[0];
          if (!best) continue;
          work.set(ticker, new Map<string, CaptureReason>([[best.e, 'coverage']]));
          result.coverageTickers++;
        } catch (e) {
          result.failures.push({ ticker, step: 'coverage expirations', message: errText(e) });
        }
      }
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
