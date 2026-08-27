-- #236: the written session timeline. One row per session, holding the
-- narrative the local model produced from that session's raw AI observation
-- journal after the session ended.
--
-- A separate table rather than columns on `sessions` on purpose: the sessions
-- upsert merges stints with COALESCE and an explicit focus-metrics replace
-- mode (see db/sessions.rs), and a whole-session narrative is regenerated
-- wholesale rather than merged. INSERT OR REPLACE here keeps the two apart.
--
-- `source` records how the entries were produced, so the report can never
-- claim a model wrote a narrative it did not: 'model' (every window written by
-- the local model), 'mixed' (some windows fell back), 'observations' (no model
-- output at all — the entries are the deterministic per-window digest).
CREATE TABLE IF NOT EXISTS session_timelines (
  session_id   TEXT PRIMARY KEY,
  generated_at INTEGER NOT NULL,
  model_id     TEXT,
  source       TEXT NOT NULL,
  entries      TEXT NOT NULL,
  -- 1 when the journal held more checks than were read back, so the narrative
  -- covers only part of the session. The report says so rather than passing a
  -- partial account off as the whole thing.
  truncated    INTEGER NOT NULL DEFAULT 0
);
