import { describe, it, expect } from 'vitest';
import {
  buildIngest, canonicalJson, parseStoredRecipe, recipeDigest, recipes, INGEST_MODULES, RecipeError,
  type IngestRecipe
} from '../src/ingest/recipes.js';
import { hashAccountKey, makeOrderIngest } from '../src/ingest/account.js';
import { makeExpirationIngest } from '../src/ingest/options.js';

/**
 * Ingest recipes (B9b): the record of how a response was parsed, kept so a
 * replay re-runs the same parse rather than reconstructing it.
 */

const KEY = 'ACCT-KEY-abc123';
const ctx = { runId: 1, asOfDate: '2026-09-07', observedAt: '2026-09-07T17:05:01-04:00', captureRuleId: null, sourceResponseId: 1 };

/** One of every module — the set is asserted equal to the registry, so a new module cannot go untested. */
const SAMPLES: readonly IngestRecipe[] = [
  recipes.bars({ ticker: 'SPY', fetchKind: 'daily', adjustedAsOf: '2026-09-07', provisionalDate: '2026-09-07' }),
  recipes.snapshot(),
  recipes.splits(),
  recipes.dividends(),
  recipes.shortInterest(),
  recipes.tickerReference(),
  recipes.expirations({ ticker: 'SPY', selection: new Map([['2026-09-18', 'within_max_dte' as const]]) }),
  recipes.chain({ ticker: 'SPY', expirationDate: '2026-09-18', stickyReasons: new Map([['SPY---260918P00600000', 'held_position']]) }),
  recipes.positions(KEY),
  recipes.balance(KEY),
  recipes.orders({ accountKey: KEY, knownOrders: new Map([['987', 'abc']]) }),
  recipes.transactions({ accountKey: KEY, knownIds: new Set(['t1']) }),
  recipes.indexQuote({ symbol: 'VIX' }),
  recipes.etradeEarnings({ ticker: 'SWKS' }),
  recipes.earnings({ sweepFrom: '2026-09-07', sweepTo: '2026-09-16', universe: new Set(['SPY', 'AAPL']) }),
  recipes.recommendations({ ticker: 'AAPL' }),
  recipes.treasury(),
  recipes.fomc(),
  recipes.bls({ slug: 'cpi', type: 'CPI', label: 'Consumer Price Index' }),
  recipes.submissions({ cik: '0000320193', ticker: 'AAPL', since: '2025-09-07', forms: new Set(['10-K', '10-Q']) }),
  recipes.companyFacts({ cik: '0000320193', since: '2025-09-07' }),
  recipes.form4({ accessionNo: '0000320193-26-000001', tickerByCik: new Map([['0000320193', 'AAPL']]) }),
  recipes.ivBootstrap({ ticker: 'SPY', source: 'ivolatility', methodNote: 'IVX' }),
  recipes.legacyBrief()
];

describe('the registry', () => {
  it('has a sample for every module, so none goes unexercised', () => {
    expect(new Set(SAMPLES.map((s) => s.module))).toEqual(new Set(INGEST_MODULES));
  });

  it('turns every stored recipe back into a parser', () => {
    for (const r of SAMPLES) {
      const stored = parseStoredRecipe(r.module, canonicalJson(r.args));
      expect(typeof buildIngest(stored), r.module).toBe('function');
      // The digest survives the round trip through storage — it is the key.
      expect(recipeDigest(stored), r.module).toBe(recipeDigest(r));
    }
  });

  it('refuses a module it does not know and arguments of the wrong shape', () => {
    expect(() => parseStoredRecipe('polygon_minute_bars', '{}')).toThrow(RecipeError);
    expect(() => buildIngest(parseStoredRecipe('etrade_chain', '{"ticker":"SPY"}'))).toThrow(/expirationDate/);
    expect(() => buildIngest(parseStoredRecipe('polygon_bars', '{"ticker":"SPY","fetchKind":"weekly","adjustedAsOf":"2026-09-07"}')))
      .toThrow(/fetchKind/);
    expect(() => parseStoredRecipe('polygon_snapshot', '[1,2]')).toThrow(/JSON object/);
  });
});

