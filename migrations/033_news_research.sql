-- News & Research: daily cache per ticker + macro events calendar.
-- See Requirements/news-research.md for full spec (FR-NR-35, FR-NR-36).

CREATE TABLE IF NOT EXISTS news_research_cache (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker       TEXT NOT NULL,
  cache_date   TEXT NOT NULL,          -- YYYY-MM-DD local trading date
  raw_data     TEXT NOT NULL,          -- JSON: RawSignals blob
  ai_summary   TEXT,                   -- JSON: { keyFactors, summary, portfolioNote } (null until AI phase)
  impact_score REAL,                   -- denormalized for fast sort
  bias         TEXT CHECK(bias IN ('bull','bear','mixed')),
  ai_model     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(ticker, cache_date)
);

CREATE TABLE IF NOT EXISTS macro_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date  TEXT NOT NULL,           -- YYYY-MM-DD
  event_type  TEXT NOT NULL,           -- 'FOMC' | 'CPI' | 'PPI' | 'JOBS' | 'OTHER'
  description TEXT NOT NULL,
  source      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 2026 FOMC decision dates (last day of each meeting) ───────────────────────
INSERT OR IGNORE INTO macro_events (event_date, event_type, description, source) VALUES
  ('2026-01-29', 'FOMC', 'FOMC Rate Decision — Jan 2026', 'Federal Reserve'),
  ('2026-03-19', 'FOMC', 'FOMC Rate Decision — Mar 2026', 'Federal Reserve'),
  ('2026-05-07', 'FOMC', 'FOMC Rate Decision — May 2026', 'Federal Reserve'),
  ('2026-06-18', 'FOMC', 'FOMC Rate Decision — Jun 2026', 'Federal Reserve'),
  ('2026-07-30', 'FOMC', 'FOMC Rate Decision — Jul 2026', 'Federal Reserve'),
  ('2026-09-17', 'FOMC', 'FOMC Rate Decision — Sep 2026', 'Federal Reserve'),
  ('2026-11-05', 'FOMC', 'FOMC Rate Decision — Nov 2026', 'Federal Reserve'),
  ('2026-12-10', 'FOMC', 'FOMC Rate Decision — Dec 2026', 'Federal Reserve');

-- ── 2026 CPI release dates (Bureau of Labor Statistics) ───────────────────────
INSERT OR IGNORE INTO macro_events (event_date, event_type, description, source) VALUES
  ('2026-01-15', 'CPI', 'CPI Release — Dec 2025 data', 'BLS'),
  ('2026-02-12', 'CPI', 'CPI Release — Jan 2026 data', 'BLS'),
  ('2026-03-12', 'CPI', 'CPI Release — Feb 2026 data', 'BLS'),
  ('2026-04-10', 'CPI', 'CPI Release — Mar 2026 data', 'BLS'),
  ('2026-05-12', 'CPI', 'CPI Release — Apr 2026 data', 'BLS'),
  ('2026-06-11', 'CPI', 'CPI Release — May 2026 data', 'BLS'),
  ('2026-07-14', 'CPI', 'CPI Release — Jun 2026 data', 'BLS'),
  ('2026-08-12', 'CPI', 'CPI Release — Jul 2026 data', 'BLS'),
  ('2026-09-10', 'CPI', 'CPI Release — Aug 2026 data', 'BLS'),
  ('2026-10-14', 'CPI', 'CPI Release — Sep 2026 data', 'BLS'),
  ('2026-11-12', 'CPI', 'CPI Release — Oct 2026 data', 'BLS'),
  ('2026-12-11', 'CPI', 'CPI Release — Nov 2026 data', 'BLS');

-- ── 2026 Nonfarm Payrolls / Jobs Report (first Friday of each month) ──────────
INSERT OR IGNORE INTO macro_events (event_date, event_type, description, source) VALUES
  ('2026-01-09', 'JOBS', 'Nonfarm Payrolls — Dec 2025', 'BLS'),
  ('2026-02-06', 'JOBS', 'Nonfarm Payrolls — Jan 2026', 'BLS'),
  ('2026-03-06', 'JOBS', 'Nonfarm Payrolls — Feb 2026', 'BLS'),
  ('2026-04-03', 'JOBS', 'Nonfarm Payrolls — Mar 2026', 'BLS'),
  ('2026-05-01', 'JOBS', 'Nonfarm Payrolls — Apr 2026', 'BLS'),
  ('2026-06-05', 'JOBS', 'Nonfarm Payrolls — May 2026', 'BLS'),
  ('2026-07-02', 'JOBS', 'Nonfarm Payrolls — Jun 2026', 'BLS'),
  ('2026-08-07', 'JOBS', 'Nonfarm Payrolls — Jul 2026', 'BLS'),
  ('2026-09-04', 'JOBS', 'Nonfarm Payrolls — Aug 2026', 'BLS'),
  ('2026-10-02', 'JOBS', 'Nonfarm Payrolls — Sep 2026', 'BLS'),
  ('2026-11-06', 'JOBS', 'Nonfarm Payrolls — Oct 2026', 'BLS'),
  ('2026-12-04', 'JOBS', 'Nonfarm Payrolls — Nov 2026', 'BLS');
