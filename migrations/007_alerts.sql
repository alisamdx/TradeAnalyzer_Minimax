-- 007_alerts.sql - Alerts system for notifications
-- Supports Phase 8: Alerts System
-- see SPEC: Priority 8 - Alerts System

-- Alerts table for user-configurable notifications
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,

  -- Alert types: price, expiration, delta
  alert_type TEXT NOT NULL CHECK (alert_type IN ('price', 'expiration', 'delta')),

  -- Threshold values
  price_threshold REAL,  -- For price alerts (target price)
  price_condition TEXT CHECK (price_condition IN ('above', 'below')),  -- above or below target

  -- For expiration alerts (days before expiration)
  days_before_expiration INTEGER DEFAULT 7,

  -- For delta alerts (option delta threshold)
  delta_threshold REAL,  -- e.g., 0.40 for 40%
  delta_direction TEXT CHECK (delta_direction IN ('above', 'below')),

  -- Alert status
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_triggered INTEGER NOT NULL DEFAULT 0 CHECK (is_triggered IN (0, 1)),
  triggered_at TEXT,  -- ISO timestamp when triggered

  -- Optional sound alert
  play_sound INTEGER NOT NULL DEFAULT 1 CHECK (play_sound IN (0, 1)),

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_alerts_ticker
  ON alerts (ticker);

CREATE INDEX IF NOT EXISTS idx_alerts_type
  ON alerts (alert_type);

CREATE INDEX IF NOT EXISTS idx_alerts_active
  ON alerts (is_active);

CREATE INDEX IF NOT EXISTS idx_alerts_triggered
  ON alerts (is_triggered);

CREATE INDEX IF NOT EXISTS idx_alerts_ticker_active
  ON alerts (ticker, is_active);

-- View: Active alerts summary
CREATE VIEW IF NOT EXISTS v_active_alerts AS
SELECT
  a.*,
  CASE
    WHEN a.alert_type = 'price' THEN
      'Price ' || a.price_condition || ' $' || a.price_threshold
    WHEN a.alert_type = 'expiration' THEN
      a.days_before_expiration || ' days before expiration'
    WHEN a.alert_type = 'delta' THEN
      'Delta ' || a.delta_direction || ' ' || (a.delta_threshold * 100) || '%'
  END as description
FROM alerts a
WHERE a.is_active = 1;

-- View: Triggered alerts (for notification history)
CREATE VIEW IF NOT EXISTS v_triggered_alerts AS
SELECT *
FROM alerts
WHERE is_triggered = 1
ORDER BY triggered_at DESC;

-- Trigger to update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS trg_alerts_updated_at
AFTER UPDATE ON alerts
BEGIN
  UPDATE alerts
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.id;
END;
