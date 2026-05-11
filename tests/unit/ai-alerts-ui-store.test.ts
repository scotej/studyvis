// V2-P6 — alertsUiStore: TTL-driven self-warning + alerted-peers state.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  PEER_ALERT_TTL_MS,
  WARNING_TTL_MS,
  __resetAlertsUiRuntime,
  __setAlertsUiRuntime,
  useAlertsUiStore,
} from '@/features/ai'

type Handle = { id: number; fire: () => void }

class FakeClock {
  private nextId = 1
  private handles = new Map<number, Handle>()

  setTimeout = (handler: () => void): Handle => {
    const id = this.nextId++
    const handle: Handle = {
      id,
      fire: () => {
        if (this.handles.delete(id)) handler()
      },
    }
    this.handles.set(id, handle)
    return handle
  }

  clearTimeout = (handleOrId: unknown): void => {
    if (
      handleOrId &&
      typeof handleOrId === 'object' &&
      'id' in (handleOrId as Handle)
    ) {
      this.handles.delete((handleOrId as Handle).id)
    }
  }

  fireOne(id: number): void {
    this.handles.get(id)?.fire()
  }

  fireAll(): void {
    for (const handle of Array.from(this.handles.values())) handle.fire()
  }

  pendingCount(): number {
    return this.handles.size
  }
}

function reset(): void {
  useAlertsUiStore.setState({ selfWarning: null, alertedPeers: {} })
}

beforeEach(() => {
  reset()
  __resetAlertsUiRuntime()
})

afterEach(() => {
  __resetAlertsUiRuntime()
  reset()
})

describe('useAlertsUiStore — self-warning', () => {
  test('setSelfWarning stores the warning and schedules auto-dismiss', () => {
    const clock = new FakeClock()
    __setAlertsUiRuntime({
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })

    useAlertsUiStore.getState().setSelfWarning({
      reasoning: 'looking away',
      severity: 'mild',
      ts: 1_700_000_000_000,
    })
    expect(useAlertsUiStore.getState().selfWarning?.reasoning).toBe(
      'looking away'
    )
    expect(clock.pendingCount()).toBe(1)
    expect(WARNING_TTL_MS).toBeGreaterThanOrEqual(15_000)

    // Firing the TTL timer clears the warning.
    clock.fireAll()
    expect(useAlertsUiStore.getState().selfWarning).toBeNull()
  })

  test('setting a second warning cancels the prior TTL', () => {
    const clock = new FakeClock()
    __setAlertsUiRuntime({
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })

    useAlertsUiStore.getState().setSelfWarning({
      reasoning: 'first',
      severity: 'mild',
      ts: 1,
    })
    expect(clock.pendingCount()).toBe(1)

    useAlertsUiStore.getState().setSelfWarning({
      reasoning: 'second',
      severity: 'moderate',
      ts: 2,
    })
    // First handle was cleared; only the second's timer remains.
    expect(clock.pendingCount()).toBe(1)
    expect(useAlertsUiStore.getState().selfWarning?.reasoning).toBe('second')
  })

  test('clearSelfWarning cancels the TTL timer', () => {
    const clock = new FakeClock()
    __setAlertsUiRuntime({
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })

    useAlertsUiStore.getState().setSelfWarning({
      reasoning: 'x',
      severity: 'mild',
      ts: 1,
    })
    expect(clock.pendingCount()).toBe(1)
    useAlertsUiStore.getState().clearSelfWarning()
    expect(clock.pendingCount()).toBe(0)
    expect(useAlertsUiStore.getState().selfWarning).toBeNull()
  })
})

