import { sha256 } from '@noble/hashes/sha2.js'

import { verifyMessage } from '@/lib/crypto/identity'
import { bytesToHex, hexToBytes } from '@/lib/encoding'

export const IMAGE_ACTION = 'session-image'
export const IMAGE_VERSION = 1 as const
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const IMAGE_MAX_DIMENSION = 32_768
export const IMAGE_FILENAME_MAX_LENGTH = 120

export const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number]
export type SessionImageErrorCode =
  'unsupported_type' | 'too_large' | 'invalid_image'

export class SessionImageError extends Error {
  readonly code: SessionImageErrorCode

  constructor(code: SessionImageErrorCode) {
    super(code)
    this.name = 'SessionImageError'
    this.code = code
  }
}

export type ImageCore = {
  v: typeof IMAGE_VERSION
  session_topic: string
  from_ed_pubkey: string
  filename: string
  mime_type: ImageMimeType
  byte_length: number
  width: number
  height: number
  sha256: string
  ts: number
}

export type ImageMetadata = ImageCore & { sig: string }

export type BuiltImagePayload = {
  bytes: Uint8Array
  metadata: ImageMetadata
}

export type VerifiedImagePayload = {
  blob: Blob
  metadata: ImageMetadata
}

const MIME_TYPE_SET = new Set<string>(IMAGE_MIME_TYPES)

export function isImageMimeType(value: unknown): value is ImageMimeType {
  return typeof value === 'string' && MIME_TYPE_SET.has(value)
}

export function imageExtensionForMime(mimeType: ImageMimeType): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
  }
}

export function sanitizeImageFilename(
  input: string,
  mimeType: ImageMimeType
): string {
  const extension = imageExtensionForMime(mimeType)
  const aliases = mimeType === 'image/jpeg' ? ['jpg', 'jpeg'] : [extension]
  const basename = input.replaceAll('\\', '/').split('/').at(-1) ?? ''
  const cleaned = [...basename]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 || '<>:"/\\|?*'.includes(character)
        ? '-'
        : character
    })
    .join('')
    .replace(/-+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, IMAGE_FILENAME_MAX_LENGTH)
  const fallback = `studyvis-image.${extension}`
  if (!cleaned) return fallback

  const dot = cleaned.lastIndexOf('.')
  const currentExtension = dot >= 0 ? cleaned.slice(dot + 1).toLowerCase() : ''
  if (aliases.includes(currentExtension)) return cleaned

  const stem = (dot > 0 ? cleaned.slice(0, dot) : cleaned)
    .replace(/[. ]+$/g, '')
    .slice(0, IMAGE_FILENAME_MAX_LENGTH - extension.length - 1)
  return stem ? `${stem}.${extension}` : fallback
}

export function validateOutgoingImage(file: File): void {
  if (!isImageMimeType(file.type)) {
    throw new SessionImageError('unsupported_type')
  }
  if (file.size <= 0) {
    throw new SessionImageError('invalid_image')
  }
  if (file.size > IMAGE_MAX_BYTES) {
    throw new SessionImageError('too_large')
  }
}

