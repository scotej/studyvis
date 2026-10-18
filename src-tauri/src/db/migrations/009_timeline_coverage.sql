-- #417: completion time does not describe the input snapshot of a write-up.
-- NULL preserves unknown coverage for narratives produced by older builds.
ALTER TABLE session_timelines ADD COLUMN covered_until INTEGER;
