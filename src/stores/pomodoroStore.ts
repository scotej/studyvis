import { create } from 'zustand'

import type { PomodoroSnapshot } from '@/features/session/pomodoro'

const INITIAL: PomodoroSnapshot = {
  phase: 'idle',
  endsAt: null,
  preset: null,
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
