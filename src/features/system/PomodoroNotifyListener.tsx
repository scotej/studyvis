import { useEffect, useRef } from 'react'

import {
  detectPhaseTransition,
  handlePomodoroTransition,
} from '@/features/session/pomodoroNotify'
import type { PomodoroPhase } from '@/lib/pomodoro-types'
import { usePomodoroStore } from '@/stores/pomodoroStore'
import { useSettingsStore } from '@/stores/settingsStore'

// N2 / N6 — app-wide observer of the LOCAL pomodoro phase. Mounted once in
// App.tsx alongside the other system listeners. Subscribes to the pomodoro
// store (local read only — no broadcaster authority, no wire change, so I9 is
// untouched) and fires an OS notification + chime on each work↔rest boundary,
// each gated by its own setting. Idle transitions (start / stop) are filtered
// out by `detectPhaseTransition`.
export function PomodoroNotifyListener() {
  const prevPhaseRef = useRef<PomodoroPhase>(usePomodoroStore.getState().phase)

  useEffect(() => {
    const unsub = usePomodoroStore.subscribe((state) => {
      const prev = prevPhaseRef.current
      const next = state.phase
      if (next === prev) return
      prevPhaseRef.current = next
      const transition = detectPhaseTransition(prev, next)
      if (transition === null) return
      handlePomodoroTransition(transition, {
        notificationsEnabled: () =>
          useSettingsStore.getState().values.pomodoroNotificationEnabled,
        soundEnabled: () =>
          useSettingsStore.getState().values.pomodoroSoundEnabled,
      })
    })
    return () => unsub()
  }, [])

  return null
}
