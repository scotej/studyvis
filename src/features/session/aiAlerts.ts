// V2-P6 — Peer-alert wire protocol + score-event dispatcher.
//
// This module bridges the V2-P5 score machine (which emits warning / alert
// ScoreEvents into `useFocusStore.lastEvents` per sample) into:
//
//   1. The local UI (`useAlertsUiStore`)            — self-warning badge,
//      alerted-peer tile state.
//   2. The local audit log (`useAuditStore.append`) — `ai_warning` events
//      are LOCAL ONLY; `ai_alert` events both append locally AND broadcast
//      via the SessionView-owned audit pipeline.
//   3. The new `ai-alert` data-channel action       — signed peer-alert
//      message (ARCHITECTURE.md §7) so peers can render the tile-border,
//      play the sound, and log the audit row immediately.
//
// Two invariants from the V2-P5 carryover are load-bearing:
//
//   * Warnings NEVER broadcast. The dispatcher routes `{type:'warning'}`
//     events to the local-only audit append + private badge. A future
//     reader who is tempted to add `auditAction.send` for warnings should
//     re-read this comment.
//
//   * Alert payloads omit `deduction` and `scoreAfter` so peers cannot
//     reconstruct the off-task user's running score. Only `severity` +
//     `reasoning` cross the wire. The detail attached to the `ai_alert`
//     audit event uses the same shape for parity.

import {
  useAlertsUiStore,
  type AlertSeverity,
} from '@/features/ai/alertsUiStore'
import { playPeerAlertSound } from '@/features/ai/alertSound'
import type { Severity } from '@/features/ai/parseJudgment'
import type { ScoreEvent } from '@/features/ai/scoreMachine'
import { verifyMessage } from '@/lib/crypto/identity'
import { bytesToHex, hexToBytes } from '@/lib/encoding'
import type { TopicRoom } from '@/lib/trystero'
import type { AuditEventDetail, AuditEventKind } from '@/lib/audit-types'
import type { SignFn } from '@/stores/auditStore'

export const AI_ALERT_ACTION = 'ai-alert'
export const AI_ALERT_VERSION = 1 as const

export type AiAlertCore = {
  v: typeof AI_ALERT_VERSION
  session_topic: string
  ts: number
  who: string
  severity: AlertSeverity
  reasoning: string
}

export type AiAlertPayload = AiAlertCore & { sig: string }

// Canonical bytes the sender signs and the receiver re-serializes for
// verification. Key order and whitespace are pinned so the round-trip is
// byte-stable — same approach as audit events / hello payloads.
export function serializeAiAlertForSig(core: AiAlertCore): Uint8Array {
  const canonical = JSON.stringify({
    v: core.v,
    session_topic: core.session_topic,
    ts: core.ts,
    who: core.who,
    severity: core.severity,
    reasoning: core.reasoning,
  })
  return new TextEncoder().encode(canonical)
}

function isAlertSeverity(value: unknown): value is AlertSeverity {
  return value === 'mild' || value === 'moderate' || value === 'blatant'
}

export function isAiAlertPayload(value: unknown): value is AiAlertPayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<AiAlertPayload>
  return (
    v.v === AI_ALERT_VERSION &&
    typeof v.session_topic === 'string' &&
    typeof v.ts === 'number' &&
    typeof v.who === 'string' &&
    isAlertSeverity(v.severity) &&
    typeof v.reasoning === 'string' &&
    typeof v.sig === 'string'
  )
}

// Receiver-side verification — mirrors `verifyIncomingAuditEvent`. Uses the
// peerId→ed_pubkey binding established by the V1-P9 signed-hello so a
// stranger on the topic cannot impersonate a friend.
export function verifyIncomingAiAlert(
  data: unknown,
  expectedEdPubkeyHex: string | null
): AiAlertPayload | null {
  if (!isAiAlertPayload(data)) return null
  if (!expectedEdPubkeyHex) return null
  if (data.who !== expectedEdPubkeyHex) return null

  let edPub: Uint8Array
  let sig: Uint8Array
  try {
    edPub = hexToBytes(expectedEdPubkeyHex)
    sig = hexToBytes(data.sig)
  } catch {
    return null
  }
  if (edPub.length !== 32 || sig.length !== 64) return null

  const signed = serializeAiAlertForSig({
    v: data.v,
    session_topic: data.session_topic,
    ts: data.ts,
    who: data.who,
    severity: data.severity,
    reasoning: data.reasoning,
  })
  if (!verifyMessage(edPub, signed, sig)) return null
  return data
}

export type BuildAiAlertArgs = {
  sessionTopic: string
  myEdPubkeyHex: string
  severity: AlertSeverity
  reasoning: string
  ts: number
  sign: SignFn
}

export async function buildAiAlertPayload(
  args: BuildAiAlertArgs
): Promise<AiAlertPayload> {
  const core: AiAlertCore = {
    v: AI_ALERT_VERSION,
    session_topic: args.sessionTopic,
    ts: args.ts,
    who: args.myEdPubkeyHex,
    severity: args.severity,
    reasoning: args.reasoning,
  }
  const sig = await args.sign(serializeAiAlertForSig(core))
  return { ...core, sig: bytesToHex(sig) }
}

