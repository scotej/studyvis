import { create } from 'zustand'

import {
  AUDIT_EVENT_VERSION,
  isAuditEvent,
  serializeAuditForSig,
  type AuditEvent,
  type AuditEventCore,
  type AuditEventDetail,
  type AuditEventKind,
} from '@/features/session/audit'
import { verifyMessage } from '@/lib/crypto/identity'
import { auditEventInsert } from '@/lib/db/audit'
import { bytesToHex, hexToBytes } from '@/lib/encoding'

export type StoredAuditEvent = AuditEvent & {
  // Per-event monotonic sequence used as React key. Receiver-side seq is
  // assigned by the local store in arrival order; the wire payload does not
  // carry it.
  seq: number
}

type AuditState = {
  events: StoredAuditEvent[]
  // Monotonic counter for breaking ties when two events share the same `ts`
  // (microsecond clock collisions are rare in practice but trivial to
  // construct with vi.useFakeTimers). Held in store state so HMR /
  // StrictMode dev double-mount can't inherit a stale module-level value
  // and emit a duplicate `seq` for the first event of a fresh session.
  nextSeq: number
  // Pushes a verified event onto the local list. Used by both the local-
  // emit path (after our own send succeeds) and the receive path (after
  // signature + binding checks pass). Idempotent on (who, ts, kind, sig)
  // so a self-loopback doesn't double-render.
  append: (event: AuditEvent) => void
  reset: () => void
}

// Test seam — replaced by Vitest mocks in unit tests so the store can be
// driven without a Tauri runtime. Production calls the real Tauri command.
let persistFn: (event: AuditEvent) => Promise<void> = async (event) => {
  await auditEventInsert({
    sessionId: event.session_topic,
    ts: event.ts,
    who: event.who,
    kind: event.kind,
    detail: JSON.stringify(event.detail ?? {}),
    sig: event.sig,
  })
}

export function __setAuditPersistFn(
  fn: (event: AuditEvent) => Promise<void>
): void {
  persistFn = fn
}

export const useAuditStore = create<AuditState>((set, get) => ({
  events: [],
  nextSeq: 0,
  append: (event) => {
    // Drop exact duplicates (same sig). Cheap O(n) scan; n is small (events
    // accrue at human cadence per session).
    if (get().events.some((e) => e.sig === event.sig)) return
    const seq = get().nextSeq + 1
    const stored: StoredAuditEvent = { ...event, seq }
    set((s) => ({ events: [...s.events, stored], nextSeq: seq }))
    // Best-effort SQLite persistence (V1-P9 carryover): the panel reflects
    // the event regardless of disk write success. The post-session report
    // (V2) is the consumer of the persisted rows.
    void persistFn(event).catch((err) => {
      console.error('audit persist failed:', err)
    })
  },
  reset: () => set({ events: [], nextSeq: 0 }),
}))

export type SignFn = (bytes: Uint8Array) => Promise<Uint8Array>

export type EmitArgs = {
  sessionTopic: string
  myEdPubkeyHex: string
  kind: AuditEventKind
  detail?: AuditEventDetail
  sign: SignFn
  // Test seam — production passes Date.now.
  now?: () => number
}

// Builds + signs an audit event. The caller appends to the local store and
// broadcasts on the data channel; this helper exists so the unit test can
// exercise the canonical-bytes round-trip directly.
export async function buildAuditEvent(args: EmitArgs): Promise<AuditEvent> {
  const ts = args.now ? args.now() : Date.now()
  const core: AuditEventCore = {
    v: AUDIT_EVENT_VERSION,
    session_topic: args.sessionTopic,
    ts,
    who: args.myEdPubkeyHex,
    kind: args.kind,
    detail: args.detail ?? {},
  }
  const sig = await args.sign(serializeAuditForSig(core))
  return { ...core, sig: bytesToHex(sig) }
}

// Verifies an incoming audit event against the peerId↔ed_pubkey binding
// established by signed-hello. Returns the verified event iff:
//   - shape matches the V1 wire schema
//   - `expectedEdPubkeyHex` (caller's binding lookup) exists
//   - the event's `who` matches the binding (no impersonation)
//   - the Ed25519 signature over canonical bytes verifies
// Anything else is a silent drop, matching ARCHITECTURE.md §7's
// "Unsigned or invalid-signature messages are dropped" rule.
export function verifyIncomingAuditEvent(
  data: unknown,
  expectedEdPubkeyHex: string | null
): AuditEvent | null {
  if (!isAuditEvent(data)) return null
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

  const signed = serializeAuditForSig({
    v: data.v,
    session_topic: data.session_topic,
    ts: data.ts,
    who: data.who,
    kind: data.kind,
    detail: data.detail,
  })
  if (!verifyMessage(edPub, signed, sig)) return null
  return data
}
