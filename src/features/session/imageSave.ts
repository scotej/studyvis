import { invoke } from '@tauri-apps/api/core'

import type { ImageMimeType } from './images'

export type SaveImageDeps = {
  saveFile: (options: {
    filename: string
    mimeType: ImageMimeType
    bytes: number[]
  }) => Promise<boolean>
}

const defaultDeps: SaveImageDeps = {
  saveFile: (options) => invoke<boolean>('system_save_image', options),
}

export async function saveSessionImage(
  blob: Blob,
  filename: string,
  mimeType: ImageMimeType,
  deps: SaveImageDeps = defaultDeps
): Promise<'saved' | 'cancelled'> {
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
  const saved = await deps.saveFile({ filename, mimeType, bytes })
  return saved ? 'saved' : 'cancelled'
}
