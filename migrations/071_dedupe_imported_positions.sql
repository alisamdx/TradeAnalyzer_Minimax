-- 071: collapse duplicate closed positions left by the v1.1.150 import.
--
-- Sequence that produced them:
--   v1.1.150  the executed-orders import landed and INSERTED 25 closed positions. Supersede
--             logic did not exist yet, so each one sat beside the estimate it should have
--             replaced.
--   v1.1.151  supersede added: a real fill now overwrites the matching estimate in place.
--   v1.1.152  orders made primary, so the import finally ran that path again and superseded
--             12 estimates -- which were already duplicated by the v1.1.150 inserts.
--
-- Verified before writing this: all 12 pairs carry IDENTICAL realized_pnl (e.g. the TSLA 350
-- assignment reads +499.48 in both rows, the TSLA 360 CC +347.47 in both), so collapsing them
-- cannot change any P&L figure.
--
-- The surviving row is the LOWEST id -- the original position-sync row, which also carries
-- etrade_position_id, Greeks and market_value that the import does not populate.
--
-- Idempotent and harmless on an install that never ran v1.1.150: the subquery simply matches
-- nothing. Going forward no duplicate can arise, because insertClosedPosition supersedes an
-- estimate in place and skips a position already imported.
DELETE FROM positions
 WHERE status = 'closed'
   AND id NOT IN (
     SELECT MIN(id) FROM positions
      WHERE status = 'closed'
      GROUP BY ticker, position_type,
               IFNULL(strike_price, -1), IFNULL(expiration_date, ''),
               entry_date, quantity
   );
