import { describe, expect, test, vi } from 'vitest'

import {
  buildDirectMessagePayload,
  DIRECT_MESSAGE_MAX_LENGTH,
  sendDirectMessageToPeer,
  serializeDirectMessageForSig,
  verifyIncomingDirectMessage,
} from '@/features/session/directMessages'
import {
  bytesToHex,
  generateIdentity,
  signMessage,
} from '@/lib/crypto/identity'

const TOPIC = 'session-topic-fixture'

function makeSigner() {
  const identity = generateIdentity()
  return {
    edHex: bytesToHex(identity.edPub),
    sign: async (message: Uint8Array) => signMessage(identity.edPriv, message),
  }
}

async function fixture() {
  const sender = makeSigner()
  const recipient = makeSigner()
  const other = makeSigner()
  const payload = await buildDirectMessagePayload({
    sessionTopic: TOPIC,
    myEdPubkeyHex: sender.edHex,
    recipientEdPubkeyHex: recipient.edHex,
    text: 'private hello',
    sign: sender.sign,
    now: () => 123,
  })
  return { sender, recipient, other, payload }
}

describe('session direct-message trust boundary', () => {
  test('serializes the signed core in one canonical field order', () => {
    const serialized = serializeDirectMessageForSig({
      v: 1,
      session_topic: TOPIC,
      from_ed_pubkey: '11'.repeat(32),
      to_ed_pubkey: '22'.repeat(32),
      text: 'private hello',
      ts: 123,
    })

    expect(new TextDecoder().decode(serialized)).toBe(
      `{"v":1,"session_topic":"${TOPIC}","from_ed_pubkey":"${'11'.repeat(32)}","to_ed_pubkey":"${'22'.repeat(32)}","text":"private hello","ts":123}`
    )
  })

  test('trims and caps outbound text and rejects an empty message', async () => {
    const sender = makeSigner()
    const recipient = makeSigner()
    const payload = await buildDirectMessagePayload({
      sessionTopic: TOPIC,
      myEdPubkeyHex: sender.edHex,
      recipientEdPubkeyHex: recipient.edHex,
      text: `  ${'x'.repeat(DIRECT_MESSAGE_MAX_LENGTH + 1)}  `,
      sign: sender.sign,
      now: () => 123,
    })

    expect(payload.text).toBe('x'.repeat(DIRECT_MESSAGE_MAX_LENGTH))
    await expect(
      buildDirectMessagePayload({
        sessionTopic: TOPIC,
        myEdPubkeyHex: sender.edHex,
        recipientEdPubkeyHex: recipient.edHex,
        text: '   ',
        sign: sender.sign,
      })
    ).rejects.toThrow('direct message text must not be empty')
  })

  test('always targets the intended peer when sending', async () => {
    const { payload } = await fixture()
    const send = vi.fn().mockResolvedValue(undefined)

    await sendDirectMessageToPeer({ send }, payload, 'recipient-peer-id')

    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(payload, 'recipient-peer-id')

    await expect(
      sendDirectMessageToPeer({ send }, payload, '   ')
    ).rejects.toThrow('direct message recipient peer ID must not be empty')
    expect(send).toHaveBeenCalledOnce()
  })

  test('accepts a valid recipient-bound message', async () => {
    const { sender, recipient, payload } = await fixture()
    expect(
      verifyIncomingDirectMessage(payload, sender.edHex, recipient.edHex, TOPIC)
    ).toEqual(payload)
  })

  test('rejects wrong version, recipient, topic, and expected sender', async () => {
    const { sender, recipient, other, payload } = await fixture()
    expect(
      verifyIncomingDirectMessage(
        { ...payload, v: 2 },
        sender.edHex,
        recipient.edHex,
        TOPIC
      )
    ).toBeNull()
    expect(
      verifyIncomingDirectMessage(
        { ...payload, to_ed_pubkey: other.edHex },
        sender.edHex,
        recipient.edHex,
        TOPIC
      )
    ).toBeNull()
    expect(
      verifyIncomingDirectMessage(
        { ...payload, session_topic: 'other-topic' },
        sender.edHex,
        recipient.edHex,
        TOPIC
      )
    ).toBeNull()
    expect(
      verifyIncomingDirectMessage(payload, other.edHex, recipient.edHex, TOPIC)
    ).toBeNull()
    expect(
      verifyIncomingDirectMessage(payload, null, recipient.edHex, TOPIC)
    ).toBeNull()
  })

  test('rejects malformed hex and invalid key or signature lengths', async () => {
    const { recipient, payload } = await fixture()
    expect(
      verifyIncomingDirectMessage(
        { ...payload, from_ed_pubkey: 'zz'.repeat(32) },
        'zz'.repeat(32),
        recipient.edHex,
        TOPIC
      )
    ).toBeNull()
    expect(
      verifyIncomingDirectMessage(
        { ...payload, sig: 'zz'.repeat(64) },
        payload.from_ed_pubkey,
        recipient.edHex,
        TOPIC
      )
    ).toBeNull()

    const shortKey = '11'.repeat(31)
    expect(
      verifyIncomingDirectMessage(
        { ...payload, from_ed_pubkey: shortKey },
        shortKey,
        recipient.edHex,
        TOPIC
      )
    ).toBeNull()
    expect(
      verifyIncomingDirectMessage(
        { ...payload, sig: '00'.repeat(63) },
        payload.from_ed_pubkey,
        recipient.edHex,
        TOPIC
      )
    ).toBeNull()
    expect(
      verifyIncomingDirectMessage(
        { ...payload, from_ed_pubkey: '11'.repeat(33) },
        '11'.repeat(33),
        recipient.edHex,
        TOPIC
      )
    ).toBeNull()
    expect(
      verifyIncomingDirectMessage(
        { ...payload, sig: '00'.repeat(65) },
        payload.from_ed_pubkey,
        recipient.edHex,
        TOPIC
      )
    ).toBeNull()
  })

  test('rejects non-finite timestamps before signature verification', async () => {
    const { sender, recipient, payload } = await fixture()
    for (const ts of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(
        verifyIncomingDirectMessage(
          { ...payload, ts },
          sender.edHex,
          recipient.edHex,
          TOPIC
        )
      ).toBeNull()
    }
  })

  test('cryptographically binds the payload to its recipient', async () => {
    const { sender, other, payload } = await fixture()
    expect(
      verifyIncomingDirectMessage(
        { ...payload, to_ed_pubkey: other.edHex },
        sender.edHex,
        other.edHex,
        TOPIC
      )
    ).toBeNull()
  })

  test('rejects a validly shaped payload whose signature no longer verifies', async () => {
    const { sender, recipient, payload } = await fixture()
    expect(
      verifyIncomingDirectMessage(
        { ...payload, text: 'tampered' },
        sender.edHex,
        recipient.edHex,
        TOPIC
      )
    ).toBeNull()
  })
})
