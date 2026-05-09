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

pub fn remove(conn: &Connection, ed_pubkey_hex: &str) -> Result<usize> {
    conn.execute(
        "DELETE FROM friends WHERE ed_pubkey_hex = ?1",
        params![ed_pubkey_hex],
    )
}

pub fn update_last_studied(
    conn: &Connection,
    ed_pubkey_hex: &str,
    ts: i64,
) -> Result<usize> {
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
