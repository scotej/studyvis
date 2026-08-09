//! Forward-only, versioned schema migrations.
//!
//! Friends install releases manually and out of order in time, so the schema
//! is a cross-version compatibility surface: **never edit a shipped migration
//! in place** (001 was amended pre-release; that door is closed). To change
//! the schema, add `migrations/NNN_name.sql` and append a `(NNN, include_str!)`
//! tuple to `MIGRATIONS` — `MAX_KNOWN_VERSION` derives from the last entry.
//! There are no down migrations. Write DDL idempotently (`IF NOT EXISTS`) and
//! add an upgrade test alongside the existing ones below.
//!
//! 001's own header calls its two pre-release in-place amendments harmless
//! because "SQLite tolerates extra columns". That holds for the column the
//! `friends` amendment removed and not for the two the `sessions` one added:
//! a database created between them records version 1, so 001 never re-runs and
//! `sessions` stays short `focused_pct` + `generated_at` forever (issue #99).
//! `db::schema_repair` converges those databases at boot; the file itself is
//! now immutable (see `shipped_migrations_are_immutable`), hashes included,
//! so don't "correct" that comment.

use rusqlite::{Connection, TransactionBehavior};

const MIGRATION_001_INITIAL: &str = include_str!("migrations/001_initial.sql");
const MIGRATION_002_V2: &str = include_str!("migrations/002_v2.sql");
const MIGRATION_003_SAMPLE_COUNTS: &str = include_str!("migrations/003_sample_counts.sql");
const MIGRATION_004_AI_ENABLED: &str = include_str!("migrations/004_ai_enabled.sql");
const MIGRATION_005_SESSION_IDENTITY: &str = include_str!("migrations/005_session_identity.sql");

const MIGRATIONS: &[(u32, &str)] = &[
    (1, MIGRATION_001_INITIAL),
    (2, MIGRATION_002_V2),
    (3, MIGRATION_003_SAMPLE_COUNTS),
    (4, MIGRATION_004_AI_ENABLED),
    (5, MIGRATION_005_SESSION_IDENTITY),
];

pub const MAX_KNOWN_VERSION: u32 = MIGRATIONS[MIGRATIONS.len() - 1].0;

// `NewerSchema` is deliberately distinct from a plain SQLite failure: the
// database is healthy, the *binary* is too old to understand it. Callers must
// not treat it as corruption (no rename/recreate — see db::init).
#[derive(Debug)]
pub enum MigrationError {
    NewerSchema { found: u32 },
    Sqlite(rusqlite::Error),
}

impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NewerSchema { found } => write!(
                f,
                "database was created by a newer version of StudyVis \
                 (schema version {found}, this build supports up to {MAX_KNOWN_VERSION})"
            ),
            Self::Sqlite(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for MigrationError {}

impl From<rusqlite::Error> for MigrationError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e)
    }
}

