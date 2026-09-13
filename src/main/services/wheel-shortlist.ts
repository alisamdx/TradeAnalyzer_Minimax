// Wheel Shortlist — the interim, advisory answer to "what are the best wheel trades today?"
//
// NewApp/requirements/07-opportunity-engine.md §3. Operator decisions 2026-09-12: premium return on
// capital while avoiding assignment; 0.35–0.45 delta at 14–30 DTE; roll when ITM with ≤ 7 days left
// to the next 14–30 DTE expiry at the same or a lower strike for a credit, else close; top 5; no
// capital cap; after both brief runs.
//
// WHAT IS AND IS NOT EVIDENCE HERE. The ranking — premium return on capital — is the one ranking the
// existing app measured as positive (v1.1.176), and higher delta measured as earning more up to 0.35
// (v1.1.171). Both were measured at 0.20–0.35Δ and 30–45 DTE; this profile is outside that, so the
// ranking is an extrapolation and is labelled as one. The pool deliberately ignores the composite
// score, whose top end measured anti-predictive (v1.1.173). Advisory only: nothing here reaches the
// execution engine. see docs/formulas.md#wheel-shortlist

import type { DbHandle } from '../db/connection.js';
import type { OptionsProvider, OptionContract } from './options-provider.js';
import { loadPriceWindows } from './roll-the-dice.js';
import { readOwnAtStrike } from '@shared/own-at-strike.js';
import {
  SHORTLIST_PROFILE as P,
  type ShortlistContract, type ShortlistEntry, type ShortlistResult, type ShortlistRollRoom,
} from '@shared/wheel-shortlist.js';

export { SHORTLIST_PROFILE } from '@shared/wheel-shortlist.js';

type Chain = { expiration: string; contracts: OptionContract[] };
type ChainSource = Pick<OptionsProvider, 'getOptionsExpirations' | 'getOptionsChain'>;

/** Calendar days from an ET date to an expiry (both ISO dates). */
export function dteFrom(todayEt: string, expiration: string): number {
  return Math.round((Date.parse(`${expiration}T00:00:00Z`) - Date.parse(`${todayEt}T00:00:00Z`)) / 86_400_000);
}

const twoSided = (c: OptionContract): boolean => c.bid > 0 && c.ask > 0 && c.ask >= c.bid;
const midOf = (c: OptionContract): number => (c.bid + c.ask) / 2;

/**
 * The best put in the profile across the given chains: |delta| in [0.35, 0.45], DTE in [14, 30],
 * two-sided, highest premium return on capital (annualized). Null when nothing qualifies.
 */
export function pickShortlistContract(chains: readonly Chain[], todayEt: string): ShortlistContract | null {
  let best: ShortlistContract | null = null;
  for (const chain of chains) {
    const dte = dteFrom(todayEt, chain.expiration);
    if (dte < P.dteMin || dte > P.dteMax) continue;
    for (const c of chain.contracts) {
      if (c.side !== 'put' || !twoSided(c) || c.delta == null || !(c.strike > 0)) continue;
      const delta = Math.abs(c.delta);
      if (delta < P.deltaMin || delta > P.deltaMax) continue;
      const mid = midOf(c);
      const premiumRocAnnualPct = (mid / c.strike) * (365 / dte) * 100; // see docs/formulas.md#wheel-shortlist
      if (!best || premiumRocAnnualPct > best.premiumRocAnnualPct) {
        best = {
          expiration: chain.expiration, dte, strike: c.strike, bid: c.bid, ask: c.ask, mid, delta,
          openInterest: c.openInterest, spreadPct: mid > 0 ? ((c.ask - c.bid) / mid) * 100 : 100,
          premiumRocAnnualPct,
        };
      }
    }
  }
  return best;
}

/**
 * D3's roll target, approximated from today's listing: at the trigger the put has ≤ 7 days left and
 * rolls to the next expiry at 14–30 DTE — i.e. roughly 7 to 30 days after the current one. The
 * nearest listed expiry in that span.
 */
export function pickRollExpiration(expirations: readonly string[], chosenExpiration: string): string | null {
  const later = expirations
    .map(e => ({ e, gap: dteFrom(chosenExpiration, e) }))
    .filter(x => x.gap >= P.rollTriggerDte && x.gap <= P.dteMax)
    .sort((a, b) => a.gap - b.gap);
  return later[0]?.e ?? null;
}

