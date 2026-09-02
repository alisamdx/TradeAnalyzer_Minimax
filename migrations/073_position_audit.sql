-- 073: audit trail for automated writes to the real position record.
--
-- The nightly portfolio-sync job (v1.1.159) is the FIRST batch job that mutates the user's
-- actual financial record rather than market data. Every other job touches prices, chains or
-- signals -- if one corrupts something you re-fetch it. This one rewrites `positions`, and its
-- supersede path OVERWRITES a stored realized P&L.
--
-- The risk is low by construction (idempotent; only ever replaces an ESTIMATE with a real
-- broker fill, never the reverse), but "low risk" and "unattended, nightly, on money" together
-- warrant a record. Tonight's whole investigation only became tractable once E*Trade calls were
-- logged at all -- the same argument applies here.
--
-- One row per write, so a wrong number can always be traced to the run that produced it.
CREATE TABLE IF NOT EXISTS position_audit (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at      TEXT NOT NULL,
  action           TEXT NOT NULL CHECK (action IN ('imported','superseded')),
  position_id      INTEGER,
  ticker           TEXT NOT NULL,
  position_type    TEXT,
  strike_price     REAL,
  expiration_date  TEXT,
  entry_date       TEXT,
  -- Before/after on the two fields that carry money. NULL "old" on an import: nothing existed.
  old_realized_pnl REAL,
  new_realized_pnl REAL,
  old_exit_price   REAL,
  new_exit_price   REAL,
  source           TEXT,               -- 'orders' | 'transactions'
  note             TEXT
);

CREATE INDEX IF NOT EXISTS idx_position_audit_occurred ON position_audit(occurred_at);
CREATE INDEX IF NOT EXISTS idx_position_audit_ticker   ON position_audit(ticker);
