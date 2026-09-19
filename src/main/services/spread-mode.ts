// Bull put spread mode — the second strategy after wheel (TODO #44).
//
// Design: NewApp/requirements/08-bull-put-spread-mode.md. Evidence: TODO #43 and
// scripts/fr-bull-put-spread-study.mjs — model-priced, one replay, so the mode ships in SHADOW: it is
// computed after each brief run and stored in `spread_mode_picks`, with no panel and no email, until the
// 08 §4 enable gate passes on captured quotes. Nothing here reaches the v2 execution engine.
//
// It makes NO E*Trade calls. It reads the put chains `captureSpreadChains` wrote for this same run
// (`spread_chain_capture`, reason = 'entry'), so its quotes are exactly the ones a forward study will
// later mark against. Never throws: a failure is returned in `error` and the brief is unaffected.
//
// see docs/formulas.md#bull-put-spread-mode

import { withTransaction, type DbHandle } from '../db/connection.js';
import type { BriefCandidateSlot } from './brief-candidates.js';
import type { CapturedPut } from './spread-chain-capture.js';
import { fillPrice } from './options-fill.js';
import {
  SPREAD_MODE_PROFILE as P, SPREAD_MODE_DEFAULTS, SPREAD_MODE_SETTING_KEYS, SPREAD_MODE_LIMITS,
  type SpreadConstruction, type SpreadLegQuote, type SpreadModePick, type SpreadModeResult, type SpreadModeSettings,
} from '@shared/spread-mode.js';

export { SPREAD_MODE_PROFILE, SPREAD_MODE_DEFAULTS } from '@shared/spread-mode.js';

const RETENTION_DAYS = 730;
/** An ETF's "next report": later than every expiry, so the earnings gate never binds. */
const NO_EARNINGS = '9999-12-31';

/** Read the mode's settings; anything missing or malformed falls back to the approved defaults. */
export function readSpreadModeSettings(db: DbHandle): SpreadModeSettings {
  const get = (key: string): string | undefined => {
    try {
      return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined)?.value;
    } catch { return undefined; }
  };
  const positiveInt = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const mode = get(SPREAD_MODE_SETTING_KEYS.mode);
  return {
    mode: mode === 'off' || mode === 'shadow' ? mode : SPREAD_MODE_DEFAULTS.mode,
    maxLossPerPosition: positiveInt(get(SPREAD_MODE_SETTING_KEYS.maxLossPerPosition), SPREAD_MODE_DEFAULTS.maxLossPerPosition),
    maxOpenPositions: positiveInt(get(SPREAD_MODE_SETTING_KEYS.maxOpenPositions), SPREAD_MODE_DEFAULTS.maxOpenPositions),
    maxOpenPerSector: positiveInt(get(SPREAD_MODE_SETTING_KEYS.maxOpenPerSector), SPREAD_MODE_DEFAULTS.maxOpenPerSector),
  };
}

/**
 * Write the operator's settings, clamped to `SPREAD_MODE_LIMITS`, and return what was stored.
 *
 * Every writer passes through here, so the bounds cannot be bypassed by a second caller — the
 * lesson from the conviction bands, where the edit modal validated and the AI "Apply" path did not.
 * A non-finite or out-of-range number is clamped rather than rejected: these are operator
 * preferences, and the stored value is always one the mode can run with.
 */
export function writeSpreadModeSettings(db: DbHandle, next: SpreadModeSettings): SpreadModeSettings {
  const clamp = (v: number, { min, max }: { min: number; max: number }, fallback: number): number =>
    Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
  const stored: SpreadModeSettings = {
    mode: next.mode === 'off' ? 'off' : 'shadow',
    maxLossPerPosition: clamp(next.maxLossPerPosition, SPREAD_MODE_LIMITS.maxLossPerPosition, SPREAD_MODE_DEFAULTS.maxLossPerPosition),
    maxOpenPositions: clamp(next.maxOpenPositions, SPREAD_MODE_LIMITS.maxOpenPositions, SPREAD_MODE_DEFAULTS.maxOpenPositions),
    maxOpenPerSector: clamp(next.maxOpenPerSector, SPREAD_MODE_LIMITS.maxOpenPerSector, SPREAD_MODE_DEFAULTS.maxOpenPerSector),
  };
  // A per-sector cap above the book cap can never bind, which reads as a rule that is on but silent.
  stored.maxOpenPerSector = Math.min(stored.maxOpenPerSector, stored.maxOpenPositions);

  const write = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  withTransaction(db, () => {
    write.run(SPREAD_MODE_SETTING_KEYS.mode, stored.mode);
    write.run(SPREAD_MODE_SETTING_KEYS.maxLossPerPosition, String(stored.maxLossPerPosition));
    write.run(SPREAD_MODE_SETTING_KEYS.maxOpenPositions, String(stored.maxOpenPositions));
    write.run(SPREAD_MODE_SETTING_KEYS.maxOpenPerSector, String(stored.maxOpenPerSector));
  });
  return stored;
}

