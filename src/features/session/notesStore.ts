import { create } from 'zustand'

// #47 B6 — session-scoped, in-memory-only note feed. Deliberately never
// persisted (no SQLite, no LazyStore): notes are ephemeral by design so the
// feature stays clear of the recording non-goal (PLAN §6). Reset alongside
// the other per-session stores when a new session begins. Capped so a chatty
// 90-minute session can't grow memory unbounded.

export const NOTES_CAP = 100

export type SessionNote = {
  // `${from}:${ts}:${seq}` — unique enough for React keys within a session.
  id: string
  fromEdPubkeyHex: string
  mine: boolean
  text: string
  ts: number
}

type NotesState = {
  notes: ReadonlyArray<SessionNote>
  append: (note: Omit<SessionNote, 'id'>) => void
  reset: () => void
}

let seq = 0

export const useNotesStore = create<NotesState>((set) => ({
  notes: [],
  append: (note) =>
    set((s) => {
      const entry: SessionNote = {
        ...note,
        id: `${note.fromEdPubkeyHex}:${note.ts}:${seq++}`,
      }
      const next = [...s.notes, entry]
      return { notes: next.length > NOTES_CAP ? next.slice(-NOTES_CAP) : next }
    }),
  reset: () => set({ notes: [] }),
}))
