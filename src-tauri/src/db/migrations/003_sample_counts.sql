-- #47 D5 migration. Chained behind 002 (never edit a shipped migration).
-- Two nullable per-session AI sample counters so the post-session report can
-- render an honest data-quality line: `skipped_samples` (uncertain /
-- unparseable checks, excluded from focused-time math per A2/A3) and
-- `confident_samples` (the denominator focused_pct was computed over).
-- NULL on rows written before this migration and on AI-off sessions — the
-- report treats NULL as "counts unknown" and stays silent.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`; the schema_version guard in
-- migrations.rs is what makes this single-shot.
ALTER TABLE sessions ADD COLUMN confident_samples INTEGER;
ALTER TABLE sessions ADD COLUMN skipped_samples INTEGER;