/** The listed expiry at 21–35 DTE, strictly before the next report, nearest 30 DTE (earlier on a tie). */
export function pickSpreadExpiration(
  expiries: ReadonlyArray<{ expiration: string; dte: number }>,
  earningsDate: string,
): { expiration: string; dte: number } | null {
  const eligible = expiries
    .filter(e => e.dte >= P.dteMin && e.dte <= P.dteMax && e.expiration < earningsDate)
    .sort((a, b) => Math.abs(a.dte - P.dteTarget) - Math.abs(b.dte - P.dteTarget) || a.dte - b.dte);
  return eligible[0] ?? null;
}

const toLeg = (p: CapturedPut): SpreadLegQuote => ({ strike: p[0], bid: p[1], ask: p[2], delta: p[3], openInterest: p[5] });
const twoSided = (p: CapturedPut): boolean => p[1] > 0 && p[2] >= p[1];
const pct = (x: number): string => `${Math.round(x * 100)}%`;

/**
 * Build the spread from one chain, or say why not.
 * short: |Δ| 0.20–0.40, closest to 0.30 · long: strike closest to short − 5% of spot, within 3–10% ·
 * fills by options-fill.ts · gates: net credit > $0.05, round-trip cost ≤ 25% of mid credit.
 * see docs/formulas.md#bull-put-spread-mode
 */
