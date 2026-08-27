//! `session_timelines` table queries (#236) — the written narrative the local
//! model produced from a session's raw AI observation journal after it ended.
//!
//! One row per session, replaced wholesale on every regeneration. Rows are
//! deleted only through the session cascade in `sessions.rs`; the raw journal
//! file that fed them is removed alongside it by `commands::session_journal`.

use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};

// Serialized verbatim (no `rename_all`), so `session_timeline_get` returns
// snake_case keys. Mirrored by SessionTimelineRecord in
// src/lib/db/sessionTimeline.ts — keep the two aligned.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionTimelineRow {
    pub session_id: String,
    pub generated_at: i64,
    /// Model that wrote the narrative; NULL when every window fell back to the
    /// deterministic digest and no model output was used.
    pub model_id: Option<String>,
    /// 'model' | 'mixed' | 'observations' — see 008_session_timelines.sql.
    pub source: String,
    /// JSON array of `{ start_min, end_min, summary }` objects.
    pub entries: String,
    /// 1 when the journal held more than the write-up covers.
    pub truncated: i64,
}

pub fn get(conn: &Connection, session_id: &str) -> Result<Option<SessionTimelineRow>> {
    let mut stmt = conn.prepare(
        "SELECT session_id, generated_at, model_id, source, entries, truncated
         FROM session_timelines
         WHERE session_id = ?1",
    )?;
    let mut rows = stmt.query_map([session_id], |row| {
        Ok(SessionTimelineRow {
            session_id: row.get(0)?,
            generated_at: row.get(1)?,
            model_id: row.get(2)?,
            source: row.get(3)?,
            entries: row.get(4)?,
            truncated: row.get(5)?,
        })
    })?;
    rows.next().transpose()
}

/// Regeneration replaces the stored narrative rather than accumulating rows:
/// a rejoined session ends twice, and the second write-up spans both stints.
pub fn upsert(conn: &Connection, row: &SessionTimelineRow) -> Result<()> {
    conn.execute(
        "INSERT INTO session_timelines (session_id, generated_at, model_id, source, entries, truncated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(session_id) DO UPDATE SET
           generated_at = excluded.generated_at,
           model_id     = excluded.model_id,
           source       = excluded.source,
           entries      = excluded.entries,
           truncated    = excluded.truncated",
        params![
            row.session_id,
            row.generated_at,
            row.model_id,
            row.source,
            row.entries,
            row.truncated,
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

    fn row(session_id: &str, source: &str, entries: &str) -> SessionTimelineRow {
        SessionTimelineRow {
            session_id: session_id.to_string(),
            generated_at: 1_700_000_000_000,
            model_id: Some("gemma-3-4b".to_string()),
            source: source.to_string(),
            entries: entries.to_string(),
            truncated: 0,
        }
    }

    #[test]
    fn get_returns_none_for_a_session_without_a_timeline() {
        let conn = fresh();
        assert!(get(&conn, "missing").expect("get").is_none());
    }

    #[test]
    fn upsert_then_get_round_trips() {
        let conn = fresh();
        let written = row(
            "s1",
            "model",
            r#"[{"start_min":0,"end_min":2,"summary":"Wrote tests"}]"#,
        );
        upsert(&conn, &written).expect("upsert");
        let read = get(&conn, "s1").expect("get").expect("row");
        assert_eq!(read.session_id, "s1");
        assert_eq!(read.source, "model");
        assert_eq!(read.entries, written.entries);
        assert_eq!(read.model_id.as_deref(), Some("gemma-3-4b"));
        assert_eq!(read.truncated, 0);
    }

    #[test]
    fn upsert_replaces_a_previous_narrative_for_the_same_session() {
        let conn = fresh();
        upsert(&conn, &row("s1", "observations", "[]")).expect("first");
        upsert(
            &conn,
            &row(
                "s1",
                "model",
                r#"[{"start_min":0,"end_min":1,"summary":"Read"}]"#,
            ),
        )
        .expect("second");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM session_timelines", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1, "regeneration replaces rather than accumulates");
        let read = get(&conn, "s1").expect("get").expect("row");
        assert_eq!(read.source, "model");
    }
}
