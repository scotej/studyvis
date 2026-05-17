use rusqlite::{Connection, Result, TransactionBehavior};

const MIGRATION_001_INITIAL: &str = include_str!("migrations/001_initial.sql");
const MIGRATION_002_V2: &str = include_str!("migrations/002_v2.sql");

const MIGRATIONS: &[(u32, &str)] = &[(1, MIGRATION_001_INITIAL), (2, MIGRATION_002_V2)];

pub fn run_migrations(conn: &mut Connection) -> Result<u32> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)",
        [],
    )?;

    // IMMEDIATE acquires the write lock at BEGIN, so a concurrent
    // first-launch (no single-instance plugin) blocks here and reads the
    // version AFTER the other process committed — instead of both reading 0
    // and double-applying. `IF NOT EXISTS` on 001's DDL + `INSERT OR IGNORE`
    // make a lost race idempotent rather than a panic.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current: u32 = tx
        .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
            row.get::<_, Option<u32>>(0)
        })?
        .unwrap_or(0);
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

    const LATEST_VERSION: u32 = 2;

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
}
