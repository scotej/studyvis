use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRow {
    pub id: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub total_minutes: i64,
    // JSON-array string of ed_pubkey_hex values observed via signed-hello in
    // the session, sorted lexicographically. NULL when no hello arrived.
    pub peer_pubkeys: Option<String>,
}

pub fn list(conn: &Connection) -> Result<Vec<SessionRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, started_at, ended_at, total_minutes, peer_pubkeys
         FROM sessions
         ORDER BY started_at DESC, id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SessionRow {
            id: row.get(0)?,
            started_at: row.get(1)?,
            ended_at: row.get(2)?,
            total_minutes: row.get(3)?,
            peer_pubkeys: row.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn insert(conn: &Connection, row: &SessionRow) -> Result<()> {
    // V1-P8 stored only the placeholder fields; V1-P9 added peer_pubkeys
    // (from the signed-hello binding). declared_topic + score arrive with
    // the V2 report shape.
    conn.execute(
        "INSERT INTO sessions (id, started_at, ended_at, total_minutes, peer_pubkeys)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
             started_at    = excluded.started_at,
             ended_at      = excluded.ended_at,
             total_minutes = excluded.total_minutes,
             peer_pubkeys  = COALESCE(excluded.peer_pubkeys, sessions.peer_pubkeys)",
        params![
            row.id,
            row.started_at,
            row.ended_at,
            row.total_minutes,
            row.peer_pubkeys,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn fresh() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open in-memory");
        migrations::run_migrations(&mut conn).expect("migrations");
        conn
    }

    #[test]
    fn insert_writes_a_row_with_expected_columns() {
        let conn = fresh();
        let row = SessionRow {
            id: "topic-hex".into(),
            started_at: 1_700_000_000_000,
            ended_at: 1_700_000_300_000,
            total_minutes: 5,
            peer_pubkeys: Some("[\"aa\",\"bb\"]".into()),
        };
        insert(&conn, &row).expect("insert");
        let read: (String, i64, i64, Option<i64>, Option<String>) = conn
            .query_row(
                "SELECT id, started_at, ended_at, total_minutes, peer_pubkeys FROM sessions WHERE id = ?1",
                ["topic-hex"],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .expect("select");
        assert_eq!(read.0, "topic-hex");
        assert_eq!(read.1, 1_700_000_000_000);
        assert_eq!(read.2, 1_700_000_300_000);
        assert_eq!(read.3, Some(5));
        assert_eq!(read.4.as_deref(), Some("[\"aa\",\"bb\"]"));
    }

    #[test]
    fn insert_upserts_on_conflicting_id() {
        let conn = fresh();
        let mut row = SessionRow {
            id: "topic-hex".into(),
            started_at: 1,
            ended_at: 2,
            total_minutes: 0,
            peer_pubkeys: None,
        };
        insert(&conn, &row).expect("insert 1");
        row.ended_at = 99;
        row.total_minutes = 1;
        insert(&conn, &row).expect("insert 2");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1);
        let ended: i64 = conn
            .query_row(
                "SELECT ended_at FROM sessions WHERE id = ?1",
                ["topic-hex"],
                |r| r.get(0),
            )
            .expect("read ended_at");
        assert_eq!(ended, 99);
    }

    #[test]
    fn list_orders_by_started_at_desc() {
        let conn = fresh();
        insert(
            &conn,
            &SessionRow {
                id: "older".into(),
                started_at: 100,
                ended_at: 200,
                total_minutes: 1,
                peer_pubkeys: None,
            },
        )
        .expect("insert older");
        insert(
            &conn,
            &SessionRow {
                id: "newer".into(),
                started_at: 300,
                ended_at: 400,
                total_minutes: 1,
                peer_pubkeys: None,
            },
        )
        .expect("insert newer");
        let read = list(&conn).expect("list");
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].id, "newer");
        assert_eq!(read[1].id, "older");
    }

    #[test]
    fn insert_preserves_peer_pubkeys_when_subsequent_upsert_omits_them() {
        // First insert carries the JSON array (e.g. session ended via the
        // local leave-handler after hellos arrived). A subsequent upsert
        // (e.g. an idempotent leave) without the column must NOT clobber
        // the previously-stored bindings; COALESCE on excluded.peer_pubkeys
        // keeps them.
        let conn = fresh();
        let row = SessionRow {
            id: "topic-hex".into(),
            started_at: 1,
            ended_at: 2,
            total_minutes: 0,
            peer_pubkeys: Some("[\"aa\"]".into()),
        };
        insert(&conn, &row).expect("insert 1");
        let again = SessionRow {
            id: "topic-hex".into(),
            started_at: 1,
            ended_at: 9,
            total_minutes: 0,
            peer_pubkeys: None,
        };
        insert(&conn, &again).expect("insert 2");
        let kept: Option<String> = conn
            .query_row(
                "SELECT peer_pubkeys FROM sessions WHERE id = ?1",
                ["topic-hex"],
                |r| r.get(0),
            )
            .expect("read peer_pubkeys");
        assert_eq!(kept.as_deref(), Some("[\"aa\"]"));
    }
}
