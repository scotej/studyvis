// Shared types for the V1 audit log. Lives in `lib/` so both the
// `features/session/audit.ts` controller and the `stores/auditStore` can
// import them without violating the layering rule (stores must not reach
// into features). Mirrors the placement of `lib/pomodoro-types.ts`.

import type { JsonValue } from 'trystero'

// V1 audit-log event kinds (ARCHITECTURE.md §9). The full set including AI
// kinds — `topic_set`, `topic_change`, `ai_warning`, `ai_alert`,
// `break_request`, `break_approved`, `break_denied` — is V2-and-later.
export type AuditEventKind =
  | 'joined'
  | 'left'
  | 'paused_break'
  | 'resumed'
  | 'pomodoro_start'
  | 'pomodoro_end'

export const AUDIT_EVENT_VERSION = 1 as const
export const AUDIT_ACTION = 'audit'

// Detail must round-trip through trystero's data channel, so values are
// constrained to JSON-safe shapes. Keep detail small and string/number-typed
// — the audit log is a UI surface, not a structured event log.
export type AuditEventDetail = { [key: string]: JsonValue }

// User-facing action label for each kind. The audit panel reads this through
// the SessionView mapper so the components/ layer stays independent of the
// V1 vs V2 kind set (the V2 phase will extend this map and the panel
// renders whatever label the mapper hands it).
export const AUDIT_KIND_LABELS: Record<AuditEventKind, string> = {
  joined: 'joined',
  left: 'left',
  paused_break: 'took a break',
  resumed: 'returned',
  pomodoro_start: 'started a Pomodoro',
  pomodoro_end: 'stopped the Pomodoro',
}

// Wire shape: `who` is the sender's ed_pubkey hex, `sig` is hex(64), but
// receivers MUST authenticate via the peerId→ed_pubkey map established by
// the signed-hello handshake — never trust `who` from the wire as the
// verification key (see §7's "Unsigned or invalid-signature messages are
// dropped" requirement and the V1-P8 carryover that this phase resolves).
export type AuditEventCore = {
  v: typeof AUDIT_EVENT_VERSION
  session_topic: string
  ts: number
  who: string
  kind: AuditEventKind
  detail: AuditEventDetail
}

export type AuditEvent = AuditEventCore & { sig: string }

// Canonical bytes-being-signed AND bytes the receiver re-serializes for
// verification. Round-trip must be byte-identical: JSON key order, whitespace,
// and field selection are pinned here. Detail is round-tripped through
// JSON.stringify directly so nested objects keep their existing key order.
export function serializeAuditForSig(core: AuditEventCore): Uint8Array {
  const canonical = JSON.stringify({
    v: core.v,
    session_topic: core.session_topic,
    ts: core.ts,
    who: core.who,
    kind: core.kind,
    detail: core.detail,
  })
  return new TextEncoder().encode(canonical)
}

export function isAuditEventKind(value: unknown): value is AuditEventKind {
  return (
    value === 'joined' ||
    value === 'left' ||
    value === 'paused_break' ||
    value === 'resumed' ||
    value === 'pomodoro_start' ||
    value === 'pomodoro_end'
  )
}

export function isAuditEvent(value: unknown): value is AuditEvent {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<AuditEvent>
  return (
    v.v === AUDIT_EVENT_VERSION &&
    typeof v.session_topic === 'string' &&
    typeof v.ts === 'number' &&
    typeof v.who === 'string' &&
    isAuditEventKind(v.kind) &&
    typeof v.sig === 'string' &&
    !!v.detail &&
    typeof v.detail === 'object'
  )
}
