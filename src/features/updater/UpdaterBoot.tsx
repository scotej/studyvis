// X6 — owns *when* the updater runs. The store owns what it does.
//
// Two rules shape the schedule:
//
//   1. Nothing outbound while `autoUpdateEnabled` is off. The effect bails
//      before the first check, which is what keeps the PLAN §3 promise the
//      toggle's help text makes.
//   2. Nothing at all during a session. A check is a trivial request, but the
//      download that follows it is not — pulling an installer while three
//      people are on a WebRTC mesh is exactly the bandwidth you don't have to
//      spare. Sessions are finite; the update waits.
//
// The first check is delayed rather than fired at mount so it doesn't race
// P2P discovery for the network on a cold launch.

import { useEffect } from 'react'

import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'

import { useUpdaterStore } from './updaterStore'

// Long enough to stay out of the way of boot: identity load, relay
// connection, and presence all land well inside it.
const FIRST_CHECK_DELAY_MS = 20_000
// Friends ship releases in bursts, not continuously. Six hours catches a
// same-day release without meaningful traffic.
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export function UpdaterBoot() {
  const autoUpdateEnabled = useSettingsStore((s) => s.values.autoUpdateEnabled)
  const settingsStatus = useSettingsStore((s) => s.status)
  const sessionStatus = useSessionStore((s) => s.status)
  const checkNow = useUpdaterStore((s) => s.checkNow)

  const sessionActive = sessionStatus === 'active'

  useEffect(() => {
    // Wait for the persisted value: hydrating later would let one check slip
    // out on the `true` default before we learn the user turned it off.
    if (settingsStatus !== 'ready' || !autoUpdateEnabled || sessionActive)
      return

    let cancelled = false
    const run = () => {
      if (cancelled) return
      void checkNow()
    }

    const first = setTimeout(run, FIRST_CHECK_DELAY_MS)
    const repeat = setInterval(run, RECHECK_INTERVAL_MS)
    return () => {
      cancelled = true
      clearTimeout(first)
      clearInterval(repeat)
    }
    // Re-running on `sessionActive` is the point: the timers are torn down
    // when a session starts and re-armed (delay included) when it ends.
  }, [settingsStatus, autoUpdateEnabled, sessionActive, checkNow])

  return null
}