/** How far down a credit roll could go at today's prices. see docs/formulas.md#wheel-shortlist */
export function computeRollRoom(chosen: ShortlistContract, rollChain: Chain | null): ShortlistRollRoom | null {
  if (!rollChain) return null;
  const puts = rollChain.contracts.filter(c => c.side === 'put' && twoSided(c) && c.strike <= chosen.strike);
  const covering = puts.filter(c => midOf(c) >= chosen.mid);
  if (covering.length === 0) {
    return { expiration: rollChain.expiration, strike: null, dollarsLower: null, strikesLower: 0 };
  }
  const lowest = Math.min(...covering.map(c => c.strike));
  const strikesLower = new Set(puts.map(c => c.strike).filter(s => s < chosen.strike && s >= lowest)).size;
  return { expiration: rollChain.expiration, strike: lowest, dollarsLower: chosen.strike - lowest, strikesLower };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Build today's shortlist from the latest brief run's wheel + income candidate pools, pricing each
 * ticker's contract live. Never throws for a single ticker: a failure becomes a rejection with its
 * reason, so the output always says why a name is absent.
 */
export async function computeWheelShortlist(deps: {
  readonly db: DbHandle;
  readonly provider: ChainSource;
  readonly now?: Date;
}): Promise<ShortlistResult> {
  const { db, provider } = deps;
  const todayEt = (deps.now ?? new Date()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const latest = db.prepare(
    `SELECT generated_at FROM brief_candidates WHERE strategy IN ('wheel', 'income')
      ORDER BY generated_at DESC LIMIT 1`,
  ).get() as { generated_at: string } | undefined;
  if (!latest) {
    return { briefGeneratedAt: null, considered: 0, entries: [], rejections: [],
      noResultReason: 'No wheel or income candidates are recorded yet — run the brief first.' };
  }

  // Validated pool only: `picked` and `capped_out` cleared the lab's liquidity gate; the composite
  // RANK is ignored on purpose (its top end measured anti-predictive).
  const rows = db.prepare(
    `SELECT ticker, strategy, spot FROM brief_candidates
      WHERE generated_at = ? AND strategy IN ('wheel', 'income') AND disposition IN ('picked', 'capped_out')
      ORDER BY rank`,
  ).all(latest.generated_at) as Array<{ ticker: string; strategy: string; spot: number | null }>;

  const pool = new Map<string, { strategies: string[]; spot: number | null }>();
  for (const r of rows) {
    const cur = pool.get(r.ticker) ?? { strategies: [], spot: r.spot };
    if (!cur.strategies.includes(r.strategy)) cur.strategies.push(r.strategy);
    cur.spot = cur.spot ?? r.spot;
    pool.set(r.ticker, cur);
  }
  const tickers = [...pool.keys()];

  // Critic verdicts from the latest stored wheel and income briefs. A `flag` excludes; the worst
  // verdict wins when a ticker appears in both.
  const verdicts = new Map<string, 'pass' | 'caution' | 'flag'>();
  const rank = { pass: 0, caution: 1, flag: 2 } as const;
  for (const strategy of ['wheel', 'income']) {
    const brief = db.prepare(
      `SELECT picks FROM daily_briefs WHERE strategy = ? ORDER BY generated_at DESC LIMIT 1`,
    ).get(strategy) as { picks: string } | undefined;
    if (!brief) continue;
    let picks: Array<{ ticker?: string; criticVerdict?: { verdict?: string } | null }> = [];
    try { picks = JSON.parse(brief.picks) as typeof picks; } catch { continue; }
    for (const p of picks) {
      const v = p.criticVerdict?.verdict;
      if (!p.ticker || (v !== 'pass' && v !== 'caution' && v !== 'flag')) continue;
      const prev = verdicts.get(p.ticker);
      if (!prev || rank[v] > rank[prev]) verdicts.set(p.ticker, v);
    }
  }

  const earnings = new Map<string, string>();
  if (tickers.length > 0) {
    const marks = tickers.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT ticker, report_date FROM earnings_calendar WHERE ticker IN (${marks})`)
      .all(...tickers) as Array<{ ticker: string; report_date: string }>) {
      earnings.set(r.ticker, r.report_date);
    }
  }
  const windows = loadPriceWindows(db, tickers, todayEt);

  const entries: ShortlistEntry[] = [];
  const rejections: Array<{ ticker: string; reason: string }> = [];
  const reject = (ticker: string, reason: string) => { rejections.push({ ticker, reason }); };

  for (const ticker of tickers) {
    const info = pool.get(ticker)!;
    const verdict = verdicts.get(ticker) ?? null;
    if (verdict === 'flag') { reject(ticker, 'critic flag'); continue; }

    // Earnings: fail closed on unknown or stale, exactly like Roll the Dice.
    const rd = earnings.get(ticker);
    if (rd === undefined) { reject(ticker, 'earnings date unknown'); continue; }
    if (rd < todayEt) { reject(ticker, `earnings calendar stale (last known ${rd})`); continue; }

    let expirations: string[];
    try {
      expirations = await provider.getOptionsExpirations(ticker);
    } catch (e) { reject(ticker, `expirations unavailable: ${errText(e)}`); continue; }

    const inWindow = expirations.filter(e => {
      const d = dteFrom(todayEt, e);
      return d >= P.dteMin && d <= P.dteMax;
    });
    if (inWindow.length === 0) { reject(ticker, 'no 14–30 DTE expiry listed'); continue; }
    // An expiry on or after the report would carry the put through earnings.
    const beforeEarnings = inWindow.filter(e => e < rd);
    if (beforeEarnings.length === 0) { reject(ticker, `earnings ${rd} before every 14–30 DTE expiry`); continue; }

    const fetched = new Map<string, Chain>();
    let underlying: number | null = null;
    for (const exp of beforeEarnings) {
      try {
        const ch = await provider.getOptionsChain(ticker, exp);
        fetched.set(exp, { expiration: exp, contracts: ch.contracts });
        underlying = underlying ?? ch.underlyingPrice;
      } catch { /* one missing expiry does not reject the ticker */ }
    }

    const contract = pickShortlistContract([...fetched.values()], todayEt);
    if (!contract) { reject(ticker, 'no put at 0.35–0.45Δ with a two-sided quote'); continue; }

    let rollChain: Chain | null = null;
    const rollExp = pickRollExpiration(expirations, contract.expiration);
    if (rollExp) {
      rollChain = fetched.get(rollExp) ?? null;
      if (!rollChain) {
        try {
          const ch = await provider.getOptionsChain(ticker, rollExp);
          rollChain = { expiration: rollExp, contracts: ch.contracts };
        } catch { rollChain = null; }
      }
    }

    entries.push({
      ticker,
      spot: info.spot ?? underlying,
      strategies: info.strategies,
      contract,
      creditPerContract: contract.mid * 100,
      capitalRequired: contract.strike * 100,
      assignmentProbPct: contract.delta * 100,
      rollRoom: computeRollRoom(contract, rollChain),
      earningsDate: rd,
      ownership: readOwnAtStrike(contract.strike, contract.strike - contract.mid, windows.get(ticker)),
      criticVerdict: verdict === 'pass' || verdict === 'caution' ? verdict : null,
    });
  }

  entries.sort((a, b) => b.contract.premiumRocAnnualPct - a.contract.premiumRocAnnualPct);
  const top = entries.slice(0, P.topN);

  let noResultReason: string | null = null;
  if (top.length === 0) {
    const tally = rejections.reduce<Record<string, number>>((acc, r) => {
      const k = r.reason.replace(/\d{4}-\d{2}-\d{2}/g, '').replace(/\(last known \)/, '').replace(/:.*$/, '').trim();
      acc[k] = (acc[k] ?? 0) + 1; return acc;
    }, {});
    const common = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    noResultReason = `No shortlist — ${tickers.length} candidate${tickers.length === 1 ? '' : 's'} considered, none had a qualifying contract`
      + (common ? ` (most common: ${common[0]}, ${common[1]}).` : '.');
  }

  return { briefGeneratedAt: latest.generated_at, considered: tickers.length, entries: top, rejections, noResultReason };
}
