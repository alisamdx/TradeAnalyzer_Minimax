-- 070: allow a third verdict on a price discontinuity — 'ticker_reuse' — and record the
-- volume evidence that distinguishes it.
--
-- A symbol can be reassigned to a completely different company (rename, reverse merger,
-- de-SPAC, delisting + reuse). The stored series then splices two unrelated entities and
-- NO re-fetch can fix it: the provider keys by ticker too, so it returns the same spliced
-- series. This is a third bug class, distinct from an unadjusted split (repairable) and a
-- genuine market move (correct as stored).
--
-- Observed 2026-09-01, both recorded 'confirmed_real' because a re-fetch changed nothing:
--   BNY  "Bank of New York Mellon Corp."  median vol   46,254 ->  3,519,645  (76x)
--   SPCX "Space Exploration Technologies" median vol    1,531 -> 82,047,547  (53,592x)
-- Against the six genuine moves in the same batch, whose volume regime moved 0.4x-5.0x.
--
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt. Existing rows are
-- preserved; volume_ratio is NULL for verdicts recorded before this migration.
CREATE TABLE price_split_repairs_new (
  ticker             TEXT NOT NULL,
  discontinuity_date TEXT NOT NULL,
  ratio              REAL NOT NULL,          -- close / prev_close
  volume_ratio       REAL,                   -- median volume after / before (regime shift)
  status             TEXT NOT NULL CHECK (status IN ('repaired','confirmed_real','ticker_reuse')),
  bars_rewritten     INTEGER,
  detected_at        TEXT NOT NULL,
  resolved_at        TEXT,
  PRIMARY KEY (ticker, discontinuity_date)
);

INSERT INTO price_split_repairs_new
  (ticker, discontinuity_date, ratio, volume_ratio, status, bars_rewritten, detected_at, resolved_at)
SELECT ticker, discontinuity_date, ratio, NULL, status, bars_rewritten, detected_at, resolved_at
  FROM price_split_repairs;

DROP TABLE price_split_repairs;
ALTER TABLE price_split_repairs_new RENAME TO price_split_repairs;

CREATE INDEX IF NOT EXISTS idx_price_split_repairs_status
  ON price_split_repairs(status);

-- Re-open the two known ticker-reuse cases so the next price-gap-fill run classifies and
-- truncates them properly instead of leaving them as 'confirmed_real'.
DELETE FROM price_split_repairs
 WHERE ticker IN ('BNY','SPCX') AND status = 'confirmed_real';
