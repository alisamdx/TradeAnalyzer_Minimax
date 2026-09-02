// Capital-efficiency metrics for the real position book.
//
// Motivation: measuring a wheel book's return against the whole portfolio understates it badly
// when capital is deliberately held back. Measured 2026-09-02 over 2026-04-09..08-28: the wheel
// realised $2,858.73, which is 3.61% of a ~$79k portfolio but 11.02% of the ~$26k actually at
// risk, against SPY's 13.15%. Those are different claims and only the second one describes the
// trading. Both are reported here so a sizing choice is never mistaken for a strategy result.
//
// Everything is derived from the `positions` table — no new sync, no provider calls.

/** The subset of a position row these metrics need. */
export interface PositionLike {
  ticker: string;
  position_type: string;
  quantity: number;
  entry_price: number;
  entry_date: string;
  exit_date: string | null;
  strike_price: number | null;
  expiration_date: string | null;
  realized_pnl: number | null;
  status: string;
}

/** Annualised figures beyond this are shown clamped — a 1-day trade implies absurd rates. */
export const ROC_DISPLAY_CAP = 999;

const day = (iso: string): string => iso.slice(0, 10);
const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${day(b)}T00:00:00Z`) - Date.parse(`${day(a)}T00:00:00Z`)) / 86_400_000);

/**
 * Cash a position ties up while it is open.
 *
 * A covered call contributes **nothing**: the shares securing it are already counted as the
 * stock position, and charging both would double-count the same dollars. That is what makes a
 * wheel cycle read as one continuous block of capital — CSP secures the strike, assignment
 * hands it to the stock, the call written against those shares adds no new exposure.
 */
export function capitalAtRisk(p: PositionLike): number {
  switch (p.position_type) {
    case 'CSP':       return (p.strike_price ?? 0) * 100 * p.quantity;
    case 'CC':        return 0;
    case 'Stock':     return p.entry_price * p.quantity;
    case 'Long Put':
    case 'Long Call': return p.entry_price * 100 * p.quantity;
    default:          return 0;
  }
}

/**
 * End date to use for capital purposes — normally the exit, but an ASSIGNED cash-secured put
 * hands its capital to the resulting stock rather than releasing it.
 *
 * Without this the two overlap: the TSLA $350 put exited 07-30 while the assigned shares start
 * 07-29, double-counting ~$35k for a day. An assignment is recognised by a stock position in the
 * same ticker whose cost basis matches `strike − premium` (TSLA: 350 − 5.00 = 345.00 against an
 * actual 345.0052), which is the arithmetic signature of assignment and hard to hit by accident.
 */
export function effectiveEnd(p: PositionLike, all: readonly PositionLike[]): string | null {
  const exit = p.exit_date ? day(p.exit_date) : null;
  if (p.position_type !== 'CSP' || p.strike_price == null) return exit;

  const basis = p.strike_price - p.entry_price;
  const assignedLot = all.find(o =>
    o.position_type === 'Stock' &&
    o.ticker === p.ticker &&
    Math.abs(o.entry_price - basis) < 0.05 &&
    exit != null && Math.abs(daysBetween(day(o.entry_date), exit)) <= 5);

  if (!assignedLot) return exit;
  const handover = day(assignedLot.entry_date);
  return exit != null && handover > exit ? exit : handover;
}

export interface DeployedPoint { date: string; capital: number }

/** Capital at risk on each supplied date. `dates` should be trading days, ascending. */
export function dailyDeployed(
  positions: readonly PositionLike[],
  dates: readonly string[],
): DeployedPoint[] {
  const spans = positions.map(p => ({
    from: day(p.entry_date),
    to: effectiveEnd(p, positions),
    cap: capitalAtRisk(p),
  }));
  return dates.map(d => ({
    date: d,
    // Open on the entry day, released on the exit day (the position is gone by that close).
    capital: spans.reduce((sum, s) => sum + (s.from <= d && (s.to === null || d < s.to) ? s.cap : 0), 0),
  }));
}

export interface PortfolioEfficiency {
  tradingDays: number;
  idleDays: number;
  avgDeployed: number;
  peakDeployed: number;
  utilizationPct: number | null;
  realizedPnl: number;
  returnOnPortfolioPct: number | null;
  returnOnDeployedPct: number | null;
  annualizedOnDeployedPct: number | null;
}

/**
 * Portfolio-level view.
 *
 * Idle days are deliberately INCLUDED in the average. The question this answers is "for every
 * dollar-day I had at risk, what did I earn" — holding cash lowers the average and so raises
 * return-per-deployed-dollar, while `returnOnPortfolioPct` alongside it shows what sitting flat
 * cost. Reporting only one of the two would hide a sizing decision inside a strategy number.
 */
export function portfolioEfficiency(
  positions: readonly PositionLike[],
  dates: readonly string[],
  portfolioValue: number | null,
): PortfolioEfficiency {
  const series = dailyDeployed(positions, dates);
  const caps = series.map(s => s.capital);
  const avg = caps.length ? caps.reduce((a, b) => a + b, 0) / caps.length : 0;
  const realized = positions
    .filter(p => p.status === 'closed')
    .reduce((a, p) => a + (p.realized_pnl ?? 0), 0);
  const spanDays = dates.length > 1 ? daysBetween(dates[0]!, dates[dates.length - 1]!) : 0;
  const retDeployed = avg > 0 ? (realized / avg) * 100 : null;

  return {
    tradingDays: dates.length,
    idleDays: caps.filter(c => c === 0).length,
    avgDeployed: avg,
    peakDeployed: caps.length ? Math.max(...caps) : 0,
    utilizationPct: portfolioValue && portfolioValue > 0 ? (avg / portfolioValue) * 100 : null,
    realizedPnl: realized,
    returnOnPortfolioPct:
      portfolioValue && portfolioValue > 0 ? (realized / portfolioValue) * 100 : null,
    returnOnDeployedPct: retDeployed,
    annualizedOnDeployedPct:
      retDeployed != null && spanDays > 0 ? retDeployed * (365 / spanDays) : null,
  };
}

export interface PositionRoc {
  ticker: string;
  positionType: string;
  strike: number | null;
  entryDate: string;
  exitDate: string | null;
  daysHeld: number;
  dteAtEntry: number | null;
  capital: number;
  realizedPnl: number;
  /** Annualised ROC the premium implied if carried to expiry. */
  projectedAnnualPct: number | null;
  /** Annualised ROC actually achieved over the real holding period. */
  realizedAnnualPct: number | null;
  /** True when annualisation was clamped for display (very short holds). */
  clamped: boolean;
}

/**
 * Per-trade capital efficiency: what the premium promised versus what the trade delivered.
 *
 * This is the metric that separates a disciplined early close from a panicked one, without
 * needing any counterfactual price path. A position closed on day 2 for a third of the premium
 * can post a HIGHER annualised return than one held to expiry — or a far worse one — and raw
 * P&L cannot tell those apart. Book examples: AMD $450 put, +$858.97 on $45,000 in 7 days is
 * ~+100%/yr; NVDA $195 put, −$169.03 on $19,500 in 2 days is ~−158%/yr. Similar dollar sizes,
 * opposite decision quality.
 */
export function positionRoc(p: PositionLike): PositionRoc | null {
  const capital = capitalAtRisk(p);
  if (capital <= 0 || p.status !== 'closed' || !p.exit_date) return null;

  // A same-day round trip still consumed a day of capital; 0 would divide to infinity.
  const daysHeld = Math.max(1, daysBetween(p.entry_date, p.exit_date));
  const dte = p.expiration_date ? daysBetween(p.entry_date, p.expiration_date) : null;
  const isShortPremium = p.position_type === 'CSP' || p.position_type === 'CC';

  const projected = isShortPremium && dte != null && dte > 0
    ? ((p.entry_price * 100 * p.quantity) / capital) * 100 * (365 / dte)
    : null;
  const realizedRaw = ((p.realized_pnl ?? 0) / capital) * 100 * (365 / daysHeld);
  const clamp = (v: number): number => Math.max(-ROC_DISPLAY_CAP, Math.min(ROC_DISPLAY_CAP, v));

  return {
    ticker: p.ticker,
    positionType: p.position_type,
    strike: p.strike_price,
    entryDate: day(p.entry_date),
    exitDate: day(p.exit_date),
    daysHeld,
    dteAtEntry: dte,
    capital,
    realizedPnl: p.realized_pnl ?? 0,
    projectedAnnualPct: projected == null ? null : clamp(projected),
    realizedAnnualPct: clamp(realizedRaw),
    clamped: Math.abs(realizedRaw) > ROC_DISPLAY_CAP
          || (projected != null && Math.abs(projected) > ROC_DISPLAY_CAP),
  };
}
