// N2 / N6 — local pomodoro transition detection + side-effect gating.

import { describe, expect, test, vi } from 'vitest'

import {
  detectPhaseTransition,
  handlePomodoroTransition,
} from '@/features/session/pomodoroNotify'

describe('detectPhaseTransition', () => {
  test('work→rest is a to-rest boundary (every preset family)', () => {
    expect(detectPhaseTransition('work-25', 'rest-5')).toBe('to-rest')
    expect(detectPhaseTransition('work-50', 'rest-10')).toBe('to-rest')
    expect(detectPhaseTransition('work-custom', 'rest-custom')).toBe('to-rest')
  })

  test('rest→work is a to-work boundary', () => {
    expect(detectPhaseTransition('rest-5', 'work-25')).toBe('to-work')
    expect(detectPhaseTransition('rest-custom', 'work-custom')).toBe('to-work')
  })

  test('start (idle→work) and stop (work→idle) are NOT boundaries', () => {
    expect(detectPhaseTransition('idle', 'work-25')).toBeNull()
    expect(detectPhaseTransition('work-25', 'idle')).toBeNull()
    expect(detectPhaseTransition('idle', 'idle')).toBeNull()
  })

  test('a same-family relabel is not a boundary', () => {
    // e.g. a preset swap that keeps the work family.
    expect(detectPhaseTransition('work-25', 'work-50')).toBeNull()
    expect(detectPhaseTransition('rest-5', 'rest-custom')).toBeNull()
  })
})

describe('handlePomodoroTransition', () => {
  test('null transition does nothing', () => {
    const notify = vi.fn()
    const playChime = vi.fn()
    handlePomodoroTransition(null, {
      notificationsEnabled: () => true,
      soundEnabled: () => true,
      notify,
      playChime,
      isLookingAtTimer: () => false,
    })
    expect(notify).not.toHaveBeenCalled()
    expect(playChime).not.toHaveBeenCalled()
  })

  test('fires notification + chime when both enabled and user is away', () => {
    const notify = vi.fn()
    const playChime = vi.fn()
    handlePomodoroTransition('to-rest', {
      notificationsEnabled: () => true,
      soundEnabled: () => true,
      notify,
      playChime,
      isLookingAtTimer: () => false,
    })
    expect(notify).toHaveBeenCalledWith('to-rest')
    expect(playChime).toHaveBeenCalledTimes(1)
  })

  test('suppresses only the notification when the user is looking at the timer', () => {
    const notify = vi.fn()
    const playChime = vi.fn()
    handlePomodoroTransition('to-work', {
      notificationsEnabled: () => true,
      soundEnabled: () => true,
      notify,
      playChime,
      isLookingAtTimer: () => true,
    })
    // The chime still plays — it's the opt-in away-signal; the OS prompt is
    // the one that'd be redundant on a focused window.
    expect(notify).not.toHaveBeenCalled()
    expect(playChime).toHaveBeenCalledTimes(1)
  })

  test('respects each gate independently', () => {
    const notify = vi.fn()
    const playChime = vi.fn()
    handlePomodoroTransition('to-rest', {
      notificationsEnabled: () => true,
      soundEnabled: () => false,
      notify,
      playChime,
      isLookingAtTimer: () => false,
    })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(playChime).not.toHaveBeenCalled()

    const notify2 = vi.fn()
    const playChime2 = vi.fn()
    handlePomodoroTransition('to-rest', {
      notificationsEnabled: () => false,
      soundEnabled: () => true,
      notify: notify2,
      playChime: playChime2,
      isLookingAtTimer: () => false,
    })
    expect(notify2).not.toHaveBeenCalled()
    expect(playChime2).toHaveBeenCalledTimes(1)
  })
})
