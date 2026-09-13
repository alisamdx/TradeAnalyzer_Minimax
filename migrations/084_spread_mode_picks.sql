-- 084: Bull put spread mode — the picks it would make, and why every other candidate was excluded.
--
-- WHY. The mode (NewApp/requirements/08-bull-put-spread-mode.md) ships in SHADOW: computed after each
-- brief run and stored, with no panel and no email. Its enable gate (§4) needs ≥ 30 settled shadow picks
-- with a positive mean return after modelled fills, and that sample can only exist if picks are written
-- from the first day. Capture is one-directional — a pick not stored today cannot be reconstructed,
-- because it depends on the quotes of that run.
--
-- ONE ROW PER (date, slot, ticker). `outcome = 'pick'` carries the full construction; `outcome =
-- 'rejected'` carries the reason, so a study can see what the gates removed — the losers are the data a
-- ranking question needs (see migration 076). Both batch slots are kept; a re-run of a slot REPLACES.
--
-- Outcomes are NOT stored: they are settled later against `spread_chain_capture` track rows (real marks)
-- or `historical_prices` at expiry, so a split repair corrects them rather than freezing a wrong number.
-- `spot` is stored for the split scale guard.
--
-- Per-share values unless named total_*. IV is not stored here; the chain row in spread_chain_capture
-- for the same date/slot/ticker/expiration has it.
--
-- see src/main/services/spread-mode.ts, docs/formulas.md#bull-put-spread-mode

CREATE TABLE IF NOT EXISTS spread_mode_picks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_date       TEXT    NOT NULL,           -- ET trading date, YYYY-MM-DD
  slot             TEXT    NOT NULL CHECK (slot IN ('intraday', 'after_close')),
  generated_at     TEXT    NOT NULL,           -- when the mode ran (UTC ISO)
  mode             TEXT    NOT NULL CHECK (mode IN ('shadow', 'on')),
  ticker           TEXT    NOT NULL,
  outcome          TEXT    NOT NULL CHECK (outcome IN ('pick', 'rejected')),
  rank             INTEGER,                    -- 1 = best; NULL on rejections
  reason           TEXT,                       -- why excluded; NULL on picks

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
  net_credit       REAL,                       -- after fills (options-fill.ts)
  max_loss         REAL,                       -- width − net_credit
  return_on_risk   REAL,                       -- net_credit ÷ max_loss
  cost_share       REAL,                       -- round-trip slippage ÷ mid credit
  contracts        INTEGER,
  total_max_loss   REAL,                       -- $, contracts × max_loss × 100
  earnings_date    TEXT,
  critic_verdict   TEXT,

  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_spread_mode_picks_unique
  ON spread_mode_picks (as_of_date, slot, ticker);

-- Settling a pick walks its ticker+expiry forward through spread_chain_capture.
CREATE INDEX IF NOT EXISTS idx_spread_mode_picks_settle
  ON spread_mode_picks (ticker, expiration);
