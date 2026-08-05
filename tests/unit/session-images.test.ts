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
// prettier-ignore
const VALID_PNG_BYTES = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,
  1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68,
  65, 84, 120, 218, 99, 252, 255, 31, 0, 2, 235, 1, 245, 143, 89, 210, 45,
  0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
])

function makeSigner() {
  const identity = generateIdentity()
  return {
    edHex: bytesToHex(identity.edPub),
    sign: async (message: Uint8Array) => signMessage(identity.edPriv, message),
  }
}

async function fixture() {
  const signer = makeSigner()
  const bytes = VALID_PNG_BYTES.slice()
  const payload = await buildImagePayload({
    sessionTopic: TOPIC,
    myEdPubkeyHex: signer.edHex,
    bytes,
    filename: '../study shot.PNG',
    mimeType: 'image/png',
    width: 1,
    height: 1,
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
    expect(verified?.blob.size).toBe(VALID_PNG_BYTES.byteLength)
  })

  test('rejects tampered bytes, metadata, sender, and session', async () => {
    const { signer, payload } = await fixture()
    const tamperedBytes = payload.bytes.slice()
    tamperedBytes[tamperedBytes.length - 1] ^= 1

    expect(
      verifyIncomingImage(
        tamperedBytes,
        payload.metadata,
        signer.edHex,
        TOPIC
      )
    ).toBeNull()
    expect(
      verifyIncomingImage(
        payload.bytes,
        { ...payload.metadata, width: 2 },
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
