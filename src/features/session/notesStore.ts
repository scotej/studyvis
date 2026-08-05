import { create } from 'zustand'

// #47 B6 — session-scoped, in-memory-only note feed. Deliberately never
// persisted (no SQLite, no LazyStore): notes are ephemeral by design so the
// feature stays clear of the recording non-goal (PLAN §6). Reset alongside
// the other per-session stores when a new session begins. Capped so a chatty
// 90-minute session can't grow memory unbounded.

export const NOTES_CAP = 100
export const IMAGES_CAP = 12
export const IMAGES_MAX_STORED_BYTES = 20 * 1024 * 1024
export const IMAGES_MAX_STORED_PIXELS = 64 * 1024 * 1024

export type SessionNote = {
  // `${from}:${ts}:${seq}` — unique enough for React keys within a session.
  id: string
  fromEdPubkeyHex: string
  mine: boolean
  text: string
  ts: number
}

export type SessionImage = {
  id: string
  fromEdPubkeyHex: string
  mine: boolean
  blob: Blob
  objectUrl: string
  filename: string
  mimeType: string
  width: number
  height: number
  frameCount: number
  ts: number
}

type NotesState = {
  notes: ReadonlyArray<SessionNote>
  images: ReadonlyArray<SessionImage>
  append: (note: Omit<SessionNote, 'id'>) => void
  appendImage: (image: Omit<SessionImage, 'id' | 'objectUrl'>) => void
  reset: () => void
}

let seq = 0

export const useNotesStore = create<NotesState>((set) => ({
  notes: [],
  images: [],
  append: (note) =>
    set((s) => {
      const entry: SessionNote = {
        ...note,
        id: `${note.fromEdPubkeyHex}:${note.ts}:${seq++}`,
      }
      const next = [...s.notes, entry]
      return { notes: next.length > NOTES_CAP ? next.slice(-NOTES_CAP) : next }
    }),
  appendImage: (image) =>
    set((s) => {
      const entry: SessionImage = {
        ...image,
        id: `${image.fromEdPubkeyHex}:${image.ts}:${seq++}`,
        objectUrl: URL.createObjectURL(image.blob),
      }
      const next = [...s.images, entry]
      const kept = [...next]
      let encodedBytes = kept.reduce((total, item) => total + item.blob.size, 0)
      let decodedPixels = kept.reduce(
        (total, item) => total + item.width * item.height * item.frameCount,
        0
      )
      while (
        kept.length > IMAGES_CAP ||
        encodedBytes > IMAGES_MAX_STORED_BYTES ||
        decodedPixels > IMAGES_MAX_STORED_PIXELS
      ) {
        const removed = kept.shift()
        if (!removed) break
        encodedBytes -= removed.blob.size
        decodedPixels -= removed.width * removed.height * removed.frameCount
        URL.revokeObjectURL(removed.objectUrl)
      }
      return { images: kept }
    }),
  reset: () =>
    set((s) => {
      for (const image of s.images) URL.revokeObjectURL(image.objectUrl)
      return { notes: [], images: [] }
    }),
}))
