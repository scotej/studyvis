-- #210: authenticated overlap duration per peer for sessions that may continue
-- solo after the other participants leave. NULL on every older row means the
-- finer-grained duration was not recorded; readers retain the legacy whole-
-- session-per-peer interpretation for those rows.
--
-- New writers store a canonical JSON object, including `{}` for a precisely
-- measured peerless session. SQLite owns only the nullable compatibility
-- envelope; the shared TypeScript codec validates the object and its values.
ALTER TABLE sessions ADD COLUMN peer_presence_ms TEXT;
