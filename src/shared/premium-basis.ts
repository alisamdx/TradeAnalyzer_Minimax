// Premium vs cost basis on stock holdings — Bec's "risk line" (docs/Bec/STRATEGY-SUMMARY.md §6a,
// §9.6). Tier 1: reporting only. It reads stored positions and changes nothing.
//
// Her test of a stock she holds to sell calls against: every call sold LOWERS the cost basis, so
// the risk line only ever moves down. A put-seller who keeps rolling strikes up has a risk line
// that moves up. We tracked realised P&L per position but never surfaced premium as a running
// reduction in basis, so this answers two questions per open stock holding:
//
//   1. Net basis = cost per share − premium KEPT per share (closed short options, real fills).
//   2. Has the line only fallen? Each closed option is a step; a net loss on one (bought back for
//      more than it was sold) is a step UP, and is listed as such.
//
// WHICH OPTIONS COUNT. A wheel holding's premium starts with the put that assigned it, so the
// window is: short options on the ticker closed on or after the stock's acquisition date, plus the
// ASSIGNING put — a CSP that expired within ASSIGNMENT_WINDOW_DAYS before the acquisition date at a
// strike matching a lot's cost (±1%, as strike or as strike − premium). Identified by expiry and strike, NOT an 'Assigned'
// note: the orders import has no order for an assignment, so that row usually carries the sync's
// "estimated from last mark" note instead. Older trades on the same ticker belong to an earlier
// cycle and are left out rather than credited to these shares.
//
// NO DOUBLE COUNT OF THE ASSIGNING PUT. Tax rules fold a put's premium into the basis of the shares
// it assigns, and a broker may report that ADJUSTED basis (strike − premium) as the cost per share.
// Whether E*Trade does was not verifiable from code, so each holding decides from its own numbers:
// if the lot's cost is nearer strike − premium than the strike, the premium is already in the cost,
// and the put is shown (`assignmentInBasis`) but NOT subtracted again.
//
// ESTIMATED ROWS (CLAUDE.md: "An ASSIGNED CSP is a CONVERSION into stock, not a loss"). When a short
// option vanishes from the broker with no closing fill, the sync closes it with realized P&L
// "estimated from last mark" (exit_price NULL) — measured wrong in both directions, e.g. the TSLA 350
// put read −$3,736 when the real result was +$499. Taken at face value one such row would push the
// line UP by thousands. So:
//   - vanished on/after its expiry  → it expired or was assigned, with no buyback: kept = the full
//     credit (entry × 100 × contracts, before commissions), flagged `estimated`;
//   - vanished BEFORE expiry with no fill → not counted at all, listed in `unresolved` (Sync Closed
//     Positions resolves it). A guess in either direction would be a fabricated step.
//
// WHAT IS NOT COUNTED AS KEPT. An open short option's credit is shown on its own ("open credit,
// not yet kept"): it can still be bought back for more, so folding it into the basis would draw
// the line lower than anything has earned yet.
//
// Pure (no DB): shared so the preload and renderer can use its types. The DB read is
// src/main/services/premium-basis.ts.
// see docs/formulas.md#premium-basis

/** A CSP that assigned these shares closes on (or a few days before) the acquisition date. */
export const ASSIGNMENT_WINDOW_DAYS = 7;

export interface PremiumBasisPositionRow {
  id: number;
  ticker: string;
  positionType: string;
  quantity: number;
  entryPrice: number;
  entryDate: string;
  exitPrice: number | null;
  exitDate: string | null;
  strikePrice: number | null;
  expirationDate: string | null;
  realizedPnl: number | null;
  status: 'open' | 'closed';
}

export interface PremiumBasisStep {
  positionId: number;
  date: string;               // exit date
  type: 'CSP' | 'CC';
  strike: number | null;
  expiration: string | null;
  contracts: number;
  kept: number;               // dollars, net of buyback and commissions (realized_pnl)
  basisAfter: number;         // net basis per share after this step
  rose: boolean;              // a net loss: the risk line moved UP
  /** No closing fill: expired or assigned, counted at the full credit. */
  estimated: boolean;
  /** The assigning put, whose premium the broker's cost per share already includes: shown, not
   *  subtracted again (kept is reported, basisAfter does not move). */
  inBrokerBasis: boolean;
}

export interface PremiumBasisHolding {
  ticker: string;
  shares: number;
  acquired: string;           // earliest open stock lot's acquisition date
  costPerShare: number;       // share-weighted across open stock lots
  premiumKept: number;        // dollars
  premiumKeptPerShare: number;
  netBasis: number;           // per share
  reductionPct: number;       // premium kept / cost
  steps: PremiumBasisStep[];  // chronological
  rises: number;              // steps that raised the line
  onlyFallen: boolean;        // her test: true when no step rose (vacuously true with no steps)
  /** Dollars of assigning-put premium already inside the broker's cost per share (not re-subtracted). */
  premiumInBrokerBasis: number;
  openCredit: number;         // dollars of open short-option credit, not yet kept
  openShortCalls: number;     // contracts
  /** Closed short options in the window with no closing fill that vanished before expiry: not
   *  counted (neither kept nor lost) until Sync Closed Positions resolves them. */
  unresolved: Array<{ positionId: number; type: 'CSP' | 'CC'; strike: number | null; expiration: string | null; exitDate: string }>;
}

