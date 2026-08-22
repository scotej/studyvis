// The lab's SQLite layer.
//
// Fidelity rule for this file: the schema is the SHIPPED schema (the very
// `src-tauri/src/db/migrations/*.sql` files the app runs), and every statement
// below is copied verbatim from its Rust twin in `src-tauri/src/db/`. That is
// what makes a lab scenario's stored history mean the same thing a real
// install's does — upsert precedence, COALESCE retention and the `sig`
// idempotence guard included. If you change a query in Rust, change it here.
//
// What this does NOT cover, and must not be claimed to: the Rust migration
// runner and its `user_version` bookkeeping, `schema_repair`, corrupt-database
// recovery, or the command wrappers' error strings. Those are `cargo test`'s.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  '../../../src-tauri/src/db/migrations'
)

export type Friend = {
  ed_pubkey_hex: string
  x_pubkey_hex: string
  display_name: string | null
  paired_at: number | null
  last_studied_with: number | null
}

export type SessionRecord = {
  id: string
  started_at: number | null
  ended_at: number | null
  total_minutes: number | null
  total_duration_ms: number | null
  peer_pubkeys: string | null
  declared_topic: string | null
  score: number | null
  focused_pct: number | null
  generated_at: number | null
  confident_samples: number | null
  skipped_samples: number | null
  ai_enabled: number | null
  local_ed_pubkey: string | null
  local_display_name: string | null
  peer_presence_ms: string | null
}

export type AuditEventRecord = {
  session_id: string
  ts: number
  who: string
  kind: string
  detail: string
  sig: string
}

const SESSION_COLUMNS = `id, started_at, ended_at, total_minutes, total_duration_ms, peer_pubkeys,
                declared_topic, score, focused_pct, generated_at,
                confident_samples, skipped_samples, ai_enabled,
                local_ed_pubkey, local_display_name, peer_presence_ms`