export type AiAlertDispatcherArgs = {
  room: TopicRoom
  sessionTopic: string
  myEdPubkeyHex: string
  sign: SignFn
  // Receiver-side binding lookup. Production routes through
  // `useSessionStore.peers[peerId]?.edPubkeyHex` (set by V1-P9's signed
  // hello); tests inject a deterministic map.
  resolveSenderEdPubkey: (peerId: string) => string | null
  // Audit pipeline accessors owned by SessionView. The dispatcher is a
  // consumer, not an owner: warnings call `appendLocalAudit` (local-only
  // append, no wire), alerts call `emitAudit` (append + broadcast on the
  // existing AUDIT_ACTION channel). Keeping ownership in SessionView
  // avoids duplicating the audit channel listener / send pair.
  appendLocalAudit: (
    kind: AuditEventKind,
    detail: AuditEventDetail,
    options?: { now?: () => number }
  ) => Promise<void>
  emitAudit: (
    kind: AuditEventKind,
    detail: AuditEventDetail,
    options?: { now?: () => number }
  ) => Promise<void>
  // Test seam — production uses `Date.now`. Injected here rather than
  // shared module-level so vi.useFakeTimers + the dispatcher's wall-clock
  // reads can be coordinated in tests. The dispatcher pins this `ts`
  // through to the alert payload AND the ai_alert audit event so receivers
  // see byte-identical timestamps in both surfaces.
  now?: () => number
  // Test seam — production uses `playPeerAlertSound`. Injected so unit /
  // integration tests can assert sound-fire count without touching audio.
  playSound?: () => void
}

export type AiAlertDispatcher = {
  // Routes every batch of ScoreEvents the sample loop just emitted.
  // Warnings stay local; alerts broadcast. Each call is independent: the
  // dispatcher never queues, never debounces.
  handleScoreEvents: (events: ReadonlyArray<ScoreEvent>) => Promise<void>
  // Reacts to an on_task severity by clearing the active self-warning. The
  // 30 s TTL would catch this too, but the spec calls for explicit
  // dismissal on the next on_task sample.
  handleSeverity: (severity: Severity) => void
  teardown: () => void
}

export function startAiAlertDispatcher(
  args: AiAlertDispatcherArgs
): AiAlertDispatcher {
  const alertAction = args.room.makeAction<AiAlertPayload>(AI_ALERT_ACTION)
  const now = args.now ?? (() => Date.now())
  const playSound = args.playSound ?? playPeerAlertSound

  alertAction.receive((data, peerId) => {
    const expectedEd = args.resolveSenderEdPubkey(peerId)
    const verified = verifyIncomingAiAlert(data, expectedEd)
    if (!verified) return
    // Drop alerts that claim a different session — the trystero room is
    // already topic-scoped, but a misbehaving peer could replay an alert
    // from a previous session. Cheap defensive check.
    if (verified.session_topic !== args.sessionTopic) return
    useAlertsUiStore.getState().setAlertedPeer({
      edPubkeyHex: verified.who,
      reasoning: verified.reasoning,
      severity: verified.severity,
      ts: verified.ts,
    })
    playSound()
  })

  async function handleAlert(severity: AlertSeverity, reasoning: string) {
    const ts = now()
    // 1. Audit row: append locally + broadcast via the AUDIT_ACTION pipe.
    // Pin the audit-event ts to the same `ts` we use for the signed alert
    // payload so the two surfaces (audit row + alert message) line up
    // byte-identically — important for post-session report ordering.
    try {
      await args.emitAudit(
        'ai_alert',
        { severity, reasoning },
        { now: () => ts }
      )
    } catch (err) {
      console.error('[aiAlerts] ai_alert audit failed:', err)
    }

    // 2. Signed alert message on the new AI_ALERT_ACTION channel.
    try {
      const payload = await buildAiAlertPayload({
        sessionTopic: args.sessionTopic,
        myEdPubkeyHex: args.myEdPubkeyHex,
        severity,
        reasoning,
        ts,
        sign: args.sign,
      })
      await alertAction.send(payload)
    } catch (err) {
      console.error('[aiAlerts] alert broadcast failed:', err)
    }

    // 3. Light our own tile too — the carryover spec is "All peers
    // (including the off-task user) get a sound + tile-border highlight."
    // Updating our own entry directly avoids needing a self-loopback over
    // the data channel.
    useAlertsUiStore.getState().setAlertedPeer({
      edPubkeyHex: args.myEdPubkeyHex,
      reasoning,
      severity,
      ts,
    })
    playSound()
  }

  async function handleWarning(severity: AlertSeverity, reasoning: string) {
    const ts = now()
    useAlertsUiStore.getState().setSelfWarning({
      reasoning,
      severity,
      ts,
    })
    try {
      await args.appendLocalAudit(
        'ai_warning',
        { severity, reasoning },
        { now: () => ts }
      )
    } catch (err) {
      console.error('[aiAlerts] ai_warning local-append failed:', err)
    }
  }

  return {
    handleScoreEvents: async (events) => {
      for (const event of events) {
        if (event.type === 'warning') {
          await handleWarning(event.severity, event.reasoning)
        } else if (event.type === 'alert') {
          await handleAlert(event.severity, event.reasoning)
        }
      }
    },
    handleSeverity: (severity) => {
      if (severity === 'on_task') {
        useAlertsUiStore.getState().clearSelfWarning()
      }
    },
    teardown: () => {
      // trystero's receivers tear down naturally when the room leaves —
      // there's no per-receiver detach in the trystero API. We
      // intentionally do not reset `useAlertsUiStore` here; SessionView
      // owns the lifecycle reset on session boundaries so the splash
      // transition can read the outgoing state.
    },
  }
}
