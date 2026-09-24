-- 088: shadow log for STALE_GREEK_MODEL_DELTA (v1.1.320).
--
-- Since v1.1.255 a chain whose E*Trade deltas imply a price > 1 % from both the chain price and the
-- put-call-parity price has its Greeks withheld, so the wheel skips that ticker. v1.1.319 added a
-- fallback (our Black-Scholes delta at the chain's own price) and shipped it OFF, because it adds
-- candidates that cannot be judged until they expire. This table records, for every stale chain in
-- the wheel DTE window, the put the wheel CSP rule WOULD have picked by that model delta — so the
-- flag can be decided on realized outcomes (Requirements/v2-execution/06, shipped-disabled register).
--
-- One row per (date, slot, ticker, expiration); a chain re-fetched within a slot overwrites its row.
-- `strike` is NULL when no put fell in the 0.20-0.30 band: the stale chain is still recorded, so the
-- count of skipped chains is not lost with the picks. The scorer takes the earliest expiration per
-- ticker and slot, as `AnalysisService.findSuitableChain` does. Nothing reads it on the live path.
-- see src/main/services/stale-greek-shadow.ts, docs/formulas.md#greek-consistency

CREATE TABLE stale_greek_shadow_picks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_date        TEXT    NOT NULL,
  slot              TEXT    NOT NULL CHECK (slot IN ('intraday', 'after_close')),
  ticker            TEXT    NOT NULL,
  expiration        TEXT    NOT NULL,
  dte               INTEGER NOT NULL,
  underlying_price  REAL    NOT NULL,
  implied_spot      REAL,
  deviation         REAL,
  strike            REAL,
  model_delta       REAL,
  provider_delta    REAL,
  bid               REAL,
  ask               REAL,
  iv                REAL,
  open_interest     INTEGER,
  volume            INTEGER,
  recorded_at       TEXT    NOT NULL,
  UNIQUE (as_of_date, slot, ticker, expiration)
);

CREATE INDEX idx_stale_greek_shadow_date ON stale_greek_shadow_picks (as_of_date);
