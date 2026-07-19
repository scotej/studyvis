//! `sessions` table queries, backing the post-session report and Stats.
//!
//! `insert` is a split-semantics upsert: the lifecycle fields (`started_at`,
//! `ended_at`, `total_minutes`) overwrite authoritatively so a re-summarize
//! can correct them, while the report fields coalesce (a partial upsert never
//! clobbers an earlier value). There is no FK to `audit_events` — `delete` /
//! `clear_all` cascade manually inside one transaction. Serde emits verbatim
//! snake_case, mirrored by the TS `SessionRecord`; keep them aligned.

use rusqlite::{params, Connection, OptionalExtension, Result, TransactionBehavior};
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
    // #47 D5 — AI data-quality counters (003 migration). NULL on pre-003 rows
    // and AI-off sessions; the report treats NULL as "counts unknown".
    pub confident_samples: Option<i64>,
    pub skipped_samples: Option<i64>,
}

pub fn list(conn: &Connection) -> Result<Vec<SessionRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, started_at, ended_at, total_minutes, peer_pubkeys,
                declared_topic, score, focused_pct, generated_at,
                confident_samples, skipped_samples
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
            confident_samples: row.get(9)?,
            skipped_samples: row.get(10)?,
        })
    })?;
    rows.collect()
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<SessionRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, started_at, ended_at, total_minutes, peer_pubkeys,
                declared_topic, score, focused_pct, generated_at,
                confident_samples, skipped_samples
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
            confident_samples: row.get(9)?,
            skipped_samples: row.get(10)?,
        })
    })
    .optional()
}

pub fn insert(conn: &Connection, row: &SessionRow) -> Result<()> {
    // Two distinct upsert semantics, deliberately (I17):
    //  - started_at / ended_at / total_minutes are authoritative-overwrite:
    //    the sole caller (lifecycle.ts leave handler) always supplies real
    //    values in one call, and a later re-summarize MUST be able to
    //    correct them. COALESCE here would silently swallow a legitimate
    //    update, so it is intentionally NOT used. On a re-entry into the
    //    same room (Rejoin / re-invite) that caller accumulates across
    //    stints before writing (mergeSessionStints), so the overwrite
    //    corrects the row upward instead of rewinding it to the tail stint.
    //  - the optional report columns (peer_pubkeys, declared_topic, score,
    //    focused_pct, generated_at) are additive via COALESCE so a partial
    //    upsert that omits them does not clobber a prior call's values.
    conn.execute(
        "INSERT INTO sessions
             (id, started_at, ended_at, total_minutes, peer_pubkeys,
              declared_topic, score, focused_pct, generated_at,
              confident_samples, skipped_samples)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
             started_at     = excluded.started_at,
             ended_at       = excluded.ended_at,
             total_minutes  = excluded.total_minutes,
             peer_pubkeys   = COALESCE(excluded.peer_pubkeys, sessions.peer_pubkeys),
             declared_topic = COALESCE(excluded.declared_topic, sessions.declared_topic),
             score          = COALESCE(excluded.score, sessions.score),
             focused_pct    = COALESCE(excluded.focused_pct, sessions.focused_pct),
             generated_at   = COALESCE(excluded.generated_at, sessions.generated_at),
             confident_samples = COALESCE(excluded.confident_samples, sessions.confident_samples),
             skipped_samples   = COALESCE(excluded.skipped_samples, sessions.skipped_samples)",
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
            row.confident_samples,
            row.skipped_samples,
        ],
    )?;
    Ok(())
}

