// R3 — local file export shared by the report ("Save as…", raw audit JSON)
// and the stats dashboard ("Export CSV").
//
// The dialog plugin's save() only returns a user-chosen path; it can't write
// the file. @tauri-apps/plugin-fs is not installed, so the actual write goes
// through the small `system_write_text_file` Rust command (least-new-surface:
// it only writes the path the user just picked in the picker). Everything
// here that doesn't touch Tauri (filename slug, CSV builder) is pure and
// unit-tested so the formatting is pinned without a runtime.

import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'

export type SaveTextFileResult =
  | { kind: 'saved'; path: string }
  | { kind: 'cancelled' }

export type DialogFilter = { name: string; extensions: string[] }

export type SaveTextFileDeps = {
  // Injectable seams so the orchestration is node-testable without Tauri.
  pickPath: (options: {
    defaultPath?: string
    filters?: DialogFilter[]
  }) => Promise<string | null>
  writeFile: (path: string, contents: string) => Promise<void>
}

const defaultDeps: SaveTextFileDeps = {
  pickPath: (options) => save(options),
  writeFile: (path, contents) =>
    invoke('system_write_text_file', { path, contents }),
}

// Opens the OS save dialog, then writes `contents` to the chosen path.
// Returns 'cancelled' when the user dismisses the picker (no toast on that
// path); throws on a real write failure so the caller surfaces an error
// toast.
export async function saveTextFile(
  contents: string,
  options: { defaultPath: string; filters?: DialogFilter[] },
  deps: SaveTextFileDeps = defaultDeps
): Promise<SaveTextFileResult> {
  const path = await deps.pickPath({
    defaultPath: options.defaultPath,
    filters: options.filters,
  })
  if (path == null) return { kind: 'cancelled' }
  await deps.writeFile(path, contents)
  return { kind: 'saved', path }
}

// Filesystem-safe slug for a default filename stem: lowercase, alnum +
// dashes, collapsed runs, trimmed. Empty input falls back to `fallback`.
export function slugify(input: string, fallback = 'export'): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  return slug || fallback
}

// YYYY-MM-DD stamp for a default filename, in the runtime-local zone (tests
// pass an explicit `timeZone`). Mirrors statsData.dayKey's en-CA approach so
// the stamp sorts lexicographically.
export function fileDateStamp(ts: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts))
}

// RFC-4180-ish CSV cell escaping: wrap in quotes and double internal quotes
// when the value contains a comma, quote, or newline. String cells are also
// guarded against spreadsheet formula injection (PR-10).
export function csvCell(value: string | number): string {
  // Numeric cells are our own data, never a user-controlled formula — and a
  // negative number legitimately begins with '-', so it must NOT be prefixed.
  if (typeof value === 'number') {
    const n = String(value)
    return /[",\n\r]/.test(n) ? `"${n.replace(/"/g, '""')}"` : n
  }
  let s = value
  // PR-10 — neutralize CSV/formula injection. A peer- or stranger-chosen string
  // (a friend display name flows verbatim into the stats CSV) beginning with a
  // formula trigger would execute when the file is opened in Excel / LibreOffice
  // / Google Sheets — data exfiltration via =HYPERLINK, command execution via a
  // =cmd|'/c …'!A1 DDE payload. Leading whitespace (tab / CR / LF) counts too:
  // a spreadsheet that trims it re-exposes a following trigger. Prefixing a
  // single quote makes the cell text.
  if (/^[=+\-@\t\r\n]/.test(s)) {
    s = `'${s}`
  }
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Builds a CSV string from a header row + body rows. Cells are escaped; rows
// are CRLF-joined (Excel-friendly) with a trailing newline.
export function buildCsv(
  header: readonly (string | number)[],
  rows: readonly (readonly (string | number)[])[]
): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','))
  return lines.join('\r\n') + '\r\n'
}
