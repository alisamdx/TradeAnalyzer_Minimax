-- 092: three more delisted tickers kept out of the constituent lists (v1.1.348).
--
-- WHY. Measured 2026-10-11 on TradeAnalyzer 2's 2026-10-09 run: no Polygon bar for QRVO since 10-02,
-- or for PSKY and WBD since 10-05, and E*Trade answers all three "The symbol entered is invalid"
-- (10033) since 10-06. Confirmed against the deals themselves:
--   QRVO  acquired by Skyworks (SWKS); delisted from Nasdaq 2026-10-05.
--   WBD   acquired by Paramount Skydance; the merger closed 2026-10-06.
--   PSKY  the acquirer, renamed: the combined company trades on the NYSE as SKYD from 2026-10-06.
-- The constituents feeds (Vanguard month-end holdings, as of 2026-08-31 on 10-09) will keep listing
-- them for weeks, and each refresh replaces the list, so deleting the rows alone would last one
-- refresh. Same mechanism as migration 085.
--
-- SKYD is NOT added here. It is a new listing whose history begins 2026-10-06, and it enters the
-- universe when the feeds carry it, like any index addition. Reading PSKY's bars as SKYD's would
-- splice two securities.
--
-- TradeAnalyzer 2 closes these memberships on its next `universe_seed` run. Until then its QC-211
-- (member stopped trading) and QC-415 (pinned underlying unlisted) report them.

INSERT OR IGNORE INTO constituents_excluded (ticker, reason) VALUES
  ('QRVO', 'delisted 2026-10-05 — acquired by Skyworks (SWKS)'),
  ('WBD',  'delisted 2026-10-06 — acquired by Paramount Skydance; combined company trades as SKYD'),
  ('PSKY', 'delisted 2026-10-06 — renamed SKYD on closing the Warner Bros. Discovery merger');

DELETE FROM constituents WHERE ticker IN (SELECT ticker FROM constituents_excluded);
