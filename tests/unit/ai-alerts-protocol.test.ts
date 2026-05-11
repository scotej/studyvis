// V2-P6 — peer-alert wire shape: sign/verify/serialize round-trip.

import { describe, expect, test } from 'vitest'

import {
  AI_ALERT_VERSION,
  buildAiAlertPayload,
  isAiAlertPayload,
  serializeAiAlertForSig,
  verifyIncomingAiAlert,
} from '@/features/session'
import { generateIdentity, signMessage } from '@/lib/crypto/identity'
import { bytesToHex } from '@/lib/encoding'

describe('AI alert wire shape', () => {
  test('build + verify round-trips with the sender ed_pubkey binding', async () => {
    const me = generateIdentity()
    const payload = await buildAiAlertPayload({
      sessionTopic: 'topic-1',
      myEdPubkeyHex: bytesToHex(me.edPub),
      severity: 'moderate',
      reasoning: 'browsing news',
      ts: 1_700_000_000_000,
      sign: async (msg) => signMessage(me.edPriv, msg),
    })
    expect(payload.v).toBe(AI_ALERT_VERSION)
    expect(payload.who).toBe(bytesToHex(me.edPub))
    const verified = verifyIncomingAiAlert(payload, bytesToHex(me.edPub))
    expect(verified?.sig).toBe(payload.sig)
    expect(verified?.severity).toBe('moderate')
    expect(verified?.reasoning).toBe('browsing news')
  })

  test('rejects unknown / out-of-range severity', () => {
    // Manually construct so we can inject a non-ScoreEvent severity.
    expect(
      isAiAlertPayload({
        v: AI_ALERT_VERSION,
        session_topic: 't',
        ts: 1,
        who: 'aa',
        severity: 'on_task',
        reasoning: 'x',
        sig: 'aa',
      })
    ).toBe(false)
    expect(
      isAiAlertPayload({
        v: AI_ALERT_VERSION,
        session_topic: 't',
        ts: 1,
        who: 'aa',
        severity: 'unknown',
        reasoning: 'x',
        sig: 'aa',
      })
    ).toBe(false)
  })

  test('rejects when no binding (signed-hello not yet arrived)', async () => {
    const me = generateIdentity()
    const payload = await buildAiAlertPayload({
      sessionTopic: 'topic-1',
      myEdPubkeyHex: bytesToHex(me.edPub),
      severity: 'mild',
      reasoning: 'x',
      ts: 1,
      sign: async (msg) => signMessage(me.edPriv, msg),
    })
    expect(verifyIncomingAiAlert(payload, null)).toBeNull()
  })

  test('rejects when the declared who does not match the binding', async () => {
    const a = generateIdentity()
    const b = generateIdentity()
    // A signs an alert correctly but claims `who` belongs to B. Receiver's
    // binding for peer A is bytesToHex(a.edPub); the mismatch drops it.
    const core = {
      v: AI_ALERT_VERSION,
      session_topic: 'topic-1',
      ts: 1,
      who: bytesToHex(b.edPub),
      severity: 'mild' as const,
      reasoning: 'x',
    }
    const sig = signMessage(a.edPriv, serializeAiAlertForSig(core))
    const payload = { ...core, sig: bytesToHex(sig) }
    expect(verifyIncomingAiAlert(payload, bytesToHex(a.edPub))).toBeNull()
  })

  test('rejects a tampered reasoning field (sig invalidates)', async () => {
    const me = generateIdentity()
    const payload = await buildAiAlertPayload({
      sessionTopic: 'topic-1',
      myEdPubkeyHex: bytesToHex(me.edPub),
      severity: 'moderate',
      reasoning: 'original',
      ts: 1,
      sign: async (msg) => signMessage(me.edPriv, msg),
    })
    const tampered = { ...payload, reasoning: 'tampered' }
    expect(verifyIncomingAiAlert(tampered, bytesToHex(me.edPub))).toBeNull()
  })

  test('rejects a tampered signature', async () => {
    const me = generateIdentity()
    const payload = await buildAiAlertPayload({
      sessionTopic: 'topic-1',
      myEdPubkeyHex: bytesToHex(me.edPub),
      severity: 'mild',
      reasoning: 'x',
      ts: 1,
      sign: async (msg) => signMessage(me.edPriv, msg),
    })
    const tampered = {
      ...payload,
      sig: payload.sig.slice(0, -1) + (payload.sig.endsWith('0') ? '1' : '0'),
    }
    expect(verifyIncomingAiAlert(tampered, bytesToHex(me.edPub))).toBeNull()
  })

  test('the wire payload omits deduction and scoreAfter', async () => {
    const me = generateIdentity()
    const payload = await buildAiAlertPayload({
      sessionTopic: 'topic-1',
      myEdPubkeyHex: bytesToHex(me.edPub),
      severity: 'blatant',
      reasoning: 'a game',
      ts: 1,
      sign: async (msg) => signMessage(me.edPriv, msg),
    })
    // The wire MUST NOT carry deduction / scoreAfter — peers can't be able
    // to reconstruct the off-task user's running score from broadcast
    // payloads.
    expect(Object.keys(payload)).not.toContain('deduction')
    expect(Object.keys(payload)).not.toContain('scoreAfter')
  })

  test('canonical serializer is byte-identical between sender and receiver', () => {
    const core = {
      v: AI_ALERT_VERSION,
      session_topic: 't',
      ts: 1,
      who: 'aa',
      severity: 'mild' as const,
      reasoning: 'x',
    }
    const senderBytes = serializeAiAlertForSig(core)
    const receiverBytes = serializeAiAlertForSig(core)
    // Reference-different but byte-equal arrays.
    expect(senderBytes).not.toBe(receiverBytes)
    expect(Array.from(senderBytes)).toEqual(Array.from(receiverBytes))
  })
})
