-- 072: drop the mislabelled CSP/CC twin of a long-option position.
--
-- Before v1.1.155, matchClosedPositions priced EVERY option as short premium
-- ((open - close) x multiplier) and labelled every put CSP / every call CC regardless of
-- direction. A long option therefore imported with an INVERTED sign under a wheel label.
--
-- Caught by reconciling against E*Trade's own Gains & Losses export:
--   TSLA Jul 17 '26 $375 Put -- BOUGHT 19.63, SOLD 15.98 -> real -$364.06
--     id 14  Long Put  -364.03  (correct, written once v1.1.155 superseded the estimate)
--     id 39  CSP       +361.97  (phantom, from the pre-fix import)
-- One trade, two rows, opposite signs -- a $726 swing in the direction that flatters the book.
--
-- v1.1.155 fixes the mapping so this cannot recur, but the bad row is already persisted. It
-- survived migration 071's dedupe because that grouped on position_type, and these twins
-- disagree on exactly that column.
--
-- Rule: when the SAME trade (ticker + strike + expiry + entry_date + entry_price + quantity)
-- has both a Long row and a CSP/CC row, the CSP/CC one is the pre-fix artefact. Deliberately
-- narrow -- it cannot touch a genuine wheel position, because a real CSP never shares an entry
-- price and date with a long option on the same contract.
--
-- Verified before shipping: exactly one such pair exists, and removing it reconciles the
-- account to E*Trade's short-term realized gain within $0.68 of commission rounding.
DELETE FROM positions
 WHERE status = 'closed'
   AND position_type IN ('CSP','CC')
   AND EXISTS (
     SELECT 1 FROM positions AS long_twin
      WHERE long_twin.status = 'closed'
        AND long_twin.position_type IN ('Long Put','Long Call')
        AND long_twin.ticker = positions.ticker
        AND long_twin.entry_date = positions.entry_date
        AND long_twin.entry_price = positions.entry_price
        AND long_twin.quantity = positions.quantity
        AND IFNULL(long_twin.strike_price, -1) = IFNULL(positions.strike_price, -1)
        AND IFNULL(long_twin.expiration_date, '') = IFNULL(positions.expiration_date, '')
   );
