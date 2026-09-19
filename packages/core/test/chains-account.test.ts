import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { osiSymbol } from '../src/ingest/osi.js';
import { recipes } from '../src/ingest/recipes.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost, ProviderResponse } from '../src/collector/host.js';
import { resetOffsetCache } from '../src/collector/archive.js';
import { beginRun, captureRuleId, type RunHandle } from '../src/collector/run.js';
import { captureResponse } from '../src/collector/capture.js';
import {
  etradeYesNoToFlag,
  secondsEpochToEt,
  makeChainIngest,
  makeExpirationIngest
} from '../src/ingest/options.js';
import {
  makePositionIngest,
  makeBalanceIngest,
  makeOrderIngest,
  makeTransactionIngest,
  orderFingerprint,
  hashAccountKey,
  msEpochToEt
} from '../src/ingest/account.js';
import {
  runAccountPhase,
  deriveHeldStickyContracts,
  maskAccountKey,
  accountKeysFrom
} from '../src/collector/phases/account.js';
import {
  runChainSubsetPhase,
  runChainsPhase,
  selectExpirations,
  subsetCandidates,
  closeExpiredStickyContracts,
  repairStickyOsiPadding
} from '../src/collector/phases/chains.js';
import { runGate } from '../src/qa/gate.js';
import { CHAIN_CHECKS, ACCOUNT_CHECKS } from '../src/qa/registry.js';
import { bsDelta } from '../src/qa/black-scholes.js';
import { QC404_BID_ASK_SANITY } from '../src/qa/checks/chains.js';

/**
 * B6 — the chain and account domains.
 *
 * The gate for this step is AC-5 on a full run: stored contracts equal parsed
 * contracts for every chain response. Everything else here exists because a
 * live E*Trade response on 2026-09-07 disagreed with what a field name
 * suggested, and each of those disagreements is one test.
 */

let dir: string;
let raw: Database.Database;

function response(body: string, status: number | null = 200): ProviderResponse {
  return {
    status,
    body,
    requestedAt: '2026-09-07T17:05:00-04:00',
    respondedAt: status === null ? null : '2026-09-07T17:05:01-04:00'
  };
}

function makeHost(overrides: Partial<CollectorHost> = {}): CollectorHost {
  return {
    openGenerationDb: () => raw as unknown as SqliteLike,
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    decryptFromArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    polygonGet: async () => response('{"results":[]}'),
    etradeGet: async () => response('{}'),
    httpGet: async () => response('{}'),
    nowET: () => '2026-09-07T17:05:00-04:00',
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test-host', version: '0.0.0' },
    ...overrides
  };
}

const DATE = '2026-09-07';

function db(): SqliteLike {
  return raw as unknown as SqliteLike;
}

function newRun(): RunHandle {
  return beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
}

function ctxFor(run: RunHandle) {
  return { runId: run.runId, asOfDate: DATE, observedAt: '2026-09-07T17:05:01-04:00', captureRuleId: null, sourceResponseId: 1 };
}

