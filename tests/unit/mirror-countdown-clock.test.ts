import { afterEach, describe, expect, test, vi } from 'vitest'
import { useBreakStore } from '@/features/ai/breakStore'
import { usePomodoroStore } from '@/stores/pomodoroStore'
import { mirrorCountdownDeadlines } from '@/features/mirror/sessionBridge'

const work = {
  phase: 'work-25' as const,
  endsAt: 1_501_000,
  preset: '25/5' as const,
  workMs: 1_500_000,
  restMs: 300_000,
  broadcasterEdPubkey: 'own',
  iAmBroadcaster: true,
}

afterEach(() => {
  vi.restoreAllMocks()
  usePomodoroStore.getState().reset()
  useBreakStore.getState().reset(null)
})

describe('host-controlled companion countdowns (#392)', () => {
  test.each([-600_000, 0, 600_000])(
    'a browser wall-clock offset of %d does not change duration',
    (offset) => {
      vi.spyOn(Date, 'now').mockReturnValue(1000 + offset)
      const projected = mirrorCountdownDeadlines(
        { countdowns: { pomodoroMs: 1_500_000, breakMs: 300_000 } },
        5000
      )!
      expect(projected.pomodoro! - 5000).toBe(1_500_000)
      expect(projected.break! - 5000).toBe(300_000)
      vi.mocked(Date.now).mockReturnValue(1000 - offset)
      expect(projected.pomodoro! - 65_000).toBe(1_440_000)
      expect(projected.break! - 65_000).toBe(240_000)
    }
  )

  test('host wall-clock jumps cannot rebase an unchanged phase or approved break', () => {
    const wall = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const mono = vi.spyOn(performance, 'now').mockReturnValue(5000)
    usePomodoroStore.getState().apply(work)
    useBreakStore
      .getState()
      .startApprovedBreak({ durationSec: 300, startedAt: 1000 })
    const phaseDeadline = usePomodoroStore.getState().endsAtMono!
    const breakDeadline = useBreakStore.getState().breakEndsAtMono!
    wall.mockReturnValue(601_000)
    mono.mockReturnValue(65_000)
    usePomodoroStore.getState().apply(work)
    expect(usePomodoroStore.getState().endsAtMono).toBe(phaseDeadline)
    expect(phaseDeadline - performance.now()).toBe(1_440_000)
    expect(breakDeadline - performance.now()).toBe(240_000)
    wall.mockReturnValue(-599_000)
    usePomodoroStore.getState().apply(work)
    expect(usePomodoroStore.getState().endsAtMono).toBe(phaseDeadline)
  })

  test('reconnect and phase transitions project a new host-controlled duration', () => {
    const wall = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const mono = vi.spyOn(performance, 'now').mockReturnValue(5000)
    usePomodoroStore.getState().apply(work)
    wall.mockReturnValue(601_000)
    mono.mockReturnValue(65_000)
    usePomodoroStore
      .getState()
      .apply({ ...work, phase: 'rest-5', endsAt: 901_000 })
    expect(usePomodoroStore.getState().endsAtMono).toBe(365_000)
    const reconnected = mirrorCountdownDeadlines(
      { countdowns: { pomodoroMs: 240_000, breakMs: null } },
      100_000
    )!
    expect(reconnected.pomodoro).toBe(340_000)
    expect(reconnected.break).toBeNull()
    usePomodoroStore.getState().reset()
    useBreakStore.getState().endBreak(Date.now())
    expect(usePomodoroStore.getState().endsAtMono).toBeNull()
    expect(useBreakStore.getState().breakEndsAtMono).toBeNull()
  })

  test('offline cached durations freeze and legacy snapshots retain their existing path', () => {
    const cached = mirrorCountdownDeadlines(
      { countdowns: { pomodoroMs: 40_000, breakMs: 0 } },
      undefined
    )!
    expect(cached).toEqual({ pomodoro: 40_000, break: 0, live: false })
    expect(mirrorCountdownDeadlines({}, 5000)).toBeNull()
  })
})
