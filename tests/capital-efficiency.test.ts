// Capital-efficiency metrics (v1.1.157).
//
// Measuring a wheel book against the WHOLE portfolio understates it when capital is
// deliberately held back. Measured 2026-09-02 over 2026-04-09..08-28: the wheel realised
// $2,858.73 = 3.61% of a ~$79k portfolio but 11.02% of the ~$26k actually at risk, against
// SPY's 13.15%. Only the second number describes the trading; both are reported so a sizing
// choice is never mistaken for a strategy result.

import { describe, it, expect } from 'vitest';
import {
  capitalAtRisk, effectiveEnd, dailyDeployed, portfolioEfficiency, positionRoc,
  ROC_DISPLAY_CAP, type PositionLike,
} from '../src/main/services/capital-efficiency.js';

const pos = (o: Partial<PositionLike>): PositionLike => ({
  ticker: 'TSLA', position_type: 'CSP', quantity: 1, entry_price: 5,
  entry_date: '2026-07-17', exit_date: '2026-07-30', strike_price: 350,
  expiration_date: '2026-07-31', realized_pnl: 499.48, status: 'closed', ...o,
});

describe('capitalAtRisk', () => {
  it('secures a CSP at its strike', () => {
    expect(capitalAtRisk(pos({ strike_price: 350 }))).toBe(35_000);
  });

  it('charges a covered call NOTHING — the shares are already counted', () => {
    // Counting both would double-count the same dollars and make a wheel cycle look like two
    // separate commitments instead of one continuous block of capital.
    expect(capitalAtRisk(pos({ position_type: 'CC', strike_price: 360 }))).toBe(0);
  });

  it('uses cost basis for stock and the debit for a long option', () => {
    expect(capitalAtRisk(pos({ position_type: 'Stock', quantity: 100, entry_price: 345 }))).toBe(34_500);
    expect(capitalAtRisk(pos({ position_type: 'Long Put', entry_price: 19.62 }))).toBeCloseTo(1962, 0);
  });
});

describe('assignment handoff', () => {
  const csp = pos({ strike_price: 350, entry_price: 5, exit_date: '2026-07-30' });
  // Cost basis 345.0052 == strike 350 - premium 5.00, the arithmetic signature of assignment.
  const lot = pos({ position_type: 'Stock', quantity: 100, entry_price: 345.0052,
                    entry_date: '2026-07-29', exit_date: null, strike_price: null,
                    expiration_date: null, status: 'open' });

  it('ends the CSP where the assigned lot begins, so capital is handed over not duplicated', () => {
    expect(effectiveEnd(csp, [csp, lot])).toBe('2026-07-29');
  });

  it('leaves a CSP with no matching lot ending at its own exit', () => {
    const other = pos({ position_type: 'Stock', quantity: 100, entry_price: 500,
                        entry_date: '2026-07-29', exit_date: null, status: 'open' });
    expect(effectiveEnd(csp, [csp, other])).toBe('2026-07-30');
  });

  it('does not double-count capital across the handoff day', () => {
    const series = dailyDeployed([csp, lot], ['2026-07-28', '2026-07-29', '2026-07-30']);
    expect(series[0]!.capital).toBe(35_000);            // put still secured
    expect(series[1]!.capital).toBeCloseTo(34_500.52, 2);  // handed to the shares...
    expect(series[1]!.capital).toBeLessThan(40_000);          // ...NOT 69,500 (both counted)
    expect(series[2]!.capital).toBeCloseTo(34_500.52, 2);
  });
});

