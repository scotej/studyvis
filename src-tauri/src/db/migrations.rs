use rusqlite::{Connection, Result};

const MIGRATION_001_INITIAL: &str = include_str!("migrations/001_initial.sql");

const MIGRATIONS: &[(u32, &str)] = &[(1, MIGRATION_001_INITIAL)];

pub fn run_migrations(conn: &mut Connection) -> Result<u32> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)",
        [],
    )?;

    let current: u32 = conn
        .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
            row.get::<_, Option<u32>>(0)
        })?
        .unwrap_or(0);

    let tx = conn.transaction()?;
    let mut applied = current;
    for (version, sql) in MIGRATIONS.iter().copied() {
        if version > applied {
            tx.execute_batch(sql)?;
            tx.execute(
                "INSERT INTO schema_version (version) VALUES (?1)",
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

    #[test]
    fn applies_initial_schema_on_empty_db() {
        let mut conn = Connection::open_in_memory().expect("open in-memory");
        let applied = run_migrations(&mut conn).expect("run migrations");
        assert_eq!(applied, 1);
        assert_table_exists(&conn, "schema_version");
        assert_table_exists(&conn, "friends");
        assert_table_exists(&conn, "sessions");
        assert_table_exists(&conn, "audit_events");
        assert_eq!(current_version(&conn), 1);
    }

    #[test]
    fn second_run_is_a_noop_on_same_connection() {
        let mut conn = Connection::open_in_memory().expect("open in-memory");
        run_migrations(&mut conn).expect("first run");
        let applied = run_migrations(&mut conn).expect("second run");
        assert_eq!(applied, 1);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_version", [], |row| row.get(0))
            .expect("count schema_version rows");
        assert_eq!(rows, 1, "no duplicate version row should be inserted");
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
