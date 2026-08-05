import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  buildImagePayload,
  IMAGE_MAX_ANIMATION_FRAMES,
  IMAGE_MAX_BYTES,
  inspectImageBytes,
  sanitizeImageFilename,
  SessionImageError,
  validateOutgoingImage,
  verifyIncomingImage,
} from '@/features/session/images'
import { saveSessionImage } from '@/features/session/imageSave'
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
  1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68,
  65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 0, 5, 0, 1, 255, 137, 153,
  61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
])

const VALID_JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01,
  0x11, 0x00, 0xff, 0xd9,
])

const VALID_GIF_BYTES = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x01, 0x00,
  0x00, 0x3b,
])

const VALID_WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56,
  0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
])

function pngChunk(type: string, data: number[]): number[] {
  const length = data.length
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...[...type].map((character) => character.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ]
}

function mismatchedApng(): Uint8Array {
  return new Uint8Array([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    ...pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]),
    ...pngChunk('fcTL', new Array(26).fill(0)),
    ...pngChunk('IDAT', [0]),
    ...pngChunk('IEND', []),
  ])
}

function gifWithFrames(frameCount: number): Uint8Array {
  const frame = [
    0x2c, 0x02, 0x00, 0x02, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x01,
    0x00, 0x00,
  ]
  return new Uint8Array([
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    ...Array.from({ length: frameCount }, () => frame).flat(),
    0x3b,
  ])
}

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
  test('inspects each supported image container', () => {
    expect(inspectImageBytes(VALID_PNG_BYTES, 'image/png')).toEqual({
      width: 1,
      height: 1,
      frameCount: 1,
    })
    expect(inspectImageBytes(VALID_JPEG_BYTES, 'image/jpeg')).toEqual({
      width: 1,
      height: 1,
      frameCount: 1,
    })
    expect(inspectImageBytes(VALID_GIF_BYTES, 'image/gif')).toEqual({
      width: 1,
      height: 1,
      frameCount: 1,
    })
    expect(inspectImageBytes(VALID_WEBP_BYTES, 'image/webp')).toEqual({
      width: 1,
      height: 1,
      frameCount: 1,
    })
  })

  test('rejects inconsistent and over-budget animations', () => {
    expect(inspectImageBytes(mismatchedApng(), 'image/png')).toBeNull()
    expect(
      inspectImageBytes(
        gifWithFrames(IMAGE_MAX_ANIMATION_FRAMES + 1),
        'image/gif'
      )
    ).toBeNull()
  })

  test('accepts browser-renderable GIF frames outside the logical screen', () => {
    expect(inspectImageBytes(gifWithFrames(1), 'image/gif')).toEqual({
      width: 1,
      height: 1,
      frameCount: 1,
    })
  })

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
      verifyIncomingImage(tamperedBytes, payload.metadata, signer.edHex, TOPIC)
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
      frameCount: 1,
      ts: 1,
    })
    expect(useNotesStore.getState().images[0]?.objectUrl).toBe('blob:fixture')
    useNotesStore.getState().reset()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fixture')
  })
})

describe('session image save', () => {
  test('writes exact bytes after a chosen path', async () => {
    const writeFile = vi.fn(async () => {})
    const result = await saveSessionImage(
      new Blob([VALID_PNG_BYTES], { type: 'image/png' }),
      'image.png',
      'image/png',
      {
        pickPath: async () => '/tmp/image.png',
        writeFile,
      }
    )
    expect(result).toBe('saved')
    expect(writeFile).toHaveBeenCalledWith(
      '/tmp/image.png',
      Array.from(VALID_PNG_BYTES)
    )
  })

  test('does not write when the dialog is cancelled', async () => {
    const writeFile = vi.fn(async () => {})
    const result = await saveSessionImage(
      new Blob([VALID_PNG_BYTES], { type: 'image/png' }),
      'image.png',
      'image/png',
      {
        pickPath: async () => null,
        writeFile,
      }
    )
    expect(result).toBe('cancelled')
    expect(writeFile).not.toHaveBeenCalled()
  })
})
