import type { SqliteLike } from '../db/sqlite-like.js';
import type { CollectorHost } from './host.js';

/**
 * `ref_macro_series` — the index symbols quoted daily into `raw_index_quote`.
 *
 * **Seeded here, before it is read**, for exactly the reason `ref_trading_day`
 * is: a reference table that exists only if somebody remembered to seed it is
 * one that will be missing on the day it matters.
 *
 * It was missing from the day the table was declared. The only
 * `INSERT INTO ref_macro_series` in the repository was a test fixture, so
 * `runIndexQuotes` read an empty list, skipped every run, and `raw_index_quote`
 * held **0 rows** — confirmed on gen-001 after three daily runs. The run report
 * said `expected 0, stored 0`, which is what a phase asking for nothing looks
 * like, and it is indistinguishable from a phase that asked and got nothing.
 *
 * QC-901 is the sharper half. It is **blocking**, it maps over
 * `WHERE enabled = 1`, and on an empty table that map returns zero evaluations —
 * a blocking check that cannot fire, guarding a VIX that is never fetched. The
 * same family as the conviction band that could never fire and the liquidity
 * gate that always did: the check looked healthy because nothing it could
 * object to ever reached it.
 *
 * The band is the one QC-901's own evidence note states: VIX has never closed
 * outside [5, 150]. It is stored per series rather than compiled in, so adding
 * VIX3M or VVIX later is data rather than a release.
 */

export interface MacroSeriesSeed {
  readonly symbol: string;
  readonly description: string;
  readonly saneMin: number;
  readonly saneMax: number;
}

/**
 * VIX only, deliberately.
 *
 * `VIX` was confirmed live on 2026-09-07 — HTTP 200 returning 14.53 — while
 * `VIX.X` is rejected as invalid. VIX3M and VVIX are named in the dictionary as
 * later additions and are **not** seeded: an unverified symbol would quote as a
 * failure every run, which is noise asserting nothing.
 */
export const DEFAULT_MACRO_SERIES: readonly MacroSeriesSeed[] = [
  { symbol: 'VIX', description: 'CBOE Volatility Index', saneMin: 5, saneMax: 150 }
];

export interface MacroSeedResult {
  readonly inserted: number;
  readonly present: number;
}

/**
 * Idempotent: inserts a series that is absent and never touches one that is
 * there, so an operator disabling VIX stays disabled across runs. `enabled` and
 * the band are the operator's to change once the row exists — the seed's only
 * job is that the row exists at all.
 */
export function ensureMacroSeries(
  db: SqliteLike,
  host: CollectorHost,
  series: readonly MacroSeriesSeed[] = DEFAULT_MACRO_SERIES
): MacroSeedResult {
  const exists = db.prepare('SELECT 1 AS present FROM ref_macro_series WHERE symbol = ?');
  const insert = db.prepare(
    `INSERT INTO ref_macro_series (symbol, description, sane_min, sane_max, enabled, added_at)
     VALUES (?, ?, ?, ?, 1, ?)`
  );

  const now = host.nowET();
  let inserted = 0;

  const write = db.transaction(() => {
    for (const s of series) {
      if (exists.get(s.symbol) !== undefined) continue;
      insert.run(s.symbol, s.description, s.saneMin, s.saneMax, now);
      inserted += 1;
    }
  });
  write();

  const present = (
    db.prepare('SELECT COUNT(*) AS n FROM ref_macro_series WHERE enabled = 1').get() as { n: number }
  ).n;

  return { inserted, present };
}
