// N5 — custom-duration wire-compat matrix.
//
// The cross-version contract is `{ phase: 'work'|'rest', preset: '25/5'|'50/10',
// ends_at }` plus the new OPTIONAL `work_ms`/`rest_ms`. We assert both
// directions:
//   - new→old: a custom-duration broadcaster's message is accepted + rendered
//     work/rest by an OLDER receiver's parser (modelled here exactly as it
//     shipped pre-N5), so a custom host never strands a friend on an old build.
//   - old→new: a legacy message with NO explicit durations is accepted by the
//     new parser and renders the fixed preset timings.

import { describe, expect, test } from 'vitest'

import {
  durationsForPreset,
  isPomodoroMessage,
  resolveWirePhase,
  startPomodoroController,
  type PomodoroMessage,
  type PomodoroSnapshot,
} from '@/features/session/pomodoro'
import type { TopicRoom } from '@/lib/trystero'

// --- The pre-N5 receiver, frozen so the contract can't silently regress. ---
// This is the parser an OLDER build runs: it knows nothing about work_ms /
// rest_ms and rejects any preset that isn't a legacy one.
function legacyIsPomodoroMessage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    v.v === 1 &&
    (v.phase === 'work' || v.phase === 'rest') &&
    (v.preset === '25/5' || v.preset === '50/10') &&
    (v.stopped === undefined || v.stopped === true) &&
    typeof v.ends_at === 'number' &&
    Number.isFinite(v.ends_at) &&
    (v.ends_at as number) > 0
  )
}

const LEGACY_PRESET_DURATIONS = {
  '25/5': { work: 25 * 60_000, rest: 5 * 60_000 },
  '50/10': { work: 50 * 60_000, rest: 10 * 60_000 },
} as const

// The pre-N5 receiver's phase label derivation (the shipped `fullPhase`).
function legacyFullPhase(
  wire: 'work' | 'rest',
  preset: '25/5' | '50/10'
): string {
  if (preset === '25/5') return wire === 'work' ? 'work-25' : 'rest-5'
  return wire === 'work' ? 'work-50' : 'rest-10'
}

// Captures the messages the controller broadcasts, so we can inspect the
// exact wire shape a NEW custom-duration host emits.
function makeCapturingRoom(): { room: TopicRoom; sent: PomodoroMessage[] } {
  const sent: PomodoroMessage[] = []
  const room: Partial<TopicRoom> & { selfId: string } = {
    selfId: 'self',
    makeAction: <T>() => ({
      send: async (data: T): Promise<void[]> => {
        sent.push(data as PomodoroMessage)
        return []
      },
      receive: () => {},
    }),
    onPeerJoin: () => () => {},
    onPeerLeave: () => () => {},
    onPeerStream: () => () => {},
    addStream: () => {},
    removeStream: () => {},
    getPeers: () => ({}),
    leave: async () => {},
  }
  return { room: room as TopicRoom, sent }
}

const ED = 'aa'.repeat(32)

function startController(room: TopicRoom, now: () => number) {
  const snaps: PomodoroSnapshot[] = []
  const ctrl = startPomodoroController({
    room,
    myEdPubkeyHex: ED,
    selfJoinedAt: 0,
    getAllPeerOrdering: () => [{ ed_pubkey_hex: ED, joined_at: 0 }],
    resolveSenderEdPubkey: () => ED,
    onSnapshot: (s) => snaps.push(s),
    onPomodoroStart: () => {},
    onPomodoroEnd: () => {},
    now,
    // No-op timers so start() doesn't schedule real intervals.
    setTimeoutFn: (() => 0) as never,
    setIntervalFn: (() => 0) as never,
    clearTimeoutFn: () => {},
    clearIntervalFn: () => {},
  })
  return { ctrl, snaps }
}

describe('N5 wire shape: a custom-duration broadcast', () => {
  test('carries explicit work_ms/rest_ms AND a valid legacy preset fallback', () => {
    const { room, sent } = makeCapturingRoom()
    const { ctrl } = startController(room, () => 1_000)
    // 45/15 — a common alternative split that maps to no legacy preset.
    ctrl.start({ preset: 'custom', workMs: 45 * 60_000, restMs: 15 * 60_000 })

    const msg = sent.at(-1)
    expect(msg).toBeDefined()
    expect(msg!.work_ms).toBe(45 * 60_000)
    expect(msg!.rest_ms).toBe(15 * 60_000)
    // 45 min work is >= the 37.5 min midpoint → the closest legacy fallback
    // is 50/10. Crucially it's a *valid legacy preset*, never 'custom'.
    expect(msg!.preset).toBe('50/10')
    expect(msg!.phase).toBe('work')
  })

  test('a short custom split falls back to the 25/5 legacy preset', () => {
    const { room, sent } = makeCapturingRoom()
    const { ctrl } = startController(room, () => 0)
    ctrl.start({ preset: 'custom', workMs: 20 * 60_000, restMs: 3 * 60_000 })
    expect(sent.at(-1)!.preset).toBe('25/5')
  })
})

