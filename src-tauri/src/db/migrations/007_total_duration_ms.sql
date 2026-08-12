-- #220: retain sub-minute awake study time across same-topic Leave/Rejoin
-- stints. Existing rows deliberately remain NULL: their total_minutes value
-- was rounded at each historical write, so backfilling would falsely claim
-- millisecond precision. New writers always store a non-negative integer.
ALTER TABLE sessions ADD COLUMN total_duration_ms INTEGER;
