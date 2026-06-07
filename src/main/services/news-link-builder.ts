// Builds source links for News & Research key factors.
// Called after rule-based OR AI synthesis to attach clickable URLs to each factor.
// See Requirements/news-research.md

import type { KeyFactor, KeyFactorLink, KeyFactorTag, NewsHeadline } from '@shared/types.js';

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Attach relevant source links to each key factor.
 * NEWS factors: try to match back to a source headline URL; fallback to Google News search.
 * MACRO factors: standard resource URLs (Fed, BLS) + search.
 * Others: Yahoo Finance + Google search.
 */
export function enrichFactorsWithLinks(
  factors: KeyFactor[],
  ticker: string,
  headlines: NewsHeadline[],
): KeyFactor[] {
  return factors.map((f) => ({
    ...f,
    links: buildLinks(f, ticker, headlines),
  }));
}

// ─── Per-tag link builders ────────────────────────────────────────────────────

function buildLinks(
  factor: KeyFactor,
  ticker: string,
  headlines: NewsHeadline[],
): KeyFactorLink[] {
  switch (factor.tag as KeyFactorTag) {
    case 'NEWS':
      return buildNewsLinks(factor.description, ticker, headlines);
    case 'MACRO':
      return buildMacroLinks(factor.description);
    case 'EARNINGS':
      return buildEarningsLinks(ticker);
    case 'ANALYST':
      return buildAnalystLinks(factor.description, ticker);
    case 'INSIDER':
      return buildInsiderLinks(ticker);
    case 'REGULATORY':
      return buildRegulatoryLinks(factor.description, ticker);
    case 'SHORT_SQUEEZE':
      return buildShortLinks(ticker);
    case 'SEASONALITY':
      return buildSearchLinks(`${ticker} seasonal patterns`);
    default:
      return buildSearchLinks(`${ticker} ${factor.description}`);
  }
}

// ─── NEWS ─────────────────────────────────────────────────────────────────────

function buildNewsLinks(
  description: string,
  ticker: string,
  headlines: NewsHeadline[],
): KeyFactorLink[] {
  const links: KeyFactorLink[] = [];

  // Try to match description back to a source headline.
  const matched = findMatchingHeadline(description, headlines);
  if (matched) {
    links.push({ label: matched.source, url: matched.url });
  }

  // Always add a Google News search as a secondary/fallback.
  const query = encodeURIComponent(`${ticker} ${description.slice(0, 60)}`);
  links.push({
    label: 'Search',
    url: `https://www.google.com/search?q=${query}&tbm=nws`,
  });

  return links;
}

/**
 * Match a factor description back to a source headline by checking word overlap.
 * Returns the first headline with >= 2 significant word matches.
 */
function findMatchingHeadline(
  description: string,
  headlines: NewsHeadline[],
): NewsHeadline | null {
  if (headlines.length === 0) return null;

  // Extract significant words (>= 4 chars, not stop-words).
  const descWords = tokenize(description);
  if (descWords.length === 0) return null;

  let bestMatch: { headline: NewsHeadline; score: number } | null = null;

  for (const h of headlines) {
    const headlineWords = tokenize(h.headline);
    const overlap = descWords.filter((w) => headlineWords.includes(w)).length;
    if (overlap >= 2 && (!bestMatch || overlap > bestMatch.score)) {
      bestMatch = { headline: h, score: overlap };
    }
  }

  return bestMatch?.headline ?? null;
}

