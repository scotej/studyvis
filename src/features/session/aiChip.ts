// I79 — the footer AI chip's status, as a pure function.
//
// It lives here rather than inside SessionView for two reasons: react-refresh
// forbids non-component exports from a component file (the same constraint that
// put `noScoreBody` in reportSerialize.ts), and vitest runs node-env with no
// jsdom, so a pure module is the only part of this the test suite can reach.
//
// The bug it fixes: the chip read "AI off" whenever `activeModelId` was null,
// even with AI switched ON in Settings. During issue #92 that was the single
// on-screen signal that anything was wrong, and it pointed the user at exactly
// the wrong conclusion — that they had left AI off — while the real state was
// "AI is on and cannot run". "AI off" is now reserved for AI actually being off.

import type { AiStatus } from '@/components/AiStatusChip'

export type AiChipInputs = {
  aiFeaturesEnabled: boolean
  activeModelId: string | null
  // The model store's hydration status. 'loading' is the reason this function
  // exists as a four-input decision rather than a two-input one.
  modelStatus: 'loading' | 'ready' | 'error'
  hasLocalStream: boolean
  // What the running loop's callbacks last reported. Only consulted once every
  // "AI cannot possibly be running" case is excluded, so a stale 'error' from a
  // previous loop can never outlive the condition that produced it.
  runtimeStatus: AiStatus
}

// Guard order is load-bearing; each comment says what breaks if it moves.
export function deriveAiChipStatus({
  aiFeaturesEnabled,
  activeModelId,
  modelStatus,
  hasLocalStream,
  runtimeStatus,
}: AiChipInputs): AiStatus {
  // First, so a stale runtime 'error' or 'paused' from a loop that has since
  // been torn down can never claim something is wrong after the user switched
  // AI off themselves.
  if (!aiFeaturesEnabled) return 'off'
  // AI is on but has nothing to run. Only claimable once the store has actually
  // reported: while it is still 'loading' a null model is unknown, not absent,
  // and treating it as absent would flash "AI needs a model" on every launch.
  if (!activeModelId) {
    return modelStatus === 'loading' ? 'off' : 'unconfigured'
  }
  // Camera still spinning up (or off). Reads as 'off' rather than
  // 'unconfigured' — nothing is missing from the user's setup, and the camera
  // tile plus MediaErrorBanner already own that story.
  if (!hasLocalStream) return 'off'
  return runtimeStatus
}
