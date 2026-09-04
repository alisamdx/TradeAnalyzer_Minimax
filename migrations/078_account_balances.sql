-- 078: Snapshot the E*Trade cash balance, so capital utilisation is answerable.
--
-- WHY. The operator's observation was "I am not fully utilizing my money, it's idle — that's a
-- waste of resource", and the app could not answer it at all: searched 2026-09-03, NO table held
-- a cash, buying-power or net-liquidation figure anywhere. The only "cash" columns in the schema
-- belong to `historical_financials` (a company's operating cash flow) and
-- `leaps_csp_opportunities.total_cash_to_deploy` — neither is an account balance.
--
-- WHY SNAPSHOTS RATHER THAN A SINGLE CURRENT ROW. "How much is idle" needs one number; "how long
-- has it been idle" needs a series, and that is the half the operator actually asked about. A
-- single mutable row answers the first and forecloses the second, and capture is one-directional
-- — the same reasoning as brief_candidates (migration 076). One row per account per day is a few
-- KB a year.
--
-- WHAT IS AND IS NOT DOUBLE COUNTED. E*Trade already withholds cash-secured put collateral from
-- `cashAvailableForInvestment`, so available and committed are COMPLEMENTARY, not overlapping:
--     total ~= available + committed        utilisation = committed / total
-- Deriving idle as (available - committed) would subtract the same collateral twice. The
-- committed side is computed from `positions` at read time rather than stored here, so a later
-- correction to a position flows through instead of being frozen into a snapshot.
--
-- see src/main/services/capital-utilisation.ts, Requirements/spec/02-data-model.md

CREATE TABLE IF NOT EXISTS account_balances (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_date            TEXT    NOT NULL,   -- YYYY-MM-DD (ET) — one snapshot per account per day
  fetched_at            TEXT    NOT NULL,   -- full timestamp of the fetch
  account_id_key        TEXT    NOT NULL,   -- E*Trade accountIdKey (opaque; not the account number)
  account_id            TEXT,               -- display account id, when the response carries one

  -- Straight from E*Trade's Computed block. Null where the response omits a field rather than
  -- zero — a missing balance and a zero balance are very different facts.
  cash_available        REAL,               -- cashAvailableForInvestment: deployable right now
  cash_balance          REAL,               -- cashBalance
  net_cash              REAL,               -- netCash
  settled_cash          REAL,               -- settledCashForInvestment
  total_account_value   REAL,               -- RealTimeValues.totalAccountValue
  margin_buying_power   REAL,               -- marginBuyingPower (0 on a cash account)

  created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- The portfolio sync can run several times a day; the latest wins, exactly as every other job's
-- re-run does.  see CLAUDE.md "the batch runs twice a trading day"
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_balances_unique
  ON account_balances (as_of_date, account_id_key);

CREATE INDEX IF NOT EXISTS idx_account_balances_recent
  ON account_balances (account_id_key, as_of_date DESC);
