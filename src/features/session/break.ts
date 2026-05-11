// V2-P7 — Deterministic break rules + the request orchestration that wires
// the AI dialog into the SessionView audit pipeline.
//
// Why a rule layer at all (spec PLAN.md V2 + V2-P7 prompt):
//
//   "AI agent can recommend approve/deny with reasoning; the rule layer
//    is the final arbiter (so a clever user can't just say 'approve')."
//
// So even if the user manipulates the small local model into recommending
// approve, this layer will deny when the deterministic constraints fail.
// The AI's reasoning is surfaced when it tips a tie (rules pass, AI denies)
// but never overrides a rule violation.
//
// Constraints (V2-P7 step 4):
//   - Cool-down:   ≥ 25 min between break ENDS and the next request.
//   - Cap:         ≤ 10 min per break.
//   - Quota:       ≤ 4 breaks per session (simple total since session
//                  start; V2-P9 may upgrade to a rolling 2-hour window).
//
// Duration cap policy: we silently CLAMP requests above the cap rather
// than deny them. A user typing "15 min" gets a 10-min break with a
// "capped" note in the reason. Denying would surprise the user and the
// rules are already enforced by the clamp — denial would also reject the
// AI's recommendation merely for being optimistic about a constraint we
// could just enforce.

import { useBreakStore } from '@/features/ai/breakStore'
import type { AuditEventDetail, AuditEventKind } from '@/lib/audit-types'

export const MIN_BREAK_INTERVAL_MS = 25 * 60 * 1000
export const MAX_BREAK_DURATION_SEC = 10 * 60
export const MAX_BREAKS_PER_SESSION = 4
export const MIN_BREAK_DURATION_SEC = 30

export type BreakVerdict =
  | { verdict: 'approved'; durationSec: number; reason: string }
  | { verdict: 'denied'; reason: string }

export type AiRecommendation = 'approve' | 'deny'

export type RequestBreakInput = {
  // The model's intent JSON `payload`. `requestedDurationSec` is what the
  // user (via the AI) asked for; the rule layer clamps it.
  requestedDurationSec: number
  // The AI's verdict. Advisory — the rule layer is the final arbiter,
  // but a "deny" with rules-pass surfaces the AI's reasoning to the user.
  aiRecommendation: AiRecommendation
  // Free-text reason the AI offered. Used as the verdict reason when the
  // AI tips a tie (or for context in audit log details).
  aiReasoning: string
  // Wall-clock ms epoch the request landed. Tests inject; production
  // passes `Date.now()`.
  now: number
}

// Snapshot of the breakStore that the rule layer reads. Pulled out as a
// separate type so unit tests can hand-construct a snapshot rather than
// mutating the global store. Production wraps `useBreakStore.getState()`.
export type BreakRuleState = {
  onBreak: boolean
  lastBreakEndedAt: number | null
  breaksThisSession: number
}

export function snapshotBreakState(): BreakRuleState {
  const s = useBreakStore.getState()
  return {
    onBreak: s.onBreak,
    lastBreakEndedAt: s.lastBreakEndedAt,
    breaksThisSession: s.breaksThisSession,
  }
}

// Pure rule evaluator — no store reads, no side effects. Easy to test for
// every boundary; the orchestrator below combines this with the store
// mutations and audit emits.
export function evaluateBreakRules(
  input: RequestBreakInput,
  state: BreakRuleState
): BreakVerdict {
  if (state.onBreak) {
    return { verdict: 'denied', reason: "you're already on a break." }
  }
  if (state.breaksThisSession >= MAX_BREAKS_PER_SESSION) {
    return {
      verdict: 'denied',
      reason: `you've already taken ${MAX_BREAKS_PER_SESSION} breaks this session.`,
    }
  }
  if (state.lastBreakEndedAt !== null) {
    const elapsedMs = input.now - state.lastBreakEndedAt
    if (elapsedMs < MIN_BREAK_INTERVAL_MS) {
      const remainingMin = Math.ceil(
        (MIN_BREAK_INTERVAL_MS - elapsedMs) / 60_000
      )
      return {
        verdict: 'denied',
        reason: `your last break was less than 25 minutes ago — try again in ${remainingMin} min.`,
      }
    }
  }
  if (
    !Number.isFinite(input.requestedDurationSec) ||
    input.requestedDurationSec < MIN_BREAK_DURATION_SEC
  ) {
    return {
      verdict: 'denied',
      reason: `breaks need to be at least ${MIN_BREAK_DURATION_SEC} seconds.`,
    }
  }
  // Clamp to cap. We never deny purely for "too long" — the AI may have
  // asked for 15 min and the user-visible message just notes the cap.
  const clamped = Math.min(input.requestedDurationSec, MAX_BREAK_DURATION_SEC)
  const wasCapped = clamped < input.requestedDurationSec
  // Rule layer passes; consult the AI's recommendation. Per the prompt
  // "the rule layer is the final arbiter" so an AI deny here only surfaces
  // its reasoning — the user-visible verdict honours the AI's read of
  // the situation when rules are silent.
  if (input.aiRecommendation === 'deny') {
    return {
      verdict: 'denied',
      reason: input.aiReasoning || 'the assistant recommended against it.',
    }
  }
  const displayDuration = formatBreakDuration(clamped)
  const reason = wasCapped
    ? `approved · ${displayDuration} (capped to the ${MAX_BREAK_DURATION_SEC / 60}-min max).`
    : `approved · ${displayDuration}.`
  return { verdict: 'approved', durationSec: clamped, reason }
}

