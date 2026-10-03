-- 091: constituents.sub_industry — keep the GICS sub-industry beside the sector (v1.1.342).
--
-- The Wikipedia parser chose columns from the first data row, and on the S&P 500 page that row is 3M,
-- whose two-character name failed the "company names are longer than 3 characters" test. Every column
-- choice shifted one to the right: company_name got the GICS Sector and `sector` got the GICS
-- SUB-INDUSTRY. Vanguard (the primary source) overwrites company names but carries no sector, so the
-- sub-industries stayed — and the spread mode's per-sector cap became a per-sub-industry cap.
--
-- The parser now finds columns by header name and stores both levels: `sector` = GICS Sector,
-- `sub_industry` = GICS Sub-Industry. Existing rows are NOT rewritten here: which level a stored value
-- is cannot be told from the value alone. The constituents-refresh job's sector refresh from Wikipedia
-- replaces S&P 500 members' values on its next run. Russell-only names keep what they have.

ALTER TABLE constituents ADD COLUMN sub_industry TEXT;
