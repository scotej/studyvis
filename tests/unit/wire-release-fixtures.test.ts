import { describe, expect, test } from 'vitest'

import {
  serializeAckForSig,
  serializePayloadForSig,
} from '@/features/friends/envelope'
import {
  serializeAiAlertForSig,
  verifyIncomingAiAlert,
} from '@/features/session/aiAlerts'
import { serializeAuditForSig } from '@/lib/audit-types'
import { hexToBytes, verifyMessage } from '@/lib/crypto/identity'
import { verifyIncomingAuditEvent } from '@/stores/auditStore'

// v2.0.0's canonical layouts, signed once with RFC 8032 test vector 1.
// Literals are independent of the current producer and verifier: updating both
// together must not make a wire-format change pass unnoticed.
const ED = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
const INVITE =
  '{"session_topic":"release-fixture","session_password":"fixture-password","our_display_name":"Zoë","expires_at":1700000300000}'
const INVITE_SIG =
  '450f73e9cfacbdaeb708a3a35fa3399e23a82d668daa294684be01126139b4ee905ebdfc02eaa0be9583c275cd73a49a6f16eef70a0b21a449b3decbeea0c903'
const ACK =
  '{"session_topic":"release-fixture","to_ed_pubkey":"d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a","ts":1700000000000}'
const ACK_SIG =
  'b971b89f352d850be0d0589f6733710856d91b2751f590f627290769ba91d1d9fae775dcd220a4b520678e55ebf69f844c63a588888a38f22178f3b56e42330f'
const AUDIT =
  '{"v":1,"session_topic":"release-fixture","ts":1700000000000,"who":"d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a","kind":"joined","detail":{"display_name":"Zoë","sequence":1}}'
const AUDIT_SIG =
  '0eb8a0b132e1e26667e27e88efd7445f892241acce4493fe6cd4091e8c0b042c3953c2afdce92fecd61f1e0d157f2b3c83ca08071df79d40a16bb107e0b16c0e'
const ALERT =
  '{"v":1,"session_topic":"release-fixture","ts":1700000000000,"who":"d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a","severity":"moderate","reasoning":"Reading news café"}'
const ALERT_SIG =
  'fb79f5f043475e63f6c14edb1e0686a281a6a9c2436feeab4878d2ab5f6261be52b846defdf615e3bf77b83a7844585357cfbeaadfcfe79aeb38059a1fd8bd02'

function checkReleasedBytes(
  actual: Uint8Array,
  literal: string,
  signature: string
) {
  expect(actual).toEqual(new TextEncoder().encode(literal))
  expect(verifyMessage(hexToBytes(ED), actual, hexToBytes(signature))).toBe(
    true
  )
}

describe('released signed-wire bytes', () => {
  test('invite producer preserves field order, UTF-8 and released signature', () => {
    checkReleasedBytes(
      serializePayloadForSig({
        session_topic: 'release-fixture',
        session_password: 'fixture-password',
        our_display_name: 'Zoë',
        expires_at: 1_700_000_300_000,
      }),
      INVITE,
      INVITE_SIG
    )
  })

  test('invite ACK producer preserves released signature bytes', () => {
    checkReleasedBytes(
      serializeAckForSig({
        session_topic: 'release-fixture',
        to_ed_pubkey: ED,
        ts: 1_700_000_000_000,
      }),
      ACK,
      ACK_SIG
    )
  })

  test('audit producer and receiver interoperate with a released signed record', () => {
    const core = {
      v: 1 as const,
      session_topic: 'release-fixture',
      ts: 1_700_000_000_000,
      who: ED,
      kind: 'joined' as const,
      detail: { display_name: 'Zoë', sequence: 1 },
    }
    checkReleasedBytes(serializeAuditForSig(core), AUDIT, AUDIT_SIG)
    expect(
      verifyIncomingAuditEvent({ ...JSON.parse(AUDIT), sig: AUDIT_SIG }, ED)
    ).toEqual({ ...core, sig: AUDIT_SIG })
    expect(
      verifyIncomingAuditEvent(
        { ...core, detail: { ...core.detail, sequence: 2 }, sig: AUDIT_SIG },
        ED
      )
    ).toBeNull()
  })

  test('AI alert producer and receiver interoperate with a released signed record', () => {
    const core = {
      v: 1 as const,
      session_topic: 'release-fixture',
      ts: 1_700_000_000_000,
      who: ED,
      severity: 'moderate' as const,
      reasoning: 'Reading news café',
    }
    checkReleasedBytes(serializeAiAlertForSig(core), ALERT, ALERT_SIG)
    expect(
      verifyIncomingAiAlert({ ...JSON.parse(ALERT), sig: ALERT_SIG }, ED)
    ).toEqual({ ...core, sig: ALERT_SIG })
    expect(
      verifyIncomingAiAlert(
        { ...core, reasoning: 'Different', sig: ALERT_SIG },
        ED
      )
    ).toBeNull()
  })
})