/** The chain shape E*Trade actually returns, reduced to what ingestion reads. */
function chainBody(opts: {
  nearPrice: number;
  pairs: {
    strike: number;
    callVolume?: number;
    callOi?: number;
    inTheMoney?: unknown;
    iv?: number;
    lastPrice?: number;
    bid?: number;
    ask?: number;
    putBid?: number;
    putAsk?: number;
  }[];
}): string {
  return JSON.stringify({
    OptionChainResponse: {
      nearPrice: opts.nearPrice,
      OptionPair: opts.pairs.map((p) => ({
        Call: {
          osiKey: `SPY---260918C${String(Math.round(p.strike * 1000)).padStart(8, '0')}`,
          strikePrice: p.strike,
          displaySymbol: `SPY Sep 18 '26 $${String(p.strike)} Call`,
          ...(p.bid === undefined ? {} : { bid: p.bid }),
          ...(p.ask === undefined ? {} : { ask: p.ask }),
          ...(p.lastPrice === undefined ? {} : { lastPrice: p.lastPrice }),
          ...(p.callVolume === undefined ? {} : { volume: p.callVolume }),
          ...(p.callOi === undefined ? {} : { openInterest: p.callOi }),
          ...(p.inTheMoney === undefined ? {} : { inTheMoney: p.inTheMoney }),
          timeStamp: 1_788_552_898,
          OptionGreeks: { iv: p.iv ?? 0.1523, delta: 0.52, gamma: 0.01, theta: -0.18651, vega: 0.4, rho: 0.1 }
        },
        Put: {
          osiKey: `SPY---260918P${String(Math.round(p.strike * 1000)).padStart(8, '0')}`,
          strikePrice: p.strike,
          bid: p.putBid ?? 1,
          ask: p.putAsk ?? 1.1,
          volume: 5,
          openInterest: 10,
          inTheMoney: 'n',
          timeStamp: 1_788_552_898,
          OptionGreeks: { iv: 0.16, delta: -0.48, gamma: 0.01, theta: -0.17, vega: 0.4, rho: -0.1 }
        }
      }))
    }
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-b6-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
  raw.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) " +
      "VALUES (1, '2026-09-07T00:00:00-04:00', 'pilot', 'x', 'y')"
  );
  resetOffsetCache();
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('E*Trade field types — a name does not tell you the type', () => {
  it('maps the STRING "n" to 0, which a cast gets exactly backwards', () => {
    // Boolean("n") === true, so a cast would mark every contract in the money:
    // nothing throws, no check fires, and a moneyness filter selects the chain.
    expect(etradeYesNoToFlag('n')).toBe(0);
    expect(etradeYesNoToFlag('y')).toBe(1);
    expect(Boolean('n')).toBe(true);
  });

  it('leaves an unrecognised moneyness value null rather than guessing', () => {
    expect(etradeYesNoToFlag(undefined)).toBeNull();
    expect(etradeYesNoToFlag('maybe')).toBeNull();
  });

  it('reads timeStamp as epoch SECONDS — as milliseconds it lands in 1970', () => {
    const asSeconds = secondsEpochToEt(1_788_552_898);
    expect(asSeconds?.slice(0, 4)).toBe('2026');
    expect(new Date(1_788_552_898).getUTCFullYear()).toBe(1970);
  });

  it('reads an order time as epoch MILLISECONDS, which is the other feed', () => {
    expect(msEpochToEt(1_788_552_898_000)?.slice(0, 4)).toBe('2026');
  });
});

describe('option-contract ingestion — absent and zero are different facts', () => {
  it('stores an absent volume as null + omitted, never as 0', () => {
    const run = newRun();
    const rows = makeChainIngest({ ticker: 'SPY', expirationDate: '2026-09-18' })(
      chainBody({ nearPrice: 770.19, pairs: [{ strike: 770 }] }),
      ctxFor(run)
    );
    const call = rows.find((r) => r.values['right'] === 'call')!;
    expect(call.values['volume']).toBeNull();
    expect(call.values['volume_status']).toBe('omitted');
  });

  it('stores a genuine zero volume as 0 + ok — 60 of 171 live SPY calls send one', () => {
    const run = newRun();
    const rows = makeChainIngest({ ticker: 'SPY', expirationDate: '2026-09-18' })(
      chainBody({ nearPrice: 770.19, pairs: [{ strike: 770, callVolume: 0, callOi: 0 }] }),
      ctxFor(run)
    );
    const call = rows.find((r) => r.values['right'] === 'call')!;
    expect(call.values['volume']).toBe(0);
    expect(call.values['volume_status']).toBe('ok');
  });

  it('stores lastPrice 0 as omitted — a zero there would read as "it traded at zero"', () => {
    const run = newRun();
    const rows = makeChainIngest({ ticker: 'SPY', expirationDate: '2026-09-18' })(
      chainBody({ nearPrice: 770.19, pairs: [{ strike: 770, lastPrice: 0 }] }),
      ctxFor(run)
    );
    const call = rows.find((r) => r.values['right'] === 'call')!;
    expect(call.values['last']).toBeNull();
    expect(call.values['last_status']).toBe('omitted');
  });

  it('marks an out-of-range IV invalid rather than storing it', () => {
    const run = newRun();
    const rows = makeChainIngest({ ticker: 'SPY', expirationDate: '2026-09-18' })(
      chainBody({ nearPrice: 770.19, pairs: [{ strike: 770, iv: 15.23 }] }),
      ctxFor(run)
    );
    const call = rows.find((r) => r.values['right'] === 'call')!;
    expect(call.values['iv']).toBeNull();
    expect(call.values['iv_status']).toBe('invalid');
  });

  it('stores every strike returned, winners and losers alike (Q2)', () => {
    const run = newRun();
    const rows = makeChainIngest({ ticker: 'SPY', expirationDate: '2026-09-18' })(
      chainBody({ nearPrice: 770.19, pairs: [{ strike: 700 }, { strike: 770 }, { strike: 850 }] }),
      ctxFor(run)
    );
    expect(rows).toHaveLength(6);
  });

  it('is deterministic — the same body gives byte-identical rows', () => {
    const run = newRun();
    const body = chainBody({ nearPrice: 770.19, pairs: [{ strike: 770, callVolume: 3 }] });
    const ingest = makeChainIngest({ ticker: 'SPY', expirationDate: '2026-09-18' });
    expect(JSON.stringify(ingest(body, ctxFor(run)))).toBe(JSON.stringify(ingest(body, ctxFor(run))));
  });
});

describe('expirations — the declined ones are recorded too', () => {
  const listed = [
    { date: '2026-09-11', expiryType: 'WEEKLY' },
    { date: '2026-09-18', expiryType: 'MONTHLY' },
    { date: '2026-09-30', expiryType: 'MONTHEND' },
    { date: '2026-12-18', expiryType: 'MONTHLY' },
    { date: '2027-01-15', expiryType: 'MONTHLY' },
    { date: '2027-06-17', expiryType: 'MONTHLY' }
  ];

  it('takes everything inside the window plus two monthlies beyond it', () => {
    const selection = selectExpirations({ tradingDate: DATE, listed, stickyExpirations: new Set() });
    expect(selection.get('2026-09-11')).toBe('within_max_dte');
    expect(selection.get('2026-12-18')).toBe('extra_monthly');
    expect(selection.get('2027-01-15')).toBe('extra_monthly');
    expect(selection.get('2027-06-17')).toBe('outside');
  });

  it('records a declined expiration rather than omitting it', () => {
    const selection = selectExpirations({ tradingDate: DATE, listed, stickyExpirations: new Set() });
    // A pipeline that keeps only what it captured cannot say why something is
    // missing, so `outside` is a stored fact.
    expect([...selection.keys()]).toHaveLength(listed.length);
  });

  it('pulls a sticky contract\'s expiration in even when the window declined it', () => {
    const selection = selectExpirations({
      tradingDate: DATE,
      listed,
      stickyExpirations: new Set(['2027-06-17'])
    });
    expect(selection.get('2027-06-17')).toBe('sticky_contract');
  });

  it('stores MONTHEND, the fourth expiryType the draft did not have', () => {
    const run = newRun();
    const body = JSON.stringify({
      OptionExpireDateResponse: {
        ExpirationDate: [{ year: 2026, month: 9, day: 30, expiryType: 'MONTHEND' }]
      }
    });
    const rows = makeExpirationIngest({
      ticker: 'SPY',
      selection: new Map([['2026-09-30', 'within_max_dte' as const]])
    })(body, ctxFor(run));
    expect(rows[0]!.values['expiry_type']).toBe('MONTHEND');
  });
});

describe('the account — provider estimates stay labelled as estimates', () => {
  const KEY = 'ACCT-KEY-abc123';

  const portfolio = JSON.stringify({
    PortfolioResponse: {
      AccountPortfolio: [
        {
          Position: [
            {
              positionId: 1234,
              quantity: 2,
              positionType: 'SHORT',
              pricePaid: 3.4,
              totalCost: -680,
              marketValue: -410,
              daysGain: 12,
              totalGain: 270,
              dateAcquired: '2026-08-20T00:00:00Z',
              Product: {
                symbol: 'TSLA',
                securityType: 'OPTN',
                callPut: 'PUT',
                expiryYear: 2026,
                expiryMonth: 9,
                expiryDay: 18,
                strikePrice: 350
              },
              Quick: { lastTrade: 2.05 }
            },
            {
              positionId: 1235,
              quantity: 100,
              positionType: 'LONG',
              pricePaid: 210.5,
              totalCost: 21_050,
              marketValue: 22_000,
              Product: { symbol: 'AMD', securityType: 'EQ' },
              Quick: { lastTrade: 220 }
            }
          ]
        }
      ]
    }
  });

  it('signs a short position negative so nothing downstream guesses the convention', () => {
    const run = newRun();
    const rows = makePositionIngest(KEY)(portfolio, ctxFor(run));
    expect(rows[0]!.values['quantity']).toBe(-2);
    expect(rows[1]!.values['quantity']).toBe(100);
  });

  it('never stores the account key itself, only a digest of it', () => {
    const run = newRun();
    const rows = makePositionIngest(KEY)(portfolio, ctxFor(run));
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(KEY);
    expect(rows[0]!.values['account_key_hash']).toBe(hashAccountKey(KEY));
  });

  it('builds an OSI symbol for an option line and leaves it null for a stock line', () => {
    const run = newRun();
    const rows = makePositionIngest(KEY)(portfolio, ctxFor(run));
    expect(rows[0]!.values['osi_symbol']).toBe('TSLA  260918P00350000');
    expect(rows[0]!.values['right']).toBe('put');
    expect(rows[1]!.values['osi_symbol']).toBeNull();
    expect(rows[1]!.values['strike']).toBeNull();
  });

  it('masks the key out of the endpoint before it reaches meta_response', () => {
    expect(maskAccountKey(`/v1/accounts/${KEY}/portfolio`, KEY)).toBe('/v1/accounts/{accountKey}/portfolio');
  });

  it('reads the balance from Computed.RealTimeValues, where it actually lives', () => {
    const run = newRun();
    const rows = makeBalanceIngest(KEY)(
      JSON.stringify({
        BalanceResponse: {
          accountType: 'MARGIN',
          Computed: {
            cashAvailableForInvestment: 1000,
            cashBuyingPower: 1000,
            netCash: 950,
            RealTimeValues: { totalAccountValue: 51_234.56 }
          }
        }
      }),
      ctxFor(run)
    );
    expect(rows[0]!.values['total_account_value']).toBe(51_234.56);
    // Absent in the payload, so `omitted` — not zero.
    expect(rows[0]!.values['margin_buying_power']).toBeNull();
    expect(rows[0]!.values['margin_buying_power_status']).toBe('omitted');
  });

  it('leaves a cash transaction\'s symbol null — brokerage.product is an empty object there', () => {
    const run = newRun();
    const rows = makeTransactionIngest({ accountKey: KEY })(
      JSON.stringify({
        TransactionListResponse: {
          Transaction: [
            { transactionId: 1, transactionDate: 1_788_552_898_000, transactionType: 'Transfer', amount: 500, brokerage: { product: {} } },
            { transactionId: 2, transactionDate: 1_788_552_898_000, transactionType: 'Sold Short', amount: 340, brokerage: { product: { symbol: 'TSLA' }, quantity: 2, price: 1.7 } }
          ]
        }
      }),
      ctxFor(run)
    );
    expect(rows[0]!.values['symbol']).toBeNull();
    expect(rows[1]!.values['symbol']).toBe('TSLA');
  });

  it('skips a transaction already stored — they are immutable', () => {
    const run = newRun();
    const body = JSON.stringify({
      TransactionListResponse: {
        Transaction: [{ transactionId: 7, transactionDate: 1_788_552_898_000, transactionType: 'Dividend', amount: 12 }]
      }
    });
    expect(makeTransactionIngest({ accountKey: KEY })(body, ctxFor(run))).toHaveLength(1);
    expect(
      makeTransactionIngest({ accountKey: KEY, knownIds: new Set(['7']) })(body, ctxFor(run))
    ).toHaveLength(0);
  });
});

describe('executed orders — the fills that supersede every estimate', () => {
  const KEY = 'ACCT-KEY-abc123';
  const ordersBody = (price: number): string =>
    JSON.stringify({
      OrdersResponse: {
        Order: [
          {
            orderId: 987,
            orderType: 'OPTN',
            OrderDetail: [
              {
                placedTime: 1_788_552_000_000,
                executedTime: 1_788_552_898_000,
                status: 'EXECUTED',
                priceType: 'NET_CREDIT',
                Instrument: [
                  {
                    orderAction: 'SELL_OPEN',
                    quantityOrdered: 2,
                    filledQuantity: 2,
                    averageExecutionPrice: price,
                    estimatedCommission: 0,
                    estimatedFees: 0.14,
                    Product: {
                      symbol: 'TSLA', securityType: 'OPTN', callPut: 'PUT',
                      expiryYear: 2026, expiryMonth: 9, expiryDay: 18, strikePrice: 350
                    }
                  }
                ]
              }
            ]
          }
        ]
      }
    });

  it('returns legs as children, because order_row_id is not knowable in a pure module', () => {
    const run = newRun();
    const rows = makeOrderIngest({ accountKey: KEY })(ordersBody(3.4), ctxFor(run));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.children?.[0]?.parentColumn).toBe('order_row_id');
    expect(rows[0]!.children?.[0]?.rows[0]?.['order_action']).toBe('SELL_OPEN');
  });

  it('writes the legs against the parent row_id, inside the parent transaction', () => {
    const run = newRun();
    const rule = captureRuleId(db(), makeHost(), 'account', { v: 1 }, 'test');
    const result = captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'etrade',
      endpoint: '/v1/accounts/{accountKey}/orders', slug: 'account-orders', params: {},
      response: response(ordersBody(3.4)), captureRuleId: rule,
      recipe: recipes.orders({ accountKey: KEY })
    });
    expect(result.parseStatus).toBe('ok');
    // Order plus leg: `parsed_row_count` counts children so AC-5 holds for every
    // table a response writes, not only the top-level one.
    expect(result.rowsWritten).toBe(2);
    const leg = raw
      .prepare(
        `SELECT l.osi_symbol, o.order_id FROM raw_executed_order_leg l
           JOIN raw_executed_order o ON o.row_id = l.order_row_id`
      )
      .get() as { osi_symbol: string; order_id: string };
    expect(leg.order_id).toBe('987');
    expect(leg.osi_symbol).toBe('TSLA  260918P00350000');
  });

  it('writes nothing for an unchanged re-pull, so the daily window does not duplicate', () => {
    const run = newRun();
    const first = makeOrderIngest({ accountKey: KEY })(ordersBody(3.4), ctxFor(run));
    const fingerprint = first[0]!.values['order_fingerprint'] as string;
    const second = makeOrderIngest({
      accountKey: KEY,
      knownOrders: new Map([['987', fingerprint]])
    })(ordersBody(3.4), ctxFor(run));
    expect(second).toHaveLength(0);
  });

  it('appends a second observation when the leg data changed — QC-803 needs both', () => {
    const run = newRun();
    const first = makeOrderIngest({ accountKey: KEY })(ordersBody(3.4), ctxFor(run));
    const fingerprint = first[0]!.values['order_fingerprint'] as string;
    const changed = makeOrderIngest({
      accountKey: KEY,
      knownOrders: new Map([['987', fingerprint]])
    })(ordersBody(9.9), ctxFor(run));
    expect(changed).toHaveLength(1);
    expect(changed[0]!.values['order_fingerprint']).not.toBe(fingerprint);
  });

  it('fingerprints on the leg tuple, not on the whole row', () => {
    const a = orderFingerprint({ executedTime: 't', status: 'EXECUTED', legs: [{ leg_index: 0, symbol: 'X' }] });
    const b = orderFingerprint({ executedTime: 't', status: 'EXECUTED', legs: [{ leg_index: 0, symbol: 'Y' }] });
    expect(a).not.toBe(b);
  });
});