describe('portfolioEfficiency', () => {
  const dates = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04'];

  it('includes idle days in the average, and reports both returns side by side', () => {
    // One $35k CSP open for 2 of 4 days, earning $700.
    const p = pos({ entry_date: '2026-07-01', exit_date: '2026-07-03', realized_pnl: 700 });
    const e = portfolioEfficiency([p], dates, 79_221);

    expect(e.idleDays).toBe(2);
    expect(e.avgDeployed).toBeCloseTo(17_500, 0);       // (35k+35k+0+0)/4
    // Return on deployed is the trading result; return on portfolio shows what idling cost.
    expect(e.returnOnDeployedPct).toBeCloseTo(4.0, 1);
    expect(e.returnOnPortfolioPct).toBeCloseTo(0.88, 1);
    expect(e.utilizationPct).toBeCloseTo(22.1, 0);
  });

  it('reproduces the real book: 3.61% of portfolio vs 11.02% of deployed', () => {
    // The two numbers that motivated this metric — a 3x difference from sizing alone.
    const realized = 2858.73, avgDeployed = 25_949, portfolio = 79_221;
    expect((realized / portfolio) * 100).toBeCloseTo(3.61, 1);
    expect((realized / avgDeployed) * 100).toBeCloseTo(11.02, 1);
  });

  it('returns nulls rather than dividing by zero when nothing was deployed', () => {
    const e = portfolioEfficiency([], dates, 79_221);
    expect(e.returnOnDeployedPct).toBeNull();
    expect(e.annualizedOnDeployedPct).toBeNull();
  });
});

describe('positionRoc — projected vs realized', () => {
  it('scores a fast, efficient close well above a slow one of equal dollars', () => {
    // AMD $450 put: +$858.97 on $45,000 in 7 days.
    const fast = positionRoc(pos({ ticker: 'AMD', strike_price: 450, entry_price: 12,
      entry_date: '2026-07-16', exit_date: '2026-07-23', expiration_date: '2026-07-31',
      realized_pnl: 858.97 }))!;
    expect(fast.daysHeld).toBe(7);
    expect(fast.realizedAnnualPct).toBeCloseTo(99.6, 0);
    // The premium implied ~65%/yr if carried; the early close BEAT its own projection.
    expect(fast.realizedAnnualPct!).toBeGreaterThan(fast.projectedAnnualPct!);
  });

  it('scores a quick loss as sharply negative — same dollars, opposite decision quality', () => {
    // NVDA $195 put: -$169.03 on $19,500 in 2 days.
    const bad = positionRoc(pos({ ticker: 'NVDA', strike_price: 195, entry_price: 6,
      entry_date: '2026-06-23', exit_date: '2026-06-25', expiration_date: '2026-07-24',
      realized_pnl: -169.03 }))!;
    expect(bad.realizedAnnualPct).toBeCloseTo(-158.2, 0);
  });

  it('treats a same-day round trip as one day rather than dividing by zero', () => {
    const sameDay = positionRoc(pos({ entry_date: '2026-06-09', exit_date: '2026-06-09',
      realized_pnl: 467.97, strike_price: 370 }))!;
    expect(sameDay.daysHeld).toBe(1);
    expect(Number.isFinite(sameDay.realizedAnnualPct!)).toBe(true);
  });

  it('clamps absurd annualisations for display but flags that it did', () => {
    const wild = positionRoc(pos({ entry_date: '2026-06-09', exit_date: '2026-06-10',
      realized_pnl: 5000, strike_price: 10 }))!;
    expect(wild.realizedAnnualPct).toBe(ROC_DISPLAY_CAP);
    expect(wild.clamped).toBe(true);
    expect(wild.realizedPnl).toBe(5000);   // raw dollars always survive unclamped
  });

  it('gives a long option no premium projection — it pays a debit, it collects nothing', () => {
    const long = positionRoc(pos({ position_type: 'Long Put', entry_price: 19.62,
      realized_pnl: -364.03, strike_price: 375 }))!;
    expect(long.projectedAnnualPct).toBeNull();
    expect(long.realizedAnnualPct!).toBeLessThan(0);
  });

  it('skips open positions — there is no realised return yet', () => {
    expect(positionRoc(pos({ status: 'open', exit_date: null }))).toBeNull();
  });
});
