import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  buildImagePayload,
  IMAGE_MAX_BYTES,
  sanitizeImageFilename,
  SessionImageError,
  validateOutgoingImage,
  verifyIncomingImage,
} from '@/features/session/images'
import { useNotesStore } from '@/features/session/notesStore'
import {
  bytesToHex,
  generateIdentity,
  signMessage,
} from '@/lib/crypto/identity'

const TOPIC = 'session-image-topic'

function makeSigner() {
  const identity = generateIdentity()
  return {
    edHex: bytesToHex(identity.edPub),
    sign: async (message: Uint8Array) => signMessage(identity.edPriv, message),
  }
}

async function fixture() {
  const signer = makeSigner()
  const bytes = new Uint8Array([1, 2, 3, 4])
  const payload = await buildImagePayload({
    sessionTopic: TOPIC,
    myEdPubkeyHex: signer.edHex,
    bytes,
    filename: '../study shot.PNG',
    mimeType: 'image/png',
    width: 640,
    height: 480,
    sign: signer.sign,
    now: () => 123,
  })
  return { signer, payload }
}

describe('session image wire', () => {
  test('round-trips a signed binary image', async () => {
    const { signer, payload } = await fixture()
    const verified = verifyIncomingImage(
      payload.bytes.buffer,
      payload.metadata,
      signer.edHex,
      TOPIC
    )
    expect(verified?.metadata.filename).toBe('study shot.PNG')
    expect(verified?.blob.type).toBe('image/png')
    expect(verified?.blob.size).toBe(4)
  })

  test('rejects tampered bytes, metadata, sender, and session', async () => {
    const { signer, payload } = await fixture()
    expect(
      verifyIncomingImage(
        new Uint8Array([1, 2, 3, 5]),
        payload.metadata,
        signer.edHex,
        TOPIC
      )
    ).toBeNull()
    expect(
      verifyIncomingImage(
        payload.bytes,
        { ...payload.metadata, width: 641 },
        signer.edHex,
        TOPIC
      )
    ).toBeNull()
    expect(
      verifyIncomingImage(payload.bytes, payload.metadata, null, TOPIC)
    ).toBeNull()
    expect(
      verifyIncomingImage(
        payload.bytes,
        payload.metadata,
        signer.edHex,
        'other-topic'
      )
    ).toBeNull()
  })

  test('validates supported type and 5 MB transfer cap', () => {
    expect(() =>
      validateOutgoingImage(new File(['x'], 'x.svg', { type: 'image/svg+xml' }))
    ).toThrowError(SessionImageError)
    expect(() =>
      validateOutgoingImage(
        new File([new Uint8Array(IMAGE_MAX_BYTES + 1)], 'x.png', {
          type: 'image/png',
        })
      )
    ).toThrowError(SessionImageError)
  })

  test('normalizes unsafe filenames and MIME extensions', () => {
    expect(sanitizeImageFilename('../../bad:name.exe', 'image/jpeg')).toBe(
      'bad-name.jpg'
    )
    expect(sanitizeImageFilename('', 'image/webp')).toBe('studyvis-image.webp')
  })
})

describe('session image store lifecycle', () => {
  const createObjectURL = vi.fn(() => 'blob:fixture')
  const revokeObjectURL = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    useNotesStore.setState({ notes: [], images: [] })
  })

  test('creates an object URL and revokes it on reset', () => {
    useNotesStore.getState().appendImage({
      fromEdPubkeyHex: 'sender',
      mine: false,
      blob: new Blob(['image'], { type: 'image/png' }),
      filename: 'image.png',
      mimeType: 'image/png',
      width: 10,
      height: 10,
      ts: 1,
    })
    expect(useNotesStore.getState().images[0]?.objectUrl).toBe('blob:fixture')
    useNotesStore.getState().reset()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fixture')
  })
})
