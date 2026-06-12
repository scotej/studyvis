// N2 / N6 — react to LOCAL pomodoro work↔rest transitions.
//
// The local 5-state machine's phase lives in `usePomodoroStore`, updated by
// the controller's `onSnapshot`. We observe THAT — the local phase only — so
// nothing here touches the I9 broadcaster-authority protocol (no wire change,
// no broadcaster read). Whoever is broadcaster, every peer's local snapshot
// flips work→rest / rest→work in lockstep, and that flip is all we need.
//
// On a work↔rest boundary we (a) fire an OS notification when N2 is enabled
// and the user isn't actively looking at the timer, and (b) play a chime when
// N6 is enabled. Start (idle→work) and stop (work→idle) are NOT boundaries —
// they're not "time for a break" / "back to work" moments — so they're
// excluded.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

import type { PomodoroPhase } from '@/lib/pomodoro-types'
import { strings } from '@/strings'

import { playPomodoroChime } from './pomodoroSound'

export type PhaseTransition = 'to-rest' | 'to-work' | null

function family(phase: PomodoroPhase): 'work' | 'rest' | 'idle' {
  if (phase === 'idle') return 'idle'
  return phase.startsWith('work') ? 'work' : 'rest'
}

// Pure: classify a (prev → next) phase pair as a work↔rest boundary. Returns
// null for non-boundary changes (start, stop, no-op, preset relabel within the
// same family). Easy to unit-test for every pair.
export function detectPhaseTransition(
  prev: PomodoroPhase,
  next: PomodoroPhase
): PhaseTransition {
  const from = family(prev)
  const to = family(next)
  if (from === 'work' && to === 'rest') return 'to-rest'
  if (from === 'rest' && to === 'work') return 'to-work'
  return null
}

// Whether the user is actively looking at the window (N2 suppression). When
// the window is both visible and focused the OS notification is noise — the
// timer flip is right there on screen — so we skip it. The whole motivation
// is the minimized-to-tray case, where neither is true.
function userIsLookingAtTimer(): boolean {
  if (typeof document === 'undefined') return false
  const visible = document.visibilityState === 'visible'
  const focused = typeof document.hasFocus === 'function' && document.hasFocus()
  return visible && focused
}

async function sendTransitionNotification(
  transition: Exclude<PhaseTransition, null>
): Promise<void> {
  const copy = strings.notifications.pomodoro
  const { title, body } =
    transition === 'to-rest'
      ? { title: copy.breakTitle, body: copy.breakBody }
      : { title: copy.workTitle, body: copy.workBody }
  try {
    let granted = await isPermissionGranted()
    if (!granted) {
      const result = await requestPermission()
      granted = result === 'granted'
    }
    if (granted) await sendNotification({ title, body })
  } catch {
    // Notification plugin is best-effort — a failure is silent (the in-app
    // timer remains the source of truth).
  }
}

export type PomodoroTransitionDeps = {
  // N2 — OS notification gate (opt-out, ON by default).
  notificationsEnabled: () => boolean
  // N6 — chime gate (opt-in, OFF by default).
  soundEnabled: () => boolean
  // Seams so the unit test can drive the side effects without Tauri / Audio.
  notify?: (transition: Exclude<PhaseTransition, null>) => void
  playChime?: () => void
  isLookingAtTimer?: () => boolean
}

// Side-effecting handler for one detected transition. Pulled out from the
// store subscription so it can be unit-tested directly.
export function handlePomodoroTransition(
  transition: PhaseTransition,
  deps: PomodoroTransitionDeps
): void {
  if (transition === null) return
  const looking = (deps.isLookingAtTimer ?? userIsLookingAtTimer)()
  if (deps.notificationsEnabled() && !looking) {
    const notify = deps.notify ?? ((t) => void sendTransitionNotification(t))
    notify(transition)
  }
  if (deps.soundEnabled()) {
    const play = deps.playChime ?? playPomodoroChime
    play()
  }
}
