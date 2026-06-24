-- Migration 060: settings-driven per-mode broker selection (Requirements/v2-execution/07-broker-alternatives.md §3).
--
-- Until now the ExecutionBroker behind the seam was chosen by ENV only (TA_EXEC_BROKER=ibkr,
-- else the mock). That makes the running app's venue invisible/uneditable in the UI. This adds a
-- persisted, per-mode selection so the operator can pick the paper (soak) venue and the live
-- (real-money) venue independently — the v2 design deliberately DECOUPLES the two slots (a broker
-- that can soak need not be the one that goes live, and vice-versa).
--
--   • paper_broker — venue used when execution_mode = 'paper' (the soak)
--   • live_broker  — venue used when execution_mode = 'live'  (real money)
--
-- Allowed values: 'mock' | 'ibkr' | 'tradier' (the governor validates defensively, no CHECK
-- constraint per SQLite ALTER ADD COLUMN limits — same pattern as automation_mode).
--
-- Default 'mock' preserves the existing opt-in behaviour EXACTLY: today an install with no
-- TA_EXEC_BROKER env resolves to the mock broker, so defaulting the columns to 'mock' means no
-- existing install silently starts connecting to a real broker after this migration. The operator
-- opts into ibkr/tradier explicitly via the Execution Settings dropdowns. Resolution precedence
-- stays: explicit TA_EXEC_BROKER env (dev/test override) → these columns by mode → 'mock'.
--
-- Validation-exempt per FR-SEY-5: selecting the venue changes neither which trades are selected nor
-- how they're sized/exited — it only routes the same orders to a different (still fail-closed,
-- still spread-permission-preflighted) broker.

ALTER TABLE exec_config ADD COLUMN paper_broker TEXT NOT NULL DEFAULT 'mock';   -- mock | ibkr | tradier
ALTER TABLE exec_config ADD COLUMN live_broker  TEXT NOT NULL DEFAULT 'mock';   -- mock | ibkr | tradier
