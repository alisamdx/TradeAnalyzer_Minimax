-- Migration 047: link an order to the position it opens/closes (Phase 4b OrderManager).
-- Set on the opening order once its fill creates the position, and on a closing order at
-- submit time so the close fill can resolve which position to mark closed.

ALTER TABLE exec_orders ADD COLUMN position_id INTEGER;
