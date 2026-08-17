import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import type { PttObservation } from '@/features/system/pttInvariants'
import {
  __resetPttWatchdogScheduler,
  __setPttWatchdogScheduler,
  classifyPttStoreChange,
  createPttWatchdog,
  PTT_WATCHDOG_ACTIVE_MS,
  PTT_WATCHDOG_HEARTBEAT_MS,
  type PttWatchdogTick,
} from '@/features/system/pttWatchdog'

// A hand-driven scheduler: nothing fires until a test advances the clock, so
// the whole watchdog is deterministic in node-env with no timers or DOM.
function fakeScheduler() {
  let nowMs = 0
  let nextHandle = 1
  const queued = new Map<number, { at: number; run: () => void }>()

  return {
    scheduler: {
      setTimeout: (handler: () => void, ms: number) => {
        const handle = nextHandle
        nextHandle += 1
        queued.set(handle, { at: nowMs + ms, run: handler })
        return handle
      },
      clearTimeout: (handle: number) => {
        queued.delete(handle)
      },
    },
    now: () => nowMs,
    advance: (ms: number) => {
      const target = nowMs + ms
      // Fire in due order, letting each handler schedule its successor.
      for (;;) {
        let dueHandle: number | null = null
        let dueAt = Number.POSITIVE_INFINITY
        for (const [handle, entry] of queued) {
          if (entry.at <= target && entry.at < dueAt) {
            dueAt = entry.at
            dueHandle = handle
          }
        }
        if (dueHandle === null) break
        const entry = queued.get(dueHandle)
        queued.delete(dueHandle)
        // An overdue timer fires late; it never rewinds the clock. Without the
        // max() a simulated suspend would be silently undone here.
        if (entry) nowMs = Math.max(nowMs, entry.at)
        entry?.run()
      }
      nowMs = target
    },
    // Simulate a suspend: jump the clock without firing anything in between.
    jump: (ms: number) => {
      nowMs += ms
    },
    pending: () => queued.size,
  }
}

function observation(overrides: Partial<PttObservation> = {}): PttObservation {
  return {
    atMs: 0,
    sessionActive: true,
    platform: 'macos',
    physicalWatchExpected: true,
    peerPttActive: 0,
    store: {
      active: false,
      awaitingRelease: false,
      heldSources: [],
      revision: 3,
      holdMs: null,
    },
    reconciler: {
      physicalHeld: false,
      shortcutDown: false,
      logicalHoldActive: false,
      deferredShortcutPress: false,
    },
    track: {
      roomActive: true,
      peerConnections: 1,
      audioSenders: 1,
      enabledAudioSenders: 0,
      liveAudioSenders: 1,
      audioReceivers: 1,
      liveAudioReceivers: 1,
      collectionError: false,
    },
    render: {
      selfLit: false,
      opacityLit: null,
      peerLit: 0,
      peerTiles: 1,
      holdButtonPressed: null,
      surfaces: 2,
      probeError: false,
    },
    broadcast: {
      lastActive: false,
      msSinceSend: 9_000,
      sends: 2,
      sendFails: 0,
      lastKind: 'state-change',
    },
    native: {
      lastPhysicalHeld: false,
      msSincePhysical: 100,
      physicalEvents: 10,
      pressedEvents: 5,
      releasedEvents: 5,
    },
    ...overrides,
  }
}

