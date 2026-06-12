import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  MAX_HOLD_MS,
  __resetPttScheduler,
  __setPttScheduler,
  usePttStore,
} from '@/stores/pttStore'

describe('pttStore', () => {
  beforeEach(() => {
    __resetPttScheduler()
    usePttStore.setState({ active: false })
  })
  afterEach(() => {
    __resetPttScheduler()
  })

  test('starts inactive', () => {
    expect(usePttStore.getState().active).toBe(false)
  })

  test('press flips active to true', () => {
    usePttStore.getState().press()
    expect(usePttStore.getState().active).toBe(true)
  })

  test('release flips active to false', () => {
    usePttStore.getState().press()
    usePttStore.getState().release()
    expect(usePttStore.getState().active).toBe(false)
  })

  test('repeated press is idempotent', () => {
    usePttStore.getState().press()
    usePttStore.getState().press()
    expect(usePttStore.getState().active).toBe(true)
  })

  test('release without prior press stays inactive', () => {
    usePttStore.getState().release()
    expect(usePttStore.getState().active).toBe(false)
  })

  test('press then release then press flips correctly', () => {
    const { press, release } = usePttStore.getState()
    press()
    expect(usePttStore.getState().active).toBe(true)
    release()
    expect(usePttStore.getState().active).toBe(false)
    press()
    expect(usePttStore.getState().active).toBe(true)
  })

  test('reset clears active', () => {
    usePttStore.getState().press()
    expect(usePttStore.getState().active).toBe(true)
    usePttStore.getState().reset()
    expect(usePttStore.getState().active).toBe(false)
  })

  describe('S2 max-hold failsafe', () => {
    function fakeScheduler() {
      let nextId = 1
      const timers = new Map<number, { fn: () => void; at: number }>()
      let clock = 0
      __setPttScheduler({
        setTimeout: (fn, ms) => {
          const id = nextId++
          timers.set(id, { fn, at: clock + ms })
          return id
        },
        clearTimeout: (id) => {
          timers.delete(id)
        },
      })
      return {
        advance(ms: number) {
          clock += ms
          for (const [id, t] of [...timers.entries()]) {
            if (t.at <= clock) {
              timers.delete(id)
              t.fn()
            }
          }
        },
        pending: () => timers.size,
      }
    }

    test('a held key with a dropped release auto-releases after MAX_HOLD_MS', () => {
      const sched = fakeScheduler()
      usePttStore.getState().press()
      expect(usePttStore.getState().active).toBe(true)
      // No matching release ever arrives (the dropped-event bug).
      sched.advance(MAX_HOLD_MS)
      expect(usePttStore.getState().active).toBe(false)
    })

    test('a genuine continuous hold survives the whole window on a single press', () => {
      const sched = fakeScheduler()
      // macOS global hotkeys deliver exactly one Pressed for a physical hold
      // (no auto-repeat), so a long utterance must stay live off one press().
      usePttStore.getState().press()
      sched.advance(MAX_HOLD_MS - 1)
      expect(usePttStore.getState().active).toBe(true)
    })

    test('an explicit release before the timeout cancels the failsafe', () => {
      const sched = fakeScheduler()
      usePttStore.getState().press()
      usePttStore.getState().release()
      expect(usePttStore.getState().active).toBe(false)
      // No stray timer left to flip a future session's state.
      expect(sched.pending()).toBe(0)
      sched.advance(MAX_HOLD_MS)
      expect(usePttStore.getState().active).toBe(false)
    })

    test('a re-press re-arms the failsafe without stacking timers', () => {
      const sched = fakeScheduler()
      usePttStore.getState().press()
      sched.advance(MAX_HOLD_MS - 1)
      // A fresh press (e.g. release-then-press) re-arms from a clean window.
      usePttStore.getState().press()
      expect(sched.pending()).toBe(1)
      // The original timer would have fired here had it not been cleared.
      sched.advance(1)
      expect(usePttStore.getState().active).toBe(true)
      // It still falls back a full window after the last press.
      sched.advance(MAX_HOLD_MS)
      expect(usePttStore.getState().active).toBe(false)
    })

    test('reset cancels a pending failsafe timer', () => {
      const sched = fakeScheduler()
      usePttStore.getState().press()
      usePttStore.getState().reset()
      expect(sched.pending()).toBe(0)
    })
  })
})
