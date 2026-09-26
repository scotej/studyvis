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
///
/// I100 — the write is conditional on the session still existing. A write-up is
/// a minutes-long local-model pass that the report deliberately detaches on
/// unmount, holding the journal it already read in memory, so unlinking that
/// journal cannot stop it. Without this guard, deleting a session while its
/// write-up was running let the finished pass insert the narrative back
/// afterwards: a row for a session the user had asked us to forget, reachable
/// from no report and removable only by clear-all. `sessions_delete` orders its
/// own work so a failure can only ever orphan a journal, never a narrative
/// whose evidence is gone; this is the same invariant seen from the other side.
///
/// Returns whether a row was written, so a caller can tell "stored" from
/// "the session went away underneath it".
///
/// The `WHERE` is also what makes this parse: SQLite cannot tell an UPSERT's
/// `ON` from a join's `ON` after a bare `INSERT … SELECT`, and documents a
/// WHERE clause as the disambiguator.
pub fn upsert(conn: &Connection, row: &SessionTimelineRow) -> Result<bool> {
    let written = conn.execute(
        "INSERT INTO session_timelines (session_id, generated_at, model_id, source, entries, truncated)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?1)
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
    Ok(written > 0)
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

    /// A timeline belongs to a session, so every round-trip test needs the row
    /// it hangs off (I100).
    fn with_session(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO sessions (id, started_at, ended_at) VALUES (?1, ?2, ?3)",
            params![id, 1_700_000_000_000i64, 1_700_000_600_000i64],
        )
        .expect("insert session");
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
        with_session(&conn, "s1");
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
        with_session(&conn, "s1");
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

    // I100 — the delete wins. A write-up that finishes after its session was
    // removed must not put the narrative back.
    #[test]
    fn upsert_writes_nothing_for_a_session_that_no_longer_exists() {
        let conn = fresh();
        let stored = upsert(&conn, &row("gone", "model", "[]")).expect("upsert");
        assert!(!stored, "no session row means nothing to narrate");
        assert!(get(&conn, "gone").expect("get").is_none());
    }

    #[test]
    fn upsert_writes_nothing_when_the_session_is_deleted_mid_write_up() {
        let conn = fresh();
        with_session(&conn, "s1");
        assert!(upsert(&conn, &row("s1", "model", "[]")).expect("first"));
        // The user deletes the session while a second pass is still running.
        conn.execute("DELETE FROM session_timelines WHERE session_id = 's1'", [])
            .expect("cascade");
        conn.execute("DELETE FROM sessions WHERE id = 's1'", [])
            .expect("delete session");
        let stored = upsert(
            &conn,
            &row(
                "s1",
                "model",
                r#"[{"start_min":0,"end_min":1,"summary":"Read"}]"#,
            ),
        )
        .expect("late pass");
        assert!(!stored);
        assert!(get(&conn, "s1").expect("get").is_none());
    }
}
