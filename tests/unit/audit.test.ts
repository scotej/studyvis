import { describe, expect, test } from 'vitest'

import {
  AUDIT_EVENT_VERSION,
  serializeAuditForSig,
  type AuditEvent,
} from '@/features/session/audit'
import { generateIdentity, signMessage } from '@/lib/crypto/identity'
import { bytesToHex } from '@/lib/encoding'
import { buildAuditEvent, verifyIncomingAuditEvent } from '@/stores/auditStore'

function buildEvent(
  edPriv: Uint8Array,
  edPub: Uint8Array,
  overrides: Partial<AuditEvent> = {}
): AuditEvent {
  const core = {
    v: AUDIT_EVENT_VERSION,
    session_topic: 'topic-fixture-hex',
    ts: 1_700_000_001_000,
    who: bytesToHex(edPub),
    kind: 'joined' as const,
    detail: {},
    ...overrides,
  }
  const sigBytes = signMessage(edPriv, serializeAuditForSig(core))
  return { ...core, sig: bytesToHex(sigBytes) }
}

describe('buildAuditEvent + verifyIncomingAuditEvent round-trip', () => {
  test('a properly-signed event verifies against its declared `who`', async () => {
    const me = generateIdentity()
    const event = await buildAuditEvent({
      sessionTopic: 'topic-1',
      myEdPubkeyHex: bytesToHex(me.edPub),
      kind: 'joined',
      sign: async (msg) => signMessage(me.edPriv, msg),
      now: () => 1_700_000_002_000,
    })
    expect(event.kind).toBe('joined')
    expect(event.ts).toBe(1_700_000_002_000)
    const verified = verifyIncomingAuditEvent(event, bytesToHex(me.edPub))
    expect(verified).not.toBeNull()
    expect(verified?.sig).toBe(event.sig)
  })
})

describe('verifyIncomingAuditEvent rejects malformed / unsigned / tampered', () => {
  test('rejects when expected ed_pubkey is null (no signed-hello binding yet)', () => {
    const me = generateIdentity()
    const event = buildEvent(me.edPriv, me.edPub)
    expect(verifyIncomingAuditEvent(event, null)).toBeNull()
  })

  test('rejects when the declared `who` does not match the binding', () => {
    // Sender peer A sends an event correctly signed by their own key, but
    // claims `who` belongs to peer B. The receiver's binding for peer A is
    // their own pubkey — the mismatch causes a drop. (Belt-and-braces with
    // the sig check below; the binding mismatch alone is enough.)
    const a = generateIdentity()
    const b = generateIdentity()
    const event = buildEvent(a.edPriv, a.edPub, { who: bytesToHex(b.edPub) })
    expect(verifyIncomingAuditEvent(event, bytesToHex(a.edPub))).toBeNull()
  })

  test('rejects a tampered detail field', () => {
    const me = generateIdentity()
    const event = buildEvent(me.edPriv, me.edPub, { detail: { tag: 'orig' } })
    const tampered: AuditEvent = {
      ...event,
      detail: { tag: 'tampered' },
    }
    expect(verifyIncomingAuditEvent(tampered, bytesToHex(me.edPub))).toBeNull()
  })

  test('rejects a tampered signature', () => {
    const me = generateIdentity()
    const event = buildEvent(me.edPriv, me.edPub)
    const tampered: AuditEvent = {
      ...event,
      // Flip one nibble of the sig.
      sig: event.sig.slice(0, -1) + (event.sig.endsWith('0') ? '1' : '0'),
    }
    expect(verifyIncomingAuditEvent(tampered, bytesToHex(me.edPub))).toBeNull()
  })

  test('rejects when the wrong identity is used to verify', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const event = buildEvent(a.edPriv, a.edPub)
    expect(verifyIncomingAuditEvent(event, bytesToHex(b.edPub))).toBeNull()
  })

  test('rejects an entirely unsigned-shaped payload', () => {
    expect(
      verifyIncomingAuditEvent({ kind: 'joined', who: 'aa' }, 'aa'.repeat(32))
    ).toBeNull()
  })

  test('rejects a kind not in the V1 set (AI events belong to V2)', () => {
    const me = generateIdentity()
    // Manually construct with a V2 kind to make sure shape-validation drops
    // it without exposing AI plumbing into V1.
    const core = {
      v: AUDIT_EVENT_VERSION,
      session_topic: 'topic-1',
      ts: 1,
      who: bytesToHex(me.edPub),
      kind: 'ai_warning',
      detail: {},
    }
    const sigBytes = signMessage(me.edPriv, serializeAuditForSig(core as never))
    const event = { ...core, sig: bytesToHex(sigBytes) }
    expect(verifyIncomingAuditEvent(event, bytesToHex(me.edPub))).toBeNull()
  })

  test("rejects a peer claiming someone else's identity (impersonation)", () => {
    // Peer B generates a signature with their own key but claims to be A.
    // Even with the right sig over their canonical bytes, the binding
    // (peerId B → ed_pubkey B) gates the verify call. Receiver looks up
    // peerId B → expected_ed = B; event.who = A; mismatch drops it.
    const a = generateIdentity()
    const b = generateIdentity()
    const event = buildEvent(b.edPriv, b.edPub, { who: bytesToHex(a.edPub) })
    expect(verifyIncomingAuditEvent(event, bytesToHex(b.edPub))).toBeNull()
  })
})
