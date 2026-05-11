// V2-P6 — peer-alert tone player.
//
// The asset itself lives at the repo-root path the prompt + DESIGN-SYSTEM
// §13 prescribe: `assets/sounds/peer_alert.opus`. Vite resolves the
// relative import below into a hashed URL in production; in tests the
// import resolves to a stub string but `playPeerAlertSound` is never
// invoked from test code paths (dispatcher tests inject a stub
// `playPeerAlertSound` runtime).
//
// The tone is a short two-step chirp (700 Hz → 1050 Hz, ~440 ms total)
// with gentle fades — "noticeable but not jarring" per DESIGN-SYSTEM
// §13. Composed locally via ffmpeg's lavfi sine generator + libopus.

import alertSoundUrl from '../../../assets/sounds/peer_alert.opus'

export { alertSoundUrl }

// Default JS playback uses HTMLAudioElement so we sidestep the AudioContext
// "auto-play requires a user gesture" trap on some webviews: the alert
// always fires inside a session room the user explicitly joined, so the
// gesture-allowance carries.
export type AlertSoundRuntime = {
  play: () => void
}

function makeDefaultRuntime(): AlertSoundRuntime {
  // Defer constructing the Audio element until first play() so the JSDOM /
  // node test environment never tries to instantiate it.
  let audio: HTMLAudioElement | null = null
  return {
    play: () => {
      if (typeof window === 'undefined') return
      try {
        if (!audio) {
          audio = new Audio(alertSoundUrl)
          audio.preload = 'auto'
          audio.volume = 1
        }
        audio.currentTime = 0
        void audio.play().catch((err) => {
          console.warn('[alertSound] play failed:', err)
        })
      } catch (err) {
        console.warn('[alertSound] play threw:', err)
      }
    },
  }
}

let activeRuntime: AlertSoundRuntime = makeDefaultRuntime()

export function playPeerAlertSound(): void {
  activeRuntime.play()
}

export function __setAlertSoundRuntime(runtime: AlertSoundRuntime): void {
  activeRuntime = runtime
}

export function __resetAlertSoundRuntime(): void {
  activeRuntime = makeDefaultRuntime()
}