const SESSION_INSERT_HEAD = `INSERT INTO sessions
             (id, started_at, ended_at, total_minutes, total_duration_ms, peer_pubkeys,
              declared_topic, score, focused_pct, generated_at,
              confident_samples, skipped_samples, ai_enabled,
              local_ed_pubkey, local_display_name, peer_presence_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

type SqlValue = string | number | null

export class LabDb {
  private readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  // Mirrors `run_migrations` in src-tauri/src/db/migrations.rs: a
  // `schema_version` table, forward-only application of anything newer than the
  // recorded max, and a refusal to open a database written by a newer build.
  // Without the version gate, reopening a machine's disk re-runs 003's
  // `ALTER TABLE … ADD COLUMN` and fails — which is exactly the bug the real
  // runner exists to prevent, so the lab reproduces it faithfully by reusing
  // the same rule rather than by re-executing every file.
  private migrate(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)'
    )
    const migrations = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => ({
        version: Number.parseInt(name.slice(0, 3), 10),
        sql: readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
      }))
    const maxKnown = migrations[migrations.length - 1]?.version ?? 0

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db
        .prepare('SELECT MAX(version) AS version FROM schema_version')
        .get() as { version: number | null } | undefined
      const current = row?.version ?? 0
      if (current > maxKnown) {
        throw new Error(
          `lab: this machine's database is schema version ${current}, newer than the ${maxKnown} these migrations know`
        )
      }
      for (const { version, sql } of migrations) {
        if (version <= current) continue
        this.db.exec(sql)
        this.db
          .prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)')
          .run(version)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  close(): void {
    this.db.close()
  }

  // --- friends ------------------------------------------------------------

  friendsList(): Friend[] {
    return this.db
      .prepare(
        `SELECT ed_pubkey_hex, x_pubkey_hex, display_name, paired_at, last_studied_with
         FROM friends
         ORDER BY paired_at DESC, ed_pubkey_hex ASC`
      )
      .all() as unknown as Friend[]
  }

  friendsAdd(
    edPubkey: string,
    xPubkey: string,
    name: string,
    ts: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO friends (ed_pubkey_hex, x_pubkey_hex, display_name, paired_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(ed_pubkey_hex) DO UPDATE SET
             x_pubkey_hex = excluded.x_pubkey_hex,
             display_name = excluded.display_name,
             paired_at    = excluded.paired_at`
      )
      .run(edPubkey, xPubkey, name, ts)
  }

  friendsRemove(edPubkey: string): void {
    this.db.prepare('DELETE FROM friends WHERE ed_pubkey_hex = ?').run(edPubkey)
  }

  friendsUpdateLastStudied(edPubkey: string, ts: number): void {
    this.db
      .prepare(
        `UPDATE friends SET last_studied_with = ?
         WHERE ed_pubkey_hex = ?
           AND (last_studied_with IS NULL OR last_studied_with < ?)`
      )
      .run(ts, edPubkey, ts)
  }

  friendsGetXPubkey(edPubkey: string): string | null {
    const row = this.db
      .prepare('SELECT x_pubkey_hex FROM friends WHERE ed_pubkey_hex = ?')
      .get(edPubkey) as { x_pubkey_hex?: string } | undefined
    return row?.x_pubkey_hex ?? null
  }

  // --- sessions -----------------------------------------------------------

  sessionsList(): SessionRecord[] {
    return this.db
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY started_at DESC, id ASC`
      )
      .all() as unknown as SessionRecord[]
  }

  sessionsGet(id: string): SessionRecord | null {
    const row = this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
      .get(id)
    return (row as unknown as SessionRecord) ?? null
  }

  sessionsInsert(row: SessionRecord, replaceFocusMetrics: boolean): void {
    // `?17` in Rust is the replace-focus-metrics flag, referenced three times.
    // node:sqlite binds positionally, so it is repeated in the parameter list.
    this.db
      .prepare(
        `${SESSION_INSERT_HEAD}
         ON CONFLICT(id) DO UPDATE SET
             started_at     = excluded.started_at,
             ended_at       = excluded.ended_at,
             total_minutes  = excluded.total_minutes,
             total_duration_ms = excluded.total_duration_ms,
             peer_pubkeys   = COALESCE(excluded.peer_pubkeys, sessions.peer_pubkeys),
             declared_topic = COALESCE(excluded.declared_topic, sessions.declared_topic),
             score          = CASE WHEN ? THEN excluded.score ELSE COALESCE(excluded.score, sessions.score) END,
             focused_pct    = CASE WHEN ? THEN excluded.focused_pct ELSE COALESCE(excluded.focused_pct, sessions.focused_pct) END,
             generated_at   = COALESCE(excluded.generated_at, sessions.generated_at),
             confident_samples = CASE WHEN ? THEN excluded.confident_samples ELSE COALESCE(excluded.confident_samples, sessions.confident_samples) END,
             skipped_samples   = CASE WHEN ? THEN excluded.skipped_samples ELSE COALESCE(excluded.skipped_samples, sessions.skipped_samples) END,
             ai_enabled        = CASE WHEN ? THEN excluded.ai_enabled ELSE COALESCE(excluded.ai_enabled, sessions.ai_enabled) END,
             local_ed_pubkey   = sessions.local_ed_pubkey,
             local_display_name = sessions.local_display_name,
             peer_presence_ms = COALESCE(excluded.peer_presence_ms, sessions.peer_presence_ms)`
      )
      .run(
        ...sessionParams(row),
        ...Array<number>(5).fill(replaceFocusMetrics ? 1 : 0)
      )
  }

  sessionsInsertIfAbsent(row: SessionRecord): boolean {
    const result = this.db
      .prepare(`${SESSION_INSERT_HEAD} ON CONFLICT(id) DO NOTHING`)
      .run(...sessionParams(row))
    return result.changes === 1
  }

  sessionsDelete(id: string): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM audit_events WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  sessionsClearAll(): void {
    this.db.exec('BEGIN')
    try {
      this.db.exec('DELETE FROM audit_events')
      this.db.exec('DELETE FROM sessions')
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  // --- audit events -------------------------------------------------------

  auditInsert(row: AuditEventRecord): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (session_id, ts, who, kind, detail, sig)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE sig = ?)`
      )
      .run(
        row.session_id,
        row.ts,
        row.who,
        row.kind,
        row.detail,
        row.sig,
        row.sig
      )
  }

  auditListForSession(sessionId: string): AuditEventRecord[] {
    return this.db
      .prepare(
        `SELECT session_id, ts, who, kind, detail, sig
         FROM audit_events
         WHERE session_id = ?
         ORDER BY ts ASC, id ASC`
      )
      .all(sessionId) as unknown as AuditEventRecord[]
  }

  auditListAll(): AuditEventRecord[] {
    return this.db
      .prepare(
        `SELECT session_id, ts, who, kind, detail, sig
         FROM audit_events
         WHERE kind IN ('ai_warning', 'ai_alert')
         ORDER BY session_id ASC, ts ASC, id ASC`
      )
      .all() as unknown as AuditEventRecord[]
  }
}

function sessionParams(row: SessionRecord): SqlValue[] {
  return [
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
  ]
}
