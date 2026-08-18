import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'

import { flushLog } from '@/lib/log'
import { strings } from '@/strings'

export type DiagnosticsExportResult =
  { kind: 'saved'; path: string } | { kind: 'cancelled' }

// What the user was doing when they asked for diagnostics. Carried on the
// snapshot record so a reader can tell an archive saved from Settings apart
// from one attached to an in-app report.
export type DiagnosticsTrigger =
  'settings-archive' | 'settings-clipboard' | 'report-archive'

type DiagnosticsSnapshotHook = (trigger: DiagnosticsTrigger) => void

// #226 — the archive never recorded what was live at the moment the user
// complained, so a symptom the logs did not already explain was unfalsifiable.
// The slot lives here and features register into it, keeping the direction of
// the dependency right: src/lib never imports src/features.
let snapshotHook: DiagnosticsSnapshotHook | null = null

export function setDiagnosticsSnapshotHook(
  hook: DiagnosticsSnapshotHook | null
): void {
  snapshotHook = hook
}

// Must run BEFORE the flush that precedes the archive build, or the record it
// writes misses the very archive it describes. Never throws into the export.
export function captureDiagnosticsSnapshot(trigger: DiagnosticsTrigger): void {
  try {
    snapshotHook?.(trigger)
  } catch {
    // A broken observer must not cost the user their bug report.
  }
}

export type DiagnosticsExportDeps = {
  pickPath: (options: {
    defaultPath: string
    filters: Array<{ name: string; extensions: string[] }>
  }) => Promise<string | null>
  flush: () => Promise<void>
  exportArchive: (path: string, sessionPrefix: string | null) => Promise<string>
}

const defaultDeps: DiagnosticsExportDeps = {
  pickPath: (options) => save(options),
  flush: flushLog,
  exportArchive: (path, sessionPrefix) =>
    invoke<string>('diagnostics_export', { path, sessionPrefix }),
}

export async function saveDiagnosticsArchive(
  options: {
    defaultPath?: string
    sessionPrefix?: string | null
    trigger?: DiagnosticsTrigger
  } = {},
  deps: DiagnosticsExportDeps = defaultDeps
): Promise<DiagnosticsExportResult> {
  const path = await deps.pickPath({
    defaultPath: options.defaultPath ?? strings.diagnostics.defaultFilename,
    filters: [
      {
        name: strings.diagnostics.filterName,
        extensions: ['zip'],
      },
    ],
  })
  if (path == null) return { kind: 'cancelled' }

  captureDiagnosticsSnapshot(options.trigger ?? 'settings-archive')
  await deps.flush()
  const exportedPath = await deps.exportArchive(
    path,
    options.sessionPrefix ?? null
  )
  return { kind: 'saved', path: exportedPath }
}