function tokenize(text: string): string[] {
  const STOP_WORDS = new Set([
    'the', 'and', 'for', 'that', 'with', 'from', 'this', 'have', 'will',
    'been', 'are', 'not', 'its', 'over', 'amid', 'after', 'into', 'amid',
    'but', 'may', 'says', 'amid', 'could', 'would', 'their',
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

// ─── MACRO ────────────────────────────────────────────────────────────────────

const MACRO_RESOURCES: Array<{ keywords: string[]; label: string; url: string }> = [
  {
    keywords: ['fomc', 'federal reserve', 'fed rate', 'rate decision', 'rate hike', 'rate cut'],
    label: 'Fed Calendar',
    url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  },
  {
    keywords: ['cpi', 'consumer price', 'inflation'],
    label: 'BLS CPI',
    url: 'https://www.bls.gov/cpi/',
  },
  {
    keywords: ['ppi', 'producer price'],
    label: 'BLS PPI',
    url: 'https://www.bls.gov/ppi/',
  },
  {
    keywords: ['nonfarm', 'payroll', 'jobs report', 'employment'],
    label: 'BLS Jobs',
    url: 'https://www.bls.gov/news.release/empsit.toc.htm',
  },
  {
    keywords: ['gdp', 'gross domestic'],
    label: 'BEA GDP',
    url: 'https://www.bea.gov/data/gdp/gross-domestic-product',
  },
  {
    keywords: ['tariff', 'trade policy', 'trade war'],
    label: 'USTR Trade',
    url: 'https://ustr.gov/issue-areas/trade-topics',
  },
];

function buildMacroLinks(description: string): KeyFactorLink[] {
  const lower = description.toLowerCase();
  const links: KeyFactorLink[] = [];

  // Add all matching resource links (a single description can mention CPI + FOMC).
  for (const resource of MACRO_RESOURCES) {
    if (resource.keywords.some((kw) => lower.includes(kw))) {
      links.push({ label: resource.label, url: resource.url });
    }
  }

  // Always add a Google search for the specific event.
  const query = encodeURIComponent(description.slice(0, 80));
  links.push({ label: 'Search', url: `https://www.google.com/search?q=${query}` });

  return links;
}

// ─── EARNINGS ────────────────────────────────────────────────────────────────

function buildEarningsLinks(ticker: string): KeyFactorLink[] {
  return [
    {
      label: 'Yahoo Finance',
      url: `https://finance.yahoo.com/quote/${ticker}/financials/`,
    },
    {
      label: 'Search',
      url: `https://www.google.com/search?q=${ticker}+earnings+date+estimate`,
    },
  ];
}

// ─── ANALYST ─────────────────────────────────────────────────────────────────

function buildAnalystLinks(description: string, ticker: string): KeyFactorLink[] {
  const query = encodeURIComponent(`${ticker} analyst rating ${description.slice(0, 40)}`);
  return [
    {
      label: 'Yahoo Finance',
      url: `https://finance.yahoo.com/quote/${ticker}/analysis/`,
    },
    {
      label: 'Search',
      url: `https://www.google.com/search?q=${query}`,
    },
  ];
}

// ─── INSIDER ─────────────────────────────────────────────────────────────────

function buildInsiderLinks(ticker: string): KeyFactorLink[] {
  return [
    {
      label: 'SEC Filings',
      url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${ticker}&CIK=&type=4&dateb=&owner=include&count=10&search_text=`,
    },
    {
      label: 'Search',
      url: `https://www.google.com/search?q=${ticker}+insider+trading+SEC+form+4`,
    },
  ];
}

// ─── REGULATORY ──────────────────────────────────────────────────────────────

function buildRegulatoryLinks(description: string, ticker: string): KeyFactorLink[] {
  const lower = description.toLowerCase();
  const links: KeyFactorLink[] = [];

  if (lower.includes('fda') || lower.includes('drug') || lower.includes('approval')) {
    links.push({ label: 'FDA', url: 'https://www.fda.gov/drugs/development-approval-process-drugs' });
  }
  if (lower.includes('ftc') || lower.includes('antitrust')) {
    links.push({ label: 'FTC', url: 'https://www.ftc.gov/news-events/news' });
  }
  if (lower.includes('sec') || lower.includes('filing')) {
    links.push({ label: 'SEC EDGAR', url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${ticker}&type=&dateb=&owner=include&count=10` });
  }

  const query = encodeURIComponent(`${ticker} ${description.slice(0, 60)}`);
  links.push({ label: 'Search', url: `https://www.google.com/search?q=${query}` });
  return links;
}

// ─── SHORT SQUEEZE ───────────────────────────────────────────────────────────

function buildShortLinks(ticker: string): KeyFactorLink[] {
  return [
    {
      label: 'Short Data',
      url: `https://www.google.com/search?q=${ticker}+short+interest+float`,
    },
  ];
}

// ─── Generic search fallback ─────────────────────────────────────────────────

function buildSearchLinks(query: string): KeyFactorLink[] {
  return [
    {
      label: 'Search',
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    },
  ];
}