// Renders a break duration so the reason line is accurate to the actual
// seconds approved. Clean minutes (multiples of 60) render as "N min";
// sub-minute durations render as "Ns"; everything else renders as
// "Nm Ms" so a 90-second break doesn't surface as "2 min" or "1 min".
export function formatBreakDuration(durationSec: number): string {
  const total = Math.max(0, Math.floor(durationSec))
  if (total < 60) {
    return `${total}s`
  }
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (seconds === 0) {
    return `${minutes} min`
  }
  return `${minutes}m ${seconds}s`
}

// Audit-pipeline accessors the orchestrator depends on. Mirrors the
// V2-P6 dispatcher's pattern: SessionView owns the audit channel; the
// orchestrator is a consumer.
export type BreakAuditPipeline = {
  appendLocalAudit: (
    kind: AuditEventKind,
    detail: AuditEventDetail
  ) => Promise<void>
  emitAudit: (kind: AuditEventKind, detail: AuditEventDetail) => Promise<void>
}

export type RequestBreakOrchestratorDeps = BreakAuditPipeline & {
  // Setter for breakStore — production passes
  // `useBreakStore.getState().startApprovedBreak`.
  startApprovedBreak: (args: { durationSec: number; startedAt: number }) => void
  endBreak: (endedAt: number) => void
  // `setTimeout` injection so tests can drive the deadline deterministically.
  setTimeout: (handler: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  // Reader for the breakStore snapshot — production wraps
  // `snapshotBreakState`. Tests inject a stub state.
  snapshot: () => BreakRuleState
  // Test seam for `now` so the deadline scheduler can be advanced with
  // vi.useFakeTimers without depending on Date.now alignment.
  now: () => number
}

// State the orchestrator hands back so consumers (cross-window IPC) can
// surface it. Mirrors `BreakVerdict` with the extra context that the
// audit pipeline already saw the events — callers only need to relay the
// verdict to the dialog window.
export type BreakRequestOutcome = BreakVerdict

let activeBreakTimerHandle: unknown = null

// Single-orchestrator hand-off. SessionView is the only caller in V2-P7
// (it sits behind the cross-window event listener). Re-entrant: a second
// call while a break is active is denied by the rule layer's `onBreak`
// check, so we never need to mutex this.
export async function requestBreak(
  input: RequestBreakInput,
  deps: RequestBreakOrchestratorDeps
): Promise<BreakRequestOutcome> {
  const state = deps.snapshot()
  // Audit the request first (LOCAL-ONLY — mirrors V2-P6 `ai_warning`
  // privacy invariant). The user's intent is private until the verdict
  // resolves; if denied, only the user sees the request happened.
  try {
    await deps.appendLocalAudit('break_request', {
      requested_duration_sec: input.requestedDurationSec,
      ai_recommendation: input.aiRecommendation,
      ai_reasoning: input.aiReasoning,
    })
  } catch (err) {
    console.error('[break] break_request local-audit failed:', err)
  }

  const verdict = evaluateBreakRules(input, state)

  if (verdict.verdict === 'denied') {
    try {
      await deps.emitAudit('break_denied', { reason: verdict.reason })
    } catch (err) {
      console.error('[break] break_denied broadcast failed:', err)
    }
    return verdict
  }

  // Approve path: bump the store and emit the broadcast.
  deps.startApprovedBreak({
    durationSec: verdict.durationSec,
    startedAt: input.now,
  })
  try {
    await deps.emitAudit('break_approved', {
      duration_sec: verdict.durationSec,
      reason: verdict.reason,
    })
  } catch (err) {
    console.error('[break] break_approved broadcast failed:', err)
  }
  // Schedule the natural end. The handle lives at module scope so a
  // teardown can cancel it (e.g. SessionView unmount on session end);
  // requestBreak itself is the only public surface that arms a new one,
  // and the rule layer denies re-entry while `onBreak` is true, so the
  // module-scoped handle is sufficient (no need for a per-call ID).
  if (activeBreakTimerHandle !== null) {
    deps.clearTimeout(activeBreakTimerHandle)
  }
  activeBreakTimerHandle = deps.setTimeout(() => {
    activeBreakTimerHandle = null
    deps.endBreak(deps.now())
  }, verdict.durationSec * 1000)

  return verdict
}

// Cancels any pending break-end timer. Used by SessionView's session-end
// teardown so a closed session doesn't fire a stale `endBreak` after
// `reset()` already cleared the store.
export function cancelActiveBreakTimer(
  clearTimeoutFn: (handle: unknown) => void
): void {
  if (activeBreakTimerHandle === null) return
  clearTimeoutFn(activeBreakTimerHandle)
  activeBreakTimerHandle = null
}

// Test seam — vitest tests reset the module-scoped handle between cases.
export function __resetBreakTimerForTests(): void {
  activeBreakTimerHandle = null
}
