// N6 — gentle chime played on a local pomodoro work↔rest transition.
//
// Mirrors features/ai/alertSound.ts: a small opus asset that Vite inlines as
// a data: URI (it's well under the 4 KB inline threshold, like peer_alert),
// played via HTMLAudioElement so we sidestep the AudioContext gesture trap —
// the chime only fires inside a session room the user explicitly joined, so
// the user-gesture allowance carries.
//
// Calm posture: the chime is OFF by default (the setting opt-in is the
// reduced-motion accommodation — nothing plays unless the user asks), and the
// asset itself is short (~0.5 s), quiet, and softly faded.

import chimeUrl from '../../../assets/sounds/pomodoro_chime.opus'

export { chimeUrl }

export type PomodoroSoundRuntime = {
  play: () => void
}

function makeDefaultRuntime(): PomodoroSoundRuntime {
  // Defer constructing the Audio element until first play() so the node test
  // environment never tries to instantiate it.
  let audio: HTMLAudioElement | null = null
  return {
    play: () => {
      if (typeof window === 'undefined') return
      try {
        if (!audio) {
          audio = new Audio(chimeUrl)
          audio.preload = 'auto'
          audio.volume = 1
        }
        audio.currentTime = 0
        void audio.play().catch((err) => {
          console.warn('[pomodoroSound] play failed:', err)
        })
      } catch (err) {
        console.warn('[pomodoroSound] play threw:', err)
      }
    },
  }
}

let activeRuntime: PomodoroSoundRuntime = makeDefaultRuntime()

export function playPomodoroChime(): void {
  activeRuntime.play()
}

export function __setPomodoroSoundRuntime(runtime: PomodoroSoundRuntime): void {
  activeRuntime = runtime
}

export function __resetPomodoroSoundRuntime(): void {
  activeRuntime = makeDefaultRuntime()
}
