//! `sessions` table queries, backing the post-session report and Stats.
//!
//! `insert` is a split-semantics upsert: the lifecycle fields (`started_at`,
//! `ended_at`, `total_minutes`, `total_duration_ms`) overwrite authoritatively so a re-summarize
//! can correct them, while the report fields coalesce (a partial upsert never
//! clobbers an earlier value). There is no FK to `audit_events` — `delete` /
//! `clear_all` cascade manually inside one transaction. Serde emits verbatim
//! snake_case, mirrored by the TS `SessionRecord`; keep them aligned.

use rusqlite::{params, Connection, OptionalExtension, Result, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

// JavaScript Date's documented finite range. Recovery rows travel through
// Tauri IPC, so an arbitrary remote audit clock must not create a timestamp
// the renderer cannot represent even when it is in the past.
const MIN_SAFE_JS_DATE_MS: i64 = -8_640_000_000_000_000;

fn bounded_recovery_timestamp(value: i64, now_ms: i64) -> i64 {
    value.clamp(MIN_SAFE_JS_DATE_MS, now_ms)
}

fn normalized_peer_pubkeys<I>(peers: I, local_ed_pubkey_hex: Option<&str>) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    let mut peers: Vec<String> = peers
        .into_iter()
        .filter(|p| p.len() == 64 && p.bytes().all(|b| b.is_ascii_hexdigit()))
        .filter(|p| local_ed_pubkey_hex != Some(p.as_str()))
        .collect();
    peers.sort();
    peers.dedup();
    (!peers.is_empty()).then(|| {
        format!(
            "[{}]",
            peers
                .iter()
                .map(|p| format!("\"{p}\""))
                .collect::<Vec<_>>()
                .join(",")
        )
    })
}

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
    // Exact accumulated awake duration. NULL means this row predates the
    // migration that made sub-minute rejoin residue durable.
    pub total_duration_ms: Option<i64>,
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
    // I83 — whether AI focus detection was enabled for this session (004
    // migration). 1 = on, 0 = off, NULL = unknown (pre-004 row). Lets the
    // report separate "AI was off" from "AI was on and recorded nothing",
    // which every other column in this struct reads as NULL for both.
    pub ai_enabled: Option<i64>,
    // Immutable local owner captured at session start. Historical report
    // ownership is session-scoped, never derived from the identity currently
    // active when the report is opened.
    pub local_ed_pubkey: Option<String>,
    pub local_display_name: Option<String>,
    // Canonical JSON object of authenticated peer Ed25519 key -> cumulative
    // overlap milliseconds. NULL is legacy/unknown precision; `{}` is a
    // precisely measured peerless session.
    pub peer_presence_ms: Option<String>,
}

pub fn list(conn: &Connection) -> Result<Vec<SessionRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, started_at, ended_at, total_minutes, total_duration_ms, peer_pubkeys,
                declared_topic, score, focused_pct, generated_at,
                confident_samples, skipped_samples, ai_enabled,
                local_ed_pubkey, local_display_name, peer_presence_ms
         FROM sessions
         ORDER BY started_at DESC, id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SessionRow {
            id: row.get(0)?,
            started_at: row.get(1)?,
            ended_at: row.get(2)?,
            total_minutes: row.get(3)?,
            total_duration_ms: row.get(4)?,
            peer_pubkeys: row.get(5)?,
            declared_topic: row.get(6)?,
            score: row.get(7)?,
            focused_pct: row.get(8)?,
            generated_at: row.get(9)?,
            confident_samples: row.get(10)?,
            skipped_samples: row.get(11)?,
            ai_enabled: row.get(12)?,
            local_ed_pubkey: row.get(13)?,
            local_display_name: row.get(14)?,
            peer_presence_ms: row.get(15)?,
        })
    })?;
    rows.collect()
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<SessionRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, started_at, ended_at, total_minutes, total_duration_ms, peer_pubkeys,
                declared_topic, score, focused_pct, generated_at,
                confident_samples, skipped_samples, ai_enabled,
                local_ed_pubkey, local_display_name, peer_presence_ms
         FROM sessions
         WHERE id = ?1",
    )?;
    stmt.query_row([id], |row| {
        Ok(SessionRow {
            id: row.get(0)?,
            started_at: row.get(1)?,
            ended_at: row.get(2)?,
            total_minutes: row.get(3)?,
            total_duration_ms: row.get(4)?,
            peer_pubkeys: row.get(5)?,
            declared_topic: row.get(6)?,
            score: row.get(7)?,
            focused_pct: row.get(8)?,
            generated_at: row.get(9)?,
            confident_samples: row.get(10)?,
            skipped_samples: row.get(11)?,
            ai_enabled: row.get(12)?,
            local_ed_pubkey: row.get(13)?,
            local_display_name: row.get(14)?,
            peer_presence_ms: row.get(15)?,
        })
    })
    .optional()
}

