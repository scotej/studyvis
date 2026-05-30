import { describe, expect, test } from 'vitest'

import {
  ESC_LEAVE_WINDOW_MS,
  shouldLeaveOnEsc,
} from '@/features/session/escLeave'

describe('shouldLeaveOnEsc', () => {
  const now = 1_700_000_000_000

  test('arms (does not leave) when nothing is armed yet', () => {
    expect(shouldLeaveOnEsc(null, now, ESC_LEAVE_WINDOW_MS)).toBe(false)
  })

  test('leaves when the second Esc is well within the window', () => {
    expect(shouldLeaveOnEsc(now - 500, now, ESC_LEAVE_WINDOW_MS)).toBe(true)
  })

  test('leaves at exactly the window boundary (inclusive)', () => {
    expect(
      shouldLeaveOnEsc(now - ESC_LEAVE_WINDOW_MS, now, ESC_LEAVE_WINDOW_MS)
    ).toBe(true)
  })

  test('re-arms (does not leave) one ms past the window', () => {
    expect(
      shouldLeaveOnEsc(now - ESC_LEAVE_WINDOW_MS - 1, now, ESC_LEAVE_WINDOW_MS)
    ).toBe(false)
  })
})
