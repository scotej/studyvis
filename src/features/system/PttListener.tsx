import { useEffect } from 'react'

import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { usePttStore } from '@/stores/pttStore'

export const PTT_FRIENDS_PRESSED = 'ptt-friends-pressed'
export const PTT_FRIENDS_RELEASED = 'ptt-friends-released'

export function PttListener() {
  useEffect(() => {
    const unlisteners: UnlistenFn[] = []
    let cancelled = false

    const press = usePttStore.getState().press
    const release = usePttStore.getState().release

    const wire = async () => {
      try {
        const a = await listen(PTT_FRIENDS_PRESSED, () => press())
        if (cancelled) {
          a()
          return
        }
        unlisteners.push(a)

        const b = await listen(PTT_FRIENDS_RELEASED, () => release())
        if (cancelled) {
          b()
          return
        }
        unlisteners.push(b)
      } catch {
        // Outside a Tauri runtime (Vitest, Storybook, plain web preview) the
        // event bridge is absent. PTT just stays inactive — no UI fallback.
      }
    }

    void wire()

    // No blur-release failsafe: the friends shortcut is a GLOBAL shortcut whose
    // Released event is delivered system-wide regardless of window focus, so
    // PTT must keep transmitting while the user works in another app (the whole
    // point of hold-to-talk during a body-doubling session). Releasing on blur
    // would cut audio mid-sentence in exactly that scenario. The genuinely
    // dropped-release case is covered by the store's MAX_HOLD_MS stuck-key
    // failsafe plus the per-session reset().

    return () => {
      cancelled = true
      for (const u of unlisteners) u()
    }
  }, [])

  return null
}
