-- Conviction band ordering enforced at the schema level (v1.1.165, FR-CONV-1).
--
-- The bands must be strictly increasing: price_low < price_mid < price_high, with any
-- band allowed to be NULL (a partial band is legitimate). Service-level validation
-- (validateBandOrder) already covers every in-app writer; this CHECK closes the door on
-- raw SQL, repair scripts and anything added later that bypasses the service.
--
-- SQLite cannot add a CHECK to an existing table, so conviction_stocks is rebuilt.
-- Two hazards drive the shape of this file:
--
--   1. conviction_band_history has an FK to conviction_stocks(ticker) ON DELETE CASCADE,
--      and connection.ts sets foreign_keys=ON. Dropping the parent would cascade-delete
--      the entire audit trail. PRAGMA foreign_keys=OFF is a NO-OP inside a transaction,
--      and migrations.ts wraps every migration in one — so the pragma is not available
--      here. Instead the child table is copied aside and dropped BEFORE the parent is
--      replaced, then recreated and refilled with its original ids.
--
--   2. A pre-existing row that violates the new CHECK would fail the copy, and a failed
--      migration means the app does not boot. So violating rows are normalised first:
--      the original is snapshotted into conviction_band_history (nothing is lost), then
--      the present band values are sorted into their slots.

-- ── 1. Snapshot any violating row before touching it ────────────────────────────────
-- Preserves the exact stored values in the audit trail. Note is copied verbatim: history
-- records what was stored, not why it changed.
INSERT INTO conviction_band_history (ticker, price_low, price_mid, price_high, note)
SELECT ticker, price_low, price_mid, price_high, note
FROM conviction_stocks
WHERE (price_low  IS NOT NULL AND price_mid  IS NOT NULL AND price_low  >= price_mid)
   OR (price_mid  IS NOT NULL AND price_high IS NOT NULL AND price_mid  >= price_high)
   OR (price_low  IS NOT NULL AND price_high IS NOT NULL AND price_low  >= price_high);

-- ── 2. Normalise violating rows: sort the present values into their slots ────────────
-- Lossless where possible — the numbers are kept, only their order is corrected (a
-- low/mid inversion becomes a swap). SQLite evaluates every SET expression against the
-- ORIGINAL row, so these three assignments see pre-update values.
-- Multi-argument MIN()/MAX() return NULL if any argument is NULL, hence the explicit
-- population patterns rather than a single expression.
UPDATE conviction_stocks
SET
  price_low = CASE
    WHEN price_low IS NOT NULL AND price_mid IS NOT NULL AND price_high IS NOT NULL
      THEN MIN(price_low, price_mid, price_high)
    WHEN price_low IS NOT NULL AND price_mid  IS NOT NULL THEN MIN(price_low, price_mid)
    WHEN price_low IS NOT NULL AND price_high IS NOT NULL THEN MIN(price_low, price_high)
    ELSE price_low
  END,
  price_mid = CASE
    WHEN price_low IS NOT NULL AND price_mid IS NOT NULL AND price_high IS NOT NULL
      THEN price_low + price_mid + price_high
           - MIN(price_low, price_mid, price_high)
           - MAX(price_low, price_mid, price_high)          -- the middle of three
    WHEN price_low IS NOT NULL AND price_mid  IS NOT NULL THEN MAX(price_low, price_mid)
    WHEN price_mid IS NOT NULL AND price_high IS NOT NULL THEN MIN(price_mid, price_high)
    ELSE price_mid
  END,
  price_high = CASE
    WHEN price_low IS NOT NULL AND price_mid IS NOT NULL AND price_high IS NOT NULL
      THEN MAX(price_low, price_mid, price_high)
    WHEN price_mid IS NOT NULL AND price_high IS NOT NULL THEN MAX(price_mid, price_high)
    WHEN price_low IS NOT NULL AND price_high IS NOT NULL THEN MAX(price_low, price_high)
    ELSE price_high
  END
WHERE (price_low  IS NOT NULL AND price_mid  IS NOT NULL AND price_low  >= price_mid)
   OR (price_mid  IS NOT NULL AND price_high IS NOT NULL AND price_mid  >= price_high)
   OR (price_low  IS NOT NULL AND price_high IS NOT NULL AND price_low  >= price_high);

-- Sorting cannot separate equal values, and the CHECK is strict. Drop the duplicate,
-- keeping the outer bounds — a zero-width zone carries no information anyway.
UPDATE conviction_stocks SET price_mid = NULL
WHERE price_mid IS NOT NULL
  AND (   (price_low  IS NOT NULL AND price_mid = price_low)
       OR (price_high IS NOT NULL AND price_mid = price_high));

UPDATE conviction_stocks SET price_high = NULL
WHERE price_low IS NOT NULL AND price_high IS NOT NULL AND price_low = price_high;

-- ── 3. Move the child table out of the way (see hazard 1) ───────────────────────────
CREATE TABLE conviction_band_history_backup_075 AS SELECT * FROM conviction_band_history;
DROP TABLE conviction_band_history;

-- ── 4. Rebuild conviction_stocks with the CHECK constraints ─────────────────────────
CREATE TABLE conviction_stocks_new_075 (
  ticker      TEXT PRIMARY KEY,
  price_low   REAL,                  -- comfortable entry ("I'd buy here")
  price_mid   REAL,                  -- experimental zone
  price_high  REAL,                  -- never enter above this
  note        TEXT,
  added_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  in_play     INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT conviction_bands_low_lt_mid
    CHECK (price_low  IS NULL OR price_mid  IS NULL OR price_low  < price_mid),
  CONSTRAINT conviction_bands_mid_lt_high
    CHECK (price_mid  IS NULL OR price_high IS NULL OR price_mid  < price_high),
  CONSTRAINT conviction_bands_low_lt_high
    CHECK (price_low  IS NULL OR price_high IS NULL OR price_low  < price_high)
);

INSERT INTO conviction_stocks_new_075
  (ticker, price_low, price_mid, price_high, note, added_at, updated_at, in_play)
SELECT ticker, price_low, price_mid, price_high, note, added_at, updated_at, in_play
FROM conviction_stocks;

DROP TABLE conviction_stocks;   -- nothing references it now, so no cascade
ALTER TABLE conviction_stocks_new_075 RENAME TO conviction_stocks;

-- ── 5. Recreate the audit trail and restore it, ids intact ──────────────────────────
CREATE TABLE conviction_band_history (
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

INSERT INTO conviction_band_history (id, ticker, price_low, price_mid, price_high, note, changed_at)
SELECT id, ticker, price_low, price_mid, price_high, note, changed_at
FROM conviction_band_history_backup_075;

DROP TABLE conviction_band_history_backup_075;
