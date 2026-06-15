// Sector → SPDR sector-ETF mapping (shared).
//
// Polygon stores lowercase SIC descriptions (e.g. "electronic computers"), not GICS sector
// names. `sectorStringToEtf` maps either form to one of the 11 SPDR sector ETFs via keyword
// matching — a coarse, correlation-meaningful bucket. Used by the scoring engine's
// sectorMomentum and by the execution risk governor's sector-concentration cap (FR-SEY-1),
// so "five semiconductor spreads" group as one bucket (XLK), not five.
// see docs/formulas.md#sector-momentum

/** GICS sector name → SPDR sector ETF ticker. */
export const SECTOR_ETF: Record<string, string> = {
  'Technology':             'XLK',
  'Financials':             'XLF',
  'Health Care':            'XLV',
  'Energy':                 'XLE',
  'Industrials':            'XLI',
  'Consumer Staples':       'XLP',
  'Consumer Discretionary': 'XLY',
  'Materials':              'XLB',
  'Real Estate':            'XLRE',
  'Utilities':              'XLU',
  'Communication Services': 'XLC',
};

/**
 * Map a GICS sector name OR a Polygon SIC description to a SPDR sector ETF, via keyword
 * matching. Returns undefined when no rule matches (~unmapped names stay uncapped, by design).
 */
export function sectorStringToEtf(raw: string): string | undefined {
  if (SECTOR_ETF[raw]) return SECTOR_ETF[raw];
  const s = raw.toLowerCase();
  // XLK — Technology
  if (/semiconductor|electronic computer|prepackaged software|computer integrated|computer storage|computer communication|computer programming|data processing|computer processing|telephone apparatus|communications equipment|electronic component|printed circuit|optical instrument|industrial instrument|laboratory.*instrument|analytical instrument/.test(s)) return 'XLK';
  // XLC — Communication Services
  if (/telephone communication|cable.*television|pay television|radio broadcasting|television broadcasting|motion picture|newspaper.*publish|video.*rental/.test(s)) return 'XLC';
  // XLF — Financials
  if (/commercial bank|savings institution|fire.*insurance|life insurance|accident.*insurance|investment advice|security broker|personal credit|mortgage banker|insurance agent/.test(s)) return 'XLF';
  // XLV — Health Care
  if (/pharmaceutical|biological product|diagnostic substance|surgical.*instrument|medical instrument|electromedical|hospital|health service|home health/.test(s)) return 'XLV';
  // XLE — Energy
  if (/crude petroleum|natural gas|oil.*gas field|petroleum refin|drilling.*oil/.test(s)) return 'XLE';
  // XLI — Industrials (electrical equipment before XLK catch to handle "no computer equip" variants)
  if (/air transportation|air courier|railroad|trucking.*courier|aerospace|aircraft|engineering service|industrial.*machiner|ship building|electrical equipment/.test(s)) return 'XLI';
  // XLY — Consumer Discretionary
  if (/auto dealer|retail-eating|eating.*drinking|apparel.*accessor|home furniture|hotels.*motel|motor vehicle|automotive part/.test(s)) return 'XLY';
  // XLP — Consumer Staples
  if (/food.*kindred|beverages|retail-variety|food store|drug store|soap.*detergent|tobacco product/.test(s)) return 'XLP';
  // XLB — Materials
  if (/steel work|chemicals.*allied|plastics material|metal mining|paper.*allied/.test(s)) return 'XLB';
  // XLRE — Real Estate
  if (/real estate investment trust|real estate dealer|land subdivider/.test(s)) return 'XLRE';
  // XLU — Utilities
  if (/electric service|electric.*combined|gas transmission|water supply|combination electric.*gas/.test(s)) return 'XLU';
  return undefined;
}
