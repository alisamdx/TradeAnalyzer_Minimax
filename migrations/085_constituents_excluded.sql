-- 085: Delisted tickers removed from the constituent lists, and kept out.
--
-- WHY. On 2026-09-14 six tickers answered HTTP 404 from Polygon (snapshot and reference) and
-- "The symbol entered is invalid" from E*Trade, in both batch slots, every day: AVB, EA, EQR,
-- LBRDA, LBRDK, WBS. Each is delisted — EA went private (2026-08-04), AVB and EQR merged into
-- Vivmark Residential / VMRK (2026-08-17), LBRDA and LBRDK merged into Charter (2026-08-20),
-- WBS was acquired by Santander (2026-08-20). The constituents refresh had kept them for about
-- four weeks, so its sources still list them (or it fell back to a stale list).
--
-- DELETING THE ROWS IS NOT ENOUGH. `applyRefresh` replaces a whole index from the source feed,
-- so a feed that still lists a dead ticker would put it straight back. `constituents_excluded`
-- is honoured by every writer in ConstituentsService (refresh, CSV import, bundled bootstrap).
--
-- TradeAnalyzer 2 draws its universe from this table; its membership closes on the next
-- `universe_seed` run, which reconciles against the lists it is given.

CREATE TABLE IF NOT EXISTS constituents_excluded (
  ticker      TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,
  excluded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO constituents_excluded (ticker, reason) VALUES
  ('EA',    'delisted 2026-08-04 — taken private (PIF consortium)'),
  ('AVB',   'delisted 2026-08-17 — merged with EQR into Vivmark Residential (VMRK)'),
  ('EQR',   'delisted 2026-08-17 — merged with AVB into Vivmark Residential (VMRK)'),
  ('LBRDA', 'delisted 2026-08-20 — merged into Charter (CHTR)'),
  ('LBRDK', 'delisted 2026-08-20 — merged into Charter (CHTR)'),
  ('WBS',   'delisted 2026-08-20 — acquired by Banco Santander');

CREATE TABLE IF NOT EXISTS constituents (
  ticker TEXT NOT NULL,
  index_name TEXT NOT NULL,
  company_name TEXT,
  sector TEXT,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (ticker, index_name)
);

DELETE FROM constituents WHERE ticker IN (SELECT ticker FROM constituents_excluded);