pub fn run_migrations(conn: &mut Connection) -> Result<u32, MigrationError> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)",
        [],
    )?;

    // IMMEDIATE acquires the write lock at BEGIN, so a concurrent
    // first-launch (the single-instance guard is best-effort) blocks here and
    // reads the version AFTER the other process committed — instead of both
    // reading 0 and double-applying. `IF NOT EXISTS` on 001's DDL + `INSERT
    // OR IGNORE` make a lost race idempotent rather than a panic.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current: u32 = tx
        .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
            row.get::<_, Option<u32>>(0)
        })?
        .unwrap_or(0);
    if current > MAX_KNOWN_VERSION {
        return Err(MigrationError::NewerSchema { found: current });
    }
    let mut applied = current;
    for (version, sql) in MIGRATIONS.iter().copied() {
        if version > applied {
            tx.execute_batch(sql)?;
            tx.execute(
                "INSERT OR IGNORE INTO schema_version (version) VALUES (?1)",
                [version],
            )?;
            applied = version;
        }
    }
    tx.commit()?;
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_table_exists(conn: &Connection, name: &str) {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [name],
                |row| row.get(0),
            )
            .expect("query sqlite_master");
        assert_eq!(count, 1, "table `{name}` should exist");
    }

    fn current_version(conn: &Connection) -> u32 {
        conn.query_row("SELECT MAX(version) FROM schema_version", [], |row| {
            row.get::<_, Option<u32>>(0)
        })
        .expect("read schema_version")
        .unwrap_or(0)
    }

    const LATEST_VERSION: u32 = 5;

    #[test]
    fn applies_full_schema_on_empty_db() {
        let mut conn = Connection::open_in_memory().expect("open in-memory");
        let applied = run_migrations(&mut conn).expect("run migrations");
        assert_eq!(applied, LATEST_VERSION);
        assert_table_exists(&conn, "schema_version");
        assert_table_exists(&conn, "friends");
        assert_table_exists(&conn, "sessions");
        assert_table_exists(&conn, "audit_events");
        assert_table_exists(&conn, "models");
        assert_eq!(current_version(&conn), LATEST_VERSION);
    }

    #[test]
    fn second_run_is_a_noop_on_same_connection() {
        let mut conn = Connection::open_in_memory().expect("open in-memory");
        run_migrations(&mut conn).expect("first run");
        let applied = run_migrations(&mut conn).expect("second run");
        assert_eq!(applied, LATEST_VERSION);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_version", [], |row| row.get(0))
            .expect("count schema_version rows");
        assert_eq!(
            rows, LATEST_VERSION as i64,
            "exactly one version row per applied migration, no duplicates"
        );
    }

    // The acceptance criterion: 002_v2 runs cleanly and non-destructively on a
    // database already at schema_version 1 with real rows. Simulates an
    // existing V1 install upgrading.
    #[test]
    fn upgrades_v1_db_to_v2_without_data_loss() {
        let mut conn = Connection::open_in_memory().expect("open in-memory");

        // Bring the DB to exactly version 1 by running only the first
        // migration, mirroring what a shipped V1 binary left on disk.
        {
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)",
                [],
            )
            .expect("schema_version");
            let tx = conn.transaction().expect("tx");
            tx.execute_batch(MIGRATION_001_INITIAL).expect("apply 001");
            tx.execute("INSERT INTO schema_version (version) VALUES (1)", [])
                .expect("record v1");
            tx.commit().expect("commit v1");
        }
        conn.execute(
            "INSERT INTO friends (ed_pubkey_hex, x_pubkey_hex, display_name, paired_at)
             VALUES ('aa', 'bb', 'sam', 100)",
            [],
        )
        .expect("insert friend");
        conn.execute(
            "INSERT INTO sessions (id, started_at, declared_topic) VALUES ('s1', 1, 'Calculus')",
            [],
        )
        .expect("insert session");
        assert_eq!(current_version(&conn), 1);

        let applied = run_migrations(&mut conn).expect("upgrade run");
        assert_eq!(applied, LATEST_VERSION);
        assert_table_exists(&conn, "models");

        let friends: i64 = conn
            .query_row("SELECT COUNT(*) FROM friends", [], |row| row.get(0))
            .expect("count friends");
        assert_eq!(friends, 1, "V1 friend row must survive the upgrade");
        let topic: String = conn
            .query_row(
                "SELECT declared_topic FROM sessions WHERE id = 's1'",
                [],
                |row| row.get(0),
            )
            .expect("read session topic");
        assert_eq!(
            topic, "Calculus",
            "V1 session data must survive the upgrade"
        );
    }

    #[test]
    fn upgrades_v4_db_to_v5_with_unknown_identity_on_existing_sessions() {
        let mut conn = Connection::open_in_memory().expect("open in-memory");
        {
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)",
                [],
            )
            .expect("schema_version");
            let tx = conn.transaction().expect("tx");
            tx.execute_batch(MIGRATION_001_INITIAL).expect("apply 001");
            tx.execute_batch(MIGRATION_002_V2).expect("apply 002");
            tx.execute_batch(MIGRATION_003_SAMPLE_COUNTS)
                .expect("apply 003");
            tx.execute_batch(MIGRATION_004_AI_ENABLED)
                .expect("apply 004");
            tx.execute(
                "INSERT INTO schema_version (version) VALUES (1), (2), (3), (4)",
                [],
            )
            .expect("record v4");
            tx.commit().expect("commit v4");
        }
        conn.execute("INSERT INTO sessions (id) VALUES ('s1')", [])
            .expect("insert v4 session");

        let applied = run_migrations(&mut conn).expect("upgrade run");
        assert_eq!(applied, LATEST_VERSION);
        let owner: (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT local_ed_pubkey, local_display_name FROM sessions WHERE id = 's1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read migrated owner");
        assert_eq!(owner, (None, None));
    }

    // #47 D5 acceptance: 003 runs cleanly on a database already at
    // schema_version 2 with real session rows — the columns appear and the
    // pre-migration rows read back NULL counts ("unknown", not zero).
    #[test]
    fn upgrades_v2_db_to_v3_with_null_counts_on_old_rows() {
        let mut conn = Connection::open_in_memory().expect("open in-memory");
        {
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)",
                [],
            )
            .expect("schema_version");
            let tx = conn.transaction().expect("tx");
            tx.execute_batch(MIGRATION_001_INITIAL).expect("apply 001");
            tx.execute_batch(MIGRATION_002_V2).expect("apply 002");
            tx.execute("INSERT INTO schema_version (version) VALUES (1), (2)", [])
                .expect("record v2");
            tx.commit().expect("commit v2");
        }
        conn.execute(
            "INSERT INTO sessions (id, started_at, score) VALUES ('s1', 1, 90)",
            [],
        )
        .expect("insert session");
        assert_eq!(current_version(&conn), 2);

        let applied = run_migrations(&mut conn).expect("upgrade run");
        assert_eq!(applied, LATEST_VERSION);

        let (confident, skipped): (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT confident_samples, skipped_samples FROM sessions WHERE id = 's1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read counts");
        assert_eq!(confident, None, "pre-003 rows must read as unknown");
        assert_eq!(skipped, None);
    }

    // I83 acceptance: 004 runs cleanly on a database already at schema_version
    // 3 with a real session row, and that pre-migration row reads back a NULL
    // `ai_enabled` — "unknown", never a fabricated 0 that would let the report
    // claim AI was off in a session nobody recorded the setting for.
    #[test]
    fn upgrades_v3_db_to_v4_with_null_ai_enabled_on_old_rows() {
        let mut conn = Connection::open_in_memory().expect("open in-memory");
        {
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)",
                [],
            )
            .expect("schema_version");
            let tx = conn.transaction().expect("tx");
            tx.execute_batch(MIGRATION_001_INITIAL).expect("apply 001");
            tx.execute_batch(MIGRATION_002_V2).expect("apply 002");
            tx.execute_batch(MIGRATION_003_SAMPLE_COUNTS)
                .expect("apply 003");
            tx.execute(
                "INSERT INTO schema_version (version) VALUES (1), (2), (3)",
                [],
            )
            .expect("record v3");
            tx.commit().expect("commit v3");
        }
        conn.execute(
            "INSERT INTO sessions (id, started_at, score, confident_samples)
             VALUES ('s1', 1, 90, 24)",
            [],
        )
        .expect("insert session");
        assert_eq!(current_version(&conn), 3);

        let applied = run_migrations(&mut conn).expect("upgrade run");
        assert_eq!(applied, LATEST_VERSION);

        let (ai_enabled, confident): (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT ai_enabled, confident_samples FROM sessions WHERE id = 's1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read ai_enabled");
        assert_eq!(ai_enabled, None, "pre-004 rows must read as unknown");
        assert_eq!(confident, Some(24), "003 data must survive the 004 upgrade");
    }

    #[test]
    fn refuses_db_created_by_newer_version() {
        let mut conn = Connection::open_in_memory().expect("open in-memory");
        run_migrations(&mut conn).expect("first run");
        conn.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            [MAX_KNOWN_VERSION + 1],
        )
        .expect("record future version");
        let err = run_migrations(&mut conn).expect_err("must refuse a newer schema");
        assert!(
            matches!(err, MigrationError::NewerSchema { found } if found == MAX_KNOWN_VERSION + 1),
            "expected NewerSchema, got: {err}"
        );
    }

    #[test]
    fn second_run_preserves_existing_friend_rows() {
        let mut conn = Connection::open_in_memory().expect("open in-memory");
        run_migrations(&mut conn).expect("first run");
        conn.execute(
            "INSERT INTO friends (ed_pubkey_hex, x_pubkey_hex, display_name, paired_at)
             VALUES ('aa', 'bb', 'sam', 100)",
            [],
        )
        .expect("insert friend");
        run_migrations(&mut conn).expect("second run");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM friends", [], |row| row.get(0))
            .expect("count friends");
        assert_eq!(count, 1, "existing friends row should survive a re-run");
    }

    // The header's "never edit a shipped migration in place" rule had no
    // enforcement, and every test above is structurally blind to an in-place
    // edit: they simulate old databases by applying the SAME constants, so
    // editing 002 instead of adding 004 keeps this file green while fresh
    // installs and already-migrated friends' disks diverge — the app then
    // errors at some SELECT only on their machines. Pin the shipped bytes.
    //
    // Appending a NEW migration: add its hash here. Changing an EXISTING
    // hash is exactly the mistake this test exists to catch — write a new
    // migration instead. (Whitespace-only reformats of shipped .sql pay the
    // same toll on purpose.)
    #[test]
    fn shipped_migrations_are_immutable() {
        use sha2::{Digest, Sha256};
        // (version, sha256 of the CRLF-normalized file). Normalization is
        // belt-and-braces against a .gitattributes regression on Windows
        // checkouts (`* text=auto eol=lf` currently guarantees LF bytes).
        const PINNED: &[(u32, &str)] = &[
            (
                1,
                "d19c380c48d5986806f36eedd72332f2d96e57390ce92ed839fbffe51bc8300e",
            ),
            (
                2,
                "f01897d50e1d448a0995ace633c04c82b454c32c0e792a94964a81ae46031685",
            ),
            (
                3,
                "a1ef24581336a04ecb9f9636afe3d0c574d9e47072f88ffccd1ff3c9aefffa42",
            ),
            (
                4,
                "f394e5e3179254fafb8f682dac3b189687e7ff7c5200b0b280b75cd5a26607e3",
            ),
            (
                5,
                "e7b9b90e97796876ebaf157170a9c855133b30e99b28b770ec4a20b03d025e9b",
            ),
        ];
        assert_eq!(
            MIGRATIONS.len(),
            PINNED.len(),
            "a new migration needs its hash pinned here (never change an existing one)"
        );
        let mut previous_version = 0;
        for ((version, sql), (pinned_version, pinned_hash)) in MIGRATIONS.iter().zip(PINNED.iter())
        {
            assert_eq!(version, pinned_version, "migration order must be stable");
            assert!(
                *version > previous_version,
                "migration versions must be strictly ascending"
            );
            previous_version = *version;
            let normalized = sql.replace("\r\n", "\n");
            let digest = Sha256::digest(normalized.as_bytes());
            let hex = digest
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            assert_eq!(
                &hex, pinned_hash,
                "shipped migration {version} was edited in place — friends already \
                 at this schema version will never re-run it; add a new migration \
                 instead (see the module header)"
            );
        }
        assert_eq!(MAX_KNOWN_VERSION, previous_version);
    }
}