export function buildBullPutSpread(
  puts: readonly CapturedPut[],
  spot: number,
): { spread: SpreadConstruction } | { reason: string } {
  const shorts = puts
    .filter(p => twoSided(p) && p[3] != null && Math.abs(p[3]) >= P.deltaMin && Math.abs(p[3]) <= P.deltaMax)
    .sort((a, b) => Math.abs(Math.abs(a[3]!) - P.deltaTarget) - Math.abs(Math.abs(b[3]!) - P.deltaTarget) || a[0] - b[0]);
  const shortP = shorts[0];
  if (!shortP) return { reason: `no two-sided put at ${P.deltaMin}–${P.deltaMax}Δ` };

  const eps = 1e-9;
  const target = shortP[0] - P.wingTargetPct * spot;
  const longs = puts
    .filter(p => {
      if (!twoSided(p) || p[0] >= shortP[0]) return false;
      const w = (shortP[0] - p[0]) / spot;
      return w >= P.wingMinPct - eps && w <= P.wingMaxPct + eps;
    })
    .sort((a, b) => Math.abs(a[0] - target) - Math.abs(b[0] - target) || b[0] - a[0]);
  const longP = longs[0];
  if (!longP) {
    const w = (x: number) => String(Math.round(x * 1000) / 10); // 0.075 → "7.5"
    return { reason: `no two-sided long put ${w(P.wingMinPct)}–${w(P.wingMaxPct)}% of spot below the short strike` };
  }

  const short = toLeg(shortP), long = toLeg(longP);
  const shortMid = (short.bid + short.ask) / 2, longMid = (long.bid + long.ask) / 2;
  const shortFill = fillPrice(short.bid, short.ask, 'sell');
  const longFill = fillPrice(long.bid, long.ask, 'buy');
  const midCredit = shortMid - longMid;
  const netCredit = shortFill - longFill;
  const entrySlip = (shortMid - shortFill) + (longFill - longMid);
  const costShare = midCredit > 0 ? (2 * entrySlip) / midCredit : Infinity;
  const width = short.strike - long.strike;

  if (!(netCredit > P.minNetCredit)) return { reason: `net credit $${netCredit.toFixed(2)} after fills` };
  if (costShare > P.maxCostShare) return { reason: `round-trip cost ${pct(costShare)} of credit (max ${pct(P.maxCostShare)})` };

  const maxLoss = width - netCredit;
  return {
    spread: {
      short, long, width, shortFill, longFill, midCredit, netCredit, maxLoss,
      returnOnRisk: netCredit / maxLoss,
      breakeven: short.strike - netCredit,
      costShare,
      takeProfitDebit: netCredit * P.takeProfitAtDebitFraction,
    },
  };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Compute this run's picks from the wheel pool and this run's captured chains, and store them. */
export function computeSpreadMode(deps: {
  readonly db: DbHandle;
  readonly slot: BriefCandidateSlot;
  readonly now?: Date;
  readonly settings?: SpreadModeSettings;
}): SpreadModeResult {
  const { db, slot } = deps;
  const now = deps.now ?? new Date();
  const todayEt = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const result: SpreadModeResult = {
    mode: SPREAD_MODE_DEFAULTS.mode, briefGeneratedAt: null, considered: 0, picks: [], rejections: [], rowsWritten: 0, error: null,
  };

  try {
    const settings = deps.settings ?? readSpreadModeSettings(db);
    result.mode = settings.mode;
    if (settings.mode === 'off') return result;

    const latest = db.prepare(
      `SELECT generated_at FROM brief_candidates WHERE strategy = 'wheel' ORDER BY generated_at DESC LIMIT 1`,
    ).get() as { generated_at: string } | undefined;
    if (!latest) return result;
    result.briefGeneratedAt = latest.generated_at;

    const tickers = (db.prepare(
      `SELECT DISTINCT ticker FROM brief_candidates
        WHERE generated_at = ? AND strategy = 'wheel' AND disposition IN ('picked', 'capped_out')
        ORDER BY ticker`,
    ).all(latest.generated_at) as Array<{ ticker: string }>).map(r => r.ticker);
    result.considered = tickers.length;

    // ETFs have no earnings, so the earnings gate cannot apply to them — without this every ETF was
    // rejected as "earnings date unknown" (EWZ ×5 in the first week; v1.1.292).
    const etfs = new Set<string>();
    if (tickers.length > 0) {
      for (const r of db.prepare(
        `SELECT DISTINCT ticker FROM constituents WHERE index_name = 'etf' AND ticker IN (${tickers.map(() => '?').join(',')})`,
      ).all(...tickers) as Array<{ ticker: string }>) etfs.add(r.ticker);
    }

    const verdicts = new Map<string, string>();
    const brief = db.prepare(`SELECT picks FROM daily_briefs WHERE strategy = 'wheel' ORDER BY generated_at DESC LIMIT 1`)
      .get() as { picks: string } | undefined;
    if (brief) {
      try {
        for (const p of JSON.parse(brief.picks) as Array<{ ticker?: string; criticVerdict?: { verdict?: string } | null }>) {
          if (p.ticker && p.criticVerdict?.verdict) verdicts.set(p.ticker, p.criticVerdict.verdict);
        }
      } catch { /* an unreadable brief means no verdicts, not a failed run */ }
    }

    const earnings = new Map<string, string>();
    const chains = new Map<string, Array<{ expiration: string; dte: number; spot: number | null; puts: CapturedPut[] }>>();
    if (tickers.length > 0) {
      const marks = tickers.map(() => '?').join(',');
      for (const r of db.prepare(`SELECT ticker, report_date FROM earnings_calendar WHERE ticker IN (${marks})`)
        .all(...tickers) as Array<{ ticker: string; report_date: string }>) {
        earnings.set(r.ticker, r.report_date);
      }
      for (const r of db.prepare(
        `SELECT ticker, expiration, dte, underlying_price, puts_json FROM spread_chain_capture
          WHERE as_of_date = ? AND slot = ? AND reason = 'entry' AND ticker IN (${marks})`,
      ).all(todayEt, slot, ...tickers) as Array<{ ticker: string; expiration: string; dte: number; underlying_price: number | null; puts_json: string }>) {
        let puts: CapturedPut[];
        try { puts = JSON.parse(r.puts_json) as CapturedPut[]; } catch { continue; }
        const list = chains.get(r.ticker) ?? [];
        list.push({ expiration: r.expiration, dte: r.dte, spot: r.underlying_price, puts });
        chains.set(r.ticker, list);
      }
    }

    const candidates: Array<Omit<SpreadModePick, 'rank'>> = [];
    const reject = (ticker: string, reason: string) => { result.rejections.push({ ticker, reason }); };

    for (const ticker of tickers) {
      const verdict = verdicts.get(ticker) ?? null;
      if (verdict === 'flag') { reject(ticker, 'critic flag'); continue; }
      const isEtf = etfs.has(ticker);
      const rd = isEtf ? NO_EARNINGS : earnings.get(ticker);
      if (rd === undefined) { reject(ticker, 'earnings date unknown'); continue; }
      if (rd < todayEt) { reject(ticker, `earnings calendar stale (last known ${rd})`); continue; }

      const list = chains.get(ticker);
      if (!list || list.length === 0) { reject(ticker, 'no chain captured this run'); continue; }
      const inWindow = list.filter(c => c.dte >= P.dteMin && c.dte <= P.dteMax);
      if (inWindow.length === 0) { reject(ticker, `no ${P.dteMin}–${P.dteMax} DTE expiry captured`); continue; }
      const chosen = pickSpreadExpiration(inWindow, rd);
      if (!chosen) { reject(ticker, `earnings ${rd} on/before every ${P.dteMin}–${P.dteMax} DTE expiry`); continue; }
      const chain = inWindow.find(c => c.expiration === chosen.expiration)!;
      if (chain.spot == null || !(chain.spot > 0)) { reject(ticker, 'no underlying price on the captured chain'); continue; }

      const built = buildBullPutSpread(chain.puts, chain.spot);
      if ('reason' in built) { reject(ticker, built.reason); continue; }
      const s = built.spread;

      const perContract = s.maxLoss * 100;
      const contracts = Math.floor(settings.maxLossPerPosition / perContract);
      if (contracts < 1) {
        reject(ticker, `one contract risks $${Math.round(perContract)} > $${settings.maxLossPerPosition} per-position budget`);
        continue;
      }
      candidates.push({
        ...s, ticker, expiration: chain.expiration, dte: chain.dte, spot: chain.spot,
        contracts, totalMaxLoss: contracts * perContract, earningsDate: isEtf ? null : rd,
        criticVerdict: verdict === 'pass' || verdict === 'caution' ? verdict : null,
      });
    }

    // Ranking — unvalidated (08 §3.6): return on risk after fills, descending; ties by ticker.
    // A tolerance, not `||`: two equal returns computed from different quotes differ in the 16th digit
    // (1.925 − 0.875 is 1.0499999…), and float noise must not decide the rank.
    candidates.sort((a, b) => {
      const d = b.returnOnRisk - a.returnOnRisk;
      return Math.abs(d) > 1e-9 ? d : a.ticker.localeCompare(b.ticker);
    });
    result.picks = candidates.slice(0, P.topN).map((c, i) => ({ ...c, rank: i + 1 }));
    for (const c of candidates.slice(P.topN)) reject(c.ticker, `ranked below the top ${P.topN}`);

    result.rowsWritten = storeSpreadModePicks(db, todayEt, slot, settings.mode, result);
  } catch (e) {
    result.error = errText(e);
  }
  return result;
}

function storeSpreadModePicks(
  db: DbHandle, asOfDate: string, slot: BriefCandidateSlot, mode: SpreadModeSettings['mode'], result: SpreadModeResult,
): number {
  const generatedAt = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO spread_mode_picks
      (as_of_date, slot, generated_at, mode, ticker, outcome, rank, reason,
       expiration, dte, spot, short_strike, short_bid, short_ask, short_delta, short_oi,
       long_strike, long_bid, long_ask, long_delta, long_oi, width, mid_credit, net_credit, max_loss,
       return_on_risk, cost_share, contracts, total_max_loss, earnings_date, critic_verdict)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const cutoffMs = Date.parse(`${asOfDate}T00:00:00Z`) - RETENTION_DAYS * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
  let written = 0;
  withTransaction(db, () => {
    // A re-run of a slot replaces the whole slot, so a name that dropped out does not linger.
    db.prepare('DELETE FROM spread_mode_picks WHERE as_of_date = ? AND slot = ?').run(asOfDate, slot);
    for (const p of result.picks) {
      insert.run(
        asOfDate, slot, generatedAt, mode, p.ticker, 'pick', p.rank, null,
        p.expiration, p.dte, p.spot, p.short.strike, p.short.bid, p.short.ask, p.short.delta, p.short.openInterest,
        p.long.strike, p.long.bid, p.long.ask, p.long.delta, p.long.openInterest, p.width, p.midCredit, p.netCredit, p.maxLoss,
        p.returnOnRisk, p.costShare, p.contracts, p.totalMaxLoss, p.earningsDate, p.criticVerdict,
      );
      written++;
    }
    for (const r of result.rejections) {
      insert.run(
        asOfDate, slot, generatedAt, mode, r.ticker, 'rejected', null, r.reason,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
        null, null, null, null, null, null,
      );
      written++;
    }
    db.prepare('DELETE FROM spread_mode_picks WHERE as_of_date < ?').run(cutoff);
  });
  return written;
}
