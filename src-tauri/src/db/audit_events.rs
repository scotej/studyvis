use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};

// No `#[serde(rename_all)]`: serde serializes these fields verbatim, so the
// `*_list_*` commands return snake_case keys. The TS contract (AuditEventRecord
// in src/lib/db/audit.ts) mirrors them in snake_case — keep them aligned if you
// edit this struct (same convention as SessionRow ↔ SessionRecord).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEventRow {
    pub session_id: String,
    pub ts: i64,
    pub who: String,
    pub kind: String,
    // JSON-serialized detail object. Audit-event detail is constrained to
    // JSON-safe values on the wire (see src/features/session/audit.ts), so
    // round-tripping through TEXT preserves shape.
    pub detail: String,
    pub sig: String,
}

pub fn insert(conn: &Connection, row: &AuditEventRow) -> Result<()> {
    // Idempotent on `sig`: a verified event arriving twice (own-emit echo,
    // reconnect replay) is dropped at the SQLite layer too. The store-side
    // dedup catches it first, so this is belt-and-suspenders.
    conn.execute(
        "INSERT INTO audit_events (session_id, ts, who, kind, detail, sig)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE sig = ?6)",
        params![
            row.session_id,
            row.ts,
            row.who,
            row.kind,
            row.detail,
            row.sig,
        ],
    )?;
    Ok(())
}

pub fn list_for_session(conn: &Connection, session_id: &str) -> Result<Vec<AuditEventRow>> {
    let mut stmt = conn.prepare(
        "SELECT session_id, ts, who, kind, detail, sig
         FROM audit_events
         WHERE session_id = ?1
         ORDER BY ts ASC, id ASC",
    )?;
    let rows = stmt.query_map([session_id], |row| {
        Ok(AuditEventRow {
            session_id: row.get(0)?,
            ts: row.get(1)?,
            who: row.get(2)?,
            kind: row.get(3)?,
            detail: row.get(4)?,
            sig: row.get(5)?,
        })
    })?;
    rows.collect()
}

// R7 — every audit event across all sessions, for the cross-session focus
// insights view. Ordered by session then ts so the JS side can bucket each
// event against its own session without a second sort. The per-session
// `list_for_session` stays the report's source; this is the multi-session
// counterpart. Read-only and local, like the rest of this module.
pub fn list_all(conn: &Connection) -> Result<Vec<AuditEventRow>> {
    let mut stmt = conn.prepare(
        "SELECT session_id, ts, who, kind, detail, sig
         FROM audit_events
         ORDER BY session_id ASC, ts ASC, id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(AuditEventRow {
            session_id: row.get(0)?,
            ts: row.get(1)?,
            who: row.get(2)?,
            kind: row.get(3)?,
            detail: row.get(4)?,
            sig: row.get(5)?,
        })
    })?;
    rows.collect()
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

    fn sample(sig: &str) -> AuditEventRow {
        AuditEventRow {
            session_id: "topic-hex".into(),
            ts: 1_700_000_000_000,
            who: "ed-pubkey".into(),
            kind: "joined".into(),
            detail: "{}".into(),
            sig: sig.into(),
        }
    }

    #[test]
    fn insert_writes_a_row() {
        let conn = fresh();
        insert(&conn, &sample("aa")).expect("insert");
        let read = list_for_session(&conn, "topic-hex").expect("list");
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].sig, "aa");
        assert_eq!(read[0].kind, "joined");
    }

    #[test]
    fn insert_is_idempotent_on_sig() {
        let conn = fresh();
        insert(&conn, &sample("aa")).expect("insert 1");
        insert(&conn, &sample("aa")).expect("insert 2");
        let read = list_for_session(&conn, "topic-hex").expect("list");
        assert_eq!(
            read.len(),
            1,
            "duplicate sig should not produce a second row"
        );
    }

    #[test]
    fn list_for_session_filters_and_orders_by_ts() {
        let conn = fresh();
        insert(
            &conn,
            &AuditEventRow {
                ts: 200,
                sig: "later".into(),
                ..sample("later")
            },
        )
        .expect("insert later");
        insert(
            &conn,
            &AuditEventRow {
                ts: 100,
                sig: "earlier".into(),
                ..sample("earlier")
            },
        )
        .expect("insert earlier");
        insert(
            &conn,
            &AuditEventRow {
                session_id: "other-topic".into(),
                ts: 50,
                sig: "other".into(),
                ..sample("other")
            },
        )
        .expect("insert other");
        let read = list_for_session(&conn, "topic-hex").expect("list");
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].sig, "earlier");
        assert_eq!(read[1].sig, "later");
    }

    #[test]
    fn list_all_returns_every_session_ordered_by_session_then_ts() {
        let conn = fresh();
        insert(
            &conn,
            &AuditEventRow {
                session_id: "topic-b".into(),
                ts: 100,
                sig: "b1".into(),
                ..sample("b1")
            },
        )
        .expect("insert b1");
        insert(
            &conn,
            &AuditEventRow {
                session_id: "topic-a".into(),
                ts: 300,
                sig: "a2".into(),
                ..sample("a2")
            },
        )
        .expect("insert a2");
        insert(
            &conn,
            &AuditEventRow {
                session_id: "topic-a".into(),
                ts: 200,
                sig: "a1".into(),
                ..sample("a1")
            },
        )
        .expect("insert a1");
        let read = list_all(&conn).expect("list all");
        assert_eq!(
            read.iter().map(|r| r.sig.as_str()).collect::<Vec<_>>(),
            vec!["a1", "a2", "b1"]
        );
    }

    #[test]
    fn list_all_is_empty_with_no_rows() {
        let conn = fresh();
        assert!(list_all(&conn).expect("list all").is_empty());
    }
}
