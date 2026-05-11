// V2-P5 — Minimal break-state store consumed by the sample loop.
//
// V2-P5 only needs to read `onBreak: boolean` so the sample loop can skip
// inference ticks while a break is active (ARCHITECTURE.md §8 sample loop:
// "if user_on_break: skip"). The actual break feature — request flow,
// approve/deny rules, countdown UI — lands in V2-P7's AI break dialogue
// (`features/session/break.requestBreak`), which will set this flag.
//
// Kept in `src/features/ai/` because the only V2-P5 consumer is the AI
// sample loop. V2-P7 may extend the store with break duration / breaks-per-
// session bookkeeping or move it under `features/session/`; either way the
// `onBreak` boolean stays as the surface the sample loop reads.

import { create } from 'zustand'

type BreakState = {
  onBreak: boolean
  startBreak: () => void
  endBreak: () => void
  reset: () => void
}

export const useBreakStore = create<BreakState>((set) => ({
  onBreak: false,
  startBreak: () => set({ onBreak: true }),
  endBreak: () => set({ onBreak: false }),
  reset: () => set({ onBreak: false }),
}))