const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

const round = (n: number, dp = 4): number => Math.round(n * 10 ** dp) / 10 ** dp;

/** Pure: one read per ticker holding open stock. see docs/formulas.md#premium-basis */
export function computePremiumBasis(rows: readonly PremiumBasisPositionRow[]): PremiumBasisHolding[] {
  const lotsByTicker = new Map<string, PremiumBasisPositionRow[]>();
  for (const r of rows) {
    if (r.positionType !== 'Stock' || r.status !== 'open' || !(r.quantity > 0)) continue;
    const list = lotsByTicker.get(r.ticker) ?? [];
    list.push(r);
    lotsByTicker.set(r.ticker, list);
  }

  const out: PremiumBasisHolding[] = [];
  for (const [ticker, lots] of lotsByTicker) {
    const shares = lots.reduce((s, l) => s + l.quantity, 0);
    const costPerShare = lots.reduce((s, l) => s + l.quantity * l.entryPrice, 0) / shares;
    const acquired = lots.map(l => l.entryDate).sort()[0]!;

    const shorts = rows.filter(r => r.ticker === ticker && (r.positionType === 'CSP' || r.positionType === 'CC'));
    const lotCosts = lots.map(l => l.entryPrice);
    const isAssigningPut = (r: PremiumBasisPositionRow): boolean => {
      if (r.positionType !== 'CSP' || r.expirationDate == null || r.strikePrice == null) return false;
      const gap = daysBetween(r.expirationDate, acquired);
      // A lot cost at the strike (unadjusted) or at strike − premium (broker-adjusted). Matching the
      // strike alone missed the adjusted case whenever the credit exceeded the tolerance.
      const adjusted = r.strikePrice - r.entryPrice;
      return gap >= 0 && gap <= ASSIGNMENT_WINDOW_DAYS
        && lotCosts.some(c => c > 0 && (Math.abs(r.strikePrice! - c) / c <= 0.01 || Math.abs(adjusted - c) / c <= 0.01));
    };
    // The broker already netted this put's premium into the lot cost when a lot sits nearer
    // strike − premium than the strike itself.
    const inBrokerBasis = (r: PremiumBasisPositionRow): boolean =>
      isAssigningPut(r) && lotCosts.some(c =>
        Math.abs(c - (r.strikePrice! - r.entryPrice)) < Math.abs(c - r.strikePrice!));
    const inWindow = shorts
      .filter(r => r.status === 'closed' && r.exitDate != null)
      .filter(r => r.exitDate! >= acquired || isAssigningPut(r))
      .sort((a, b) => a.exitDate!.localeCompare(b.exitDate!) || a.id - b.id);

    const unresolved: PremiumBasisHolding['unresolved'] = [];
    const counted: Array<{ row: PremiumBasisPositionRow; kept: number; estimated: boolean }> = [];
    for (const r of inWindow) {
      const hasFill = r.exitPrice != null && r.realizedPnl != null;
      if (hasFill) { counted.push({ row: r, kept: r.realizedPnl!, estimated: false }); continue; }
      const expiredFirst = r.expirationDate != null && r.exitDate! >= r.expirationDate;
      if (expiredFirst) {
        counted.push({ row: r, kept: r.entryPrice * 100 * r.quantity, estimated: true });
      } else {
        unresolved.push({
          positionId: r.id, type: r.positionType as 'CSP' | 'CC',
          strike: r.strikePrice, expiration: r.expirationDate, exitDate: r.exitDate!,
        });
      }
    }

    let kept = 0;
    const steps: PremiumBasisStep[] = counted.map(({ row: r, kept: k, estimated }) => {
      const already = inBrokerBasis(r);
      if (!already) kept += k;
      return {
        positionId: r.id,
        date: r.exitDate!,
        type: r.positionType as 'CSP' | 'CC',
        strike: r.strikePrice,
        expiration: r.expirationDate,
        contracts: r.quantity,
        kept: round(k, 2),
        basisAfter: round(costPerShare - kept / shares),
        rose: !already && k < 0,
        estimated,
        inBrokerBasis: already,
      };
    });

    const open = shorts.filter(r => r.status === 'open');
    const openCredit = open.reduce((s, r) => s + r.entryPrice * 100 * r.quantity, 0);
    const rises = steps.filter(s => s.rose).length;

    out.push({
      ticker,
      shares,
      acquired,
      costPerShare: round(costPerShare),
      premiumKept: round(kept, 2),
      premiumKeptPerShare: round(kept / shares),
      netBasis: round(costPerShare - kept / shares),
      reductionPct: costPerShare > 0 ? round((kept / shares / costPerShare) * 100, 2) : 0,
      steps,
      rises,
      onlyFallen: rises === 0,
      premiumInBrokerBasis: round(steps.filter(st => st.inBrokerBasis).reduce((a, st) => a + st.kept, 0), 2),
      openCredit: round(openCredit, 2),
      openShortCalls: open.filter(r => r.positionType === 'CC').reduce((s, r) => s + r.quantity, 0),
      unresolved,
    });
  }
  return out.sort((a, b) => a.ticker.localeCompare(b.ticker));
}
