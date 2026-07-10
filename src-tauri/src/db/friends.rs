//! `friends` table queries. `ed_pubkey_hex` is the primary key and canonical
//! identity; `add` is an upsert on it (re-pairing refreshes `x_pubkey_hex` /
//! `display_name` / `paired_at` but never resets `last_studied_with`). Serde
//! emits field names verbatim (snake_case) — the TS `Friend` type in
//! `src/lib/db/friends.ts` mirrors them; keep the two aligned.

use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Friend {
    pub ed_pubkey_hex: String,
    pub x_pubkey_hex: String,
    pub display_name: Option<String>,
    pub paired_at: Option<i64>,
    pub last_studied_with: Option<i64>,
}

pub fn list(conn: &Connection) -> Result<Vec<Friend>> {
    let mut stmt = conn.prepare(
        "SELECT ed_pubkey_hex, x_pubkey_hex, display_name, paired_at, last_studied_with
         FROM friends
         ORDER BY paired_at DESC, ed_pubkey_hex ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Friend {
            ed_pubkey_hex: row.get(0)?,
            x_pubkey_hex: row.get(1)?,
            display_name: row.get(2)?,
            paired_at: row.get(3)?,
            last_studied_with: row.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn add(
    conn: &Connection,
    ed_pubkey_hex: &str,
    x_pubkey_hex: &str,
    display_name: &str,
    paired_at: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO friends (ed_pubkey_hex, x_pubkey_hex, display_name, paired_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(ed_pubkey_hex) DO UPDATE SET
             x_pubkey_hex = excluded.x_pubkey_hex,
             display_name = excluded.display_name,
             paired_at    = excluded.paired_at",
        params![ed_pubkey_hex, x_pubkey_hex, display_name, paired_at],
    )?;
    Ok(())
}

// #47 A4 — backup-import upsert: restore what's missing, never rewind what's
// fresher locally. A months-old .svfb is the realistic import, so for an
// existing row keep the local x_pubkey_hex (re-pairing may have rotated it
// since the backup was written — rewinding it would break the invite
// channel), keep a non-empty local display_name and a non-null paired_at,
// and take the later of the two last_studied_with values (NULL-preserving so
// a never-studied pair doesn't gain a bogus epoch-0 timestamp). New rows
// insert the backup verbatim. Contrast with `add`, whose overwrite semantics
// are correct for live re-pairing and must stay that way.
pub fn import_merge(conn: &Connection, f: &Friend) -> Result<()> {
    conn.execute(
        "INSERT INTO friends (ed_pubkey_hex, x_pubkey_hex, display_name, paired_at, last_studied_with)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(ed_pubkey_hex) DO UPDATE SET
             display_name      = COALESCE(NULLIF(friends.display_name, ''), excluded.display_name),
             paired_at         = COALESCE(friends.paired_at, excluded.paired_at),
             last_studied_with = CASE
                 WHEN friends.last_studied_with IS NULL THEN excluded.last_studied_with
                 WHEN excluded.last_studied_with IS NULL THEN friends.last_studied_with
                 ELSE MAX(friends.last_studied_with, excluded.last_studied_with)
             END",
        params![
            f.ed_pubkey_hex,
            f.x_pubkey_hex,
            f.display_name,
            f.paired_at,
            f.last_studied_with
        ],
    )?;
    Ok(())
}

pub fn remove(conn: &Connection, ed_pubkey_hex: &str) -> Result<usize> {
    conn.execute(
        "DELETE FROM friends WHERE ed_pubkey_hex = ?1",
        params![ed_pubkey_hex],
    )
}

pub fn update_last_studied(conn: &Connection, ed_pubkey_hex: &str, ts: i64) -> Result<usize> {
    conn.execute(
        "UPDATE friends SET last_studied_with = ?1 WHERE ed_pubkey_hex = ?2",
        params![ts, ed_pubkey_hex],
    )
}

pub fn get_x_pubkey(conn: &Connection, ed_pubkey_hex: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT x_pubkey_hex FROM friends WHERE ed_pubkey_hex = ?1",
        params![ed_pubkey_hex],
        |row| row.get::<_, String>(0),
    )
    .optional()
}
