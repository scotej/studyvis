import { describe, expect, test } from 'vitest'

import {
  createPttInvariantMonitor,
  PTT_INVARIANTS,
  PTT_INVARIANT_BACKOFF_MS,
  PTT_INVARIANT_BUDGET,
  type PttInvariantEvent,
  type PttInvariantId,
  type PttObservation,
} from '@/features/system/pttInvariants'

// A healthy in-session observation. Every test perturbs exactly one layer, so
// a predicate that fires on an unrelated field shows up as a second id in the
// emitted set rather than passing silently.
function healthy(overrides: Partial<PttObservation> = {}): PttObservation {
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
      revision: 7,
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
      // Opacity is sampled on one tick in ten, so "not observed" is both the
      // common case and the honest default; a test that wants the opacity
      // clause sets it explicitly.
      opacityLit: null,
      peerLit: 0,
      peerTiles: 1,
      holdButtonPressed: null,
      surfaces: 2,
      probeError: false,
    },
    broadcast: {
      lastActive: false,
      msSinceSend: 5_000,
      sends: 4,
      sendFails: 0,
      lastKind: 'state-change',
    },
    native: {
      lastPhysicalHeld: false,
      // Grows with the clock, like the real thing: the macOS watcher goes
      // deliberately silent once a level settles, so this climbs through every
      // quiet stretch. Freezing it here is what previously hid an invariant
      // that fired on healthy idle sessions.
      msSincePhysical: (overrides.atMs ?? 0) + 200,
      physicalEvents: 40,
      pressedEvents: 20,
      releasedEvents: 20,
    },
    ...overrides,
  }
}

// Hold a perturbation steady across ticks until the dwell rule is satisfied.
function settle(
  monitor: ReturnType<typeof createPttInvariantMonitor>,
  build: (atMs: number) => PttObservation,
  ticks = 6,
  stepMs = 1_000
): PttInvariantEvent[] {
  const events: PttInvariantEvent[] = []
  for (let i = 1; i <= ticks; i += 1) {
    events.push(...monitor.observe(build(i * stepMs)))
  }
  return events
}

function violationIds(events: PttInvariantEvent[]): PttInvariantId[] {
  return events
    .filter((e) => e.kind === 'violation')
    .map((e) => (e as { id: PttInvariantId }).id)
}

