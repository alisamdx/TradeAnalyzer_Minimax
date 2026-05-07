// Wheel Calculator Service - computes Wheel Strategy metrics
// Wheel Suitability Score, Target Strike, and Est. Premium
// see SPEC: §2.2.2 Wheel Strategy Columns, §2.3.2 Wheel Strategy Analysis

import type { DerivedRatios, Quote } from '@shared/types.js';

export interface WheelMetrics {
  suitabilityScore: number;  // 0-100
  targetStrike: number | null;
  estimatedPremium: number | null;
}

/**
 * Calculate Wheel Suitability Score (0-100)
 * Formula: ROE×30% + D/E_Quality×30% + MarketCap×20% + Stability×25%
 */
export function calculateWheelSuitability(
  ratios: DerivedRatios,
  _quote: Quote | null  // Stability component placeholder
): number {
  // ROE Component (30%): min(ROE/30 * 100, 100)
  const roe = ratios.roe ?? 0;
  const roeComponent = Math.min((roe / 30) * 100, 100) * 0.30;

  // D/E Quality Component (30%): if D/E < 1.0: 100, else: max(0, 100 - (D/E-1)*50)
  const de = ratios.debtToEquity ?? 0;
  const deQuality = de < 1.0 ? 100 : Math.max(0, 100 - (de - 1) * 50);
  const deComponent = deQuality * 0.30;

  // Market Cap Component (20%):
  // > $50B: 100, > $10B: 75, > $1B: 50, else: 25
  const marketCap = ratios.marketCap ?? 0;
  let marketCapScore: number;
  if (marketCap > 50_000_000_000) marketCapScore = 100;
  else if (marketCap > 10_000_000_000) marketCapScore = 75;
  else if (marketCap > 1_000_000_000) marketCapScore = 50;
  else marketCapScore = 25;
  const marketCapComponent = marketCapScore * 0.20;

  // Stability Component (25%): Simplified based on volatility/sector
  // For now, use a baseline score. Could be enhanced with historical volatility
  const stabilityScore = 70; // Baseline - can be refined with volatility data
  const stabilityComponent = stabilityScore * 0.25;

  const totalScore = roeComponent + deComponent + marketCapComponent + stabilityComponent;
  return Math.round(Math.min(Math.max(totalScore, 0), 100));
}

/**
 * Calculate Target Strike (8% OTM put)
 * Formula: Current Price × 0.92
 */
export function calculateTargetStrike(currentPrice: number | null): number | null {
  if (currentPrice === null || currentPrice <= 0) return null;
  return Math.round(currentPrice * 0.92 * 100) / 100; // Round to 2 decimals
}

/**
 * Calculate Estimated Premium (30 DTE approximation)
 * Formula: Strike × 1.2%
 */
export function calculateEstimatedPremium(strike: number | null): number | null {
  if (strike === null || strike <= 0) return null;
  return Math.round(strike * 0.012 * 100) / 100; // 1.2% of strike, round to 2 decimals
}

/**
 * Get Wheel recommendation based on suitability score
 */
export function getWheelRecommendation(score: number): 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' {
  if (score >= 80) return 'EXCELLENT';
  if (score >= 60) return 'GOOD';
  if (score >= 40) return 'FAIR';
  return 'POOR';
}

/**
 * Get color for wheel score display
 */
export function getWheelScoreColor(score: number): string {
  if (score >= 80) return '#3fb950'; // Success green
  if (score >= 60) return '#58a6ff'; // Blue
  if (score >= 40) return '#d29922'; // Warning amber
  return '#f85149'; // Danger red
}

/**
 * Calculate all Wheel metrics for a ticker
 */
export function calculateWheelMetrics(
  ratios: DerivedRatios,
  quote: Quote | null
): WheelMetrics {
  const suitabilityScore = calculateWheelSuitability(ratios, quote);
  const targetStrike = calculateTargetStrike(quote?.last ?? null);
  const estimatedPremium = calculateEstimatedPremium(targetStrike);

  return {
    suitabilityScore,
    targetStrike,
    estimatedPremium
  };
}
