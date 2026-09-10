import type { SqliteLike } from '../../db/sqlite-like.js';
import type { CollectorHost } from '../host.js';
import { throwIfCancelled } from '../host.js';
import type { RunHandle } from '../run.js';
import { deriveIv30, type Iv30ContractRow } from '../../derive/iv30.js';

/**
 * Phase 9 — the derivation (04 §2, 02 §13, Q7).
 *
 * The only phase that calls no provider. It reads what phase 7 stored and
 * writes `derived_iv30_daily`, so IV rank has an own-computed history from day
 * one instead of depending permanently on a purchased bootstrap.
 *
 * **It runs last and it is allowed to be empty.** A day on which the chain phase
 * stored nothing produces no derived rows and no error — the absence is already
 * reported by phase 7's own counts, and inventing a failure here would report
 * one problem twice.
 */

export interface DerivePhaseCounts {
  readonly tickers: number;
  readonly ok: number;
  readonly insufficientExpirations: number;
  readonly noAtmQuotes: number;
}

interface SnapshotRow {
  ticker: string;
  expiration_date: string;
  strike: number;
  right: 'call' | 'put';
  iv: number | null;
  iv_status: string;
  underlying_price: number;
}

/**
 * Reads the day's chain, resolving supersession the way every reader must.
 *
 * `raw_option_contract_snapshot` is append-only and keyed
 * `(osi_symbol, as_of_date, observed_at)`, so a contract re-observed within the
 * day has more than one row and "the current value" is the one with the latest
 * `observed_at` — never an UPDATE, and never simply the last row returned. A
 * derivation that averaged two observations of the same contract would produce
 * a number that depends on how often the collector happened to run.
 */
function chainForDate(db: SqliteLike, asOfDate: string): SnapshotRow[] {
  return db
    .prepare(
      `SELECT s.ticker, s.expiration_date, s.strike, s.right, s.iv, s.iv_status, s.underlying_price
         FROM raw_option_contract_snapshot s
         JOIN (
           SELECT osi_symbol, MAX(observed_at) AS observed_at
             FROM raw_option_contract_snapshot
            WHERE as_of_date = ?
            GROUP BY osi_symbol
         ) latest
           ON latest.osi_symbol = s.osi_symbol
          AND latest.observed_at = s.observed_at
        WHERE s.as_of_date = ?
        ORDER BY s.ticker, s.expiration_date, s.strike`
    )
    .all(asOfDate, asOfDate) as SnapshotRow[];
}

export function runDerivePhase(
  db: SqliteLike,
  host: CollectorHost,
  run: RunHandle
): DerivePhaseCounts {
  const rows = chainForDate(db, run.tradingDate);

  const byTicker = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const list = byTicker.get(row.ticker) ?? [];
    list.push(row);
    byTicker.set(row.ticker, list);
  }

  const insert = db.prepare(
    `INSERT INTO derived_iv30_daily
       (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
        ticker, iv30, iv30_status, near_expiration, far_expiration, near_iv, far_iv,
        derivation_version, status)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let ok = 0;
  let insufficientExpirations = 0;
  let noAtmQuotes = 0;

  // `observed_at` is stamped once for the whole phase, not per ticker. Every
  // row here is derived from the same stored snapshot in the same pass, so they
  // genuinely share an observation moment — and a per-row clock would make two
  // tickers of one derivation look like two observations.
  const observedAt = host.nowET();

  for (const [ticker, contracts] of byTicker) {
    throwIfCancelled(host, 'derive');

    // The underlying price is carried on every contract row; they come from one
    // chain response, so any of them will do.
    const underlyingPrice = contracts[0]!.underlying_price;

    const derived = deriveIv30({
      ticker,
      asOfDate: run.tradingDate,
      underlyingPrice,
      contracts: contracts.map(
        (c): Iv30ContractRow => ({
          expirationDate: c.expiration_date,
          strike: c.strike,
          right: c.right,
          iv: c.iv,
          ivStatus: c.iv_status
        })
      )
    });

    insert.run(
      run.runId,
      run.tradingDate,
      observedAt,
      derived.ticker,
      derived.iv30,
      derived.iv30Status,
      derived.nearExpiration,
      derived.farExpiration,
      derived.nearIv,
      derived.farIv,
      derived.derivationVersion,
      derived.status
    );

    if (derived.status === 'ok') ok += 1;
    else if (derived.status === 'insufficient_expirations') insufficientExpirations += 1;
    else noAtmQuotes += 1;
  }

  // **A row is written for every ticker, including the ones that could not be
  // computed.** Storing only the successes would make "we could not price this"
  // indistinguishable from "we never looked", which is the distinction the
  // status column exists to carry — and the one the gate needs in order to
  // notice a day where the chain arrived but nothing could be derived from it.
  return {
    tickers: byTicker.size,
    ok,
    insufficientExpirations,
    noAtmQuotes
  };
}
