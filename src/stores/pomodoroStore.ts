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
  endsAtMono: number | null
  apply: (snapshot: PomodoroSnapshot) => void
  reset: () => void
}

export const usePomodoroStore = create<PomodoroStoreState>((set) => ({
  ...INITIAL,
  endsAtMono: null,
  apply: (snapshot) =>
    set((current) => ({
      ...snapshot,
      // #392: repeated broadcasts must not rebase an unchanged phase when the
      // desktop wall clock changes after its native timeout was scheduled.
      endsAtMono:
        snapshot.endsAt === null
          ? null
          : snapshot.endsAt === current.endsAt &&
              snapshot.phase === current.phase
            ? current.endsAtMono
            : performance.now() + Math.max(0, snapshot.endsAt - Date.now()),
    })),
  reset: () => set({ ...INITIAL, endsAtMono: null }),
}))
