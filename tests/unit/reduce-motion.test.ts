import { describe, expect, test } from 'vitest'

import { resolveReduceMotion } from '@/design/reduce-motion'

// V3-P7 — Pure decision-function tests. The DOM-side (matchMedia
// subscription, storage event, attribute write) is user-verifiable via
// the manual SR + visual pass in the PR; this file pins the boolean
// algebra so a future refactor can't accidentally invert the OR.

describe('resolveReduceMotion', () => {
  test.each<[boolean, boolean, boolean]>([
    // setting | osPrefers | expected
    [false, false, false], // neither — motion enabled
    [true, false, true], // user setting only — motion off
    [false, true, true], // OS preference only — motion off
    [true, true, true], // both — motion off (idempotent)
  ])('setting=%s osPrefers=%s → reduced=%s', (setting, osPrefers, expected) => {
    expect(resolveReduceMotion(setting, osPrefers)).toBe(expected)
  })
})
