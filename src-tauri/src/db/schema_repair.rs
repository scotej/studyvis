//! Additive convergence pass for a database whose table shape predates a
//! column this build's queries name.
//!
//! `migrations.rs` is version-keyed: a file only ever runs when the DB's
//! recorded `schema_version` is below it. That is correct for *appending*
//! migrations and wrong for one edited in place, because the version on disk
//! already says "applied". 001_initial.sql was amended twice before release
//! (V2-P8 added `sessions.focused_pct` + `sessions.generated_at` on
//! 2026-05-11, three days after the file was born), so every database created
//! in that window sits at version 1 with a `sessions` table missing those two
//! columns. 002 and 003 then apply normally and leave it at version 3 —
//! outwardly current, permanently short two columns.
//!
//! The blast radius is total for that table: `sessions::list`, `get` and
//! `insert` all name every column, so each fails with `no such column:
//! focused_pct`. Settings → Sessions and Settings → Stats show their load
//! error, no session is ever recorded, and no post-session report renders,
//! while friends / identity / audit events keep working — the `friends`
//! amendment only ever REMOVED a column, which SQLite tolerates. (Issue #99.)
//!
//! `migrations::shipped_migrations_are_immutable` now stops the next in-place
//! edit; this closes the DBs already diverged by the two that predate it. The
//! repair is additive only — `ALTER TABLE ADD COLUMN` for what is missing,
//! never a drop, a rewrite, or a type change — so it cannot lose data, and it
//! is a no-op on every healthy database.

use std::collections::HashSet;

use rusqlite::{Connection, Result, TransactionBehavior};

/// Every table this build queries, with the columns its statements name.
///
/// The type is the ALTER-safe bare affinity, NOT the birth DDL's full
/// declaration: SQLite refuses to add a PRIMARY KEY column, and a NOT NULL
/// column without a default, retroactively. Neither is a limitation in
/// practice — a constrained column is part of its table's `CREATE`, so it
/// exists in every database that has the table at all, and only later,
/// nullable additions can ever go missing.
///
/// Keep in lockstep with `migrations/*.sql`; the module's
/// `expected_schema_matches_a_freshly_migrated_database` test fails when a new
/// migration adds a column this list doesn't.
const EXPECTED_SCHEMA: &[(&str, &[(&str, &str)])] = &[
    (
        "friends",
        &[
            ("ed_pubkey_hex", "TEXT"),
            ("x_pubkey_hex", "TEXT"),
            ("display_name", "TEXT"),
            ("paired_at", "INTEGER"),
            ("last_studied_with", "INTEGER"),
        ],
    ),
    (
        "sessions",
        &[
            ("id", "TEXT"),
            ("started_at", "INTEGER"),
            ("ended_at", "INTEGER"),
            ("peer_pubkeys", "TEXT"),
            ("total_minutes", "INTEGER"),
            ("declared_topic", "TEXT"),
            ("score", "INTEGER"),
            ("focused_pct", "REAL"),
            ("generated_at", "INTEGER"),
            ("confident_samples", "INTEGER"),
            ("skipped_samples", "INTEGER"),
            ("ai_enabled", "INTEGER"),
            ("local_ed_pubkey", "TEXT"),
            ("local_display_name", "TEXT"),
        ],
    ),
    (
        "audit_events",
        &[
            ("id", "INTEGER"),
            ("session_id", "TEXT"),
            ("ts", "INTEGER"),
            ("who", "TEXT"),
            ("kind", "TEXT"),
            ("detail", "TEXT"),
            ("sig", "TEXT"),
        ],
    ),
    (
        "models",
        &[
            ("id", "TEXT"),
            ("model_path", "TEXT"),
            ("mmproj_path", "TEXT"),
            ("p50_ms", "INTEGER"),
            ("p95_ms", "INTEGER"),
            ("sample_interval_s", "INTEGER"),
            ("last_benchmarked_at", "INTEGER"),
        ],
    ),
];

fn columns_of(conn: &Connection, table: &str) -> Result<HashSet<String>> {
    // PRAGMA takes no bind parameters, and `table` is a literal from
    // EXPECTED_SCHEMA above — never user input — so formatting it in is safe.
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    rows.collect()
}

