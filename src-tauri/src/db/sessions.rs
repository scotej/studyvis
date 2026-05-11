use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};

// All numeric columns are NULLable in 001_initial.sql; insert() always writes
// Some(...) for the V1 lifecycle fields, but a SELECT path that hit a NULL
// row would panic on `row.get::<_, i64>(...)`. V2-P8 added the report fields
// (declared_topic, score, focused_pct, generated_at) which are NULL until the
// post-session report runs; the struct keeps every field optional so list()
// is panic-free for partial rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRow {
    pub id: String,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub total_minutes: Option<i64>,
    // JSON-array string of ed_pubkey_hex values observed via signed-hello in
    // the session, sorted lexicographically. NULL when no hello arrived.
    pub peer_pubkeys: Option<String>,
    pub declared_topic: Option<String>,
    pub score: Option<i64>,
    pub focused_pct: Option<f64>,
    pub generated_at: Option<i64>,
}

pub fn list(conn: &Connection) -> Result<Vec<SessionRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, started_at, ended_at, total_minutes, peer_pubkeys,
                declared_topic, score, focused_pct, generated_at
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
            declared_topic: row.get(5)?,
            score: row.get(6)?,
            focused_pct: row.get(7)?,
            generated_at: row.get(8)?,
        })
    })?;
    rows.collect()
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<SessionRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, started_at, ended_at, total_minutes, peer_pubkeys,
                declared_topic, score, focused_pct, generated_at
         FROM sessions
         WHERE id = ?1",
    )?;
    stmt.query_row([id], |row| {
        Ok(SessionRow {
            id: row.get(0)?,
            started_at: row.get(1)?,
            ended_at: row.get(2)?,
            total_minutes: row.get(3)?,
            peer_pubkeys: row.get(4)?,
            declared_topic: row.get(5)?,
            score: row.get(6)?,
            focused_pct: row.get(7)?,
            generated_at: row.get(8)?,
        })
    })
    .optional()
}