describe('useAlertsUiStore — alertedPeers', () => {
  test('setAlertedPeer inserts and schedules auto-expiry', () => {
    const clock = new FakeClock()
    __setAlertsUiRuntime({
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })

    useAlertsUiStore.getState().setAlertedPeer({
      edPubkeyHex: 'aa'.repeat(32),
      severity: 'moderate',
      reasoning: 'scrolling Twitter',
      ts: 1_700_000_000_000,
    })
    expect(Object.keys(useAlertsUiStore.getState().alertedPeers)).toHaveLength(
      1
    )
    expect(clock.pendingCount()).toBe(1)
    expect(PEER_ALERT_TTL_MS).toBeGreaterThanOrEqual(15_000)

    clock.fireAll()
    expect(useAlertsUiStore.getState().alertedPeers).toEqual({})
  })

  test('updating the same peer cancels the prior TTL', () => {
    const clock = new FakeClock()
    __setAlertsUiRuntime({
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })
    const ed = 'aa'.repeat(32)

    useAlertsUiStore.getState().setAlertedPeer({
      edPubkeyHex: ed,
      severity: 'mild',
      reasoning: 'first',
      ts: 1,
    })
    useAlertsUiStore.getState().setAlertedPeer({
      edPubkeyHex: ed,
      severity: 'blatant',
      reasoning: 'second',
      ts: 2,
    })
    expect(clock.pendingCount()).toBe(1)
    expect(useAlertsUiStore.getState().alertedPeers[ed].reasoning).toBe(
      'second'
    )
  })

  test('clearAlertedPeer removes the entry and cancels TTL', () => {
    const clock = new FakeClock()
    __setAlertsUiRuntime({
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })
    const ed = 'aa'.repeat(32)
    useAlertsUiStore.getState().setAlertedPeer({
      edPubkeyHex: ed,
      severity: 'mild',
      reasoning: 'r',
      ts: 1,
    })
    useAlertsUiStore.getState().clearAlertedPeer(ed)
    expect(useAlertsUiStore.getState().alertedPeers).toEqual({})
    expect(clock.pendingCount()).toBe(0)
  })

  test('reset clears both the warning and every alerted peer', () => {
    const clock = new FakeClock()
    __setAlertsUiRuntime({
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })
    useAlertsUiStore.getState().setSelfWarning({
      reasoning: 'r',
      severity: 'mild',
      ts: 1,
    })
    useAlertsUiStore.getState().setAlertedPeer({
      edPubkeyHex: 'aa'.repeat(32),
      severity: 'mild',
      reasoning: 'r',
      ts: 1,
    })
    expect(clock.pendingCount()).toBe(2)
    useAlertsUiStore.getState().reset()
    expect(useAlertsUiStore.getState().selfWarning).toBeNull()
    expect(useAlertsUiStore.getState().alertedPeers).toEqual({})
    expect(clock.pendingCount()).toBe(0)
  })

  test('the privacy invariant: store entries carry only severity + reasoning + ts', () => {
    const clock = new FakeClock()
    __setAlertsUiRuntime({
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })
    const ed = 'aa'.repeat(32)
    useAlertsUiStore.getState().setAlertedPeer({
      edPubkeyHex: ed,
      severity: 'blatant',
      reasoning: 'playing a game',
      ts: 1,
    })
    const entry = useAlertsUiStore.getState().alertedPeers[ed]
    // ScoreEvent.alert has deduction + scoreAfter; those MUST NOT cross
    // into the UI store so a screenshot of the peer's tile cannot reveal
    // the alerted user's running score.
    expect(entry).toEqual({
      edPubkeyHex: ed,
      severity: 'blatant',
      reasoning: 'playing a game',
      ts: 1,
    })
    expect(Object.keys(entry)).not.toContain('deduction')
    expect(Object.keys(entry)).not.toContain('scoreAfter')
  })

  // Belt-and-braces: vi.useFakeTimers + the real runtime to verify the
  // production setTimeout / clearTimeout wires up too.
  test('TTL fires with real wall-clock runtime + vi.useFakeTimers', () => {
    vi.useFakeTimers()
    try {
      useAlertsUiStore.getState().setSelfWarning({
        reasoning: 'r',
        severity: 'mild',
        ts: 1,
      })
      expect(useAlertsUiStore.getState().selfWarning).not.toBeNull()
      vi.advanceTimersByTime(WARNING_TTL_MS + 1)
      expect(useAlertsUiStore.getState().selfWarning).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