describe('N5 new→old: an OLDER receiver renders a custom broadcast', () => {
  test('accepts the message and renders work/rest at the legacy fallback timing', () => {
    const { room, sent } = makeCapturingRoom()
    const { ctrl } = startController(room, () => 0)
    ctrl.start({ preset: 'custom', workMs: 45 * 60_000, restMs: 15 * 60_000 })
    const msg = sent.at(-1)!

    // The old parser accepts it (it ignores the unknown work_ms/rest_ms keys).
    expect(legacyIsPomodoroMessage(msg)).toBe(true)
    // And labels it as a sane legacy work phase — no crash, no 'custom' leak.
    expect(legacyFullPhase(msg.phase, msg.preset as '25/5' | '50/10')).toBe(
      'work-50'
    )
    // The old receiver's timing comes from the legacy table, not the custom
    // split — that's the accepted degradation (it can't know the real split).
    expect(LEGACY_PRESET_DURATIONS[msg.preset as '50/10'].work).toBe(
      50 * 60_000
    )
  })
})

describe('N5 old→new: the NEW receiver renders a legacy broadcast', () => {
  test('a legacy message with no explicit durations parses + uses fixed timings', () => {
    const legacyMsg: PomodoroMessage = {
      v: 1,
      phase: 'work',
      preset: '25/5',
      ends_at: 123_456,
      // No work_ms / rest_ms — exactly what an OLD broadcaster sends.
    }
    expect(isPomodoroMessage(legacyMsg)).toBe(true)
    const resolved = resolveWirePhase(legacyMsg)
    expect(resolved.phase).toBe('work-25')
    expect(resolved.preset).toBe('25/5')
    expect(resolved.workMs).toBe(25 * 60_000)
    expect(resolved.restMs).toBe(5 * 60_000)
  })

  test('the NEW receiver prefers explicit durations and labels them custom', () => {
    const customMsg: PomodoroMessage = {
      v: 1,
      phase: 'rest',
      preset: '50/10',
      ends_at: 999,
      work_ms: 45 * 60_000,
      rest_ms: 15 * 60_000,
    }
    expect(isPomodoroMessage(customMsg)).toBe(true)
    const resolved = resolveWirePhase(customMsg)
    expect(resolved.phase).toBe('rest-custom')
    expect(resolved.preset).toBe('custom')
    expect(resolved.workMs).toBe(45 * 60_000)
    expect(resolved.restMs).toBe(15 * 60_000)
  })

  test('explicit durations that match the named preset stay labelled legacy', () => {
    const msg: PomodoroMessage = {
      v: 1,
      phase: 'work',
      preset: '50/10',
      ends_at: 1,
      work_ms: 50 * 60_000,
      rest_ms: 10 * 60_000,
    }
    const resolved = resolveWirePhase(msg)
    expect(resolved.phase).toBe('work-50')
    expect(resolved.preset).toBe('50/10')
  })
})

describe('N5 isPomodoroMessage guards', () => {
  test('rejects a non-finite explicit duration', () => {
    expect(
      isPomodoroMessage({
        v: 1,
        phase: 'work',
        preset: '25/5',
        ends_at: 1,
        work_ms: Number.NaN,
      })
    ).toBe(false)
    expect(
      isPomodoroMessage({
        v: 1,
        phase: 'work',
        preset: '25/5',
        ends_at: 1,
        rest_ms: -5,
      })
    ).toBe(false)
  })

  test("never accepts preset 'custom' on the wire (cross-version contract)", () => {
    expect(
      isPomodoroMessage({
        v: 1,
        phase: 'work',
        preset: 'custom',
        ends_at: 1,
      })
    ).toBe(false)
  })
})

describe('durationsForPreset', () => {
  test('legacy presets read the fixed table', () => {
    expect(durationsForPreset('25/5')).toEqual({
      workMs: 25 * 60_000,
      restMs: 5 * 60_000,
    })
    expect(durationsForPreset('50/10')).toEqual({
      workMs: 50 * 60_000,
      restMs: 10 * 60_000,
    })
  })

  test('custom requires explicit durations', () => {
    expect(durationsForPreset('custom', { workMs: 11, restMs: 22 })).toEqual({
      workMs: 11,
      restMs: 22,
    })
    expect(() => durationsForPreset('custom')).toThrow()
  })
})