export async function readImageDimensions(
  blob: Blob
): Promise<{ width: number; height: number }> {
  if (typeof Image === 'undefined' || typeof URL === 'undefined') {
    throw new SessionImageError('invalid_image')
  }

  const url = URL.createObjectURL(blob)
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => {
        const width = image.naturalWidth
        const height = image.naturalHeight
        if (!validDimension(width) || !validDimension(height)) {
          reject(new SessionImageError('invalid_image'))
          return
        }
        resolve({ width, height })
      }
      image.onerror = () => reject(new SessionImageError('invalid_image'))
      image.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function serializeImageForSig(core: ImageCore): Uint8Array {
  const canonical = JSON.stringify({
    v: core.v,
    session_topic: core.session_topic,
    from_ed_pubkey: core.from_ed_pubkey,
    filename: core.filename,
    mime_type: core.mime_type,
    byte_length: core.byte_length,
    width: core.width,
    height: core.height,
    sha256: core.sha256,
    ts: core.ts,
  })
  return new TextEncoder().encode(canonical)
}

export async function buildImagePayload(args: {
  sessionTopic: string
  myEdPubkeyHex: string
  bytes: Uint8Array
  filename: string
  mimeType: ImageMimeType
  width: number
  height: number
  sign: (message: Uint8Array) => Promise<Uint8Array>
  now?: () => number
}): Promise<BuiltImagePayload> {
  if (args.bytes.byteLength <= 0) {
    throw new SessionImageError('invalid_image')
  }
  if (args.bytes.byteLength > IMAGE_MAX_BYTES) {
    throw new SessionImageError('too_large')
  }
  if (!validDimension(args.width) || !validDimension(args.height)) {
    throw new SessionImageError('invalid_image')
  }

  const core: ImageCore = {
    v: IMAGE_VERSION,
    session_topic: args.sessionTopic,
    from_ed_pubkey: args.myEdPubkeyHex,
    filename: sanitizeImageFilename(args.filename, args.mimeType),
    mime_type: args.mimeType,
    byte_length: args.bytes.byteLength,
    width: args.width,
    height: args.height,
    sha256: bytesToHex(sha256(args.bytes)),
    ts: args.now ? args.now() : Date.now(),
  }
  const sig = await args.sign(serializeImageForSig(core))
  return {
    bytes: args.bytes,
    metadata: { ...core, sig: bytesToHex(sig) },
  }
}

export function verifyIncomingImage(
  data: unknown,
  metadata: unknown,
  expectedEdPubkeyHex: string | null,
  sessionTopic: string
): VerifiedImagePayload | null {
  const bytes = normalizeBinaryPayload(data)
  if (!bytes || bytes.byteLength <= 0 || bytes.byteLength > IMAGE_MAX_BYTES) {
    return null
  }
  if (!metadata || typeof metadata !== 'object') return null

  const value = metadata as Partial<ImageMetadata>
  if (
    value.v !== IMAGE_VERSION ||
    typeof value.session_topic !== 'string' ||
    typeof value.from_ed_pubkey !== 'string' ||
    typeof value.filename !== 'string' ||
    !isImageMimeType(value.mime_type) ||
    typeof value.byte_length !== 'number' ||
    typeof value.width !== 'number' ||
    typeof value.height !== 'number' ||
    typeof value.sha256 !== 'string' ||
    typeof value.ts !== 'number' ||
    typeof value.sig !== 'string'
  ) {
    return null
  }
  if (!expectedEdPubkeyHex || value.from_ed_pubkey !== expectedEdPubkeyHex) {
    return null
  }
  if (value.session_topic !== sessionTopic) return null
  if (
    !Number.isSafeInteger(value.byte_length) ||
    value.byte_length !== bytes.byteLength ||
    value.byte_length > IMAGE_MAX_BYTES ||
    !validDimension(value.width) ||
    !validDimension(value.height) ||
    !Number.isFinite(value.ts) ||
    value.ts <= 0 ||
    value.filename !== sanitizeImageFilename(value.filename, value.mime_type) ||
    value.sha256.length !== 64 ||
    !/^[0-9a-f]+$/i.test(value.sha256)
  ) {
    return null
  }
  if (bytesToHex(sha256(bytes)) !== value.sha256.toLowerCase()) return null

  let edPub: Uint8Array
  let sig: Uint8Array
  try {
    edPub = hexToBytes(value.from_ed_pubkey)
    sig = hexToBytes(value.sig)
  } catch {
    return null
  }
  if (edPub.length !== 32 || sig.length !== 64) return null

  const core: ImageCore = {
    v: value.v,
    session_topic: value.session_topic,
    from_ed_pubkey: value.from_ed_pubkey,
    filename: value.filename,
    mime_type: value.mime_type,
    byte_length: value.byte_length,
    width: value.width,
    height: value.height,
    sha256: value.sha256.toLowerCase(),
    ts: value.ts,
  }
  if (!verifyMessage(edPub, serializeImageForSig(core), sig)) return null

  return {
    blob: new Blob([bytes.slice()], { type: value.mime_type }),
    metadata: { ...core, sig: value.sig },
  }
}

function validDimension(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value > 0 && value <= IMAGE_MAX_DIMENSION
  )
}

function normalizeBinaryPayload(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  return null
}