// A crash / power-loss / force-kill (or leaveBeforeQuit's 5s bound expiring
// mid-teardown) never runs the leave handler — the only production writer of
// a sessions row — while audit events persisted incrementally throughout the
// session (auditStore.append fires per event). The orphaned events are then
// unreachable everywhere: no sessions row means no report, no stats credit,
// and no per-session delete path (only clear_all removes them). Adopt them
// at boot: one row per orphaned session_id, spanning the events' timestamps.
// Boot-time-only is race-free — this runs in db::init before the webview can
// begin a session, and the single-instance plugin rejects a second process.
// The span under-counts slightly (last event ts, not the true crash
// instant): an honest lower bound. Report fields stay NULL — the report
// already renders NULL score/counts as unknown (D5 contract).
pub fn synthesize_from_orphaned_audit_events(
    conn: &mut Connection,
    local_ed_pubkey_hex: Option<&str>,
) -> Result<u32> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let orphans: Vec<(String, i64, i64)> = {
        let mut stmt = tx.prepare(
            "SELECT a.session_id, MIN(a.ts), MAX(a.ts)
             FROM audit_events a
             LEFT JOIN sessions s ON s.id = a.session_id
             WHERE s.id IS NULL AND a.session_id IS NOT NULL AND a.ts IS NOT NULL
             GROUP BY a.session_id",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect::<Result<Vec<_>>>()?
    };
    let mut adopted = 0u32;
    for (session_id, started_at, ended_at) in orphans {
        let mut peers: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT DISTINCT who FROM audit_events
                 WHERE session_id = ?1 AND kind = 'joined' AND who IS NOT NULL",
            )?;
            let rows = stmt.query_map(params![session_id], |row| row.get(0))?;
            rows.collect::<Result<Vec<_>>>()?
        };
        // Peers = signed-hello-verified senders of 'joined' events, minus
        // ourselves (each side persists its own row; peer_pubkeys means THE
        // OTHERS). Constrain to the 64-hex shape every verified `who`
        // carries, which also makes the hand-rolled JSON below safe.
        peers.retain(|p| p.len() == 64 && p.bytes().all(|b| b.is_ascii_hexdigit()));
        if let Some(local) = local_ed_pubkey_hex {
            peers.retain(|p| p != local);
        }
        peers.sort();
        peers.dedup();
        let peer_pubkeys = if peers.is_empty() {
            None
        } else {
            Some(format!(
                "[{}]",
                peers
                    .iter()
                    .map(|p| format!("\"{p}\""))
                    .collect::<Vec<_>>()
                    .join(",")
            ))
        };
        // Mirror the live leave path's markStudied for the adopted peers —
        // but monotonic: the crashed session may predate sessions studied
        // since, and rewinding last_studied_with would corrupt friends-list
        // ordering. A non-friend peer simply matches no row.
        for peer in &peers {
            tx.execute(
                "UPDATE friends SET last_studied_with = ?2
                 WHERE ed_pubkey_hex = ?1
                   AND (last_studied_with IS NULL OR last_studied_with < ?2)",
                params![peer, ended_at],
            )?;
        }
        insert(
            &tx,
            &SessionRow {
                id: session_id,
                started_at: Some(started_at),
                ended_at: Some(ended_at),
                total_minutes: Some(((ended_at - started_at).max(0)) / 60_000),
                peer_pubkeys,
                declared_topic: None,
                score: None,
                focused_pct: None,
                generated_at: None,
                confident_samples: None,
                skipped_samples: None,
            },
        )?;
        adopted += 1;
    }
    tx.commit()?;
    Ok(adopted)
}

// Session deletion removes the audit_events for the same topic in the same
// transaction: `sessions.id` IS the session topic and `audit_events.session_id`
// references it (001_initial.sql has no FK, so the cascade is manual here).
pub fn delete(conn: &mut Connection, id: &str) -> Result<usize> {
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM audit_events WHERE session_id = ?1",
        params![id],
    )?;
    let deleted = tx.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(deleted)
}

