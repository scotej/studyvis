// #236 — the raw observation journal and the windowing that feeds the written
// session timeline. Both halves are pure, and both are load-bearing: the
// windows are what the model is shown AND what a window it fails to narrate
// falls back to, so a bug here degrades the report in two places at once.

import { afterEach, describe, expect, test, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import {
  MAX_REASONING_LENGTH,
  MAX_WINDOWS,
  MAX_WINDOW_NOTES,
  observationFromVerdict,
  parseObservation,
  readObservations,
  recordSampleObservation,
  serializeObservation,
  windowMinutesFor,
  windowObservations,
  __resetSessionJournalRuntime,
  __setSessionJournalRuntime,
  type SessionObservation,
} from '@/features/session/sessionJournal'
import { useSettingsStore } from '@/stores/settingsStore'

const T0 = 1_700_000_000_000

function observation(
  overrides: Partial<SessionObservation> = {}
): SessionObservation {
  return {
    ts: T0,
    verdict: 'on_task',
    reasoning: 'reading the TypeScript handbook',
    confidence: 0.9,
    topic: 'TypeScript',
    ...overrides,
  }
}

afterEach(() => {
  __resetSessionJournalRuntime()
  invokeMock.mockReset()
  useSettingsStore.setState((s) => ({
    values: { ...s.values, sessionTimelineEnabled: true },
  }))
})

describe('journal line format', () => {
  test('round-trips through serialize/parse', () => {
    const line = serializeObservation(observation({ verdict: 'moderate' }))
    expect(line).not.toContain('\n')
    expect(parseObservation(line)).toEqual(observation({ verdict: 'moderate' }))
  })

  test('collapses newlines so one observation is always one line', () => {
    const line = serializeObservation(
      observation({ reasoning: 'watched a\nvideo\r\nabout cats' })
    )
    expect(JSON.parse(line).r).toBe('watched a video about cats')
  })

  test('clamps a runaway reasoning string', () => {
    const line = serializeObservation(
      observation({ reasoning: 'x'.repeat(MAX_REASONING_LENGTH + 500) })
    )
    expect(JSON.parse(line).r).toHaveLength(MAX_REASONING_LENGTH)
  })

  test('rejects lines that are not observations', () => {
    for (const line of [
      '',
      'not json',
      '[]',
      JSON.stringify({ v: 'on_task' }),
      JSON.stringify({ ts: T0, v: 'brilliant' }),
    ]) {
      expect(parseObservation(line)).toBeNull()
    }
  })

  test('an unreadable check is recorded as uncertain, not dropped', () => {
    expect(
      observationFromVerdict(
        { kind: 'uncertain', reason: 'no json object found' },
        'Maths',
        T0
      )
    ).toEqual({
      ts: T0,
      verdict: 'uncertain',
      reasoning: 'no json object found',
      confidence: null,
      topic: 'Maths',
    })
  })

  test('a judgment keeps its severity and confidence', () => {
    expect(
      observationFromVerdict(
        {
          severity: 'blatant',
          reasoning: 'playing a game',
          on_topic_confidence: 0.05,
        },
        'Maths',
        T0
      )
    ).toEqual({
      ts: T0,
      verdict: 'blatant',
      reasoning: 'playing a game',
      confidence: 0.05,
      topic: 'Maths',
    })
  })
})

describe('recording gates', () => {
  test('records one line per resolved check', async () => {
    const append = vi.fn<(sessionId: string, lines: string[]) => Promise<void>>(
      async () => {}
    )
    __setSessionJournalRuntime({
      append,
      read: async () => ({ lines: [], truncated: false }),
      now: () => T0,
    })
    await recordSampleObservation({
      sessionId: 'a'.repeat(64),
      verdict: { severity: 'on_task', reasoning: 'ok', on_topic_confidence: 1 },
      topic: 'Maths',
    })
    expect(append).toHaveBeenCalledTimes(1)
    expect(append.mock.calls[0][1]).toHaveLength(1)
  })

  test('writes nothing when the setting is off', async () => {
    const append = vi.fn(async () => {})
    __setSessionJournalRuntime({
      append,
      read: async () => ({ lines: [], truncated: false }),
      now: () => T0,
    })
    useSettingsStore.setState((s) => ({
      values: { ...s.values, sessionTimelineEnabled: false },
    }))
    await recordSampleObservation({
      sessionId: 'a'.repeat(64),
      verdict: { severity: 'on_task', reasoning: 'ok', on_topic_confidence: 1 },
      topic: 'Maths',
    })
    expect(append).not.toHaveBeenCalled()
  })

  test('writes nothing without a session id', async () => {
    const append = vi.fn(async () => {})
    __setSessionJournalRuntime({
      append,
      read: async () => ({ lines: [], truncated: false }),
      now: () => T0,
    })
    await recordSampleObservation({
      sessionId: null,
      verdict: { kind: 'uncertain', reason: 'x' },
      topic: '',
    })
    expect(append).not.toHaveBeenCalled()
  })

  test('a failed append never rejects into the sample loop', async () => {
    __setSessionJournalRuntime({
      append: async () => {
        throw new Error('disk full')
      },
      read: async () => ({ lines: [], truncated: false }),
      now: () => T0,
    })
    await expect(
      recordSampleObservation({
        sessionId: 'a'.repeat(64),
        verdict: { kind: 'uncertain', reason: 'x' },
        topic: '',
      })
    ).resolves.toBeUndefined()
  })
})

describe('reading the journal back', () => {
  test('skips unreadable lines rather than losing the session', async () => {
    __setSessionJournalRuntime({
      append: async () => {},
      read: async () => ({
        lines: [
          serializeObservation(observation({ ts: T0 + 1000 })),
          '{"partial":',
          serializeObservation(observation({ ts: T0 })),
        ],
        truncated: true,
      }),
      now: () => T0,
    })
    const read = await readObservations('a'.repeat(64))
    expect(read.observations).toHaveLength(2)
    expect(read.unreadableLines).toBe(1)
    expect(read.truncated).toBe(true)
    // Sorted oldest-first regardless of file order.
    expect(read.observations[0].ts).toBe(T0)
  })
})

describe('windowing', () => {
  test('groups by whole minute from the first observation', () => {
    const windows = windowObservations([
      observation({ ts: T0 }),
      observation({ ts: T0 + 30_000 }),
      observation({
        ts: T0 + 61_000,
        verdict: 'mild',
        reasoning: 'checked phone',
      }),
    ])
    expect(windows).toHaveLength(2)
    expect(windows[0]).toMatchObject({
      startMin: 0,
      endMin: 1,
      onTask: 2,
      offTask: 0,
    })
    expect(windows[1]).toMatchObject({
      startMin: 1,
      endMin: 2,
      onTask: 0,
      offTask: 1,
    })
  })

  test('counts an uncertain check separately from on and off task', () => {
    const [window] = windowObservations([
      observation({ verdict: 'uncertain', reasoning: 'unreadable' }),
      observation({ ts: T0 + 1000, verdict: 'blatant', reasoning: 'gaming' }),
      observation({ ts: T0 + 2000 }),
    ])
    expect(window).toMatchObject({ onTask: 1, offTask: 1, uncertain: 1 })
  })

  test('drops windows with no checks instead of inventing a gap', () => {
    const windows = windowObservations([
      observation({ ts: T0 }),
      // Ten minutes of break: capture is paused, so nothing is recorded.
      observation({ ts: T0 + 10 * 60_000 }),
    ])
    expect(windows.map((w) => w.startMin)).toEqual([0, 10])
  })

  test('orders notes by frequency and caps them', () => {
    const [window] = windowObservations([
      observation({ ts: T0, reasoning: 'rare' }),
      observation({ ts: T0 + 1, reasoning: 'common' }),
      observation({ ts: T0 + 2, reasoning: 'common' }),
      observation({ ts: T0 + 3, reasoning: 'second' }),
      observation({ ts: T0 + 4, reasoning: 'second' }),
      observation({ ts: T0 + 5, reasoning: 'fourth' }),
    ])
    expect(window.notes).toHaveLength(MAX_WINDOW_NOTES)
    expect(window.notes[0]).toBe('common')
  })

  test('records each declared topic once, in the order it was seen', () => {
    const [window] = windowObservations([
      observation({ ts: T0, topic: 'Maths' }),
      observation({ ts: T0 + 1, topic: 'Maths' }),
      observation({ ts: T0 + 2, topic: 'Physics' }),
    ])
    expect(window.topics).toEqual(['Maths', 'Physics'])
  })

  test('widens the window rather than growing the count on a long session', () => {
    const threeHours = 180
    expect(windowMinutesFor(threeHours)).toBe(3)
    const observations = Array.from({ length: threeHours }, (_, minute) =>
      observation({ ts: T0 + minute * 60_000 })
    )
    const windows = windowObservations(observations)
    expect(windows.length).toBeLessThanOrEqual(MAX_WINDOWS)
    expect(windows[0]).toMatchObject({ startMin: 0, endMin: 3 })
  })

  test('a one-minute session still gets a one-minute window', () => {
    expect(windowMinutesFor(0)).toBe(1)
    expect(windowObservations([observation()])).toHaveLength(1)
  })

  test('no observations means no windows', () => {
    expect(windowObservations([])).toEqual([])
  })
})
