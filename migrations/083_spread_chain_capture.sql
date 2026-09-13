-- 083: Capture the put-side chain a BULL PUT SPREAD would be built from — both legs, every run.
--
-- WHY. The operator's second strategy (2026-09-12) is a bull put credit spread: premium, not
-- direction, held 5–15 days. Nothing stored so far can price one honestly. `options_premium_history`
-- and `brief_candidates` hold only the SHORT leg's quote, and `iv_history` only ATM IV — so a replay
-- would have to price the bought wing with Black-Scholes at ATM IV. Put skew makes the lower strike
-- dearer than that, so the model overstates the credit, which is the entire edge being measured;
-- and the 50%-profit exit that makes the hold 5–15 days would be triggered by model marks, not
-- quotes. Capture is one-directional: a chain not written today cannot be recovered.
--
-- WHAT. One row per (run, ticker, expiration): the puts a spread could use, as compact JSON.
--   reason = 'entry' — the ticker is in this run's wheel/income/bullish validated pool, and the
--            expiry is 14–45 DTE (wider than the 21–35 draft so the DTE grid is testable).
--   reason = 'track' — the ticker+expiry had an 'entry' row in the last 21 calendar days and has not
--            expired: re-quoted so a spread opened then can be MARKED daily on real quotes. Kept even
--            if the stock has since left every pool — dropping it would bias the exit study toward
--            names that are still behaving.
-- Puts kept: |delta| 0.03–0.50, or (delta missing) strike 65–100% of spot; on 'track' rows also
-- every strike inside the entry row's strike range, since a falling stock pushes a short strike far
-- past the delta band and that is exactly the mark the loss stop needs.
--
-- WHY JSON. ~15–40 contracts per chain; a row per contract would be ~150 MB per trading year against
-- a 567 MB database. As one row per chain it is ~50 MB. Studies are scripts, not SQL filters.
-- `puts_json` = [[strike, bid, ask, delta, iv_pct, open_interest, volume], ...] ascending by strike.
-- Nulls are kept as null — "not reported" is not 0 (`volume` especially; see CLAUDE.md). IV is a
-- PERCENTAGE per project convention. bid/ask are stored as sent, including 0.
--
-- Both batch slots are kept (slot is in the key), for the same reason as migration 079: the morning
-- quote is the one an entry would be placed on. A re-run of a slot REPLACES.
--
-- see src/main/services/spread-chain-capture.ts, NewApp/TODO.md #42

CREATE TABLE IF NOT EXISTS spread_chain_capture (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_date        TEXT    NOT NULL,           -- ET trading date, YYYY-MM-DD
  slot              TEXT    NOT NULL CHECK (slot IN ('intraday', 'after_close')),
  captured_at       TEXT    NOT NULL,           -- when the chain was fetched (UTC ISO)
  ticker            TEXT    NOT NULL,
  expiration        TEXT    NOT NULL,
  dte               INTEGER NOT NULL,           -- calendar days
  reason            TEXT    NOT NULL CHECK (reason IN ('entry', 'track')),
  underlying_price  REAL,                       -- as the chain reported it; the split scale guard needs it
  contract_count    INTEGER NOT NULL,
  puts_json         TEXT    NOT NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_spread_chain_capture_unique
  ON spread_chain_capture (as_of_date, slot, ticker, expiration);

-- Marking a spread walks one ticker+expiry forward through time.
CREATE INDEX IF NOT EXISTS idx_spread_chain_capture_series
  ON spread_chain_capture (ticker, expiration, as_of_date);
