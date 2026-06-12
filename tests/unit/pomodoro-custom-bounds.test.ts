// N5 — custom-split bounds clamping (the UI's only line of defence before a
// typed value reaches the broadcast).

import { describe, expect, test } from 'vitest'

import {
  CUSTOM_REST_MAX,
  CUSTOM_REST_MIN,
  CUSTOM_WORK_MAX,
  CUSTOM_WORK_MIN,
  clampCustomMinutes,
} from '@/lib/pomodoro-types'

describe('clampCustomMinutes', () => {
  test('passes through an in-range split', () => {
    expect(clampCustomMinutes(45, 15)).toEqual({ workMin: 45, restMin: 15 })
  })

  test('clamps to the lower bounds', () => {
    expect(clampCustomMinutes(1, 0)).toEqual({
      workMin: CUSTOM_WORK_MIN,
      restMin: CUSTOM_REST_MIN,
    })
  })

  test('clamps to the upper bounds', () => {
    expect(clampCustomMinutes(999, 999)).toEqual({
      workMin: CUSTOM_WORK_MAX,
      restMin: CUSTOM_REST_MAX,
    })
  })

  test('rounds fractional input and floors non-finite to the minimum', () => {
    expect(clampCustomMinutes(45.4, 15.6)).toEqual({ workMin: 45, restMin: 16 })
    expect(clampCustomMinutes(Number.NaN, Number.NaN)).toEqual({
      workMin: CUSTOM_WORK_MIN,
      restMin: CUSTOM_REST_MIN,
    })
  })
})
