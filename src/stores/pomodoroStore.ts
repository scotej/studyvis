import { create } from 'zustand'

import type { PomodoroSnapshot } from '@/lib/pomodoro-types'

const INITIAL: PomodoroSnapshot = {
  phase: 'idle',
  endsAt: null,
  preset: null,
  workMs: null,
  restMs: null,
  broadcasterEdPubkey: null,
  iAmBroadcaster: false,
}

type PomodoroStoreState = PomodoroSnapshot & {
  apply: (snapshot: PomodoroSnapshot) => void
  reset: () => void
}

export const usePomodoroStore = create<PomodoroStoreState>((set) => ({
  ...INITIAL,
  apply: (snapshot) => set({ ...snapshot }),
  reset: () => set({ ...INITIAL }),
}))
