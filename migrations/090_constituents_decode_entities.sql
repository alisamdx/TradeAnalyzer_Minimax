-- 090: decode HTML entities in stored constituent sectors and company names (v1.1.341).
--
-- The Wikipedia constituents parser stripped tags from each table cell but never decoded entities,
-- so GICS sub-industries and company names were stored as page source: `Oil &amp; Gas Exploration
-- &amp; Production`, `AT&amp;T`. Vanguard (the primary source) has no sector and a refresh keeps the
-- stored one, so the escaped value persisted indefinitely and anything grouping by sector (the spread
-- mode's 3-per-sector cap, the shadow report) could split one sector into two spellings.
-- `decodeHtmlEntities` in constituents-service.ts fixes new writes; this repairs what is stored.
--
-- `&amp;` is decoded LAST so a single pass matches the code: `&amp;lt;` becomes `&lt;`, never `<`.
-- A correctly stored name contains none of these sequences, so re-running is a no-op.

UPDATE constituents
   SET sector = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
         sector,
         '&#39;', ''''), '&#039;', ''''), '&apos;', ''''), '&quot;', '"'),
         '&lt;', '<'), '&gt;', '>'), '&nbsp;', ' '), '&#160;', ' '), '&#38;', '&'), '&amp;', '&')
 WHERE sector LIKE '%&%;%';

UPDATE constituents
   SET company_name = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
         company_name,
         '&#39;', ''''), '&#039;', ''''), '&apos;', ''''), '&quot;', '"'),
         '&lt;', '<'), '&gt;', '>'), '&nbsp;', ' '), '&#160;', ' '), '&#38;', '&'), '&amp;', '&')
 WHERE company_name LIKE '%&%;%';