describe('a recipe is the same parse, not a description of one', () => {
  const ordersBody = JSON.stringify({
    OrdersResponse: {
      Order: [
        {
          orderId: 987, orderType: 'OPTN',
          OrderDetail: [{
            placedTime: 1_788_552_000_000, executedTime: 1_788_552_898_000, status: 'EXECUTED',
            Instrument: [{
              orderAction: 'SELL_OPEN', quantityOrdered: 2, filledQuantity: 2, averageExecutionPrice: 3.4,
              Product: { symbol: 'TSLA', securityType: 'OPTN', callPut: 'PUT', expiryYear: 2026, expiryMonth: 9, expiryDay: 18, strikePrice: 350 }
            }]
          }]
        },
        {
          orderId: 988, orderType: 'EQ',
          OrderDetail: [{ executedTime: 1_788_552_900_000, status: 'EXECUTED', Instrument: [{ orderAction: 'BUY', filledQuantity: 1, averageExecutionPrice: 1, Product: { symbol: 'SPY', securityType: 'EQ' } }] }]
        }
      ]
    }
  });

  it('produces exactly the rows the factory does, known-order skip included', () => {
    // Order 988 is "already stored" with a fingerprint that will not match, and
    // 987 is not known at all; both must come out identically either way.
    const knownOrders = new Map([['988', 'not-the-fingerprint']]);
    const direct = makeOrderIngest({ accountKey: KEY, knownOrders })(ordersBody, ctx);
    const stored = parseStoredRecipe('etrade_orders', canonicalJson(recipes.orders({ accountKey: KEY, knownOrders }).args));
    expect(buildIngest(stored)(ordersBody, ctx)).toEqual(direct);
    expect(direct).toHaveLength(2);
  });

  it('carries the rule\'s expiration selection, which is not in the response', () => {
    // The parser needs to know WHY an expiration was captured, and the provider
    // does not say — that came from the rule, at capture time. Without the
    // recipe a replay would have to recompute the selection from today's rule.
    const body = JSON.stringify({
      OptionExpireDateResponse: { ExpirationDate: [
        { year: 2026, month: 9, day: 18, expiryType: 'MONTHLY' },
        { year: 2027, month: 1, day: 15, expiryType: 'MONTHLY' }
      ] }
    });
    const selection = new Map([['2026-09-18', 'within_max_dte' as const]]);
    const direct = makeExpirationIngest({ ticker: 'SPY', selection })(body, ctx);
    const replayed = buildIngest(
      parseStoredRecipe('etrade_expirations', canonicalJson(recipes.expirations({ ticker: 'SPY', selection }).args))
    )(body, ctx);
    expect(replayed).toEqual(direct);
    expect(replayed.map((r) => r.values['window_reason'])).toEqual(['within_max_dte', 'outside']);
  });
});

describe('the identity of a recipe', () => {
  it('does not depend on the order a map or set was filled in', () => {
    const a = recipes.form4({ accessionNo: 'x', tickerByCik: new Map([['1', 'A'], ['2', 'B']]) });
    const b = recipes.form4({ accessionNo: 'x', tickerByCik: new Map([['2', 'B'], ['1', 'A']]) });
    expect(recipeDigest(a)).toBe(recipeDigest(b));
    const u1 = recipes.earnings({ sweepFrom: 'a', sweepTo: 'b', universe: new Set(['Z', 'A']) });
    const u2 = recipes.earnings({ sweepFrom: 'a', sweepTo: 'b', universe: new Set(['A', 'Z']) });
    expect(recipeDigest(u1)).toBe(recipeDigest(u2));
  });

  it('treats an omitted option and an absent key as the same recipe', () => {
    const a = recipes.bars({ ticker: 'SPY', fetchKind: 'backfill', adjustedAsOf: '2026-09-07' });
    expect(Object.keys(a.args)).not.toContain('provisionalDate');
  });
});

describe('the account key never reaches a recipe (P15)', () => {
  it('stores only the digest the rows already carry', () => {
    const accountRecipes = [
      recipes.positions(KEY),
      recipes.balance(KEY),
      recipes.orders({ accountKey: KEY }),
      recipes.transactions({ accountKey: KEY })
    ];
    for (const r of accountRecipes) {
      const json = canonicalJson(r.args);
      expect(json, r.module).not.toContain(KEY);
      expect(json, r.module).toContain(hashAccountKey(KEY));
    }
  });
});
