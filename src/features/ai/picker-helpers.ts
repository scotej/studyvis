// Helpers split out of ModelPicker.tsx so the React Refresh boundary
// (`react-refresh/only-export-components`) holds: the .tsx file exports
// React components only; this module owns the pure functions consumed
// by the container + unit tests.

import type { ProgressEvent } from './download'
import type { DownloadPhase, PickerStateForModel } from './ModelPicker'
import { SUPPORTED_MODELS } from './models'

export function progressEventToPhase(evt: ProgressEvent): DownloadPhase | null {
  if (evt.phase === 'downloading') {
    return evt.file === 'mmproj' ? 'downloading-mmproj' : 'downloading-model'
  }
  if (evt.phase === 'verifying') return 'verifying'
  return null
}

export function downloadFraction(evt: ProgressEvent): number | null {
  if (evt.total_bytes <= 0) return null
  const filePart = evt.bytes_received / evt.total_bytes
  const total = evt.file_count > 0 ? evt.file_count : 1
  return Math.min(1, (evt.file_index + filePart) / total)
}

export function emptyPickerState(): Record<string, PickerStateForModel> {
  return Object.fromEntries(
    SUPPORTED_MODELS.map((spec) => [
      spec.id,
      {
        spec,
        installState: { modelExists: false, mmprojExists: false },
        record: null,
        phase: 'idle' as const,
        downloadProgress: null,
        errorMessage: null,
      } satisfies PickerStateForModel,
    ])
  ) as Record<string, PickerStateForModel>
}