describe('phase 5 — the account, and the sticky contracts it produces', () => {
  const KEY = 'ACCT-KEY-abc123';

  function accountHost(): CollectorHost {
    return makeHost({
      etradeGet: async (path) => {
        if (path === '/v1/accounts/list') {
          return response(
            JSON.stringify({
              AccountListResponse: {
                Accounts: {
                  Account: [
                    { accountIdKey: KEY, accountStatus: 'ACTIVE' },
                    { accountIdKey: 'OLD-KEY', accountStatus: 'CLOSED' }
                  ]
                }
              }
            })
          );
        }
        if (path.endsWith('/portfolio')) {
          return response(
            JSON.stringify({
              PortfolioResponse: {
                AccountPortfolio: [
                  {
                    Position: [
                      {
                        positionId: 1, quantity: 2, positionType: 'SHORT',
                        pricePaid: 3.4, totalCost: -680, marketValue: -410,
                        Product: {
                          symbol: 'TSLA', securityType: 'OPTN', callPut: 'PUT',
                          expiryYear: 2026, expiryMonth: 9, expiryDay: 18, strikePrice: 350
                        },
                        Quick: { lastTrade: 2.05 }
                      }
                    ]
                  }
                ]
              }
            })
          );
        }
        if (path.endsWith('/balance')) {
          return response(
            JSON.stringify({
              BalanceResponse: { accountType: 'MARGIN', Computed: { netCash: 1, RealTimeValues: { totalAccountValue: 50_000 } } }
            })
          );
        }
        if (path.endsWith('/orders')) return response(JSON.stringify({ OrdersResponse: { Order: [] } }));
        return response(JSON.stringify({ TransactionListResponse: { Transaction: [] } }));
      }
    });
  }

  it('discovers open accounts and skips closed ones', () => {
    const keys = accountKeysFrom(
      JSON.stringify({
        AccountListResponse: {
          Accounts: { Account: [{ accountIdKey: 'A', accountStatus: 'ACTIVE' }, { accountIdKey: 'B', accountStatus: 'CLOSED' }] }
        }
      })
    );
    expect(keys).toEqual(['A']);
  });

  it('collects positions and a balance, and pins the held option', async () => {
    const host = accountHost();
    const run = beginRun(db(), host, { kind: 'daily', tradingDate: DATE });
    const result = await runAccountPhase(host, db(), run);

    expect(result.positions).toBe(1);
    expect(result.balanceRows).toBe(1);
    expect(result.stickyOpened).toBe(1);

    const pin = raw
      .prepare('SELECT osi_symbol, reason, valid_to FROM ref_sticky_contract')
      .get() as { osi_symbol: string; reason: string; valid_to: string | null };
    // The chain's form (E*Trade osiKey, dash-padded), not the position's OCC
    // space-padded one: a space-padded pin matches no snapshot and was closed by
    // the chain phase's repair the same day it was opened (v1.1.269).
    expect(pin.osi_symbol).toBe('TSLA--260918P00350000');
    expect(pin.reason).toBe('held_in_book');
    expect(pin.valid_to).toBeNull();
    // The raw column is parser output and stays as it was, so replays of earlier days still match.
    expect(raw.prepare('SELECT osi_symbol FROM raw_account_position_snapshot').get())
      .toEqual({ osi_symbol: 'TSLA  260918P00350000' });
  });

  it('marks every account response encrypted at rest (P15)', async () => {
    const host = accountHost();
    const run = beginRun(db(), host, { kind: 'daily', tradingDate: DATE });
    await runAccountPhase(host, db(), run);
    const clear = raw
      .prepare("SELECT COUNT(*) AS n FROM meta_response WHERE endpoint LIKE '/v1/accounts/%' AND encrypted = 0")
      .get() as { n: number };
    expect(clear.n).toBe(0);
  });

  it('never lets the raw account key reach meta_response', async () => {
    const host = accountHost();
    const run = beginRun(db(), host, { kind: 'daily', tradingDate: DATE });
    await runAccountPhase(host, db(), run);
    const rows = raw.prepare('SELECT endpoint FROM meta_response').all() as { endpoint: string }[];
    expect(rows.some((r) => r.endpoint.includes(KEY))).toBe(false);
    expect(rows.some((r) => r.endpoint === '/v1/accounts/{accountKey}/portfolio')).toBe(true);
  });

  it('pins idempotently — a second run does not multiply the pin', async () => {
    const host = accountHost();
    const run = beginRun(db(), host, { kind: 'daily', tradingDate: DATE });
    await runAccountPhase(host, db(), run);
    const again = deriveHeldStickyContracts(db(), run);
    expect(again).toBe(0);
  });

  it('does not fail the phase when the transactions fallback is unavailable', async () => {
    const host = makeHost({
      etradeGet: async (path) => {
        if (path === '/v1/accounts/list') {
          return response(JSON.stringify({ AccountListResponse: { Accounts: { Account: [{ accountIdKey: KEY }] } } }));
        }
        if (path.endsWith('/transactions')) return response('oauth_problem=nonce_used', 401);
        if (path.endsWith('/balance')) {
          return response(JSON.stringify({ BalanceResponse: { Computed: { RealTimeValues: { totalAccountValue: 1 } } } }));
        }
        return response(JSON.stringify({ PortfolioResponse: { AccountPortfolio: [] } }));
      }
    });
    const run = beginRun(db(), host, { kind: 'daily', tradingDate: DATE });
    const result = await runAccountPhase(host, db(), run);
    expect(result.transactionsFailed).toBe(true);
    expect(result.balanceRows).toBe(1);
  });
});

