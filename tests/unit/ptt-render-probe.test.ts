import { afterEach, describe, expect, test } from 'vitest'

import {
  PTT_ACTIVE_ATTR,
  PTT_HOLD_ATTR,
  PTT_INDICATOR_ATTR,
  PTT_SCOPE_ATTR,
  readPttRenderState,
  type PttRenderElement,
  type PttRenderRoot,
} from '@/features/system/pttRenderProbe'
import {
  __resetPttBroadcastClock,
  __setPttBroadcastClock,
  readPttBroadcastMirror,
  recordPttBroadcast,
  resetPttBroadcastMirror,
} from '@/features/system/pttBroadcastMirror'

// vitest runs node-env here with no jsdom, which is exactly why the probe
// takes a structural root: these literals are the whole test harness.
function element(attrs: Record<string, string>): PttRenderElement {
  return { getAttribute: (name) => attrs[name] ?? null }
}

function root(map: Record<string, PttRenderElement[]>): PttRenderRoot {
  return { querySelectorAll: (selector) => map[selector] ?? [] }
}

const INDICATORS = `[${PTT_INDICATOR_ATTR}]`
const HOLD = `[${PTT_HOLD_ATTR}]`

function indicator(scope: 'self' | 'peer', active: boolean): PttRenderElement {
  return element({
    [PTT_INDICATOR_ATTR]: '',
    [PTT_SCOPE_ATTR]: scope,
    [PTT_ACTIVE_ATTR]: String(active),
  })
}

describe('PTT render probe', () => {
  test('reads the self indicator and counts lit peers', () => {
    const state = readPttRenderState(
      root({
        [INDICATORS]: [
          indicator('self', true),
          indicator('peer', true),
          indicator('peer', false),
        ],
      })
    )
    expect(state.selfLit).toBe(true)
    expect(state.peerLit).toBe(1)
    expect(state.peerTiles).toBe(2)
    expect(state.surfaces).toBe(3)
    expect(state.probeError).toBe(false)
  })

  test('an unlit self indicator is false, a missing one is null', () => {
    expect(
      readPttRenderState(root({ [INDICATORS]: [indicator('self', false)] }))
        .selfLit
    ).toBe(false)

    // Not rendered is a different fact from rendered-and-off, and the
    // invariants stand down on null rather than firing on an assumption.
    const missing = readPttRenderState(root({ [INDICATORS]: [] }))
    expect(missing.selfLit).toBeNull()
    expect(missing.surfaces).toBe(0)
  })

  test('the hold button is read when present', () => {
    const state = readPttRenderState(
      root({
        [INDICATORS]: [indicator('self', false)],
        [HOLD]: [element({ [PTT_HOLD_ATTR]: 'true' })],
      })
    )
    expect(state.holdButtonPressed).toBe(true)
    expect(state.surfaces).toBe(2)
  })

  test('computed opacity is reported alongside, never used to resolve', () => {
    // A committed attribute that says "on" while the badge is painted
    // transparent is a real and distinct fault, so the probe reports both and
    // lets the reader see the disagreement.
    const state = readPttRenderState(
      root({ [INDICATORS]: [indicator('self', true)] }),
      () => 0
    )
    expect(state.selfLit).toBe(true)
    expect(state.opacityLit).toBe(false)
  })

  test('a non-finite or absent opacity leaves opacityLit null', () => {
    const el = root({ [INDICATORS]: [indicator('self', true)] })
    expect(readPttRenderState(el, () => null).opacityLit).toBeNull()
    expect(readPttRenderState(el, () => Number.NaN).opacityLit).toBeNull()
    expect(readPttRenderState(el).opacityLit).toBeNull()
  })

  test('a throwing root is reported, not propagated', () => {
    const state = readPttRenderState({
      querySelectorAll: () => {
        throw new Error('detached')
      },
    })
    expect(state.probeError).toBe(true)
    expect(state.selfLit).toBeNull()
  })

  test('no root at all is an empty observation, not an error', () => {
    const state = readPttRenderState(null)
    expect(state.probeError).toBe(false)
    expect(state.surfaces).toBe(0)
  })
})

describe('PTT broadcast mirror', () => {
  afterEach(() => {
    resetPttBroadcastMirror()
    __resetPttBroadcastClock()
  })

  test('records what we told peers, and how long ago', () => {
    let now = 1_000
    __setPttBroadcastClock(() => now)
    recordPttBroadcast({ active: true, kind: 'state-change', ok: true })
    now = 1_400
    const mirror = readPttBroadcastMirror()
    expect(mirror.lastActive).toBe(true)
    expect(mirror.lastKind).toBe('state-change')
    expect(mirror.sends).toBe(1)
    expect(mirror.msSinceSend).toBe(400)
  })

  test('a failed send counts but never moves the last known value', () => {
    let now = 0
    __setPttBroadcastClock(() => now)
    recordPttBroadcast({ active: true, kind: 'state-change', ok: true })
    now = 100
    recordPttBroadcast({ active: false, kind: 'state-change', ok: false })

    const mirror = readPttBroadcastMirror()
    expect(mirror.lastActive).toBe(true)
    expect(mirror.sends).toBe(1)
    expect(mirror.sendFails).toBe(1)
  })

  test('before any send there is nothing to compare against', () => {
    const mirror = readPttBroadcastMirror()
    expect(mirror.lastActive).toBeNull()
    expect(mirror.msSinceSend).toBeNull()
  })

  test('reset clears the room history', () => {
    recordPttBroadcast({ active: true, kind: 'resend', ok: true })
    resetPttBroadcastMirror()
    expect(readPttBroadcastMirror().lastActive).toBeNull()
    expect(readPttBroadcastMirror().sends).toBe(0)
  })
})
