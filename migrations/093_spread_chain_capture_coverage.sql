-- 093: spread_chain_capture gains reason = 'coverage' (BPS-14, v1.1.357).
--
-- WHY. The bull put spread study prices each replay entry's slippage from that TICKER's real intraday
-- quotes, and 08 §4 needs ≥ 50% of entries priced that way. Capture only ever quoted the day's pools,
-- while the replay set is fixed (179 wheel tickers, 2025-06…2026-08), so coverage stopped moving:
-- 660 / 1,495 on both 2026-10-09 and 2026-10-13 although quoted tickers rose 169 → 182.
-- A 'coverage' row is one chain, fetched in the intraday slot only for a replay ticker that has fewer
-- than three intraday quotes, so its cost can be measured. It is never an entry and never tracked.
--
-- HOW. A CHECK cannot be altered in SQLite, so the table is rebuilt. Nothing references it by foreign
-- key, so the copy-drop-rename is safe inside the migration transaction (CLAUDE.md: PRAGMA
-- foreign_keys is a no-op there). Every existing row satisfies the wider CHECK.
--
-- see src/main/services/spread-chain-capture.ts, NewApp/TODO-bull-put-spread.md BPS-14

CREATE TABLE spread_chain_capture_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_date        TEXT    NOT NULL,           -- ET trading date, YYYY-MM-DD
  slot              TEXT    NOT NULL CHECK (slot IN ('intraday', 'after_close')),
  captured_at       TEXT    NOT NULL,           -- when the chain was fetched (UTC ISO)
  ticker            TEXT    NOT NULL,
  expiration        TEXT    NOT NULL,
  dte               INTEGER NOT NULL,           -- calendar days
  reason            TEXT    NOT NULL CHECK (reason IN ('entry', 'track', 'coverage')),
  underlying_price  REAL,                       -- as the chain reported it; the split scale guard needs it
  contract_count    INTEGER NOT NULL,
  puts_json         TEXT    NOT NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO spread_chain_capture_new
  (id, as_of_date, slot, captured_at, ticker, expiration, dte, reason, underlying_price, contract_count, puts_json, created_at)
SELECT id, as_of_date, slot, captured_at, ticker, expiration, dte, reason, underlying_price, contract_count, puts_json, created_at
  FROM spread_chain_capture;

DROP TABLE spread_chain_capture;
ALTER TABLE spread_chain_capture_new RENAME TO spread_chain_capture;

CREATE UNIQUE INDEX IF NOT EXISTS idx_spread_chain_capture_unique
  ON spread_chain_capture (as_of_date, slot, ticker, expiration);

CREATE INDEX IF NOT EXISTS idx_spread_chain_capture_series
  ON spread_chain_capture (ticker, expiration, as_of_date);
