import type { SqliteLike } from '../../db/sqlite-like.js';
import type { CollectorHost } from '../host.js';
import { throwIfCancelled } from '../host.js';
import { captureResponse } from '../capture.js';
import { recipes } from '../../ingest/recipes.js';
import { captureRuleId, type RunHandle } from '../run.js';
import { type ExpirationSelection } from '../../ingest/options.js';

/**
 * Phases 6 and 7 — the chain subset and the chains themselves (04 §4.2, §4.3).
 *
 * Together these are ~85 % of the run's calls and all of its cost, which is why
 * the subset rule is the first lever to pull if the run ever runs late.
 */

export const CHAIN_SUBSET_RULE = {
  minClose: 10,
  minAvgDollarVolume20d: 233_000_000,
  sticky: 'ticker'
} as const;

export const CHAIN_RULE = {
  maxDte: 90,
  extraMonthlies: 2,
  allStrikes: true,
  sticky: 'contract'
} as const;

export interface SubsetPhaseResult {
  readonly evaluated: number;
  readonly admitted: number;
  readonly alreadyMembers: number;
  readonly stickyAdmits: number;
}

export interface ChainPhaseResult {
  readonly tickers: number;
  readonly expirationCalls: number;
  readonly expirationFailures: number;
  readonly chainCalls: number;
  readonly chainFailures: number;
  readonly contractsStored: number;
  readonly stickyClosed: number;
}

interface SubsetCandidate {
  readonly ticker: string;
  readonly close: number | null;
  readonly advol20: number | null;
  readonly src: number | null;
}

/**
 * The admission inputs, measured per ticker.
 *
 * `advol20` is the mean of `close × volume` over the last 20 stored bars —
 * exported because the number the rule decided on is the number a study needs to
 * see, and burying it in the phase would leave `rule_inputs_json` unexplainable.
 */
export function subsetCandidates(db: SqliteLike, tradingDate: string): readonly SubsetCandidate[] {
  const tickers = (
    db
      .prepare('SELECT DISTINCT ticker FROM ref_universe_membership WHERE valid_to IS NULL ORDER BY ticker')
      .all() as { ticker: string }[]
  ).map((r) => r.ticker);

  // The latest observation PER TRADE DATE, not the latest 20 rows. Bars are
  // append-only, so a re-fetch leaves two rows for the same day — and "the last
  // 20 rows" would then silently be ten days of two readings each, blending a
  // superseded observation into the average the rule decides on.
  const recent = db.prepare(
    `SELECT close, volume, source_response_id FROM raw_daily_bar
      WHERE row_id IN (
        SELECT MAX(row_id) FROM raw_daily_bar
         WHERE ticker = ? AND trade_date <= ?
         GROUP BY trade_date
      )
      ORDER BY trade_date DESC LIMIT 20`
  );

  return tickers.map((ticker) => {
    const bars = recent.all(ticker, tradingDate) as {
      close: number;
      volume: number | null;
      source_response_id: number;
    }[];
    if (bars.length === 0) return { ticker, close: null, advol20: null, src: null };

    const dollar = bars.filter((b) => b.volume !== null).map((b) => b.close * (b.volume as number));
    return {
      ticker,
      close: bars[0]!.close,
      // Null rather than 0 when no bar carried a volume: "we could not measure
      // it" and "it did not trade" are different facts and only one of them is
      // grounds to refuse admission.
      advol20: dollar.length === 0 ? null : dollar.reduce((a, b) => a + b, 0) / dollar.length,
      src: bars[0]!.source_response_id
    };
  });
}

function openMembers(db: SqliteLike): Set<string> {
  return new Set(
    (
      db
        .prepare('SELECT ticker FROM ref_chain_subset_membership WHERE valid_to IS NULL')
        .all() as { ticker: string }[]
    ).map((r) => r.ticker)
  );
}

/**
 * Phase 6 — evaluate the subset rule and admit.
 *
 * **Admission only.** A member that falls below the threshold is never removed
 * (Q15): a series that stops mid-study is worse than one that costs a few extra
 * calls, which is why `removal_reason` has no `fell_below_threshold` value to
 * write even if this wanted to.
 *
 * Optionability is deliberately not a condition. It is derived from the
 * expirations call, which is only made for tickers *already* in the subset, so
 * it is null for every candidate — a condition written against it would admit
 * everything while reading like a gate, which is the exact failure mode this
 * project exists to avoid.
 */