pub fn insert(conn: &Connection, row: &SessionRow) -> Result<()> {
    insert_with_focus_metrics_mode(conn, row, false)
}

// Used only when the frontend could not determine whether this topic already
// has a row. The conflict guard is atomic with the insert: it preserves a
// first-ever stint without allowing stint-only values to rewind prior history.
pub fn insert_if_absent(conn: &Connection, row: &SessionRow) -> Result<bool> {
    let inserted = conn.execute(
        "INSERT INTO sessions
             (id, started_at, ended_at, total_minutes, total_duration_ms, peer_pubkeys,
              declared_topic, score, focused_pct, generated_at,
              confident_samples, skipped_samples, ai_enabled,
              local_ed_pubkey, local_display_name, peer_presence_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(id) DO NOTHING",
        params![
            row.id,
            row.started_at,
            row.ended_at,
            row.total_minutes,
            row.total_duration_ms,
            row.peer_pubkeys,
            row.declared_topic,
            row.score,
            row.focused_pct,
            row.generated_at,
            row.confident_samples,
            row.skipped_samples,
            row.ai_enabled,
            row.local_ed_pubkey,
            row.local_display_name,
            row.peer_presence_ms,
        ],
    )?;
    Ok(inserted == 1)
}

// `replace_focus_metrics` is used only when a second stint cannot continue
// the prior in-memory score machine (such as re-entry after app restart). In
// that case NULL is meaningful: retain it instead of COALESCE reviving a
// last-stint score that describes a different interval.
pub fn insert_with_focus_metrics_mode(
    conn: &Connection,
    row: &SessionRow,
    replace_focus_metrics: bool,
) -> Result<()> {
    // Two distinct upsert semantics, deliberately (I17):
    //  - started_at / ended_at / total_minutes / total_duration_ms are authoritative-overwrite:
    //    the sole caller (lifecycle.ts leave handler) always supplies real
    //    values in one call, and a later re-summarize MUST be able to
    //    correct them. COALESCE here would silently swallow a legitimate
    //    update, so it is intentionally NOT used. On a re-entry into the
    //    same room (Rejoin / re-invite) that caller accumulates across
    //    stints before writing (mergeSessionStints), so the overwrite
    //    corrects the row upward instead of rewinding it to the tail stint.
    //  - the optional report columns (peer_pubkeys, declared_topic, score,
    //    focused_pct, generated_at, peer_presence_ms) are additive via
    //    COALESCE so a partial/mixed-version upsert that omits them does not
    //    clobber a prior call's values. The presence reader treats any retained
    //    malformed value as unknown with whole-row legacy fallback.
    conn.execute(
        "INSERT INTO sessions
             (id, started_at, ended_at, total_minutes, total_duration_ms, peer_pubkeys,
              declared_topic, score, focused_pct, generated_at,
              confident_samples, skipped_samples, ai_enabled,
              local_ed_pubkey, local_display_name, peer_presence_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(id) DO UPDATE SET
             started_at     = excluded.started_at,
             ended_at       = excluded.ended_at,
             total_minutes  = excluded.total_minutes,
             total_duration_ms = excluded.total_duration_ms,
             peer_pubkeys   = COALESCE(excluded.peer_pubkeys, sessions.peer_pubkeys),
             declared_topic = COALESCE(excluded.declared_topic, sessions.declared_topic),
             score          = CASE WHEN ?17 THEN excluded.score ELSE COALESCE(excluded.score, sessions.score) END,
             focused_pct    = CASE WHEN ?17 THEN excluded.focused_pct ELSE COALESCE(excluded.focused_pct, sessions.focused_pct) END,
             generated_at   = COALESCE(excluded.generated_at, sessions.generated_at),
             confident_samples = CASE WHEN ?17 THEN excluded.confident_samples ELSE COALESCE(excluded.confident_samples, sessions.confident_samples) END,
             skipped_samples   = CASE WHEN ?17 THEN excluded.skipped_samples ELSE COALESCE(excluded.skipped_samples, sessions.skipped_samples) END,
             ai_enabled        = CASE WHEN ?17 THEN excluded.ai_enabled ELSE COALESCE(excluded.ai_enabled, sessions.ai_enabled) END,
             local_ed_pubkey   = sessions.local_ed_pubkey,
             local_display_name = sessions.local_display_name,
             peer_presence_ms = COALESCE(excluded.peer_presence_ms, sessions.peer_presence_ms)",
        params![
            row.id,
            row.started_at,
            row.ended_at,
            row.total_minutes,
            row.total_duration_ms,
            row.peer_pubkeys,
            row.declared_topic,
            row.score,
            row.focused_pct,
            row.generated_at,
            row.confident_samples,
            row.skipped_samples,
            row.ai_enabled,
            row.local_ed_pubkey,
            row.local_display_name,
            row.peer_presence_ms,
            replace_focus_metrics,
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
// at boot: one row per orphaned session_id, retaining only timestamps and
// identities that recovery can prove (not an inferred awake-time span).
// Boot-time-only is race-free — this runs in db::init before the webview can
// begin a session, and the single-instance plugin rejects a second process.
// Report fields stay NULL — the report already renders NULL score/counts as
// unknown (D5 contract). The active
// identity can help exclude itself from peer_pubkeys, but cannot prove it
// owned a crashed session after an identity restore, so provenance stays NULL.
pub fn synthesize_from_orphaned_audit_events(
    conn: &mut Connection,
    local_ed_pubkey_hex: Option<&str>,
) -> Result<u32> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(i64::MAX);
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let orphans: Vec<(String, i64, i64)> = {
        let mut stmt = tx.prepare(
            "SELECT a.session_id,
                    COALESCE(
                        MIN(CASE WHEN a.ts BETWEEN ?1 AND ?2 THEN a.ts END),
                        MIN(a.ts)
                    ),
                    COALESCE(
                        MAX(CASE WHEN a.ts BETWEEN ?1 AND ?2 THEN a.ts END),
                        MAX(a.ts)
                    )
             FROM audit_events a
             LEFT JOIN sessions s ON s.id = a.session_id
             WHERE s.id IS NULL AND a.session_id IS NOT NULL AND a.ts IS NOT NULL
             GROUP BY a.session_id",
        )?;
        let rows = stmt.query_map(params![MIN_SAFE_JS_DATE_MS, now_ms], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        rows.collect::<Result<Vec<_>>>()?
    };
    let mut adopted = 0u32;
    for (session_id, started_at, raw_ended_at) in orphans {
        // A remote signed audit timestamp can be clock-skewed. Recovery must
        // not pin report/friend ordering into an arbitrary future date.
        let ended_at = bounded_recovery_timestamp(raw_ended_at, now_ms);
        let started_at = bounded_recovery_timestamp(started_at, now_ms).min(ended_at);
        let mut peers: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT DISTINCT who FROM audit_events
                 WHERE session_id = ?1 AND kind = 'joined' AND who IS NOT NULL
                   AND ts BETWEEN ?3 AND ?2",
            )?;
            let rows = stmt.query_map(params![session_id, now_ms, MIN_SAFE_JS_DATE_MS], |row| {
                row.get(0)
            })?;
            rows.collect::<Result<Vec<_>>>()?
        };
        // Peers = signed-hello-verified senders of 'joined' events, minus
        // ourselves (each side persists its own row; peer_pubkeys means THE
        // OTHERS). Use the same normalized list for friend timestamps.
        peers.retain(|p| p.len() == 64 && p.bytes().all(|b| b.is_ascii_hexdigit()));
        if let Some(local) = local_ed_pubkey_hex {
            peers.retain(|p| p != local);
        }
        peers.sort();
        peers.dedup();
        let peer_pubkeys = normalized_peer_pubkeys(peers.clone(), local_ed_pubkey_hex);
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
                // Audit timestamps cannot distinguish awake time from sleep or
                // wall-clock skew, so recovery leaves both duration forms
                // unknown instead of fabricating study minutes.
                total_minutes: None,
                // Audit timestamps are wall clock only; a crash can span
                // suspend, so this recovery path cannot honestly claim the
                // exact awake duration that a live lifecycle measures.
                total_duration_ms: None,
                peer_pubkeys,
                declared_topic: None,
                score: None,
                focused_pct: None,
                generated_at: None,
                confident_samples: None,
                skipped_samples: None,
                ai_enabled: None,
                local_ed_pubkey: None,
                local_display_name: None,
                peer_presence_ms: None,
            },
        )?;
        adopted += 1;
    }

    // A clean first stint can already have a sessions row when a same-topic
    // rejoin crashes. Detect only a *locally authored* joined event after that
    // row's end: remote timestamps alone are not authority to invalidate an
    // otherwise precise local summary. The tail has no monotonic checkpoint,
    // so retain all proven first-stint fields/minutes but make exact precision
    // unknown. Tail identities remain in audit/friend metadata; attaching them
    // to the earlier summary would falsely credit them with prior duration.
    let continued_rows: Vec<(String, i64, String)> = {
        let mut stmt = tx.prepare(
            "SELECT s.id, s.ended_at, s.local_ed_pubkey
             FROM sessions s
             WHERE s.ended_at IS NOT NULL
               AND s.local_ed_pubkey IS NOT NULL
               AND EXISTS (
                   SELECT 1 FROM audit_events a
                   WHERE a.session_id = s.id
                     AND a.kind = 'joined'
                     AND a.who = s.local_ed_pubkey
                     AND a.ts > s.ended_at
                     AND a.ts <= ?1
               )",
        )?;
        let rows = stmt.query_map(params![now_ms], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        rows.collect::<Result<Vec<_>>>()?
    };
    for (session_id, prior_ended_at, local_ed_pubkey) in continued_rows {
        // Only the immutable local identity can establish that this process
        // continued the row; remote audit timestamps have no trusted receipt
        // time and must not extend it or alter partner chronology.
        let latest_local_rejoin: Option<i64> = tx.query_row(
            "SELECT MAX(ts) FROM audit_events
             WHERE session_id = ?1 AND kind = 'joined' AND who = ?2
               AND ts > ?3 AND ts BETWEEN ?4 AND ?5",
            params![
                session_id,
                local_ed_pubkey,
                prior_ended_at,
                MIN_SAFE_JS_DATE_MS,
                now_ms
            ],
            |row| row.get(0),
        )?;
        let ended_at = latest_local_rejoin
            .map(|ts| bounded_recovery_timestamp(ts, now_ms))
            .unwrap_or(prior_ended_at)
            .max(prior_ended_at);
        tx.execute(
            "UPDATE sessions
             SET ended_at = ?2, total_duration_ms = NULL
             WHERE id = ?1",
            params![session_id, ended_at],
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
            total_duration_ms: Some(300_000),
            peer_pubkeys: Some("[\"aa\",\"bb\"]".into()),
            declared_topic: None,
            score: None,
            focused_pct: None,
            generated_at: None,
            confident_samples: None,
            skipped_samples: None,
            ai_enabled: None,
            local_ed_pubkey: None,
            local_display_name: None,
            peer_presence_ms: None,
        }
    }

    #[test]
    fn insert_writes_a_row_with_expected_columns() {
        let conn = fresh();
        let mut row = lifecycle_row("topic-hex");
        row.peer_presence_ms = Some("{\"aa\":120000,\"bb\":300000}".into());
        insert(&conn, &row).expect("insert");
        let read = get(&conn, "topic-hex").expect("get").expect("present");
        assert_eq!(read.id, "topic-hex");
        assert_eq!(read.started_at, Some(1_700_000_000_000));
        assert_eq!(read.ended_at, Some(1_700_000_300_000));
        assert_eq!(read.total_minutes, Some(5));
        assert_eq!(read.total_duration_ms, Some(300_000));
        assert_eq!(read.peer_pubkeys.as_deref(), Some("[\"aa\",\"bb\"]"));
        assert_eq!(
            read.peer_presence_ms.as_deref(),
            Some("{\"aa\":120000,\"bb\":300000}")
        );
    }

    #[test]
    fn session_identity_is_immutable_across_later_upserts() {
        let conn = fresh();
        let mut first = lifecycle_row("topic-hex");
        first.local_ed_pubkey = Some("alice-ed".into());
        first.local_display_name = Some("Alice".into());
        insert(&conn, &first).expect("insert first owner");

        let mut later = lifecycle_row("topic-hex");
        later.local_ed_pubkey = Some("bob-ed".into());
        later.local_display_name = Some("Bob".into());
        insert(&conn, &later).expect("insert later owner");

        let read = get(&conn, "topic-hex").expect("get").expect("present");
        assert_eq!(read.local_ed_pubkey.as_deref(), Some("alice-ed"));
        assert_eq!(read.local_display_name.as_deref(), Some("Alice"));
    }

    #[test]
    fn legacy_unknown_session_owner_is_never_backfilled_by_a_later_upsert() {
        let conn = fresh();
        insert(&conn, &lifecycle_row("legacy-topic")).expect("insert legacy row");

        let mut later = lifecycle_row("legacy-topic");
        later.local_ed_pubkey = Some("new-active-identity".into());
        later.local_display_name = Some("New active identity".into());
        insert(&conn, &later).expect("later upsert");

        let read = get(&conn, "legacy-topic").expect("get").expect("present");
        assert_eq!(read.local_ed_pubkey, None);
        assert_eq!(read.local_display_name, None);
    }

    #[test]
    fn discontinuous_focus_mode_can_clear_a_stale_score() {
        let conn = fresh();
        let mut first = lifecycle_row("topic-hex");
        first.score = Some(88);
        first.focused_pct = Some(0.4);
        first.confident_samples = Some(10);
        first.skipped_samples = Some(2);
        insert(&conn, &first).expect("first stint");

        let mut second = lifecycle_row("topic-hex");
        second.score = None;
        second.focused_pct = Some(0.6);
        second.confident_samples = Some(15);
        second.skipped_samples = Some(3);
        insert_with_focus_metrics_mode(&conn, &second, true)
            .expect("replace discontinuous focus metrics");

        let read = get(&conn, "topic-hex").expect("get").expect("present");
        assert_eq!(read.score, None);
        assert_eq!(read.focused_pct, Some(0.6));
        assert_eq!(read.confident_samples, Some(15));
        assert_eq!(read.skipped_samples, Some(3));
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
        row.total_duration_ms = Some(90_000);
        insert(&conn, &row).expect("insert 2");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1);
        let read = get(&conn, "topic-hex").expect("get").expect("present");
        assert_eq!(read.ended_at, Some(99));
        assert_eq!(read.total_duration_ms, Some(90_000));
    }

    #[test]
    fn insert_if_absent_preserves_an_existing_row() {
        let conn = fresh();
        let original = lifecycle_row("topic-hex");
        insert(&conn, &original).expect("insert original");

        let mut tail_stint = lifecycle_row("topic-hex");
        tail_stint.started_at = Some(1_800_000_000_000);
        tail_stint.ended_at = Some(1_800_000_600_000);
        tail_stint.total_minutes = Some(10);
        assert!(!insert_if_absent(&conn, &tail_stint).expect("guarded insert"));

        let read = get(&conn, "topic-hex").expect("get").expect("present");
        assert_eq!(read.started_at, original.started_at);
        assert_eq!(read.ended_at, original.ended_at);
        assert_eq!(read.total_minutes, original.total_minutes);
    }

    #[test]
    fn insert_if_absent_retains_a_first_ever_stint() {
        let conn = fresh();
        let mut row = lifecycle_row("new-topic");
        row.peer_presence_ms = Some("{\"aa\":90000}".into());

        assert!(insert_if_absent(&conn, &row).expect("guarded insert"));
        let read = list(&conn).expect("list");
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].total_minutes, row.total_minutes);
        assert_eq!(read[0].total_duration_ms, row.total_duration_ms);
        assert_eq!(read[0].peer_presence_ms.as_deref(), Some("{\"aa\":90000}"));
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
        assert_eq!(read[0].total_duration_ms, None);
        assert_eq!(read[0].peer_pubkeys, None);
        assert_eq!(read[0].declared_topic, None);
        assert_eq!(read[0].score, None);
        assert_eq!(read[0].focused_pct, None);
        assert_eq!(read[0].generated_at, None);
        assert_eq!(read[0].peer_presence_ms, None);
    }

    #[test]
    fn insert_preserves_peer_pubkeys_and_presence_when_upsert_omits_them() {
        let conn = fresh();
        let row = SessionRow {
            id: "topic-hex".into(),
            started_at: Some(1),
            ended_at: Some(2),
            total_minutes: Some(0),
            total_duration_ms: Some(0),
            peer_pubkeys: Some("[\"aa\"]".into()),
            declared_topic: None,
            score: None,
            focused_pct: None,
            generated_at: None,
            confident_samples: None,
            skipped_samples: None,
            ai_enabled: None,
            local_ed_pubkey: None,
            local_display_name: None,
            peer_presence_ms: Some("{}".into()),
        };
        insert(&conn, &row).expect("insert 1");
        let again = SessionRow {
            id: "topic-hex".into(),
            started_at: Some(1),
            ended_at: Some(9),
            total_minutes: Some(0),
            total_duration_ms: Some(0),
            peer_pubkeys: None,
            declared_topic: None,
            score: None,
            focused_pct: None,
            generated_at: None,
            confident_samples: None,
            skipped_samples: None,
            ai_enabled: None,
            local_ed_pubkey: None,
            local_display_name: None,
            peer_presence_ms: None,
        };
        insert(&conn, &again).expect("insert 2");
        let read = get(&conn, "topic-hex").expect("get").expect("present");
        assert_eq!(read.peer_pubkeys.as_deref(), Some("[\"aa\"]"));
        assert_eq!(read.peer_presence_ms.as_deref(), Some("{}"));
    }

    #[test]
    fn insert_replaces_peer_presence_with_the_callers_merged_summary() {
        let conn = fresh();
        let mut row = lifecycle_row("topic-hex");
        row.peer_presence_ms = Some("{\"aa\":120000}".into());
        insert(&conn, &row).expect("insert first summary");

        row.peer_presence_ms = Some("{\"aa\":180000,\"bb\":60000}".into());
        insert(&conn, &row).expect("insert merged summary");

        let read = get(&conn, "topic-hex").expect("get").expect("present");
        assert_eq!(
            read.peer_presence_ms.as_deref(),
            Some("{\"aa\":180000,\"bb\":60000}")
        );
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
            total_duration_ms: Some(300_000),
            peer_pubkeys: None,
            declared_topic: Some("Studying".into()),
            score: Some(87),
            focused_pct: Some(0.91),
            generated_at: Some(1_700_000_300_500),
            confident_samples: Some(24),
            skipped_samples: Some(2),
            ai_enabled: None,
            local_ed_pubkey: None,
            local_display_name: None,
            peer_presence_ms: None,
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
        assert_eq!(
            row.local_ed_pubkey, None,
            "the current identity can filter peers but cannot be assigned as the orphan owner"
        );
        assert_eq!(row.ended_at, Some(1_700_002_760_000));
        assert_eq!(row.total_minutes, None);
        assert_eq!(row.total_duration_ms, None);
        assert_eq!(row.peer_pubkeys, Some(format!("[\"{friend}\"]"))); // self excluded
        assert_eq!(row.score, None);
        assert_eq!(row.skipped_samples, None);
        assert_eq!(row.peer_presence_ms, None);

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
        assert_eq!(row.total_minutes, None);
        assert_eq!(row.total_duration_ms, None);
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

    #[test]
    fn synthesize_marks_a_crashed_same_topic_rejoin_unknown_without_rewriting_prior_credit() {
        let mut conn = fresh();
        let me = hex64("aa");
        let old_peer = hex64("bb");
        let new_peer = hex64("cc");
        let mut row = lifecycle_row("continued-topic");
        row.local_ed_pubkey = Some(me.clone());
        row.peer_pubkeys = Some(format!("[\"{old_peer}\"]"));
        row.total_minutes = Some(5);
        row.total_duration_ms = Some(300_000);
        row.peer_presence_ms = Some(format!("{{\"{old_peer}\":120000}}"));
        row.ended_at = Some(1_700_000_300_000);
        insert(&conn, &row).expect("insert first stint");
        crate::db::friends::add(&conn, &old_peer, "old", "Old", 0).expect("add old");
        crate::db::friends::add(&conn, &new_peer, "new", "New", 0).expect("add new");
        crate::db::friends::update_last_studied(&conn, &old_peer, 1).expect("seed old");
        audit_events::insert(
            &conn,
            &orphan_audit_row("continued-topic", 1_700_000_300_001, &me, "joined"),
        )
        .expect("local rejoin");
        audit_events::insert(
            &conn,
            &orphan_audit_row("continued-topic", 1_700_000_310_000, &new_peer, "joined"),
        )
        .expect("new peer");
        let future_peer = hex64("dd");
        audit_events::insert(
            &conn,
            &orphan_audit_row("continued-topic", i64::MAX, &future_peer, "joined"),
        )
        .expect("future peer");

        assert_eq!(
            synthesize_from_orphaned_audit_events(&mut conn, Some(&me)).expect("recover"),
            1
        );
        let read = get(&conn, "continued-topic").expect("get").expect("row");
        assert_eq!(read.total_minutes, Some(5));
        assert_eq!(read.total_duration_ms, None);
        assert_eq!(
            read.peer_presence_ms,
            Some(format!("{{\"{old_peer}\":120000}}"))
        );
        assert_eq!(read.peer_pubkeys, Some(format!("[\"{old_peer}\"]")));
        assert_eq!(read.ended_at, Some(1_700_000_300_001));
        let friends = crate::db::friends::list(&conn).expect("friends");
        let friend_at = |key: &str| {
            friends
                .iter()
                .find(|friend| friend.ed_pubkey_hex == key)
                .expect("friend")
                .last_studied_with
        };
        assert_eq!(friend_at(&old_peer), Some(1));
        assert_eq!(friend_at(&new_peer), None);
        assert_eq!(
            synthesize_from_orphaned_audit_events(&mut conn, Some(&me)).expect("idempotent"),
            0
        );
    }

    #[test]
    fn remote_future_audit_does_not_invalidate_a_precise_completed_row() {
        let mut conn = fresh();
        let me = hex64("aa");
        let remote = hex64("bb");
        let mut row = lifecycle_row("remote-only-topic");
        row.local_ed_pubkey = Some(me);
        insert(&conn, &row).expect("insert");
        audit_events::insert(
            &conn,
            &orphan_audit_row("remote-only-topic", i64::MAX, &remote, "joined"),
        )
        .expect("remote event");

        assert_eq!(
            synthesize_from_orphaned_audit_events(&mut conn, None).expect("recover"),
            0
        );
        assert_eq!(
            get(&conn, "remote-only-topic")
                .expect("get")
                .expect("row")
                .total_duration_ms,
            Some(300_000)
        );
    }

    #[test]
    fn future_local_rejoin_marker_does_not_invalidate_a_precise_completed_row() {
        let mut conn = fresh();
        let me = hex64("aa");
        let mut row = lifecycle_row("future-local-topic");
        row.local_ed_pubkey = Some(me.clone());
        insert(&conn, &row).expect("insert");
        audit_events::insert(
            &conn,
            &orphan_audit_row("future-local-topic", i64::MAX, &me, "joined"),
        )
        .expect("future local event");

        assert_eq!(
            synthesize_from_orphaned_audit_events(&mut conn, None).expect("recover"),
            0
        );
        assert_eq!(
            get(&conn, "future-local-topic")
                .expect("get")
                .expect("row")
                .total_duration_ms,
            Some(300_000)
        );
    }

    #[test]
    fn old_local_join_marker_does_not_invalidate_a_precise_completed_row() {
        let mut conn = fresh();
        let me = hex64("aa");
        let mut row = lifecycle_row("old-local-topic");
        row.local_ed_pubkey = Some(me.clone());
        insert(&conn, &row).expect("insert");
        audit_events::insert(
            &conn,
            &orphan_audit_row("old-local-topic", 1_700_000_300_000, &me, "joined"),
        )
        .expect("old event");

        assert_eq!(
            synthesize_from_orphaned_audit_events(&mut conn, None).expect("recover"),
            0
        );
        assert_eq!(
            get(&conn, "old-local-topic")
                .expect("get")
                .expect("row")
                .total_duration_ms,
            Some(300_000)
        );
    }

    #[test]
    fn synthesis_ignores_out_of_range_orphan_clocks_when_safe_events_exist() {
        let mut conn = fresh();
        let who = hex64("aa");
        let invalid_peer = hex64("bb");
        crate::db::friends::add(&conn, &invalid_peer, "invalid", "Invalid", 0)
            .expect("add invalid peer");
        crate::db::friends::update_last_studied(&conn, &invalid_peer, 7)
            .expect("seed invalid peer");
        audit_events::insert(
            &conn,
            &orphan_audit_row("mixed-clock-topic", 1_700_000_000_000, &who, "joined"),
        )
        .expect("safe event");
        audit_events::insert(
            &conn,
            &orphan_audit_row("mixed-clock-topic", i64::MIN, &who, "left"),
        )
        .expect("past skew");
        audit_events::insert(
            &conn,
            &orphan_audit_row("mixed-clock-topic", i64::MAX, &who, "alert"),
        )
        .expect("future skew");
        audit_events::insert(
            &conn,
            &orphan_audit_row("all-invalid-topic", i64::MIN, &invalid_peer, "joined"),
        )
        .expect("all invalid past");
        audit_events::insert(
            &conn,
            &orphan_audit_row("all-invalid-topic", i64::MAX, &who, "left"),
        )
        .expect("all invalid future");

        assert_eq!(
            synthesize_from_orphaned_audit_events(&mut conn, None).expect("recover"),
            2
        );
        let mixed = get(&conn, "mixed-clock-topic")
            .expect("get")
            .expect("mixed");
        assert_eq!(mixed.started_at, Some(1_700_000_000_000));
        assert_eq!(mixed.ended_at, Some(1_700_000_000_000));
        let invalid = get(&conn, "all-invalid-topic")
            .expect("get")
            .expect("invalid");
        let start = invalid.started_at.expect("start");
        let end = invalid.ended_at.expect("end");
        assert!((MIN_SAFE_JS_DATE_MS..=i64::MAX).contains(&start));
        assert!(start <= end);
        assert!(
            end <= SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("wall time")
                .as_millis()
                .min(i64::MAX as u128) as i64
        );
        assert_eq!(invalid.peer_pubkeys, None);
        let invalid_friend = crate::db::friends::list(&conn)
            .expect("friends")
            .into_iter()
            .find(|friend| friend.ed_pubkey_hex == invalid_peer)
            .expect("invalid peer");
        assert_eq!(invalid_friend.last_studied_with, Some(7));
    }
}
