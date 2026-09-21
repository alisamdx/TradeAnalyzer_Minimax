-- 087: widen `spread_mode_picks.pool` to admit the third arm, `premium`.
--
-- WHY A WHOLE TABLE REBUILD FOR ONE VALUE. Migration 086 wrote `CHECK (pool IN ('wheel','income'))`
-- yesterday, and SQLite bakes a CHECK into the table definition at CREATE TABLE time — there is no
-- ALTER that widens it. This is the `enumOf` trap from CLAUDE.md, hit one day after the constraint was
-- written: widening an enum changes no column name, so a guard comparing columns sees nothing, and the
-- failure would surface as a constraint violation inside an unrelated ingestion transaction long after
-- the change. Rebuilding is the only honest fix.
--
-- WHY `premium` EXISTS (08 S12, v1.1.302). T7 measured selection rules over 6,221 settled rows on 54
-- dates against a same-size random draw. Ranking the universe by annualized premium return was the best
-- rule tested (+0.54% mean / 2.86% median, random band −1.29…−0.52 / 1.14…1.34), beating the wheel
-- composite (−0.12 / 2.02) and income (−0.56 / 1.67). It is not a brief strategy: its tickers come from
-- `analysis_snapshots`, which `DailyOptionsSnapshotJob` already fills nightly for ~1,100 tickers, so the
-- pool costs no new market-data calls — only the spread chain capture for its names.
--
-- SAFETY NOTES for this rebuild:
--   • `spread_mode_picks` has NO foreign-key children (checked), so the CLAUDE.md cascade trap does not
--     apply here — `PRAGMA foreign_keys=OFF` is a no-op inside a transaction and `migrations.ts` wraps
--     every migration in one, so a table with children would have needed the child copied aside first.
--   • Every existing row already satisfies the WIDER constraint, so the copy cannot fail. A rebuild
--     migration must never be able to fail on its own copy: a failed migration means the app does not boot.
--   • The indexes are recreated exactly as 084 and 086 left them.
--
-- see src/main/services/spread-pools.ts, docs/wheel-parameters.md T7

CREATE TABLE spread_mode_picks_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_date       TEXT    NOT NULL,
  slot             TEXT    NOT NULL CHECK (slot IN ('intraday', 'after_close')),
  generated_at     TEXT    NOT NULL,
  mode             TEXT    NOT NULL CHECK (mode IN ('shadow', 'on')),
  ticker           TEXT    NOT NULL,
  outcome          TEXT    NOT NULL CHECK (outcome IN ('pick', 'rejected')),
  rank             INTEGER,
  reason           TEXT,

  expiration       TEXT,
  dte              INTEGER,
  spot             REAL,
  short_strike     REAL,
  short_bid        REAL,
  short_ask        REAL,
  short_delta      REAL,
  short_oi         INTEGER,
  long_strike      REAL,
  long_bid         REAL,
  long_ask         REAL,
  long_delta       REAL,
  long_oi          INTEGER,
  width            REAL,
  mid_credit       REAL,
  net_credit       REAL,
  max_loss         REAL,
  return_on_risk   REAL,
  cost_share       REAL,
  contracts        INTEGER,
  total_max_loss   REAL,
  earnings_date    TEXT,
  critic_verdict   TEXT,

  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  pool             TEXT    NOT NULL DEFAULT 'wheel' CHECK (pool IN ('wheel', 'income', 'premium'))
);

INSERT INTO spread_mode_picks_new
  (id, as_of_date, slot, generated_at, mode, ticker, outcome, rank, reason,
   expiration, dte, spot, short_strike, short_bid, short_ask, short_delta, short_oi,
   long_strike, long_bid, long_ask, long_delta, long_oi, width, mid_credit, net_credit, max_loss,
   return_on_risk, cost_share, contracts, total_max_loss, earnings_date, critic_verdict, created_at, pool)
SELECT
   id, as_of_date, slot, generated_at, mode, ticker, outcome, rank, reason,
   expiration, dte, spot, short_strike, short_bid, short_ask, short_delta, short_oi,
   long_strike, long_bid, long_ask, long_delta, long_oi, width, mid_credit, net_credit, max_loss,
   return_on_risk, cost_share, contracts, total_max_loss, earnings_date, critic_verdict, created_at, pool
FROM spread_mode_picks;

DROP TABLE spread_mode_picks;
ALTER TABLE spread_mode_picks_new RENAME TO spread_mode_picks;

CREATE UNIQUE INDEX IF NOT EXISTS idx_spread_mode_picks_unique
  ON spread_mode_picks (as_of_date, slot, pool, ticker);
CREATE INDEX IF NOT EXISTS idx_spread_mode_picks_settle
  ON spread_mode_picks (ticker, expiration);
