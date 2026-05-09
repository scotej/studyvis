use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRow {
    pub id: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub total_minutes: i64,
}

pub fn insert(conn: &Connection, row: &SessionRow) -> Result<()> {
    // V1-P8 stores only the placeholder fields; declared_topic + score arrive
    // with the V2 report shape, peer_pubkeys arrives with the V1-P9 audit log.
    conn.execute(
        "INSERT INTO sessions (id, started_at, ended_at, total_minutes)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
             started_at    = excluded.started_at,
             ended_at      = excluded.ended_at,
             total_minutes = excluded.total_minutes",
        params![row.id, row.started_at, row.ended_at, row.total_minutes],
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
        };
        insert(&conn, &row).expect("insert");
        let read: (String, i64, i64, Option<i64>) = conn
            .query_row(
                "SELECT id, started_at, ended_at, total_minutes FROM sessions WHERE id = ?1",
                ["topic-hex"],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .expect("select");
        assert_eq!(read.0, "topic-hex");
        assert_eq!(read.1, 1_700_000_000_000);
        assert_eq!(read.2, 1_700_000_300_000);
        assert_eq!(read.3, Some(5));
    }

    #[test]
    fn insert_upserts_on_conflicting_id() {
        let conn = fresh();
        let mut row = SessionRow {
            id: "topic-hex".into(),
            started_at: 1,
            ended_at: 2,
            total_minutes: 0,
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
}
