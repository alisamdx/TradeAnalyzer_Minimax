-- Conviction List (v0.24.0)
-- Personal stock reference with price conviction bands.
-- One permanent list per user (not multi-list like watchlists).
CREATE TABLE IF NOT EXISTS conviction_stocks (
  ticker      TEXT PRIMARY KEY,
  price_low   REAL,                  -- comfortable entry ("I'd buy here")
  price_mid   REAL,                  -- experimental zone
  price_high  REAL,                  -- never enter above this
  note        TEXT,
  added_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Audit trail: written whenever bands or note change.
CREATE TABLE IF NOT EXISTS conviction_band_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker      TEXT NOT NULL REFERENCES conviction_stocks(ticker) ON DELETE CASCADE,
  price_low   REAL,
  price_mid   REAL,
  price_high  REAL,
  note        TEXT,
  changed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_conviction_band_history_ticker
  ON conviction_band_history(ticker, changed_at DESC);
