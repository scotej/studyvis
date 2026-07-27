// I79 — the footer AI chip read "AI off" whenever no model was active, even
// with AI switched ON. During issue #92 that was the only on-screen signal that
// anything was wrong, and it pointed at the wrong setting entirely.
//
// The guard ORDER is the whole design here, so these tests pin the boundaries
// between the states rather than each state in isolation.

import { describe, expect, test } from 'vitest'

import { deriveAiChipStatus } from '@/features/session/aiChip'

const running = {
  aiFeaturesEnabled: true,
  activeModelId: 'model-a',
  modelStatus: 'ready' as const,
  hasLocalStream: true,
  runtimeStatus: 'active' as const,
}

describe('deriveAiChipStatus', () => {
  test('AI off wins over a stale runtime error from a torn-down loop', () => {
    expect(
      deriveAiChipStatus({
        ...running,
        aiFeaturesEnabled: false,
        runtimeStatus: 'error',
      })
    ).toBe('off')
  })

  test("a null model while the store is still loading reads 'off', not a warning", () => {
    // Otherwise every launch flashes "AI needs a model" during the hydration
    // window that fix A introduced.
    expect(
      deriveAiChipStatus({
        ...running,
        activeModelId: null,
        modelStatus: 'loading',
      })
    ).toBe('off')
  })

  test("no model once the store is ready reads 'unconfigured'", () => {
    expect(
      deriveAiChipStatus({
        ...running,
        activeModelId: null,
        modelStatus: 'ready',
      })
    ).toBe('unconfigured')
  })

  test("no model because the store failed to read also reads 'unconfigured'", () => {
    // Different cause, same truth for the chip: AI is on and cannot run. The
    // toast carries the cause-specific advice.
    expect(
      deriveAiChipStatus({
        ...running,
        activeModelId: null,
        modelStatus: 'error',
      })
    ).toBe('unconfigured')
  })

  test("a camera still spinning up reads 'off', not 'unconfigured'", () => {
    // Nothing is missing from the user's AI setup; the camera tile and
    // MediaErrorBanner own that story.
    expect(deriveAiChipStatus({ ...running, hasLocalStream: false })).toBe(
      'off'
    )
  })

  test('a fully configured loop passes its runtime status through', () => {
    expect(deriveAiChipStatus(running)).toBe('active')
    expect(deriveAiChipStatus({ ...running, runtimeStatus: 'paused' })).toBe(
      'paused'
    )
    expect(deriveAiChipStatus({ ...running, runtimeStatus: 'error' })).toBe(
      'error'
    )
  })
})
