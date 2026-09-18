import { createHash } from 'node:crypto';
import type { IngestModule } from '../collector/capture.js';
import { makeBarIngest, ingestSnapshot, ingestSplits, ingestDividends } from './market.js';
import {
  hashAccountKey, makePositionIngest, makeBalanceIngest, makeOrderIngest, makeTransactionIngest
} from './account.js';
import { makeExpirationIngest, makeChainIngest, type ExpirationSelection } from './options.js';
import {
  makeEarningsIngest, makeEtradeEarningsIngest, makeIndexQuoteIngest, ingestTreasuryYields, makeRecommendationIngest,
  ingestShortInterest
} from './events.js';
import { ingestFomcCalendar, makeBlsScheduleIngest } from './macro-calendar.js';
import { makeSubmissionsIngest, makeCompanyFactsIngest, makeForm4Ingest } from './edgar.js';
import { makeIvBootstrapIngest, type IvBootstrapIngestArgs } from './iv-bootstrap.js';
import { makeLegacyBriefIngest } from './legacy-brief.js';
import { ingestTickerReference } from './raw-ticker-reference.js';

/**
 * Ingest recipes — what turned a response into rows, recorded so it can be done
 * again (04 §7.5, AC-4; B9b).
 *
 * **Why this exists.** The archive has always kept every response's bytes, but
 * not the arguments its parser was built with: the rule's expiration selection,
 * the sticky set, the order fingerprints and transaction ids already stored, the
 * earnings sweep's universe filter, the CIK map. Several of those are database
 * state at the moment of capture. A replay without them would have to
 * reconstruct them, and a reconstructed replay that reports "equal" is a check
 * that cannot fail on the case it exists for.
 *
 * **Why a recipe and not a recorded copy of the arguments.** `captureResponse`
 * takes a recipe and BUILDS the parser from it through `buildIngest`. There is no
 * second path in which a caller hands over a function and separately describes
 * it — so the recorded arguments are, by construction, the ones that ran. A
 * description kept beside a function is a description that can drift from it,
 * silently, on the one day it matters.
 *
 * **The account key is never in a recipe.** The account parsers use the key only
 * to hash it (P15), so the recipe carries the hash and the raw key never reaches
 * the database or the archive through this route.
 */

export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
export type RecipeArgs = { readonly [key: string]: Json };

export const INGEST_MODULES = [
  'polygon_bars',
  'polygon_snapshot',
  'polygon_splits',
  'polygon_dividends',
  'polygon_short_interest',
  'polygon_ticker_reference',
  'etrade_expirations',
  'etrade_chain',
  'etrade_positions',
  'etrade_balance',
  'etrade_orders',
  'etrade_transactions',
  'etrade_index_quote',
  'etrade_earnings',
  'finnhub_earnings',
  'finnhub_recommendations',
  'treasury_yields',
  'fomc_calendar',
  'bls_schedule',
  'edgar_submissions',
  'edgar_companyfacts',
  'edgar_form4',
  'ivolatility_ivx',
  'legacy_brief'
] as const;

export type IngestModuleName = (typeof INGEST_MODULES)[number];

export interface IngestRecipe {
  readonly module: IngestModuleName;
  readonly args: RecipeArgs;
}

/** A recipe that cannot be turned back into a parser — unknown module, or arguments of the wrong shape. */
export class RecipeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeError';
  }
}

// ── canonical form ───────────────────────────────────────────────────────────

