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
    usePttStore.setState({
      active: false,
      awaitingRelease: false,
      heldSources: [],
      revision: 0,
    })
  })
  afterEach(() => {
    __resetPttScheduler()
  })

  test('starts inactive with no physical hold latched', () => {
    expect(usePttStore.getState()).toMatchObject({
      active: false,
      awaitingRelease: false,
      revision: 0,
    })
  })

  test('press flips active and latches the physical hold', () => {
    usePttStore.getState().press()
    expect(usePttStore.getState()).toMatchObject({
      active: true,
      awaitingRelease: true,
      revision: 1,
    })
  })

  test('release flips active false and ends the physical hold', () => {
    usePttStore.getState().press()
    usePttStore.getState().release()
    expect(usePttStore.getState()).toMatchObject({
      active: false,
      awaitingRelease: false,
      revision: 2,
    })
  })

  test('a repeated press while the hold is latched is idempotent', () => {
    usePttStore.getState().press()
    usePttStore.getState().press()
    expect(usePttStore.getState()).toMatchObject({
      active: true,
      awaitingRelease: true,
      revision: 1,
    })
  })

  test('a native-style repeat burst stays active until release', () => {
    const { press, release } = usePttStore.getState()
    press()
    press()
    press()
    press()
    expect(usePttStore.getState()).toMatchObject({
      active: true,
      awaitingRelease: true,
      revision: 1,
    })

    release()
    expect(usePttStore.getState()).toMatchObject({
      active: false,
      awaitingRelease: false,
      revision: 2,
    })
  })

  test('releasing one input source does not cancel another held source', () => {
    const { press, release } = usePttStore.getState()
    press('native-shortcut')
    press('session-button')

    release('session-button')
    expect(usePttStore.getState()).toMatchObject({
      active: true,
      awaitingRelease: true,
      heldSources: ['native-shortcut'],
      revision: 1,
    })

    release('native-shortcut')
    expect(usePttStore.getState()).toMatchObject({
      active: false,
      awaitingRelease: false,
      heldSources: [],
      revision: 2,
    })
  })

  test('release without prior press stays inactive without changing generation', () => {
    usePttStore.getState().release()
    expect(usePttStore.getState()).toMatchObject({
      active: false,
      awaitingRelease: false,
      revision: 0,
    })
  })

  test('press then release then press starts a distinct new hold', () => {
    const { press, release } = usePttStore.getState()
    press()
    release()
    press()
    expect(usePttStore.getState()).toMatchObject({
      active: true,
      awaitingRelease: true,
      revision: 3,
    })
  })

  test('reset clears active and the physical hold latch', () => {
    usePttStore.getState().press()
    usePttStore.getState().reset()
    expect(usePttStore.getState()).toMatchObject({
      active: false,
      awaitingRelease: false,
      revision: 2,
    })
  })

  // I92 — PttListener discriminates a native release from a `reset()` with a
  // latch it holds only across the `press()` / `release()` call, which is
  // exact ONLY because subscribers run inside the mutation rather than after
  // it. If zustand ever notified asynchronously the latch would already be
  // false by the time the subscriber looked, and a phantom `reset` would be
  // logged mid-hold again — the very thing the latch replaced a 50 ms window
  // to stop. Pin the contract here rather than discovering it from an archive.
  describe('subscriber notification is synchronous (the I92 latch contract)', () => {
    test('press notifies before it returns', () => {
      let notifiedDuringCall = false
      let returned = false
      const unsubscribe = usePttStore.subscribe(() => {
        notifiedDuringCall = !returned
      })
      usePttStore.getState().press()
      returned = true
      unsubscribe()
      expect(notifiedDuringCall).toBe(true)
    })

    test('release notifies before it returns', () => {
      usePttStore.getState().press()
      let notifiedDuringCall = false
      let returned = false
      const unsubscribe = usePttStore.subscribe(() => {
        notifiedDuringCall = !returned
      })
      usePttStore.getState().release()
      returned = true
      unsubscribe()
      expect(notifiedDuringCall).toBe(true)
    })
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

    test('a held key with a dropped release is muted after MAX_HOLD_MS', () => {
      const sched = fakeScheduler()
      usePttStore.getState().press()
      sched.advance(MAX_HOLD_MS)
      expect(usePttStore.getState()).toMatchObject({
        active: false,
        // The same physical hold is still latched until Released arrives.
        awaitingRelease: true,
        revision: 2,
      })
    })

    test('a genuine continuous hold survives until the failsafe boundary', () => {
      const sched = fakeScheduler()
      usePttStore.getState().press()
      sched.advance(MAX_HOLD_MS - 1)
      expect(usePttStore.getState()).toMatchObject({
        active: true,
        awaitingRelease: true,
      })
    })

    test('an explicit release before the timeout cancels the failsafe', () => {
      const sched = fakeScheduler()
      usePttStore.getState().press()
      usePttStore.getState().release()
      expect(sched.pending()).toBe(0)
      sched.advance(MAX_HOLD_MS)
      expect(usePttStore.getState()).toMatchObject({
        active: false,
        awaitingRelease: false,
        revision: 2,
      })
    })

    test('duplicate presses do not extend the original failsafe deadline', () => {
      const sched = fakeScheduler()
      usePttStore.getState().press()
      expect(sched.pending()).toBe(1)

      sched.advance(MAX_HOLD_MS - 1)
      usePttStore.getState().press()
      usePttStore.getState().press()
      expect(usePttStore.getState()).toMatchObject({
        active: true,
        awaitingRelease: true,
        revision: 1,
      })
      expect(sched.pending()).toBe(1)

      sched.advance(1)
      expect(usePttStore.getState()).toMatchObject({
        active: false,
        awaitingRelease: true,
        revision: 2,
      })
      expect(sched.pending()).toBe(0)
    })

    test('repeats after the safety cutoff cannot re-open the same hold', () => {
      const sched = fakeScheduler()
      usePttStore.getState().press()
      sched.advance(MAX_HOLD_MS)
      expect(usePttStore.getState()).toMatchObject({
        active: false,
        awaitingRelease: true,
      })

      usePttStore.getState().press()
      usePttStore.getState().press()
      expect(usePttStore.getState()).toMatchObject({
        active: false,
        awaitingRelease: true,
        revision: 2,
      })
      expect(sched.pending()).toBe(0)
    })

    test('a release after the safety cutoff permits one clean new hold', () => {
      const sched = fakeScheduler()
      usePttStore.getState().press()
      sched.advance(MAX_HOLD_MS)

      usePttStore.getState().release()
      expect(usePttStore.getState()).toMatchObject({
        active: false,
        awaitingRelease: false,
        revision: 3,
      })

      usePttStore.getState().press()
      expect(usePttStore.getState()).toMatchObject({
        active: true,
        awaitingRelease: true,
        revision: 4,
      })
      expect(sched.pending()).toBe(1)

      usePttStore.getState().release()
      expect(sched.pending()).toBe(0)
    })

    test('reset cancels a pending failsafe timer and ends the hold', () => {
      const sched = fakeScheduler()
      usePttStore.getState().press()
      usePttStore.getState().reset()
      expect(sched.pending()).toBe(0)
      expect(usePttStore.getState()).toMatchObject({
        active: false,
        awaitingRelease: false,
      })
    })
  })
})
