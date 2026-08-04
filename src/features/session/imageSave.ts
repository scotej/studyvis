import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'

import type { ImageMimeType } from './images'
import { imageExtensionForMime } from './images'

export type SaveImageDeps = {
  pickPath: (options: {
    defaultPath: string
    filters: { name: string; extensions: string[] }[]
  }) => Promise<string | null>
  writeFile: (path: string, bytes: number[]) => Promise<void>
}

const defaultDeps: SaveImageDeps = {
  pickPath: (options) => save(options),
  writeFile: (path, bytes) =>
    invoke('system_write_binary_file', { path, bytes }),
}

export async function saveSessionImage(
  blob: Blob,
  filename: string,
  mimeType: ImageMimeType,
  deps: SaveImageDeps = defaultDeps
): Promise<'saved' | 'cancelled'> {
  const extension = imageExtensionForMime(mimeType)
  const path = await deps.pickPath({
    defaultPath: filename,
    filters: [{ name: 'Image', extensions: [extension] }],
  })
  if (path == null) return 'cancelled'
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
  await deps.writeFile(path, bytes)
  return 'saved'
}