pub fn clear_all(conn: &mut Connection) -> Result<usize> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM audit_events", [])?;
    let deleted = tx.execute("DELETE FROM sessions", [])?;
    tx.commit()?;
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::audit_events::{self, AuditEventRow};
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
            confident_samples: None,
            skipped_samples: None,
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
        conn.execute("INSERT INTO sessions (id) VALUES ('partial')", [])
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
            confident_samples: None,
            skipped_samples: None,
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
            confident_samples: None,
            skipped_samples: None,
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
            confident_samples: Some(24),
            skipped_samples: Some(2),
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

    fn audit_row(session_id: &str, sig: &str) -> AuditEventRow {
        AuditEventRow {
            session_id: session_id.into(),
            ts: 1_700_000_000_000,
            who: "ed-pubkey".into(),
            kind: "joined".into(),
            detail: "{}".into(),
            sig: sig.into(),
        }
    }

    #[test]
    fn delete_removes_session_and_its_audit_events_only() {
        let mut conn = fresh();
        insert(&conn, &lifecycle_row("topic-a")).expect("insert a");
        insert(&conn, &lifecycle_row("topic-b")).expect("insert b");
        audit_events::insert(&conn, &audit_row("topic-a", "sig-a")).expect("audit a");
        audit_events::insert(&conn, &audit_row("topic-b", "sig-b")).expect("audit b");

        let deleted = delete(&mut conn, "topic-a").expect("delete");
        assert_eq!(deleted, 1);
        assert!(get(&conn, "topic-a").expect("get a").is_none());
        assert!(get(&conn, "topic-b").expect("get b").is_some());
        assert!(audit_events::list_for_session(&conn, "topic-a")
            .expect("list a")
            .is_empty());
        assert_eq!(
            audit_events::list_for_session(&conn, "topic-b")
                .expect("list b")
                .len(),
            1
        );
    }

    #[test]
    fn delete_unknown_id_is_a_no_op() {
        let mut conn = fresh();
        insert(&conn, &lifecycle_row("topic-a")).expect("insert");
        let deleted = delete(&mut conn, "nope").expect("delete");
        assert_eq!(deleted, 0);
        assert!(get(&conn, "topic-a").expect("get").is_some());
    }

    #[test]
    fn clear_all_empties_sessions_and_audit_events() {
        let mut conn = fresh();
        insert(&conn, &lifecycle_row("topic-a")).expect("insert a");
        insert(&conn, &lifecycle_row("topic-b")).expect("insert b");
        audit_events::insert(&conn, &audit_row("topic-a", "sig-a")).expect("audit a");
        audit_events::insert(&conn, &audit_row("topic-b", "sig-b")).expect("audit b");

        let deleted = clear_all(&mut conn).expect("clear");
        assert_eq!(deleted, 2);
        assert!(list(&conn).expect("list sessions").is_empty());
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM audit_events", [], |r| r.get(0))
            .expect("count audit");
        assert_eq!(remaining, 0);
    }

    // Distinct name from the 2-arg `audit_row` fixture above (same module —
    // Rust has no overloading), and a UNIQUE per-row sig: audit_events::insert
    // dedups table-wide on sig (silently — it returns Ok either way), so a
    // shared placeholder would drop every fixture after the first.
    fn orphan_audit_row(session_id: &str, ts: i64, who: &str, kind: &str) -> AuditEventRow {
        AuditEventRow {
            session_id: session_id.into(),
            ts,
            who: who.into(),
            kind: kind.into(),
            detail: "{}".into(),
            sig: format!("{session_id}-{ts}-{who}-{kind}"),
        }
    }

    fn hex64(byte: &str) -> String {
        byte.repeat(32)
    }

    #[test]
    fn synthesize_adopts_orphans_and_leaves_real_rows_alone() {
        let mut conn = fresh();
        let me = hex64("aa");
        let friend = hex64("bb");
        // A session that ended cleanly: real row + its audit events.
        insert(&conn, &lifecycle_row("kept-topic")).expect("insert kept");
        audit_events::insert(
            &conn,
            &orphan_audit_row("kept-topic", 1_700_000_000_000, &me, "joined"),
        )
        .expect("kept audit");
        // A crashed session: audit events only, no sessions row.
        audit_events::insert(
            &conn,
            &orphan_audit_row("orphan-topic", 1_700_000_060_000, &me, "joined"),
        )
        .expect("orphan a");
        audit_events::insert(
            &conn,
            &orphan_audit_row("orphan-topic", 1_700_000_120_000, &friend, "joined"),
        )
        .expect("orphan b");
        audit_events::insert(
            &conn,
            &orphan_audit_row("orphan-topic", 1_700_002_760_000, &friend, "left"),
        )
        .expect("orphan c");

        let adopted =
            synthesize_from_orphaned_audit_events(&mut conn, Some(&me)).expect("synthesize");
        assert_eq!(adopted, 1);

        let row = get(&conn, "orphan-topic").expect("get").expect("adopted");
        assert_eq!(row.started_at, Some(1_700_000_060_000));
        assert_eq!(row.ended_at, Some(1_700_002_760_000));
        assert_eq!(row.total_minutes, Some(45)); // floor(2_700_000ms / 60_000)
        assert_eq!(row.peer_pubkeys, Some(format!("[\"{friend}\"]"))); // self excluded
        assert_eq!(row.score, None);
        assert_eq!(row.skipped_samples, None);

        // The clean session's row is untouched.
        let kept = get(&conn, "kept-topic").expect("get").expect("kept");
        assert_eq!(kept.started_at, Some(1_700_000_000_000));
        assert_eq!(kept.peer_pubkeys.as_deref(), Some("[\"aa\",\"bb\"]"));

        // Idempotent: the adopted row is no longer an orphan.
        let again = synthesize_from_orphaned_audit_events(&mut conn, Some(&me)).expect("re-run");
        assert_eq!(again, 0);
    }

    #[test]
    fn synthesize_single_event_orphan_is_a_zero_minute_row() {
        let mut conn = fresh();
        audit_events::insert(
            &conn,
            &orphan_audit_row("blip-topic", 1_700_000_000_000, &hex64("aa"), "joined"),
        )
        .expect("insert");
        let adopted = synthesize_from_orphaned_audit_events(&mut conn, None).expect("synthesize");
        assert_eq!(adopted, 1);
        let row = get(&conn, "blip-topic").expect("get").expect("adopted");
        assert_eq!(row.total_minutes, Some(0));
        assert_eq!(row.started_at, row.ended_at);
    }

    #[test]
    fn synthesize_bumps_last_studied_with_monotonically() {
        let mut conn = fresh();
        let stale = hex64("bb");
        let fresh_friend = hex64("cc");
        crate::db::friends::add(&conn, &stale, "x1", "Stale", 100).expect("add stale");
        crate::db::friends::update_last_studied(&conn, &stale, 1_000).expect("seed stale");
        crate::db::friends::add(&conn, &fresh_friend, "x2", "Fresh", 100).expect("add fresh");
        crate::db::friends::update_last_studied(&conn, &fresh_friend, 9_999_999_999_999)
            .expect("seed fresh");
        for (i, who) in [&stale, &fresh_friend].into_iter().enumerate() {
            audit_events::insert(
                &conn,
                &orphan_audit_row("crash-topic", 1_700_000_000_000 + i as i64, who, "joined"),
            )
            .expect("insert event");
        }
        synthesize_from_orphaned_audit_events(&mut conn, None).expect("synthesize");
        let friends = crate::db::friends::list(&conn).expect("list");
        let by_key = |k: &str| {
            friends
                .iter()
                .find(|f| f.ed_pubkey_hex == k)
                .expect("friend present")
                .last_studied_with
        };
        // Older stored value bumps to the adopted session's end...
        assert_eq!(by_key(&stale), Some(1_700_000_000_001));
        // ...but a newer one is never rewound by an old crashed session.
        assert_eq!(by_key(&fresh_friend), Some(9_999_999_999_999));
    }

    #[test]
    fn synthesize_drops_malformed_who_values_from_peers() {
        let mut conn = fresh();
        // Non-64-hex who values (malformed / unverified rows) must not reach
        // the peers JSON.
        audit_events::insert(
            &conn,
            &orphan_audit_row("odd-topic", 1_700_000_000_000, "not-a-pubkey", "joined"),
        )
        .expect("insert");
        let adopted = synthesize_from_orphaned_audit_events(&mut conn, None).expect("synthesize");
        assert_eq!(adopted, 1);
        let row = get(&conn, "odd-topic").expect("get").expect("adopted");
        assert_eq!(row.peer_pubkeys, None);
    }
}
