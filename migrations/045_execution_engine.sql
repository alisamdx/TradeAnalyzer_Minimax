-- Migration 045: v2 Execution Subsystem schema (exec_* tables).
-- Foundation for automated trade execution (see Requirements/v2-execution/).
-- The headless execution core OWNS and writes these tables; the Electron app reads
-- execution state via the core's control API, never by direct DB write (disjoint
-- write-sets — see 01-architecture §1.3b). Tables are namespaced `exec_` to avoid
-- collision with the v1 `positions`/portfolio tables.
--
-- Creation order respects foreign keys (referenced tables first). The singleton
-- config + risk-state rows (id=1) are seeded here via INSERT OR IGNORE so the engine
-- always has a row to read; defaults are the locked v2.0 values (02-risk-governor §2.3).

-- ── Configuration (single row, id=1): risk + engine config, the governor's rules ──
CREATE TABLE IF NOT EXISTS exec_config (
  id                          INTEGER PRIMARY KEY CHECK (id = 1),
  execution_mode              TEXT    NOT NULL DEFAULT 'paper'
                                CHECK (execution_mode IN ('paper', 'live')),
  capital_ceiling             REAL    NOT NULL DEFAULT 10000,   -- capital base; $ ceiling
  max_risk_per_trade_pct      REAL    NOT NULL DEFAULT 5,       -- % of ceiling
  max_concurrent_positions    INTEGER NOT NULL DEFAULT 5,
  daily_loss_trip_pct         REAL    NOT NULL DEFAULT 10,      -- kill-switch trip %
  max_positions_per_ticker    INTEGER NOT NULL DEFAULT 1,
  max_positions_per_strategy  INTEGER,                          -- NULL = off
  eligible_strategies         TEXT    NOT NULL DEFAULT 'inflection',  -- launch: inflection only
  proposal_shelf_life_min     INTEGER NOT NULL DEFAULT 120,
  updated_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO exec_config (id) VALUES (1);

-- ── Live risk ledger + engine state (single row, id=1): the governor's truth ──
CREATE TABLE IF NOT EXISTS exec_risk_state (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  engine_state         TEXT    NOT NULL DEFAULT 'stopped'
                         CHECK (engine_state IN ('running', 'stopped', 'paused', 'kill_tripped')),
  kill_switch_tripped  INTEGER NOT NULL DEFAULT 0,             -- 0/1
  kill_switch_reason   TEXT,
  capital_deployed     REAL    NOT NULL DEFAULT 0,             -- Σ open-position max loss
  day_realized_pnl     REAL    NOT NULL DEFAULT 0,
  day_unrealized_pnl   REAL    NOT NULL DEFAULT 0,
  day_anchor_date      TEXT,                                   -- session the day P&L is measured against
  updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO exec_risk_state (id) VALUES (1);

-- ── Proposals: candidate orders awaiting approval (semi-auto) ──
CREATE TABLE IF NOT EXISTS exec_proposals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at       TEXT    NOT NULL,                           -- created_at + shelf-life
  status           TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'superseded')),
  kind             TEXT    NOT NULL CHECK (kind IN ('entry', 'exit')),
  ticker           TEXT    NOT NULL,
  strategy         TEXT    NOT NULL,
  structure        TEXT    NOT NULL,                           -- short-put-vertical | short-call-vertical | csp
  legs_json        TEXT    NOT NULL,                           -- priced legs (IBKR-confirmed)
  net_credit       REAL,                                       -- per-share
  max_loss         REAL    NOT NULL,                           -- per-contract $ (sizing input)
  contracts        INTEGER NOT NULL,
  source_brief_id  INTEGER,                                    -- provenance into v1 brief pick
  risk_check_json  TEXT,                                       -- gate-result snapshot
  reject_reason    TEXT
);

CREATE INDEX IF NOT EXISTS idx_exec_proposals_status ON exec_proposals (status, created_at DESC);

-- ── Orders: the order state machine (idempotency via client_order_id) ──
CREATE TABLE IF NOT EXISTS exec_orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  client_order_id  TEXT    NOT NULL UNIQUE,                    -- COID — idempotency key
  proposal_id      INTEGER REFERENCES exec_proposals (id),
  broker_order_id  TEXT,                                       -- IBKR id once known
  status           TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'submitted', 'working', 'filled',
                                       'partially_filled', 'rejected', 'cancelled')),
  side             TEXT    NOT NULL CHECK (side IN ('open', 'close')),
  reject_reason    TEXT,
  submitted_at     TEXT,
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_exec_orders_status ON exec_orders (status);

-- ── Fills: reconciled from broker truth (broker is the source of truth) ──
CREATE TABLE IF NOT EXISTS exec_fills (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER NOT NULL REFERENCES exec_orders (id),
  broker_exec_id  TEXT    UNIQUE,                              -- dedup key from broker
  filled_at       TEXT    NOT NULL,
  price           REAL    NOT NULL,                            -- net per-share for the combo
  quantity        INTEGER NOT NULL,                            -- contracts
  commission      REAL
);

CREATE INDEX IF NOT EXISTS idx_exec_fills_order ON exec_fills (order_id);

-- ── Managed positions: bot-owned (distinct from v1 `positions` portfolio mirror) ──
CREATE TABLE IF NOT EXISTS exec_positions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker            TEXT    NOT NULL,
  strategy          TEXT    NOT NULL,
  structure         TEXT    NOT NULL,
  legs_json         TEXT    NOT NULL,
  contracts         INTEGER NOT NULL,
  entry_order_id    INTEGER REFERENCES exec_orders (id),
  entry_net_credit  REAL,
  max_loss          REAL    NOT NULL,                          -- capital this position ties up
  opened_at         TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'closing', 'closed', 'needs_attention')),
  exit_rule_json    TEXT,                                      -- exit-rule config snapshot (fixed at entry)
  current_mark      REAL,                                      -- last reconciled mark
  current_pnl       REAL,
  closed_at         TEXT,
  close_reason      TEXT                                       -- profit_target|stop|time_stop|defensive|manual|flatten
                      CHECK (close_reason IS NULL OR close_reason IN
                        ('profit_target', 'stop', 'time_stop', 'defensive', 'manual', 'flatten'))
);

CREATE INDEX IF NOT EXISTS idx_exec_positions_status ON exec_positions (status);
CREATE INDEX IF NOT EXISTS idx_exec_positions_ticker ON exec_positions (ticker);

-- ── Audit log: APPEND-ONLY forensic record of every decision and action ──
-- Never UPDATE/DELETE (enforced by convention + test). The basis for "why did the bot
-- do that?" and for paper-phase tuning.
CREATE TABLE IF NOT EXISTS exec_audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  event        TEXT    NOT NULL,                               -- proposal_created|approved|rejected|order_submitted|fill|exit_fired|limit_hit|kill_tripped|kill_cleared|engine_state|reconcile_mismatch|...
  ref_table    TEXT,
  ref_id       INTEGER,
  detail_json  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exec_audit_at ON exec_audit_log (at DESC);
