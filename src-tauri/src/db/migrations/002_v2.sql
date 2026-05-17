-- V2-P9 migration. Chained behind 001 (not amended in place) because 001 is
-- now the baseline a deployed V1 database is already at. The sessions table's
-- V2 columns (declared_topic, score, focused_pct, generated_at) already landed
-- in 001_initial.sql — do NOT redeclare them here.
--
-- Only the models table is owed. It mirrors the per-model benchmark record
-- the frontend currently keeps in models.json (modelStore); the table is the
-- prescribed schema for a later phase that moves that record into SQLite. It
-- is created here so the migration is in place; nothing reads or writes it
-- yet. `IF NOT EXISTS` keeps a re-run (or a dev DB that somehow has it) a
-- non-destructive no-op, layered on top of the schema_version guard.
CREATE TABLE IF NOT EXISTS models (
    id                  TEXT PRIMARY KEY,
    model_path          TEXT,
    mmproj_path         TEXT,
    p50_ms              INTEGER,
    p95_ms              INTEGER,
    sample_interval_s   INTEGER,
    last_benchmarked_at INTEGER
);
