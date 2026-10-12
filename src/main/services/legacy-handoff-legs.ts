import { osiSymbol, type LegacyBriefHandoff } from '@tradeanalyzer/core';

type HandoffLeg = LegacyBriefHandoff['candidates'][number]['legs'][number];

/** The fields of a Strategy Lab `SetupLeg` the hand-off reads; the brief job holds a structural subset. */
export interface HandoffInputLeg {
  side?: 'call' | 'put' | null;
  strike: number;
  expiration?: string | null;
  bid?: number | null;
  ask?: number | null;
  mid?: number | null;
  iv?: number | null;
  delta?: number | null;
  openInterest?: number | null;
  volume?: number | null;
}

/**
 * The NewApp hand-off legs for one Strategy Lab setup (04 §8).
 *
 * A leg is emitted only when its side and expiration are both known. Both are needed to build the
 * OSI symbol, and a constructed symbol that is wrong does not throw — it pins a contract tomorrow's
 * chain phase never matches, so the sticky set looks populated and captures nothing. Skipping is the
 * honest failure; guessing the right from a structure slug is not.
 *
 * **Each leg's OWN expiration (v1.1.347).** Calendars, diagonals and PMCCs take their long leg from
 * the lab's far chain, so a setup's `expiration` is the near expiry only. Until v1.1.347 every leg was
 * stamped with it: CRWD's 2026-09-29 far-dated 237.5 call was pinned as `CRWD--261030C00237500`, a
 * strike E*Trade never listed on the 10-30 weekly, and QC-409 fired on it every night. The bid, ask
 * and IV beside that symbol were also another contract's.
 */
export function handoffLegsFor(
  ticker: string,
  setup: { expiration?: string | null; legs?: readonly HandoffInputLeg[] | null } | null | undefined,
  liquidityScore: number | null
): HandoffLeg[] {
  return (setup?.legs ?? []).flatMap((l) => {
    const expiration = l.expiration || setup?.expiration;
    if (!l.side || !expiration) return [];
    return [{
      osiSymbol: osiSymbol({ ticker, expiration, side: l.side, strike: l.strike }),
      right: l.side,
      strike: l.strike,
      expiration,
      bid: l.bid ?? null,
      ask: l.ask ?? null,
      mid: l.mid ?? null,
      // **The lab holds a PERCENTAGE** (strategy-lab-service multiplies E*Trade's fraction by 100);
      // the hand-off contract is a fraction, converted here once. Until v1.1.347 it was passed through
      // under a comment saying the lab held fractions, so `legacy_brief_leg.iv` stored 50.1 for 50.1%.
      iv: l.iv == null || !Number.isFinite(l.iv) ? null : l.iv / 100,
      delta: l.delta ?? null,
      openInterest: l.openInterest ?? null,
      volume: l.volume ?? null,
      // The field's PRESENCE, not its truthiness. `?? 0` is what turned "not reported" into "did not
      // trade" on 23 of 250 stored legs.
      volumeReported: l.volume !== null && l.volume !== undefined,
      liquidityScore,
    }];
  });
}
