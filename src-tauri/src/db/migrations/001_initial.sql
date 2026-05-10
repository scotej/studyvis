-- Pre-release migration: V1 has no shipped users, so this file is amended
-- in place rather than chained behind a follow-up migration. Dev DB files
-- created before this amendment are harmless — SQLite tolerates extra
-- columns no Rust accessor reads or writes.
CREATE TABLE friends (
    ed_pubkey_hex     TEXT PRIMARY KEY,
    x_pubkey_hex      TEXT NOT NULL,
    display_name      TEXT,
    paired_at         INTEGER,
    last_studied_with INTEGER
);

CREATE TABLE sessions (
    id             TEXT PRIMARY KEY,
    started_at     INTEGER,
    ended_at       INTEGER,
    peer_pubkeys   TEXT,
    total_minutes  INTEGER,
    declared_topic TEXT,
    score          INTEGER
);

CREATE TABLE audit_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    ts         INTEGER,
    who        TEXT,
    kind       TEXT,
    detail     TEXT,
    sig        TEXT
);