export function runChainSubsetPhase(
  db: SqliteLike,
  host: CollectorHost,
  run: RunHandle
): SubsetPhaseResult {
  const ruleId = captureRuleId(
    db,
    host,
    'chain_subset',
    CHAIN_SUBSET_RULE,
    'Which tickers get option chains: close and 20-day average dollar volume, sticky by ticker.'
  );
  const candidates = subsetCandidates(db, run.tradingDate);
  const members = openMembers(db);
  const observedAt = host.nowET();

  // Tickers that get in regardless of the rule.
  const held = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT symbol FROM raw_account_position_snapshot
            WHERE as_of_date = ? AND security_type IN ('EQ', 'OPTN')`
        )
        .all(run.tradingDate) as { symbol: string }[]
    ).map((r) => r.symbol)
  );
  const recommended = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT ticker FROM legacy_brief_candidate
            WHERE as_of_date = ?`
        )
        .all(run.tradingDate) as { ticker: string }[]
    ).map((r) => r.ticker)
  );

  const insert = db.prepare(
    `INSERT INTO ref_chain_subset_membership
       (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
        ticker, valid_from, membership_reason, rule_capture_rule_id, rule_inputs_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );

  let admitted = 0;
  let stickyAdmits = 0;

  const write = db.transaction(() => {
    for (const c of candidates) {
      if (members.has(c.ticker)) continue;
      if (c.src === null) continue; // no bar, so nothing was measured and nothing is claimed

      const rulePass =
        c.close !== null &&
        c.advol20 !== null &&
        c.close >= CHAIN_SUBSET_RULE.minClose &&
        c.advol20 >= CHAIN_SUBSET_RULE.minAvgDollarVolume20d;

      const reason = rulePass
        ? 'rule_pass'
        : held.has(c.ticker)
          ? 'held_in_book'
          : recommended.has(c.ticker)
            ? 'recommended_by_legacy'
            : null;
      if (reason === null) continue;

      insert.run(
        run.runId, run.tradingDate, observedAt, ruleId, c.src,
        c.ticker, run.tradingDate, reason, ruleId,
        JSON.stringify({ close: c.close, advol20: c.advol20 })
      );
      admitted++;
      if (reason !== 'rule_pass') stickyAdmits++;
      members.add(c.ticker);
    }
  });
  write();

  return {
    evaluated: candidates.length,
    admitted,
    alreadyMembers: members.size - admitted,
    stickyAdmits
  };
}

function dte(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Which expirations this run asks for, and the reason recorded against every
 * expiration E*Trade listed — including the ones declined.
 *
 * A pipeline that keeps only what it captured cannot answer why something is
 * missing, so `outside` is a stored fact rather than an absence.
 */
export function selectExpirations(args: {
  readonly tradingDate: string;
  readonly listed: readonly { readonly date: string; readonly expiryType: string }[];
  readonly stickyExpirations: ReadonlySet<string>;
  readonly maxDte?: number;
  readonly extraMonthlies?: number;
}): Map<string, ExpirationSelection['reason']> {
  const maxDte = args.maxDte ?? CHAIN_RULE.maxDte;
  const extras = args.extraMonthlies ?? CHAIN_RULE.extraMonthlies;
  const selection = new Map<string, ExpirationSelection['reason']>();

  const sorted = [...args.listed].sort((a, b) => a.date.localeCompare(b.date));
  for (const e of sorted) {
    const d = dte(args.tradingDate, e.date);
    if (d > 0 && d <= maxDte) selection.set(e.date, 'within_max_dte');
    else selection.set(e.date, 'outside');
  }

  let taken = 0;
  for (const e of sorted) {
    if (taken >= extras) break;
    if (dte(args.tradingDate, e.date) <= maxDte) continue;
    if (e.expiryType !== 'MONTHLY') continue;
    selection.set(e.date, 'extra_monthly');
    taken++;
  }

  // A sticky contract's expiration is captured whatever the window says — that
  // is the whole point of a pin, and it outranks `outside`.
  for (const date of args.stickyExpirations) {
    if (selection.has(date)) selection.set(date, 'sticky_contract');
  }

  return selection;
}

interface TickerSticky {
  /** OSI symbol to pin reason, passed straight to the chain ingestion module. */
  readonly reasons: Map<string, string>;
  /** The expirations those pins need, which the window rule must not decline. */
  readonly expirations: Set<string>;
}

function stickyByTicker(db: SqliteLike, tradingDate: string): Map<string, TickerSticky> {
  const rows = db
    .prepare(
      `SELECT ticker, osi_symbol, expiration_date, reason FROM ref_sticky_contract
        WHERE valid_to IS NULL AND expiration_date >= ?`
    )
    .all(tradingDate) as {
    ticker: string;
    osi_symbol: string;
    expiration_date: string;
    reason: string;
  }[];

  const byTicker = new Map<string, TickerSticky>();
  for (const r of rows) {
    let entry = byTicker.get(r.ticker);
    if (!entry) { entry = { reasons: new Map(), expirations: new Set() }; byTicker.set(r.ticker, entry); }
    entry.reasons.set(r.osi_symbol, r.reason);
    entry.expirations.add(r.expiration_date);
  }
  return byTicker;
}

/** Closes pins whose contract has expired. A pin ends at expiry, never earlier. */
export function closeExpiredStickyContracts(db: SqliteLike, tradingDate: string): number {
  const expired = db
    .prepare('SELECT row_id FROM ref_sticky_contract WHERE valid_to IS NULL AND expiration_date < ?')
    .all(tradingDate) as { row_id: number }[];
  const close = db.prepare('UPDATE ref_sticky_contract SET valid_to = ? WHERE row_id = ?');
  const write = db.transaction(() => {
    for (const r of expired) close.run(tradingDate, r.row_id);
  });
  write();
  return expired.length;
}

/**
 * Phase 7 — expirations, then one chain call per selected expiration.
 *
 * Asking each ticker which expirations it lists, rather than guessing a global
 * weekly date, is what removes the existing app's 34 % chain 4xx rate: 97 % of
 * those were error 10031 against a date the ticker does not list. It costs one
 * extra call per ticker and buys back thousands of failures.
 */
export async function runChainsPhase(
  host: CollectorHost,
  db: SqliteLike,
  run: RunHandle,
  opts: { readonly maxDte?: number; readonly extraMonthlies?: number; readonly tickers?: readonly string[] } = {}
): Promise<ChainPhaseResult> {
  const ruleId = captureRuleId(
    db,
    host,
    'chain',
    CHAIN_RULE,
    'Every expiration inside 90 DTE plus two monthlies beyond it; every strike stored.'
  );

  const stickyClosed = closeExpiredStickyContracts(db, run.tradingDate);
  const sticky = stickyByTicker(db, run.tradingDate);

  const tickers =
    opts.tickers ??
    (
      db
        .prepare('SELECT ticker FROM ref_chain_subset_membership WHERE valid_to IS NULL ORDER BY ticker')
        .all() as { ticker: string }[]
    ).map((r) => r.ticker);

  let expirationCalls = 0;
  let expirationFailures = 0;
  let chainCalls = 0;
  let chainFailures = 0;
  let contractsStored = 0;

  for (const [i, ticker] of tickers.entries()) {
    throwIfCancelled(host, 'phase-7-chains');
    host.progress('chains', i, tickers.length, ticker);

    const stickyForTicker = sticky.get(ticker);
    const stickyReasons = stickyForTicker?.reasons ?? new Map<string, string>();
    const stickyExpirations = stickyForTicker?.expirations ?? new Set<string>();

    // ── expirations ────────────────────────────────────────────────────────
    const expPath = '/v1/market/optionexpiredate';
    const expParams = { symbol: ticker, expiryType: 'ALL' };
    const expResponse = await host.etradeGet(expPath, expParams);
    expirationCalls++;

    let listed: { date: string; expiryType: string }[] = [];
    if (expResponse.status !== null && expResponse.status >= 200 && expResponse.status < 300) {
      try {
        const parsed = JSON.parse(expResponse.body) as {
          OptionExpireDateResponse?: {
            ExpirationDate?: { year?: number; month?: number; day?: number; expiryType?: string }[];
          };
        };
        listed = (parsed.OptionExpireDateResponse?.ExpirationDate ?? [])
          .filter((d) => typeof d.year === 'number')
          .map((d) => ({
            date: `${String(d.year)}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`,
            expiryType: d.expiryType ?? 'UNKNOWN'
          }));
      } catch {
        listed = [];
      }
    }

    const selection = selectExpirations({
      tradingDate: run.tradingDate,
      listed,
      stickyExpirations,
      ...(opts.maxDte !== undefined ? { maxDte: opts.maxDte } : {}),
      ...(opts.extraMonthlies !== undefined ? { extraMonthlies: opts.extraMonthlies } : {})
    });

    const expResult = captureResponse({
      host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'etrade',
      endpoint: expPath, slug: 'optionexpiredate', params: expParams,
      response: expResponse, captureRuleId: ruleId,
      recipe: recipes.expirations({ ticker, selection })
    });
    if (expResult.parseStatus !== 'ok') expirationFailures++;

    // ── chains ─────────────────────────────────────────────────────────────
    const wanted = [...selection.entries()]
      .filter(([, reason]) => reason !== 'outside')
      .map(([date]) => date)
      .sort();

    for (const expiration of wanted) {
      throwIfCancelled(host, 'phase-7-chains');
      const [y, m, d] = expiration.split('-');
      const chainPath = '/v1/market/optionchains';
      const chainParams = {
        symbol: ticker,
        expiryYear: y as string,
        expiryMonth: String(Number(m)),
        expiryDay: String(Number(d)),
        // Every strike, per Q2 — the losers are the data a study needs.
        chainType: 'CALLPUT',
        includeWeekly: 'true',
        skipAdjusted: 'true'
      };
      const chainResponse = await host.etradeGet(chainPath, chainParams);
      chainCalls++;

      const result = captureResponse({
        host, db, runId: run.runId, asOfDate: run.tradingDate, provider: 'etrade',
        endpoint: chainPath, slug: 'optionchains', params: chainParams,
        response: chainResponse, captureRuleId: ruleId,
        recipe: recipes.chain({ ticker, expirationDate: expiration, stickyReasons })
      });

      if (result.parseStatus === 'ok') contractsStored += result.rowsWritten;
      else chainFailures++;
    }
  }

  return {
    tickers: tickers.length,
    expirationCalls,
    expirationFailures,
    chainCalls,
    chainFailures,
    contractsStored,
    stickyClosed
  };
}