describe('phase 6 — the chain subset admits, and never removes', () => {
  function seedBars(ticker: string, close: number, volume: number): void {
    const run = newRun();
    const rule = captureRuleId(db(), makeHost(), 'bars', { v: 1 }, 'test');
    raw
      .prepare(
        "INSERT INTO meta_response (run_id, provider, endpoint, params_json, requested_at, http_status, byte_length, archive_file, archive_offset, sha256, dedup_hash, encrypted, at_provider_cap, parse_status, parsed_row_count) " +
          "VALUES (?, 'polygon', '/x', '{}', '2026-09-07T17:00:00-04:00', 200, 1, 'f', 0, 'h', ?, 0, 0, 'ok', 1)"
      )
      .run(run.runId, `${ticker}-hash-${String(run.runId)}-${String(Date.now())}-${String(Math.random())}`);
    const src = raw.prepare('SELECT MAX(source_response_id) AS id FROM meta_response').get() as { id: number };
    const alreadyKnown = raw
      .prepare('SELECT 1 FROM ref_universe_membership WHERE ticker = ?')
      .get(ticker);
    if (!alreadyKnown) {
      raw
        .prepare(
          `INSERT INTO ref_universe_membership (run_id, as_of_date, observed_at, capture_rule_id, source_response_id, ticker, list_source, valid_from, change_reason)
           VALUES (?, ?, '2026-09-07T17:00:00-04:00', ?, ?, ?, 'sp500', ?, 'initial')`
        )
        .run(run.runId, DATE, rule, src.id, ticker, DATE);
    }
    for (let i = 0; i < 20; i++) {
      const d = new Date(Date.parse(`${DATE}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10);
      raw
        .prepare(
          `INSERT INTO raw_daily_bar (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
             ticker, trade_date, open, high, low, close, volume, adjusted_as_of, fetch_kind, is_final)
           VALUES (?, ?, '2026-09-07T17:00:00-04:00', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'daily', 1)`
        )
        .run(run.runId, DATE, rule, src.id, ticker, d, close, close, close, close, volume, DATE);
    }
  }

  it('admits a ticker above both thresholds and leaves the rest out', () => {
    seedBars('SPY', 770, 1_000_000); // $770M/day
    seedBars('TINY', 4, 1_000_000); // fails the price floor
    const host = makeHost();
    const run = newRun();
    const result = runChainSubsetPhase(db(), host, run);

    expect(result.evaluated).toBe(2);
    const members = (
      raw.prepare('SELECT ticker FROM ref_chain_subset_membership WHERE valid_to IS NULL').all() as { ticker: string }[]
    ).map((r) => r.ticker);
    expect(members).toEqual(['SPY']);
  });

  it('admits on a fractional volume — dollar volume is not close × 0', () => {
    // gen-001 stored every fractional Polygon volume as 0, so this rule measured
    // $0/day for everything and the subset sat near-empty for two days. The cause
    // was read at the time as "not enough bars yet".
    seedBars('FRAC', 500, 1_000_000.5);
    const measured = subsetCandidates(db(), DATE).find((c) => c.ticker === 'FRAC');
    expect(measured!.advol20).toBe(500 * 1_000_000.5);
    runChainSubsetPhase(db(), makeHost(), newRun());
    const members = (
      raw.prepare('SELECT ticker FROM ref_chain_subset_membership WHERE valid_to IS NULL').all() as { ticker: string }[]
    ).map((r) => r.ticker);
    expect(members).toContain('FRAC');
  });

  it('records the measured inputs the decision was made on', () => {
    seedBars('SPY', 770, 1_000_000);
    runChainSubsetPhase(db(), makeHost(), newRun());
    const row = raw.prepare('SELECT rule_inputs_json FROM ref_chain_subset_membership').get() as {
      rule_inputs_json: string;
    };
    const inputs = JSON.parse(row.rule_inputs_json) as { close: number; advol20: number };
    expect(inputs.close).toBe(770);
    expect(inputs.advol20).toBe(770_000_000);
  });

  it('keeps a member that no longer passes the rule (Q15)', () => {
    // Admitted while it qualified, then measured below the floor. `removal_reason`
    // has no `fell_below_threshold` value to write even if the phase wanted one:
    // a series that stops mid-study is worse than a few extra calls.
    seedBars('FADED', 770, 1_000_000);
    runChainSubsetPhase(db(), makeHost(), newRun());

    // A later observation, appended rather than overwritten (P1). The window is
    // the latest observation per trade date, so the superseded reading does not
    // blend into it.
    seedBars('FADED', 770, 1);
    const measured = subsetCandidates(db(), DATE).find((c) => c.ticker === 'FADED');
    expect(measured!.advol20).toBeLessThan(233_000_000);

    runChainSubsetPhase(db(), makeHost(), newRun());

    const rows = raw
      .prepare("SELECT valid_to, removal_reason FROM ref_chain_subset_membership WHERE ticker = 'FADED'")
      .all() as { valid_to: string | null; removal_reason: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valid_to).toBeNull();
  });

  it('averages the latest observation per day, not the last 20 rows', () => {
    // Append-only bars mean a re-fetch leaves two rows for one date. Reading
    // rows rather than days would make the window ten days of two readings and
    // quietly average a superseded value into the admission decision.
    seedBars('DUP', 100, 1_000_000);
    seedBars('DUP', 100, 3_000_000);
    const measured = subsetCandidates(db(), DATE).find((c) => c.ticker === 'DUP');
    expect(measured!.advol20).toBe(300_000_000);
  });

  it('does not admit a ticker with no bar at all rather than claiming a measurement', () => {
    const run = newRun();
    const rule = captureRuleId(db(), makeHost(), 'bars', { v: 1 }, 'test');
    raw
      .prepare(
        "INSERT INTO meta_response (run_id, provider, endpoint, params_json, requested_at, http_status, byte_length, archive_file, archive_offset, sha256, dedup_hash, encrypted, at_provider_cap, parse_status, parsed_row_count) " +
          "VALUES (?, 'polygon', '/x', '{}', '2026-09-07T17:00:00-04:00', 200, 1, 'f', 0, 'h', 'nobar', 0, 0, 'ok', 0)"
      )
      .run(run.runId);
    const src = raw.prepare('SELECT MAX(source_response_id) AS id FROM meta_response').get() as { id: number };
    raw
      .prepare(
        `INSERT INTO ref_universe_membership (run_id, as_of_date, observed_at, capture_rule_id, source_response_id, ticker, list_source, valid_from, change_reason)
         VALUES (?, ?, '2026-09-07T17:00:00-04:00', ?, ?, 'GHOST', 'sp500', ?, 'initial')`
      )
      .run(run.runId, DATE, rule, src.id, DATE);

    const result = runChainSubsetPhase(db(), makeHost(), newRun());
    expect(result.admitted).toBe(0);
  });
});

describe('phase 7 — chains, and AC-5 on every response', () => {
  function subsetMember(ticker: string): void {
    const run = newRun();
    const rule = captureRuleId(db(), makeHost(), 'chain_subset', { v: 1 }, 'test');
    raw
      .prepare(
        "INSERT INTO meta_response (run_id, provider, endpoint, params_json, requested_at, http_status, byte_length, archive_file, archive_offset, sha256, dedup_hash, encrypted, at_provider_cap, parse_status, parsed_row_count) " +
          "VALUES (?, 'polygon', '/x', '{}', '2026-09-07T17:00:00-04:00', 200, 1, 'f', 0, 'h', ?, 0, 0, 'ok', 0)"
      )
      .run(run.runId, `subset-${ticker}`);
    const src = raw.prepare('SELECT MAX(source_response_id) AS id FROM meta_response').get() as { id: number };
    raw
      .prepare(
        `INSERT INTO ref_chain_subset_membership (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
           ticker, valid_from, membership_reason, rule_capture_rule_id, rule_inputs_json)
         VALUES (?, ?, '2026-09-07T17:00:00-04:00', ?, ?, ?, ?, 'rule_pass', ?, '{}')`
      )
      .run(run.runId, DATE, rule, src.id, ticker, DATE, rule);
  }

  function chainHost(): CollectorHost {
    return makeHost({
      etradeGet: async (path, params) => {
        if (path === '/v1/market/optionexpiredate') {
          return response(
            JSON.stringify({
              OptionExpireDateResponse: {
                ExpirationDate: [
                  { year: 2026, month: 9, day: 18, expiryType: 'MONTHLY' },
                  { year: 2026, month: 12, day: 18, expiryType: 'MONTHLY' },
                  { year: 2027, month: 1, day: 15, expiryType: 'MONTHLY' },
                  { year: 2027, month: 9, day: 17, expiryType: 'MONTHLY' }
                ]
              }
            })
          );
        }
        void params;
        return response(chainBody({ nearPrice: 770.19, pairs: [{ strike: 760 }, { strike: 770 }, { strike: 780 }] }));
      }
    });
  }

  it('closes a member E*Trade no longer recognises as delisted, and keeps asking about the rest', async () => {
    // EA, EQR and WBS, 2026-09-16: delisted, still sticky members, one error each run.
    subsetMember('SPY');
    subsetMember('WBS');
    const inner = chainHost();
    const host = makeHost({
      etradeGet: async (path, params) => {
        if (params['symbol'] === 'WBS') {
          // E*Trade's body, verbatim from the 2026-09-16 API log.
          return response('{"Error":{"code":10033,"message":"The symbol entered is invalid. Please enter another symbol."}}', 400);
        }
        return inner.etradeGet(path, params);
      }
    });
    const run = beginRun(db(), host, { kind: 'daily', tradingDate: DATE });
    const result = await runChainsPhase(host, db(), run);
    expect(result.delistedClosed).toBe(1);
    const rows = raw
      .prepare('SELECT ticker, valid_to, removal_reason FROM ref_chain_subset_membership ORDER BY ticker')
      .all();
    expect(rows).toEqual([
      { ticker: 'SPY', valid_to: null, removal_reason: null },
      { ticker: 'WBS', valid_to: DATE, removal_reason: 'delisted' }
    ]);
  });

  it('does not close a member on any other 400', async () => {
    subsetMember('SPY');
    const host = makeHost({
      etradeGet: async () => response('{"Error":{"message":"There are no options for the given month."}}', 400)
    });
    const run = beginRun(db(), host, { kind: 'daily', tradingDate: DATE });
    expect((await runChainsPhase(host, db(), run)).delistedClosed).toBe(0);
  });

  it('asks each ticker for its own expirations rather than guessing a date', async () => {
    subsetMember('SPY');
    const seen: string[] = [];
    const host = makeHost({
      etradeGet: async (path, params) => {
        seen.push(path);
        if (path === '/v1/market/optionexpiredate') {
          return response(
            JSON.stringify({ OptionExpireDateResponse: { ExpirationDate: [{ year: 2026, month: 9, day: 18, expiryType: 'MONTHLY' }] } })
          );
        }
        expect(params['expiryDay']).toBe('18');
        return response(chainBody({ nearPrice: 770, pairs: [{ strike: 770 }] }));
      }
    });
    const run = beginRun(db(), host, { kind: 'daily', tradingDate: DATE });
    await runChainsPhase(host, db(), run);
    expect(seen[0]).toBe('/v1/market/optionexpiredate');
  });

  it('stores exactly what it parsed, for every chain response (AC-5)', async () => {
    subsetMember('SPY');
    const host = chainHost();
    const run = beginRun(db(), host, { kind: 'daily', tradingDate: DATE });
    const result = await runChainsPhase(host, db(), run);

    expect(result.chainFailures).toBe(0);
    const rows = raw
      .prepare(
        `SELECT r.parsed_row_count AS parsed,
                (SELECT COUNT(*) FROM raw_option_contract_snapshot c WHERE c.source_response_id = r.source_response_id) AS stored
           FROM meta_response r WHERE r.endpoint = '/v1/market/optionchains'`
      )
      .all() as { parsed: number; stored: number }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.stored).toBe(r.parsed);
  });

  it('records the declined expiration in the table, not only the captured one', async () => {
    subsetMember('SPY');
    const host = chainHost();
    const run = beginRun(db(), host, { kind: 'daily', tradingDate: DATE });
    await runChainsPhase(host, db(), run);
    const declined = raw
      .prepare("SELECT window_reason FROM raw_option_expiration WHERE expiration_date = '2027-09-17'")
      .get() as { window_reason: string };
    expect(declined.window_reason).toBe('outside');
  });

  it('fetches a pin whose ticker is outside the subset, at the pinned expiration only (QC-409)', async () => {
    // gen-001's first full run: the subset held one ticker, 141 pins sat on
    // tickers outside it, none was fetched, and QC-409 blocked every day.
    const run0 = newRun();
    raw
      .prepare(
        "INSERT INTO meta_response (run_id, provider, endpoint, params_json, requested_at, http_status, byte_length, archive_file, archive_offset, sha256, dedup_hash, encrypted, at_provider_cap, parse_status, parsed_row_count) " +
          "VALUES (?, 'etrade', '/x', '{}', '2026-09-07T17:00:00-04:00', 200, 1, 'f', 0, 'h', 'pin-only', 1, 0, 'ok', 0)"
      )
      .run(run0.runId);
    const src = (raw.prepare('SELECT MAX(source_response_id) AS id FROM meta_response').get() as { id: number }).id;
    raw
      .prepare(
        `INSERT INTO ref_sticky_contract (run_id, as_of_date, observed_at, source_response_id,
           osi_symbol, ticker, expiration_date, reason, valid_from)
         VALUES (?, ?, '2026-09-07T17:00:00-04:00', ?, 'SPY---260918P00770000', 'SPY', '2026-09-18', 'recommended_by_legacy', ?)`
      )
      .run(run0.runId, DATE, src, DATE);

    const chainDates: string[] = [];
    const inner = chainHost();
    const host = makeHost({
      etradeGet: async (path, params) => {
        if (path === '/v1/market/optionchains') chainDates.push(`${params['expiryMonth']}-${params['expiryDay']}`);
        return inner.etradeGet(path, params);
      }
    });
    const run = beginRun(db(), host, { kind: 'daily', tradingDate: DATE });
    const result = await runChainsPhase(host, db(), run);

    expect(result.tickers).toBe(1);
    expect(chainDates).toEqual(['9-18']);
    // What was not fetched is recorded as declined, not as in the window.
    const dec = raw
      .prepare("SELECT window_reason FROM raw_option_expiration WHERE expiration_date = '2026-12-18'")
      .get() as { window_reason: string };
    expect(dec.window_reason).toBe('outside');

    runGate(db(), makeHost(), { runId: run.runId, tradingDate: DATE, checks: [...CHAIN_CHECKS], domainsExpected: {} });
    const pinFinding = raw.prepare("SELECT 1 FROM qa_exception WHERE check_id = 'QC-409'").get();
    expect(pinFinding).toBeUndefined();
  });

  it('an explicit ticker list means exactly that list — pins do not widen a one-shot', async () => {
    const run0 = newRun();
    raw
      .prepare(
        "INSERT INTO meta_response (run_id, provider, endpoint, params_json, requested_at, http_status, byte_length, archive_file, archive_offset, sha256, dedup_hash, encrypted, at_provider_cap, parse_status, parsed_row_count) " +
          "VALUES (?, 'etrade', '/x', '{}', '2026-09-07T17:00:00-04:00', 200, 1, 'f', 0, 'h', 'pin-explicit', 1, 0, 'ok', 0)"
      )
      .run(run0.runId);
    const src = (raw.prepare('SELECT MAX(source_response_id) AS id FROM meta_response').get() as { id: number }).id;
    raw
      .prepare(
        `INSERT INTO ref_sticky_contract (run_id, as_of_date, observed_at, source_response_id,
           osi_symbol, ticker, expiration_date, reason, valid_from)
         VALUES (?, ?, '2026-09-07T17:00:00-04:00', ?, 'QQQ   260918P00500000', 'QQQ', '2026-09-18', 'held_in_book', ?)`
      )
      .run(run0.runId, DATE, src, DATE);
    const host = chainHost();
    const run = beginRun(db(), host, { kind: 'daily', tradingDate: DATE });
    const result = await runChainsPhase(host, db(), run, { tickers: ['SPY'] });
    expect(result.tickers).toBe(1);
  });

  it('closes a pin whose contract has expired, and never earlier', () => {
    const run = newRun();
    raw
      .prepare(
        "INSERT INTO meta_response (run_id, provider, endpoint, params_json, requested_at, http_status, byte_length, archive_file, archive_offset, sha256, dedup_hash, encrypted, at_provider_cap, parse_status, parsed_row_count) " +
          "VALUES (?, 'etrade', '/x', '{}', '2026-09-07T17:00:00-04:00', 200, 1, 'f', 0, 'h', 'pin', 1, 0, 'ok', 0)"
      )
      .run(run.runId);
    const src = (raw.prepare('SELECT MAX(source_response_id) AS id FROM meta_response').get() as { id: number }).id;
    raw
      .prepare(
        `INSERT INTO ref_sticky_contract (run_id, as_of_date, observed_at, source_response_id,
           osi_symbol, ticker, expiration_date, reason, valid_from)
         VALUES (?, ?, '2026-09-07T17:00:00-04:00', ?, 'X', 'X', '2026-08-21', 'held_in_book', '2026-08-01')`
      )
      .run(run.runId, DATE, src);
    raw
      .prepare(
        `INSERT INTO ref_sticky_contract (run_id, as_of_date, observed_at, source_response_id,
           osi_symbol, ticker, expiration_date, reason, valid_from)
         VALUES (?, ?, '2026-09-07T17:00:00-04:00', ?, 'Y', 'Y', '2026-12-18', 'held_in_book', '2026-08-01')`
      )
      .run(run.runId, DATE, src);

    expect(closeExpiredStickyContracts(db(), DATE)).toBe(1);
    const open = raw.prepare('SELECT osi_symbol FROM ref_sticky_contract WHERE valid_to IS NULL').all() as {
      osi_symbol: string;
    }[];
    expect(open.map((r) => r.osi_symbol)).toEqual(['Y']);
  });

  /**
   * The padding repair (2026-09-15). A pin built with the old space padding can
   * never equal an E*Trade `osiKey`, so QC-409 fired on every one of 415 live
   * pins and `sticky_reason` was never stamped. The correction is a close and a
   * re-open, because the old symbol is the evidence for those findings.
   */
  it('closes a space-padded pin and opens the dash-padded one, keeping provenance', () => {
    const run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
    raw
      .prepare(
        "INSERT INTO meta_response (run_id, provider, endpoint, params_json, requested_at, http_status, byte_length, archive_file, archive_offset, sha256, dedup_hash, encrypted, at_provider_cap, parse_status, parsed_row_count) " +
          "VALUES (?, 'etrade', '/x', '{}', '2026-09-07T17:00:00-04:00', 200, 1, 'f', 0, 'h', 'repad', 1, 0, 'ok', 0)"
      )
      .run(run.runId);
    const src = (raw.prepare('SELECT MAX(source_response_id) AS id FROM meta_response').get() as { id: number }).id;
    raw
      .prepare(
        `INSERT INTO ref_sticky_contract (run_id, as_of_date, observed_at, source_response_id,
           osi_symbol, ticker, expiration_date, reason, valid_from, origin_ref)
         VALUES (?, ?, '2026-09-07T17:00:00-04:00', ?, 'AIZ   261016C00280000', 'AIZ', '2026-10-16', 'recommended_by_legacy', '2026-09-01', 'legacy-run-7')`
      )
      .run(run.runId, DATE, src);

    const first = repairStickyOsiPadding(db(), DATE, '2026-09-15T17:05:00-04:00', run.runId);
    expect(first).toEqual({ closed: 1, reopened: 1 });

    const rows = raw
      .prepare('SELECT osi_symbol, valid_to, source_response_id, origin_ref FROM ref_sticky_contract ORDER BY row_id')
      .all() as { osi_symbol: string; valid_to: string | null; source_response_id: number; origin_ref: string | null }[];
    // Nothing deleted: the old row survives, closed, so the findings it caused
    // remain explicable.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ osi_symbol: 'AIZ   261016C00280000', valid_to: DATE });
    expect(rows[1]).toMatchObject({
      osi_symbol: 'AIZ---261016C00280000',
      valid_to: null,
      source_response_id: src,
      origin_ref: 'legacy-run-7'
    });
    // The corrected symbol is exactly what the builder would produce.
    expect(osiSymbol({ ticker: 'AIZ', expiration: '2026-10-16', side: 'call', strike: 280 }))
      .toBe(rows[1]!.osi_symbol);

    // Idempotent — a second pass finds nothing and opens no duplicate range.
    expect(repairStickyOsiPadding(db(), DATE, '2026-09-15T17:05:00-04:00', run.runId))
      .toEqual({ closed: 0, reopened: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM ref_sticky_contract WHERE valid_to IS NULL').get())
      .toEqual({ n: 1 });
  });

  /** Inserts an open pin as a past run wrote it. */
  function pin(osi: string, ticker: string, reason: string, runId: number) {
    raw
      .prepare(
        "INSERT INTO meta_response (run_id, provider, endpoint, params_json, requested_at, http_status, byte_length, archive_file, archive_offset, sha256, dedup_hash, encrypted, at_provider_cap, parse_status, parsed_row_count) " +
          "VALUES (?, 'etrade', '/x', '{}', '2026-09-16T10:33:13-04:00', 200, 1, 'f', 0, 'h', ?, 1, 0, 'ok', 0)"
      )
      .run(runId, `pin-${osi}-${reason}`);
    const src = (raw.prepare('SELECT MAX(source_response_id) AS id FROM meta_response').get() as { id: number }).id;
    raw
      .prepare(
        `INSERT INTO ref_sticky_contract (run_id, as_of_date, observed_at, source_response_id, osi_symbol,
           ticker, expiration_date, reason, valid_from, origin_ref)
         VALUES (?, ?, '2026-09-16T10:33:13-04:00', ?, ?, ?, '2026-10-16', ?, '2026-09-16', 'x')`
      )
      .run(runId, DATE, src, osi, ticker, reason);
  }

  it('re-roots a class-share pin to the root E*Trade sends (BRK.B → BRKB, v1.1.269)', () => {
    const run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
    pin('BRK.B-261016P00495000', 'BRK.B', 'recommended_by_legacy', run.runId);
    pin('SPY---261016P00500000', 'SPY', 'recommended_by_legacy', run.runId); // already correct

    expect(repairStickyOsiPadding(db(), DATE, 'now', run.runId)).toEqual({ closed: 1, reopened: 1 });
    const open = raw
      .prepare('SELECT osi_symbol FROM ref_sticky_contract WHERE valid_to IS NULL ORDER BY osi_symbol')
      .all() as { osi_symbol: string }[];
    expect(open.map((r) => r.osi_symbol)).toEqual(['BRKB--261016P00495000', 'SPY---261016P00500000']);
    expect(repairStickyOsiPadding(db(), DATE, 'now', run.runId)).toEqual({ closed: 0, reopened: 0 });
  });

  it('keeps a held pin\'s reason when a recommendation already pins the same contract', () => {
    // AMD 2026-09-18: the held 520 put was space-padded, its corrected symbol was already open
    // as recommended_by_legacy, and the repair closed the held pin without reopening it.
    const run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
    pin('AMD---261016P00520000', 'AMD', 'recommended_by_legacy', run.runId);
    pin('AMD   261016P00520000', 'AMD', 'held_in_book', run.runId);

    expect(repairStickyOsiPadding(db(), DATE, 'now', run.runId)).toEqual({ closed: 1, reopened: 1 });
    const open = raw
      .prepare('SELECT osi_symbol, reason FROM ref_sticky_contract WHERE valid_to IS NULL ORDER BY reason')
      .all();
    expect(open).toEqual([
      { osi_symbol: 'AMD---261016P00520000', reason: 'held_in_book' },
      { osi_symbol: 'AMD---261016P00520000', reason: 'recommended_by_legacy' }
    ]);
  });
});

describe('the chain and account checks', () => {
  function runChecks(run: RunHandle) {
    return runGate(db(), makeHost(), {
      runId: run.runId,
      tradingDate: DATE,
      checks: [...CHAIN_CHECKS, ...ACCOUNT_CHECKS],
      domainsExpected: {}
    });
  }

  it('records a distribution for every magnitude check, not only the fired ones', () => {
    const run = newRun();
    runChecks(run);
    const rows = raw
      .prepare(
        `SELECT check_id, distribution_json, evaluated_count FROM qa_check_result
          WHERE run_id = ? AND distribution_json IS NOT NULL`
      )
      .all(run.runId) as { check_id: string; distribution_json: string; evaluated_count: number }[];
    for (const r of rows) {
      const dist = JSON.parse(r.distribution_json) as { n: number; nearBoundary: number };
      expect(dist.n).toBe(r.evaluated_count);
      expect(dist).toHaveProperty('nearBoundary');
    }
  });

  it('QC-801 blocks when no balance row carries a usable total', () => {
    const run = newRun();
    const result = runChecks(run);
    expect(result.verdict).toBe('red');
    const ex = raw
      .prepare("SELECT check_id FROM qa_exception WHERE check_id = 'QC-801'")
      .get() as { check_id: string } | undefined;
    expect(ex?.check_id).toBe('QC-801');
  });

  /**
   * QC-404 bounded every ask by the underlying, which is only a call's ceiling —
   * a put is worth at most its strike. Live 2026-09-16: BMNR at 22.81, the $95
   * put asked 73.45 (intrinsic 72.19, so a correct quote) and 476 like it blocked
   * the gate.
   */
  function captureChain(run: RunHandle, nearPrice: number, pairs: Parameters<typeof chainBody>[0]['pairs']) {
    const result = captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'etrade',
      endpoint: '/v1/market/optionchains', slug: 'chain', params: { symbol: 'SPY' },
      response: response(chainBody({ nearPrice, pairs })),
      captureRuleId: captureRuleId(db(), makeHost(), 'chains', { v: 1 }, 'test'),
      recipe: recipes.chain({ ticker: 'SPY', expirationDate: '2026-09-18' })
    });
    expect(result.parseStatus).toBe('ok');
  }

  function qc404Fired(run: RunHandle): string[] {
    const evals = QC404_BID_ASK_SANITY.run({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: 't' });
    expect(evals.length).toBeGreaterThan(0);
    return evals.filter((e) => e.fired).map((e) => e.key).sort();
  }

  it('QC-404 does not fire on a deep in-the-money put whose ask exceeds 3x the underlying', () => {
    const run = newRun();
    // Call asks are sane; the put asks 3.22x the underlying and 0.77x its strike.
    captureChain(run, 22.81, [{ strike: 95, bid: 0.01, ask: 0.05, putBid: 72.5, putAsk: 73.45 }]);
    expect(qc404Fired(run)).toEqual([]);
  });

  it('QC-404 still fires on a put asking more than 3x its strike, and on a call above 3x the underlying', () => {
    const run = newRun();
    captureChain(run, 22.81, [
      { strike: 5, bid: 17, ask: 18, putBid: 15, putAsk: 16 },   // put ask 3.2x its strike
      { strike: 10, bid: 70, ask: 80, putBid: 0.01, putAsk: 0.05 } // call ask 3.5x the underlying
    ]);
    expect(qc404Fired(run)).toEqual(['SPY---260918C00010000', 'SPY---260918P00005000']);
  });

  it('QC-404 closes findings raised under the old bound as rule_changed, judged on their own quote (v1.1.281)', () => {
    // 519 findings on gen-002 were raised by the underlying-only bound before v1.1.251 and could
    // never close: today's quote is a different quote, and there is no remediation for a rule error.
    // The evidence they recorded predates `right` and `strike`, so both come from the symbol.
    const first = newRun();
    runGate(db(), makeHost(), {
      runId: first.runId, tradingDate: DATE, domainsExpected: {},
      checks: [{
        ...QC404_BID_ASK_SANITY,
        run: () => [
          { key: 'BMNR--270115P00095000', value: 3.22, fired: true, detail: 'old bound',
            evidence: { osiSymbol: 'BMNR--270115P00095000', bid: 72.5, ask: 73.45, underlying: 22.81, crossed: false } },
          { key: 'XYZ---270115P00005000', value: 0.7, fired: true, detail: 'put asks 3.2x its strike',
            evidence: { osiSymbol: 'XYZ---270115P00005000', bid: 15, ask: 16, underlying: 22.81, crossed: false } }
        ]
      }]
    });
    raw.prepare("UPDATE meta_run SET status = 'complete' WHERE run_id = ?").run(first.runId);

    const second = newRun();
    runGate(db(), makeHost(), { runId: second.runId, tradingDate: DATE, domainsExpected: {}, checks: [QC404_BID_ASK_SANITY] });

    const rows = Object.fromEntries(
      (raw.prepare("SELECT key, state, resolution_kind, resolution_note FROM qa_exception WHERE check_id = 'QC-404'").all() as
        { key: string; state: string; resolution_kind: string | null; resolution_note: string | null }[])
        .map((r) => [r.key, r])
    );
    expect(rows['BMNR--270115P00095000']!.state).toBe('resolved');
    expect(rows['BMNR--270115P00095000']!.resolution_kind).toBe('rule_changed');
    expect(rows['BMNR--270115P00095000']!.resolution_note).toContain('strike 95');
    // The current rule fires on this quote too, so it stays — going quiet is not a ruling.
    expect(rows['XYZ---270115P00005000']!.state).toBe('open');
  });

  it('QC-410 skips rather than fails when no 3-month yield is stored', () => {
    const run = newRun();
    runChecks(run);
    const row = raw
      .prepare("SELECT evaluated_count FROM qa_check_result WHERE run_id = ? AND check_id = 'QC-410'")
      .get(run.runId) as { evaluated_count: number };
    // A missing rate is QC-902's finding, not this one.
    expect(row.evaluated_count).toBe(0);
  });

  it('models delta close enough that a 0.05 tolerance cannot fire on a model difference', () => {
    // The live SPY reading, 2026-09-07: provider delta sat 0.018-0.029 below a
    // European Black-Scholes, which is a model difference and not an error.
    const modelled = bsDelta({ spot: 770.19, strike: 770, dteDays: 11, iv: 0.1523, rate: 0.0391, right: 'call' });
    expect(modelled).not.toBeNull();
    expect(Math.abs((modelled as number) - 0.52)).toBeLessThan(0.05);
  });

  it('a scale fault is far outside the tolerance, which is the point of 0.05', () => {
    const modelled = bsDelta({ spot: 770.19, strike: 770, dteDays: 11, iv: 0.1523, rate: 0.0391, right: 'call' }) as number;
    // IV read as a percentage instead of a fraction — the failure the check exists for.
    const wrongScale = bsDelta({ spot: 770.19, strike: 770, dteDays: 11, iv: 15.23, rate: 0.0391, right: 'call' }) as number;
    expect(Math.abs(wrongScale - modelled)).toBeGreaterThan(0.05);
  });
});