/// Adds every column in `EXPECTED_SCHEMA` that the database is missing, and
/// returns them as `table.column` for the caller to log. Empty on a healthy
/// database, which is the overwhelmingly common case.
///
/// A table that doesn't exist at all is skipped rather than created: every
/// table is born in a migration whose `CREATE TABLE IF NOT EXISTS` runs for
/// any database below that version, so an absent table means something no
/// additive pass should paper over.
pub fn reconcile_schema(conn: &mut Connection) -> Result<Vec<String>> {
    // IMMEDIATE for the same reason run_migrations uses it: take the write
    // lock up front so a second process that slipped past the single-instance
    // guard blocks here instead of racing us to the same ALTER.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut added: Vec<String> = Vec::new();
    for (table, columns) in EXPECTED_SCHEMA.iter().copied() {
        let present = columns_of(&tx, table)?;
        if present.is_empty() {
            continue;
        }
        for (column, decl) in columns.iter().copied() {
            if present.contains(column) {
                continue;
            }
            let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {decl}");
            tx.execute(&sql, [])?;
            added.push(format!("{table}.{column}"));
        }
    }
    tx.commit()?;
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::audit_events::{self, AuditEventRow};
    use crate::db::migrations;
    use crate::db::sessions::{self, SessionRow};

    // The `sessions` DDL exactly as 001_initial.sql shipped it on 2026-05-09
    // (commit 1329305, V1-P4), before V2-P8 amended the file in place. This
    // literal is the whole point of the test suite below: it must NOT be
    // rewritten to today's shape, because it is the historical artifact the
    // repair exists for.
    const V1_P4_SESSIONS_DDL: &str = "CREATE TABLE sessions (
            id             TEXT PRIMARY KEY,
            started_at     INTEGER,
            ended_at       INTEGER,
            peer_pubkeys   TEXT,
            total_minutes  INTEGER,
            declared_topic TEXT,
            score          INTEGER
        );";

    // A database as a machine that ran the 2026-05-09 build would have left
    // it: the old sessions table, version 1 recorded, then every later
    // migration applied on top by a current binary.
    fn legacy_v1_db() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open in-memory");
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)",
            [],
        )
        .expect("schema_version");
        conn.execute_batch(V1_P4_SESSIONS_DDL).expect("v1 sessions");
        conn.execute_batch(
            "CREATE TABLE friends (
                 ed_pubkey_hex     TEXT PRIMARY KEY,
                 x_pubkey_hex      TEXT NOT NULL,
                 display_name      TEXT,
                 paired_at         INTEGER,
                 last_studied_with INTEGER
             );
             CREATE TABLE audit_events (
                 id         INTEGER PRIMARY KEY AUTOINCREMENT,
                 session_id TEXT,
                 ts         INTEGER,
                 who        TEXT,
                 kind       TEXT,
                 detail     TEXT,
                 sig        TEXT
             );",
        )
        .expect("v1 siblings");
        conn.execute("INSERT INTO schema_version (version) VALUES (1)", [])
            .expect("record v1");
        migrations::run_migrations(&mut conn).expect("later migrations");
        conn
    }

    fn column_names(conn: &Connection, table: &str) -> HashSet<String> {
        columns_of(conn, table).expect("table_info")
    }

    #[test]
    fn legacy_v1_database_is_missing_the_columns_the_queries_name() {
        // Pins the defect itself: without the repair, a database in this
        // state fails every sessions query, which is what issue #99 reported.
        let conn = legacy_v1_db();
        let present = column_names(&conn, "sessions");
        assert!(!present.contains("focused_pct"));
        assert!(!present.contains("generated_at"));
        assert!(
            sessions::list(&conn).is_err(),
            "issue #99: every read fails"
        );
    }

    #[test]
    fn repair_makes_a_legacy_database_readable_and_writable_again() {
        let mut conn = legacy_v1_db();
        let added = reconcile_schema(&mut conn).expect("reconcile");
        assert_eq!(added, ["sessions.focused_pct", "sessions.generated_at"]);

        let row = SessionRow {
            id: "topic-hex".into(),
            started_at: Some(1_700_000_000_000),
            ended_at: Some(1_700_000_300_000),
            total_minutes: Some(5),
            peer_pubkeys: None,
            declared_topic: Some("Calculus".into()),
            score: Some(88),
            focused_pct: Some(0.91),
            generated_at: Some(1_700_000_300_500),
            confident_samples: Some(20),
            skipped_samples: Some(1),
            ai_enabled: Some(1),
            local_ed_pubkey: None,
            local_display_name: None,
        };
        sessions::insert(&conn, &row).expect("insert after repair");
        let read = sessions::list(&conn).expect("list after repair");
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].focused_pct, Some(0.91));
        assert_eq!(read[0].generated_at, Some(1_700_000_300_500));
    }

    #[test]
    fn repair_preserves_rows_written_before_it() {
        let mut conn = legacy_v1_db();
        conn.execute(
            "INSERT INTO sessions (id, started_at, total_minutes, declared_topic, score)
             VALUES ('old', 1, 42, 'Calculus', 77)",
            [],
        )
        .expect("legacy row");
        reconcile_schema(&mut conn).expect("reconcile");
        let read = sessions::get(&conn, "old").expect("get").expect("present");
        assert_eq!(read.total_minutes, Some(42));
        assert_eq!(read.declared_topic.as_deref(), Some("Calculus"));
        assert_eq!(read.score, Some(77));
        // The columns the repair added read as "unknown", not zero — the same
        // contract 003 gave pre-migration rows.
        assert_eq!(read.focused_pct, None);
        assert_eq!(read.generated_at, None);
    }

    // The happy consequence of WHERE this pass runs. `audit_events` was never
    // part of the divergence, so a machine that could not write a single
    // sessions row was still recording every join / leave / alert. Those rows
    // are precisely what `synthesize_from_orphaned_audit_events` (db::init
    // runs it straight after open_and_migrate, so after this repair) adopts —
    // which means the first launch on a fixed build doesn't start the user's
    // history at zero, it hands back the sessions they thought they'd lost.
    #[test]
    fn repair_lets_boot_adopt_the_history_the_broken_schema_never_wrote() {
        let mut conn = legacy_v1_db();
        let me = "aa".repeat(32);
        let friend = "bb".repeat(32);
        for (ts, who) in [(1_700_000_000_000, &me), (1_700_001_800_000, &friend)] {
            let row = AuditEventRow {
                session_id: "lost-topic".into(),
                ts,
                who: who.clone(),
                kind: "joined".into(),
                detail: "{}".into(),
                sig: format!("sig-{ts}"),
            };
            audit_events::insert(&conn, &row).expect("audit row");
        }
        // Before the repair the adoption cannot even write its row.
        let blocked = sessions::synthesize_from_orphaned_audit_events(&mut conn, Some(&me));
        assert!(blocked.is_err(), "issue #99: every write fails too");

        reconcile_schema(&mut conn).expect("reconcile");
        let adopted = sessions::synthesize_from_orphaned_audit_events(&mut conn, Some(&me));
        assert_eq!(adopted.expect("synthesize"), 1);
        let read = sessions::list(&conn).expect("list");
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].id, "lost-topic");
        assert_eq!(read[0].total_minutes, Some(30));
        assert_eq!(read[0].peer_pubkeys, Some(format!("[\"{friend}\"]")));
    }

    #[test]
    fn repair_is_a_noop_on_a_freshly_migrated_database() {
        let mut conn = Connection::open_in_memory().expect("open in-memory");
        migrations::run_migrations(&mut conn).expect("migrations");
        assert!(reconcile_schema(&mut conn).expect("reconcile").is_empty());
    }

    #[test]
    fn repair_is_idempotent() {
        let mut conn = legacy_v1_db();
        assert_eq!(reconcile_schema(&mut conn).expect("first").len(), 2);
        assert!(reconcile_schema(&mut conn).expect("second").is_empty());
    }

    // Drift guard. EXPECTED_SCHEMA is a hand-written mirror of the migration
    // chain, and a column added by a future migration but forgotten here
    // would leave exactly the hole this module exists to fill. Compare it
    // against what the migrations actually produce, both directions.
    #[test]
    fn expected_schema_matches_a_freshly_migrated_database() {
        let mut conn = Connection::open_in_memory().expect("open in-memory");
        migrations::run_migrations(&mut conn).expect("migrations");

        let mut listed: HashSet<String> = HashSet::new();
        for (table, columns) in EXPECTED_SCHEMA.iter().copied() {
            listed.insert(table.to_string());
            let actual = column_names(&conn, table);
            assert!(!actual.is_empty(), "`{table}` is not a migrated table");
            let expected: HashSet<String> =
                columns.iter().map(|(name, _)| name.to_string()).collect();
            assert_eq!(expected, actual, "column drift in `{table}`");
        }

        let sql = "SELECT name FROM sqlite_master WHERE type = 'table'";
        let mut stmt = conn.prepare(sql).expect("prepare");
        let tables: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query")
            .collect::<Result<Vec<_>>>()
            .expect("collect");
        for table in tables {
            if table.starts_with("sqlite_") || table == "schema_version" {
                continue;
            }
            assert!(listed.contains(&table), "`{table}` is unlisted");
        }
    }
}
