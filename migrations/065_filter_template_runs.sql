-- Filter template prefill runs — the latest batch-computed results for each filter template.
-- Written by the filters-prefill batch job (evening slot, Universe = All); read by FiltersView
-- so results are pre-populated when the user opens the Filters screen.
-- One row per template — each batch run overwrites the previous one (latest-only, no history).
CREATE TABLE IF NOT EXISTS filter_template_runs (
  template_id   TEXT PRIMARY KEY,
  ran_at        TEXT NOT NULL,            -- ISO timestamp of the batch run
  universe      TEXT NOT NULL,            -- universe scanned (e.g. 'all')
  result_count  INTEGER NOT NULL,
  results_json  TEXT NOT NULL,            -- FilterTemplateResult[] as JSON
  shape_version INTEGER NOT NULL          -- FILTER_RESULTS_SHAPE_VERSION at write time; stale shapes are ignored on read
);