describe('PTT invariants', () => {
  test('a healthy observation held indefinitely fires nothing', () => {
    const monitor = createPttInvariantMonitor()
    const events = settle(monitor, (atMs) => healthy({ atMs }), 30)
    expect(events).toEqual([])
    expect(monitor.openViolations()).toBe(0)
  })

  // One entry per invariant: the minimal perturbation that should fire it, and
  // nothing else. This is what keeps a predicate from quietly widening.
  const cases: Array<{
    id: PttInvariantId
    perturb: (atMs: number) => PttObservation
  }> = [
    {
      id: 'track.enabled_while_inactive',
      perturb: (atMs) => {
        const o = healthy({ atMs })
        o.track.enabledAudioSenders = 1
        return o
      },
    },
    {
      id: 'track.disabled_while_active',
      perturb: (atMs) => {
        const o = healthy({ atMs })
        o.store.active = true
        o.store.awaitingRelease = true
        o.store.heldSources = ['native-shortcut']
        o.reconciler.logicalHoldActive = true
        o.reconciler.shortcutDown = true
        o.reconciler.physicalHeld = true
        o.render.selfLit = true
        o.render.opacityLit = true
        o.broadcast.lastActive = true
        o.track.enabledAudioSenders = 0
        return o
      },
    },
    {
      id: 'indicator.disagrees_with_store',
      perturb: (atMs) => {
        const o = healthy({ atMs })
        o.render.selfLit = true
        return o
      },
    },
    {
      id: 'broadcast.disagrees_with_store',
      perturb: (atMs) => {
        const o = healthy({ atMs })
        o.broadcast.lastActive = true
        o.broadcast.msSinceSend = 4_000
        return o
      },
    },
    {
      id: 'hold.muted_while_latched',
      perturb: (atMs) => {
        const o = healthy({ atMs })
        o.store.awaitingRelease = true
        o.store.active = false
        o.store.heldSources = []
        return o
      },
    },
    {
      id: 'hold.store_without_reconciler',
      perturb: (atMs) => {
        const o = healthy({ atMs })
        o.store.heldSources = ['native-shortcut']
        o.store.active = true
        o.store.awaitingRelease = true
        o.reconciler.logicalHoldActive = false
        o.render.selfLit = true
        o.track.enabledAudioSenders = 1
        o.broadcast.lastActive = true
        o.reconciler.physicalHeld = true
        return o
      },
    },
    {
      id: 'hold.reconciler_without_store',
      perturb: (atMs) => {
        const o = healthy({ atMs })
        o.reconciler.logicalHoldActive = true
        o.reconciler.shortcutDown = true
        o.reconciler.physicalHeld = true
        return o
      },
    },
    {
      id: 'physical.up_while_active',
      perturb: (atMs) => {
        const o = healthy({ atMs })
        o.store.active = true
        o.store.awaitingRelease = true
        o.store.heldSources = ['native-shortcut']
        o.reconciler.logicalHoldActive = true
        o.reconciler.shortcutDown = true
        o.reconciler.physicalHeld = false
        o.render.selfLit = true
        o.track.enabledAudioSenders = 1
        o.broadcast.lastActive = true
        return o
      },
    },
  ]

  // The defect this suite previously missed: the macOS watcher stops publishing
  // once a level settles (#240), so an idle session's msSincePhysical climbs
  // without bound. Nothing may fire on that — a false positive here spends the
  // shared budget and silences the invariants that matter.
  test('a long quiet macOS session stays completely silent', () => {
    const monitor = createPttInvariantMonitor()
    // Half an hour at 1 Hz with nobody touching the key.
    const events = settle(monitor, (atMs) => healthy({ atMs }), 1_800)
    expect(events).toEqual([])
    expect(monitor.budgetLeft()).toBe(PTT_INVARIANT_BUDGET)
  })

  test('a visibly lit badge over an inactive store is caught', () => {
    const monitor = createPttInvariantMonitor()
    // The committed attribute agrees with the store; only what the user can
    // SEE disagrees. This is the literal #226 symptom.
    const fired = violationIds(
      settle(monitor, (atMs) => {
        const o = healthy({ atMs })
        o.render.selfLit = false
        o.render.opacityLit = true
        return o
      })
    )
    expect(fired).toContain('indicator.disagrees_with_store')
  })

  test('one stuck sender among several is not hidden by the others', () => {
    const monitor = createPttInvariantMonitor()
    const fired = violationIds(
      settle(monitor, (atMs) => {
        const o = healthy({ atMs })
        o.store.active = true
        o.store.awaitingRelease = true
        o.store.heldSources = ['native-shortcut']
        o.reconciler.logicalHoldActive = true
        o.reconciler.shortcutDown = true
        o.reconciler.physicalHeld = true
        o.render.selfLit = true
        o.broadcast.lastActive = true
        o.track.audioSenders = 3
        o.track.enabledAudioSenders = 2
        return o
      })
    )
    expect(fired).toContain('track.disabled_while_active')
  })

  test('an enabled but ended sender is not reported as an open microphone', () => {
    const monitor = createPttInvariantMonitor()
    const events = settle(
      monitor,
      (atMs) => {
        const o = healthy({ atMs })
        o.track.enabledAudioSenders = 1
        o.track.liveAudioSenders = 0
        return o
      },
      20
    )
    expect(violationIds(events)).toEqual([])
  })

  test('a flapping predicate cannot write an unbounded stream of records', () => {
    const monitor = createPttInvariantMonitor({ budget: 6 })
    // Alternates violated/ok every few ticks for an hour.
    const events = settle(
      monitor,
      (atMs) => {
        const o = healthy({ atMs })
        o.render.selfLit = Math.floor(atMs / 4_000) % 2 === 0
        return o
      },
      3_600
    )
    expect(events.length).toBeLessThanOrEqual(7)
    expect(monitor.budgetLeft()).toBe(0)
  })

  test('the backoff ladder survives a clear rather than restarting', () => {
    const monitor = createPttInvariantMonitor()
    const stuck = (atMs: number) => {
      const o = healthy({ atMs })
      o.render.selfLit = true
      return o
    }
    settle(monitor, stuck, 4)
    const afterFirst = monitor.budgetLeft()
    // Clear, then immediately re-enter: the re-entry must still owe the
    // backoff, not emit at full rate inside the throttle window.
    monitor.observe(healthy({ atMs: 10_000 }))
    const events = settle(monitor, (atMs) => stuck(11_000 + atMs), 4)
    expect(events.filter((e) => e.kind === 'violation')).toHaveLength(0)
    expect(monitor.budgetLeft()).toBeLessThan(afterFirst)
  })

  test('resetDwell clears history but never refunds the budget', () => {
    const monitor = createPttInvariantMonitor({ budget: 3 })
    settle(
      monitor,
      (atMs) => {
        const o = healthy({ atMs })
        o.render.selfLit = true
        return o
      },
      4
    )
    const left = monitor.budgetLeft()
    expect(left).toBeLessThan(3)
    monitor.resetDwell()
    expect(monitor.budgetLeft()).toBe(left)
  })

  test('every invariant has a case', () => {
    expect(cases.map((c) => c.id).sort()).toEqual(
      PTT_INVARIANTS.map((i) => i.id).sort()
    )
  })

  for (const { id, perturb } of cases) {
    test(`${id} fires on its own perturbation and alone`, () => {
      const monitor = createPttInvariantMonitor()
      const fired = violationIds(settle(monitor, perturb))
      expect(fired).toContain(id)
      expect([...new Set(fired)]).toEqual([id])
    })
  }

  test('a one-tick divergence never fires', () => {
    const monitor = createPttInvariantMonitor()
    const bad = healthy({ atMs: 1_000 })
    bad.render.selfLit = true
    expect(monitor.observe(bad)).toEqual([])
    expect(monitor.observe(healthy({ atMs: 2_000 }))).toEqual([])
  })

  // The transient/stuck discriminator: a state machine that is still moving is
  // mid-transition by definition, however long the disagreement persists.
  test('a divergence spanning a revision bump never fires', () => {
    const monitor = createPttInvariantMonitor()
    const events = settle(
      monitor,
      (atMs) => {
        const o = healthy({ atMs })
        o.render.selfLit = true
        o.store.revision = 7 + atMs / 1_000
        return o
      },
      20
    )
    expect(events).toEqual([])
  })

  test('dwell ticks met but wall duration not is not enough', () => {
    const monitor = createPttInvariantMonitor()
    // Five ticks 100 ms apart clears dwellTicks but never the 1.5 s floor.
    const events = settle(
      monitor,
      (atMs) => {
        const o = healthy({ atMs })
        o.render.selfLit = true
        return o
      },
      5,
      100
    )
    expect(events).toEqual([])
  })

  test('a stuck state re-asserts on the backoff schedule, not every tick', () => {
    const monitor = createPttInvariantMonitor()
    const stuck = (atMs: number) => {
      const o = healthy({ atMs })
      o.render.selfLit = true
      return o
    }
    // Ten minutes at 1 Hz.
    const events = settle(monitor, stuck, 600)
    const fired = events.filter((e) => e.kind === 'violation')
    // First at dwell, then +15s, +45s, +135s, +300s — five inside 600 s.
    expect(fired.length).toBeLessThanOrEqual(
      PTT_INVARIANT_BACKOFF_MS.length + 1
    )
    expect(fired.length).toBeGreaterThanOrEqual(3)
  })

  test('recovery emits exactly one cleared, and a re-entry counts up', () => {
    const monitor = createPttInvariantMonitor()
    const stuck = (atMs: number) => {
      const o = healthy({ atMs })
      o.render.selfLit = true
      return o
    }
    settle(monitor, stuck, 4)
    expect(monitor.openViolations()).toBe(1)

    const recovered = monitor.observe(healthy({ atMs: 10_000 }))
    expect(recovered.filter((e) => e.kind === 'cleared')).toHaveLength(1)
    expect(monitor.openViolations()).toBe(0)
    expect(monitor.observe(healthy({ atMs: 11_000 }))).toEqual([])

    // Re-entry is counted, but the record is not written again until the
    // backoff elapses — that is what keeps a flapping predicate bounded.
    settle(monitor, (atMs) => stuck(20_000 + atMs), 4)
    expect(monitor.openViolations()).toBe(1)

    const later = settle(monitor, (atMs) => stuck(60_000 + atMs), 4).filter(
      (e) => e.kind === 'violation'
    ) as Array<{ enterCount: number }>
    expect(later[0]?.enterCount).toBe(2)
  })

  test('budget exhaustion reports once and then goes quiet', () => {
    const monitor = createPttInvariantMonitor({ budget: 2, backoffMs: [0] })
    const events = settle(
      monitor,
      (atMs) => {
        const o = healthy({ atMs })
        o.render.selfLit = true
        return o
      },
      40
    )
    expect(events.filter((e) => e.kind === 'violation')).toHaveLength(2)
    expect(events.filter((e) => e.kind === 'budget-exhausted')).toHaveLength(1)
    expect(monitor.budgetLeft()).toBe(0)
  })

  // Windows and Linux have no physical-state stream at all. These must stay
  // dormant there rather than reporting the platform as a defect.
  test('physical invariants stay dormant without a physical watcher', () => {
    const monitor = createPttInvariantMonitor()
    const events = settle(
      monitor,
      (atMs) => {
        const o = healthy({ atMs })
        o.platform = 'windows'
        o.physicalWatchExpected = false
        o.reconciler.physicalHeld = null
        o.native.lastPhysicalHeld = null
        o.native.msSincePhysical = null
        o.store.active = true
        o.store.awaitingRelease = true
        o.store.heldSources = ['native-shortcut']
        o.reconciler.logicalHoldActive = true
        o.reconciler.shortcutDown = true
        o.render.selfLit = true
        o.track.enabledAudioSenders = 1
        o.broadcast.lastActive = true
        return o
      },
      30
    )
    expect(violationIds(events)).toEqual([])
  })

  test('session-scoped invariants stay dormant outside a session', () => {
    const monitor = createPttInvariantMonitor()
    const events = settle(
      monitor,
      (atMs) => {
        const o = healthy({ atMs })
        o.sessionActive = false
        o.track.roomActive = false
        o.track.enabledAudioSenders = 1
        o.render.selfLit = true
        return o
      },
      20
    )
    expect(violationIds(events)).toEqual([])
  })

  test('a collection error suppresses the media invariants', () => {
    const monitor = createPttInvariantMonitor()
    const events = settle(
      monitor,
      (atMs) => {
        const o = healthy({ atMs })
        o.track.collectionError = true
        o.track.enabledAudioSenders = 1
        return o
      },
      20
    )
    expect(violationIds(events)).toEqual([])
  })

  test('a probe error suppresses the render invariants', () => {
    const monitor = createPttInvariantMonitor()
    const events = settle(
      monitor,
      (atMs) => {
        const o = healthy({ atMs })
        o.render.probeError = true
        o.render.selfLit = true
        o.render.peerLit = 3
        return o
      },
      20
    )
    expect(violationIds(events)).toEqual([])
  })

  test('reset clears dwell history and the budget', () => {
    const monitor = createPttInvariantMonitor({ budget: 1, backoffMs: [0] })
    const stuck = (atMs: number) => {
      const o = healthy({ atMs })
      o.render.selfLit = true
      return o
    }
    settle(monitor, stuck, 10)
    expect(monitor.budgetLeft()).toBe(0)

    monitor.reset()
    expect(monitor.budgetLeft()).toBe(1)
    expect(monitor.openViolations()).toBe(0)
    const after = settle(monitor, (atMs) => stuck(100_000 + atMs), 4)
    expect(after.filter((e) => e.kind === 'violation')).toHaveLength(1)
  })
})