pub fn insert(conn: &Connection, row: &SessionRow) -> Result<()> {
    // COALESCE on the optional report columns so a leave-handler upsert that
    // omits them (e.g. a V1-style session insert before the report fields
    // were populated) does not clobber values written by an earlier call.
    // Mirrors the pre-existing peer_pubkeys behavior so partial upserts are
    // additive across the lifetime of a session row.
    conn.execute(
        "INSERT INTO sessions
             (id, started_at, ended_at, total_minutes, peer_pubkeys,
              declared_topic, score, focused_pct, generated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
             started_at     = excluded.started_at,
             ended_at       = excluded.ended_at,
             total_minutes  = excluded.total_minutes,
             peer_pubkeys   = COALESCE(excluded.peer_pubkeys, sessions.peer_pubkeys),
             declared_topic = COALESCE(excluded.declared_topic, sessions.declared_topic),
             score          = COALESCE(excluded.score, sessions.score),
             focused_pct    = COALESCE(excluded.focused_pct, sessions.focused_pct),
             generated_at   = COALESCE(excluded.generated_at, sessions.generated_at)",
        params![
            row.id,
            row.started_at,
            row.ended_at,
            row.total_minutes,
            row.peer_pubkeys,
            row.declared_topic,
            row.score,
            row.focused_pct,
            row.generated_at,
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

    fn lifecycle_row(id: &str) -> SessionRow {
        SessionRow {
            id: id.into(),
            started_at: Some(1_700_000_000_000),
            ended_at: Some(1_700_000_300_000),
            total_minutes: Some(5),
            peer_pubkeys: Some("[\"aa\",\"bb\"]".into()),
            declared_topic: None,
            score: None,
            focused_pct: None,
            generated_at: None,
        }
    }

    #[test]
    fn insert_writes_a_row_with_expected_columns() {
        let conn = fresh();
        insert(&conn, &lifecycle_row("topic-hex")).expect("insert");
        let read = get(&conn, "topic-hex").expect("get").expect("present");
        assert_eq!(read.id, "topic-hex");
        assert_eq!(read.started_at, Some(1_700_000_000_000));
        assert_eq!(read.ended_at, Some(1_700_000_300_000));
        assert_eq!(read.total_minutes, Some(5));
        assert_eq!(read.peer_pubkeys.as_deref(), Some("[\"aa\",\"bb\"]"));
    }

    #[test]
    fn insert_upserts_on_conflicting_id() {
        let conn = fresh();
        let mut row = lifecycle_row("topic-hex");
        row.ended_at = Some(2);
        row.total_minutes = Some(0);
        insert(&conn, &row).expect("insert 1");
        row.ended_at = Some(99);
        row.total_minutes = Some(1);
        insert(&conn, &row).expect("insert 2");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1);
        let read = get(&conn, "topic-hex").expect("get").expect("present");
        assert_eq!(read.ended_at, Some(99));
    }

    #[test]
    fn list_orders_by_started_at_desc() {
        let conn = fresh();
        let mut older = lifecycle_row("older");
        older.started_at = Some(100);
        older.ended_at = Some(200);
        older.total_minutes = Some(1);
        older.peer_pubkeys = None;
        insert(&conn, &older).expect("insert older");
        let mut newer = lifecycle_row("newer");
        newer.started_at = Some(300);
        newer.ended_at = Some(400);
        newer.total_minutes = Some(1);
        newer.peer_pubkeys = None;
        insert(&conn, &newer).expect("insert newer");
        let read = list(&conn).expect("list");
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].id, "newer");
        assert_eq!(read[1].id, "older");
    }

    #[test]
    fn list_tolerates_null_columns() {
        let conn = fresh();
        conn.execute(
            "INSERT INTO sessions (id) VALUES ('partial')",
            [],
        )
        .expect("raw insert");
        let read = list(&conn).expect("list");
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].id, "partial");
        assert_eq!(read[0].started_at, None);
        assert_eq!(read[0].ended_at, None);
        assert_eq!(read[0].total_minutes, None);
        assert_eq!(read[0].peer_pubkeys, None);
        assert_eq!(read[0].declared_topic, None);
        assert_eq!(read[0].score, None);
        assert_eq!(read[0].focused_pct, None);
        assert_eq!(read[0].generated_at, None);
    }

    #[test]
    fn insert_preserves_peer_pubkeys_when_subsequent_upsert_omits_them() {
        let conn = fresh();
        let row = SessionRow {
            id: "topic-hex".into(),
            started_at: Some(1),
            ended_at: Some(2),
            total_minutes: Some(0),
            peer_pubkeys: Some("[\"aa\"]".into()),
            declared_topic: None,
            score: None,
            focused_pct: None,
            generated_at: None,
        };
        insert(&conn, &row).expect("insert 1");
        let again = SessionRow {
            id: "topic-hex".into(),
            started_at: Some(1),
            ended_at: Some(9),
            total_minutes: Some(0),
            peer_pubkeys: None,
            declared_topic: None,
            score: None,
            focused_pct: None,
            generated_at: None,
        };
        insert(&conn, &again).expect("insert 2");
        let read = get(&conn, "topic-hex").expect("get").expect("present");
        assert_eq!(read.peer_pubkeys.as_deref(), Some("[\"aa\"]"));
    }

    #[test]
    fn report_fields_round_trip_and_persist_across_upserts() {
        // First upsert is the V1-style lifecycle insert without report fields.
        // The follow-up "report-generator" upsert layers score / focused_pct /
        // declared_topic / generated_at on top without clobbering started_at
        // or peer_pubkeys, and a later idempotent lifecycle replay must NOT
        // erase the report fields.
        let conn = fresh();
        insert(&conn, &lifecycle_row("topic-hex")).expect("insert lifecycle");
        let report_row = SessionRow {
            id: "topic-hex".into(),
            started_at: Some(1_700_000_000_000),
            ended_at: Some(1_700_000_300_000),
            total_minutes: Some(5),
            peer_pubkeys: None,
            declared_topic: Some("Studying".into()),
            score: Some(87),
            focused_pct: Some(0.91),
            generated_at: Some(1_700_000_300_500),
        };
        insert(&conn, &report_row).expect("insert report");
        let read = get(&conn, "topic-hex").expect("get").expect("present");
        assert_eq!(read.declared_topic.as_deref(), Some("Studying"));
        assert_eq!(read.score, Some(87));
        assert_eq!(read.focused_pct, Some(0.91));
        assert_eq!(read.generated_at, Some(1_700_000_300_500));
        assert_eq!(read.peer_pubkeys.as_deref(), Some("[\"aa\",\"bb\"]"));

        // Replay the lifecycle upsert; report fields stay populated.
        insert(&conn, &lifecycle_row("topic-hex")).expect("insert lifecycle replay");
        let read = get(&conn, "topic-hex").expect("get").expect("present");
        assert_eq!(read.declared_topic.as_deref(), Some("Studying"));
        assert_eq!(read.score, Some(87));
        assert_eq!(read.focused_pct, Some(0.91));
        assert_eq!(read.generated_at, Some(1_700_000_300_500));
    }

    #[test]
    fn get_returns_none_for_unknown_id() {
        let conn = fresh();
        let read = get(&conn, "nope").expect("get");
        assert!(read.is_none());
    }
}