/**
 * JSON with object keys sorted at every level, so the same recipe always has the
 * same bytes and therefore the same digest. Arrays keep their order — the
 * builders sort the ones built from maps and sets, which have no order of their
 * own to preserve.
 */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v: Json) => canonicalJson(v)).join(',')}]`;
  const obj = value as { readonly [key: string]: Json };
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k] as Json)}`)
    .join(',')}}`;
}

/** The identity `meta_ingest_recipe` is keyed on. */
export function recipeDigest(recipe: IngestRecipe): string {
  return createHash('sha256').update(`${recipe.module}\n${canonicalJson(recipe.args)}`).digest('hex');
}

const byKey = (a: readonly [string, string], b: readonly [string, string]): number =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;

function sortedPairs(map: ReadonlyMap<string, string> | undefined): readonly (readonly [string, string])[] {
  return [...(map ?? new Map<string, string>()).entries()].sort(byKey);
}

function sortedSet(set: ReadonlySet<string> | undefined): readonly string[] | undefined {
  return set ? [...set].sort() : undefined;
}

/** Drops `undefined` so an absent option and a missing key hash the same. */
function args(values: { readonly [key: string]: Json | undefined }): RecipeArgs {
  const out: { [key: string]: Json } = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined) out[k] = v;
  return out;
}

const recipe = (module: IngestModuleName, a: RecipeArgs = {}): IngestRecipe => ({ module, args: a });

// ── builders: what call sites use ────────────────────────────────────────────

export const recipes = {
  bars: (o: {
    readonly ticker: string;
    readonly fetchKind: 'backfill' | 'daily' | 'refetch_discontinuity' | 'refetch_manual';
    readonly adjustedAsOf: string;
    readonly provisionalDate?: string;
  }): IngestRecipe => recipe('polygon_bars', args({ ...o })),
  snapshot: (): IngestRecipe => recipe('polygon_snapshot'),
  splits: (): IngestRecipe => recipe('polygon_splits'),
  dividends: (): IngestRecipe => recipe('polygon_dividends'),
  shortInterest: (): IngestRecipe => recipe('polygon_short_interest'),
  tickerReference: (): IngestRecipe => recipe('polygon_ticker_reference'),

  expirations: (o: {
    readonly ticker: string;
    readonly selection: ReadonlyMap<string, ExpirationSelection['reason']>;
  }): IngestRecipe => recipe('etrade_expirations', { ticker: o.ticker, selection: sortedPairs(o.selection) }),
  chain: (o: {
    readonly ticker: string;
    readonly expirationDate: string;
    readonly stickyReasons?: ReadonlyMap<string, string>;
  }): IngestRecipe =>
    recipe('etrade_chain', {
      ticker: o.ticker,
      expirationDate: o.expirationDate,
      stickyReasons: sortedPairs(o.stickyReasons)
    }),

  // The account key goes in and only its digest comes out (P15).
  positions: (accountKey: string): IngestRecipe =>
    recipe('etrade_positions', { accountKeyHash: hashAccountKey(accountKey) }),
  balance: (accountKey: string): IngestRecipe =>
    recipe('etrade_balance', { accountKeyHash: hashAccountKey(accountKey) }),
  orders: (o: { readonly accountKey: string; readonly knownOrders?: ReadonlyMap<string, string> }): IngestRecipe =>
    recipe('etrade_orders', { accountKeyHash: hashAccountKey(o.accountKey), knownOrders: sortedPairs(o.knownOrders) }),
  transactions: (o: { readonly accountKey: string; readonly knownIds?: ReadonlySet<string> }): IngestRecipe =>
    recipe('etrade_transactions', {
      accountKeyHash: hashAccountKey(o.accountKey),
      knownIds: sortedSet(o.knownIds) ?? []
    }),
  indexQuote: (o: { readonly symbol: string }): IngestRecipe => recipe('etrade_index_quote', { symbol: o.symbol }),
  etradeEarnings: (o: { readonly ticker: string }): IngestRecipe => recipe('etrade_earnings', { ticker: o.ticker }),

  earnings: (o: { readonly sweepFrom: string; readonly sweepTo: string; readonly universe?: ReadonlySet<string> }): IngestRecipe =>
    recipe('finnhub_earnings', args({ sweepFrom: o.sweepFrom, sweepTo: o.sweepTo, universe: sortedSet(o.universe) })),
  recommendations: (o: { readonly ticker: string }): IngestRecipe =>
    recipe('finnhub_recommendations', { ticker: o.ticker }),

  treasury: (): IngestRecipe => recipe('treasury_yields'),
  fomc: (): IngestRecipe => recipe('fomc_calendar'),
  bls: (release: { readonly slug: string; readonly type: 'CPI' | 'PPI' | 'NFP'; readonly label: string }): IngestRecipe =>
    recipe('bls_schedule', { slug: release.slug, type: release.type, label: release.label }),

  submissions: (o: {
    readonly cik: string;
    readonly ticker: string;
    readonly since?: string;
    readonly forms?: ReadonlySet<string>;
  }): IngestRecipe =>
    recipe('edgar_submissions', args({ cik: o.cik, ticker: o.ticker, since: o.since, forms: sortedSet(o.forms) })),
  companyFacts: (o: { readonly cik: string; readonly since?: string; readonly concepts?: ReadonlySet<string> }): IngestRecipe =>
    recipe('edgar_companyfacts', args({ cik: o.cik, since: o.since, concepts: sortedSet(o.concepts) })),
  form4: (o: { readonly accessionNo: string; readonly tickerByCik?: ReadonlyMap<string, string> }): IngestRecipe =>
    recipe('edgar_form4', { accessionNo: o.accessionNo, tickerByCik: sortedPairs(o.tickerByCik) }),

  ivBootstrap: (o: IvBootstrapIngestArgs): IngestRecipe =>
    recipe('ivolatility_ivx', args({ ticker: o.ticker, source: o.source, methodNote: o.methodNote })),
  legacyBrief: (): IngestRecipe => recipe('legacy_brief')
} as const;

// ── decoding: recipe → parser ────────────────────────────────────────────────

function str(a: RecipeArgs, key: string): string {
  const v = a[key];
  if (typeof v !== 'string') throw new RecipeError(`recipe argument "${key}" must be a string`);
  return v;
}

function optStr(a: RecipeArgs, key: string): string | undefined {
  const v = a[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new RecipeError(`recipe argument "${key}" must be a string when present`);
  return v;
}

function strings(a: RecipeArgs, key: string): readonly string[] {
  const v = a[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new RecipeError(`recipe argument "${key}" must be an array of strings`);
  }
  return v as readonly string[];
}

function optSet(a: RecipeArgs, key: string): ReadonlySet<string> | undefined {
  return a[key] === undefined ? undefined : new Set(strings(a, key));
}

function pairMap(a: RecipeArgs, key: string): Map<string, string> {
  const v = a[key];
  if (
    !Array.isArray(v) ||
    !v.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string')
  ) {
    throw new RecipeError(`recipe argument "${key}" must be an array of [string, string] pairs`);
  }
  return new Map(v as [string, string][]);
}

function oneOf<T extends string>(a: RecipeArgs, key: string, allowed: readonly T[]): T {
  const v = str(a, key);
  if (!(allowed as readonly string[]).includes(v)) {
    throw new RecipeError(`recipe argument "${key}" must be one of ${allowed.join(', ')}; got "${v}"`);
  }
  return v as T;
}

const DECODERS: { readonly [M in IngestModuleName]: (a: RecipeArgs) => IngestModule } = {
  polygon_bars: (a) => {
    const provisionalDate = optStr(a, 'provisionalDate');
    return makeBarIngest({
      ticker: str(a, 'ticker'),
      fetchKind: oneOf(a, 'fetchKind', ['backfill', 'daily', 'refetch_discontinuity', 'refetch_manual'] as const),
      adjustedAsOf: str(a, 'adjustedAsOf'),
      ...(provisionalDate !== undefined ? { provisionalDate } : {})
    });
  },
  polygon_snapshot: () => ingestSnapshot,
  polygon_splits: () => ingestSplits,
  polygon_dividends: () => ingestDividends,
  polygon_short_interest: () => ingestShortInterest,
  polygon_ticker_reference: () => ingestTickerReference,

  etrade_expirations: (a) =>
    makeExpirationIngest({
      ticker: str(a, 'ticker'),
      selection: pairMap(a, 'selection') as Map<string, ExpirationSelection['reason']>
    }),
  etrade_chain: (a) =>
    makeChainIngest({
      ticker: str(a, 'ticker'),
      expirationDate: str(a, 'expirationDate'),
      stickyReasons: pairMap(a, 'stickyReasons')
    }),
  etrade_positions: (a) => makePositionIngest({ accountKeyHash: str(a, 'accountKeyHash') }),
  etrade_balance: (a) => makeBalanceIngest({ accountKeyHash: str(a, 'accountKeyHash') }),
  etrade_orders: (a) =>
    makeOrderIngest({ accountKeyHash: str(a, 'accountKeyHash'), knownOrders: pairMap(a, 'knownOrders') }),
  etrade_transactions: (a) =>
    makeTransactionIngest({ accountKeyHash: str(a, 'accountKeyHash'), knownIds: new Set(strings(a, 'knownIds')) }),
  etrade_index_quote: (a) => makeIndexQuoteIngest({ symbol: str(a, 'symbol') }),
  etrade_earnings: (a) => makeEtradeEarningsIngest({ ticker: str(a, 'ticker') }),

  finnhub_earnings: (a) => {
    const universe = optSet(a, 'universe');
    return makeEarningsIngest({
      sweepFrom: str(a, 'sweepFrom'),
      sweepTo: str(a, 'sweepTo'),
      ...(universe ? { universe } : {})
    });
  },
  finnhub_recommendations: (a) => makeRecommendationIngest({ ticker: str(a, 'ticker') }),

  treasury_yields: () => ingestTreasuryYields,
  fomc_calendar: () => ingestFomcCalendar,
  bls_schedule: (a) =>
    makeBlsScheduleIngest({
      slug: str(a, 'slug'),
      type: oneOf(a, 'type', ['CPI', 'PPI', 'NFP'] as const),
      label: str(a, 'label')
    }),

  edgar_submissions: (a) => {
    const since = optStr(a, 'since');
    const forms = optSet(a, 'forms');
    return makeSubmissionsIngest({
      cik: str(a, 'cik'),
      ticker: str(a, 'ticker'),
      ...(since !== undefined ? { since } : {}),
      ...(forms ? { forms } : {})
    });
  },
  edgar_companyfacts: (a) => {
    const since = optStr(a, 'since');
    const concepts = optSet(a, 'concepts');
    return makeCompanyFactsIngest({
      cik: str(a, 'cik'),
      ...(since !== undefined ? { since } : {}),
      ...(concepts ? { concepts } : {})
    });
  },
  edgar_form4: (a) =>
    makeForm4Ingest({ accessionNo: str(a, 'accessionNo'), tickerByCik: pairMap(a, 'tickerByCik') }),

  ivolatility_ivx: (a) => {
    const methodNote = optStr(a, 'methodNote');
    return makeIvBootstrapIngest({
      ticker: str(a, 'ticker'),
      source: str(a, 'source'),
      ...(methodNote !== undefined ? { methodNote } : {})
    });
  },
  legacy_brief: () => makeLegacyBriefIngest()
};

export function isIngestModuleName(name: string): name is IngestModuleName {
  return (INGEST_MODULES as readonly string[]).includes(name);
}

/** The ONLY way a parser is obtained for a capture — so what is recorded is what ran. */
export function buildIngest(recipe: IngestRecipe): IngestModule {
  if (!isIngestModuleName(recipe.module)) throw new RecipeError(`unknown ingest module "${String(recipe.module)}"`);
  return DECODERS[recipe.module](recipe.args);
}

/** Reads a recipe back out of `meta_ingest_recipe`. */
export function parseStoredRecipe(module: string, argsJson: string): IngestRecipe {
  if (!isIngestModuleName(module)) throw new RecipeError(`unknown ingest module "${module}"`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    throw new RecipeError(`recipe arguments for ${module} are not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RecipeError(`recipe arguments for ${module} must be a JSON object`);
  }
  return { module, args: parsed as RecipeArgs };
}
