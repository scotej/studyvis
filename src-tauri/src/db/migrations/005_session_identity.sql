-- Immutable local-owner provenance for historical reports. This is captured
-- when a session starts, not when a report is opened: restoring a different
-- identity later must never change which signed audit events are local.
--
-- Existing rows intentionally stay NULL/unknown. We cannot safely infer the
-- local signer from a shared audit log after the identity has changed.
ALTER TABLE sessions ADD COLUMN local_ed_pubkey TEXT;
ALTER TABLE sessions ADD COLUMN local_display_name TEXT;
