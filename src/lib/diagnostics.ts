import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'

import { flushLog } from '@/lib/log'
import { strings } from '@/strings'

export type DiagnosticsExportResult =
  { kind: 'saved'; path: string } | { kind: 'cancelled' }

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
  options: { defaultPath?: string; sessionPrefix?: string | null } = {},
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

  await deps.flush()
  const exportedPath = await deps.exportArchive(
    path,
    options.sessionPrefix ?? null
  )
  return { kind: 'saved', path: exportedPath }
}