describe('PTT watchdog', () => {
  let clock: ReturnType<typeof fakeScheduler>

  beforeEach(() => {
    clock = fakeScheduler()
    __setPttWatchdogScheduler(clock.scheduler)
  })

  afterEach(() => {
    __resetPttWatchdogScheduler()
  })

  function build(build: (atMs: number, wantStyle: boolean) => PttObservation): {
    watchdog: ReturnType<typeof createPttWatchdog>
    ticks: PttWatchdogTick[]
  } {
    const ticks: PttWatchdogTick[] = []
    const watchdog = createPttWatchdog({
      observe: (wantStyle) => build(clock.now(), wantStyle),
      onTick: (tick) => ticks.push(tick),
      now: () => clock.now(),
      wallNow: () => clock.now(),
    })
    return { watchdog, ticks }
  }

  test('a healthy session ticks silently and never emits a violation', () => {
    const { watchdog, ticks } = build((atMs) => observation({ atMs }))
    watchdog.start()
    clock.advance(60_000)
    watchdog.stop()

    expect(ticks.length).toBeGreaterThan(50)
    expect(ticks.flatMap((t) => t.events)).toEqual([])
  })

  test('a stuck divergence produces one confirmed violation, then backs off', () => {
    const { watchdog, ticks } = build((atMs) => {
      const o = observation({ atMs })
      o.render.selfLit = true
      return o
    })
    watchdog.start()
    clock.advance(10_000)
    watchdog.stop()

    const violations = ticks
      .flatMap((t) => t.events)
      .filter((e) => e.kind === 'violation')
    // Ten seconds at 1 Hz: one confirmed violation, not ten.
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      id: 'indicator.disagrees_with_store',
      level: 'error',
    })
    expect(ticks.at(-1)?.openViolations).toBe(1)
  })

  test('recovery clears, and the observation rides along with every tick', () => {
    let stuck = true
    const { watchdog, ticks } = build((atMs) => {
      const o = observation({ atMs })
      o.render.selfLit = stuck
      return o
    })
    watchdog.start()
    clock.advance(6_000)
    stuck = false
    clock.advance(3_000)
    watchdog.stop()

    const kinds = ticks.flatMap((t) => t.events).map((e) => e.kind)
    expect(kinds).toContain('violation')
    expect(kinds).toContain('cleared')
    expect(ticks[0]?.observation.store.revision).toBe(3)
  })

  test('the first tick heartbeats, then only every five minutes', () => {
    const { watchdog, ticks } = build((atMs) => observation({ atMs }))
    watchdog.start()
    clock.advance(PTT_WATCHDOG_HEARTBEAT_MS * 2 + 5_000)
    watchdog.stop()

    const beats = ticks.filter((t) => t.heartbeat)
    expect(beats).toHaveLength(3)
  })

  test('a suspended machine is reported as a timeline gap', () => {
    const { watchdog, ticks } = build((atMs) => observation({ atMs }))
    watchdog.start()
    clock.advance(3_000)
    // The timer does not fire while the machine is asleep; it fires late.
    clock.jump(120_000)
    clock.advance(PTT_WATCHDOG_ACTIVE_MS)
    watchdog.stop()

    const gaps = ticks.map((t) => t.gap).filter(Boolean)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.monoElapsedMs).toBeGreaterThan(100_000)
  })

  // Dwell counted across a suspend would be fiction: the ticks either side are
  // not consecutive observations of a continuous state.
  test('a gap restarts dwell rather than confirming across it', () => {
    const { watchdog, ticks } = build((atMs) => {
      const o = observation({ atMs })
      o.render.selfLit = true
      return o
    })
    watchdog.start()
    clock.advance(1_500)
    clock.jump(120_000)
    clock.advance(1_000)
    watchdog.stop()

    expect(
      ticks.flatMap((t) => t.events).filter((e) => e.kind === 'violation')
    ).toEqual([])
  })

  test('an idle app ticks slower than an in-session one', () => {
    const { watchdog, ticks } = build((atMs) =>
      observation({ atMs, sessionActive: false })
    )
    watchdog.start()
    clock.advance(30_000)
    watchdog.stop()
    // 5 s cadence, so well under the ~30 an active session would produce.
    expect(ticks.length).toBeLessThan(10)
  })

  test('a throwing observer never stops the watchdog', () => {
    let calls = 0
    const ticks: PttWatchdogTick[] = []
    const watchdog = createPttWatchdog({
      observe: () => {
        calls += 1
        if (calls < 3) throw new Error('detached')
        return observation({ atMs: clock.now() })
      },
      onTick: (tick) => ticks.push(tick),
      now: () => clock.now(),
      wallNow: () => clock.now(),
    })
    watchdog.start()
    clock.advance(10_000)
    watchdog.stop()
    expect(ticks.length).toBeGreaterThan(0)
  })

  test('stop clears the timer', () => {
    const { watchdog } = build((atMs) => observation({ atMs }))
    watchdog.start()
    clock.advance(2_000)
    watchdog.stop()
    expect(clock.pending()).toBe(0)
  })

  test('computed style is requested on one tick in ten', () => {
    const wanted: boolean[] = []
    const watchdog = createPttWatchdog({
      observe: (wantStyle) => {
        wanted.push(wantStyle)
        return observation({ atMs: clock.now() })
      },
      onTick: () => {},
      now: () => clock.now(),
      wallNow: () => clock.now(),
    })
    watchdog.start()
    clock.advance(20_000)
    watchdog.stop()
    expect(wanted.filter(Boolean).length).toBeLessThanOrEqual(
      Math.ceil(wanted.length / 10)
    )
    expect(wanted.filter(Boolean).length).toBeGreaterThan(0)
  })
})

describe('classifyPttStoreChange', () => {
  const held = (sources: string[], active: boolean, awaiting: boolean) => ({
    active,
    awaitingRelease: awaiting,
    heldSources: sources,
  })

  test('the MAX_HOLD failsafe is uniquely identifiable', () => {
    expect(
      classifyPttStoreChange(
        held(['native-shortcut'], true, true),
        held(['native-shortcut'], false, true)
      )
    ).toBe('failsafe')
  })

  test('a normal native release is not reported as a failsafe', () => {
    expect(
      classifyPttStoreChange(
        held(['native-shortcut'], true, true),
        held([], false, false)
      )
    ).toBe('reset')
  })

  test('a button joining or leaving the hold is attributed', () => {
    expect(
      classifyPttStoreChange(
        held([], false, false),
        held(['session-button'], true, true)
      )
    ).toBe('button')
  })

  test('a plain native press has no cause of its own', () => {
    expect(
      classifyPttStoreChange(
        held([], false, false),
        held(['native-shortcut'], true, true)
      )
    ).toBeNull()
  })
})
