-- Migration 008: Add current_iv column to quote_cache
-- Stores ATM implied volatility percentage fetched from Polygon options snapshot

ALTER TABLE quote_cache ADD COLUMN current_iv REAL;