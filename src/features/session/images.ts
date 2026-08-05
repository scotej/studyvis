import { sha256 } from '@noble/hashes/sha2.js'

import { verifyMessage } from '@/lib/crypto/identity'
import { bytesToHex, hexToBytes } from '@/lib/encoding'

export const IMAGE_ACTION = 'session-image'
export const IMAGE_VERSION = 1 as const
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const IMAGE_MAX_DIMENSION = 32_768
export const IMAGE_MAX_PIXELS = 16_777_216
export const IMAGE_MAX_ANIMATION_FRAMES = 120
export const IMAGE_MAX_ANIMATION_PIXELS = IMAGE_MAX_PIXELS * 4
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
  frameCount: number
}

export type IncomingImageEntry = {
  fromEdPubkeyHex: string
  mine: false
  blob: Blob
  filename: string
  mimeType: ImageMimeType
  width: number
  height: number
  frameCount: number
  ts: number
}

type ImageInspection = {
  width: number
  height: number
  frameCount: number
}

const MIME_TYPE_SET = new Set<string>(IMAGE_MIME_TYPES)
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

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
        if (!validImageResources(width, height, 1)) {
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

export async function appendVerifiedIncomingImage(
  verified: VerifiedImagePayload,
  deps: {
    isStopped: () => boolean
    append: (image: IncomingImageEntry) => void
    readDimensions?: typeof readImageDimensions
  }
): Promise<boolean> {
  let decoded: { width: number; height: number }
  try {
    decoded = await (deps.readDimensions ?? readImageDimensions)(verified.blob)
  } catch {
    return false
  }
  if (
    deps.isStopped() ||
    decoded.width !== verified.metadata.width ||
    decoded.height !== verified.metadata.height
  ) {
    return false
  }
  deps.append({
    fromEdPubkeyHex: verified.metadata.from_ed_pubkey,
    mine: false,
    blob: verified.blob,
    filename: verified.metadata.filename,
    mimeType: verified.metadata.mime_type,
    width: verified.metadata.width,
    height: verified.metadata.height,
    frameCount: verified.frameCount,
    ts: verified.metadata.ts,
  })
  return true
}

export function inspectImageBytes(
  bytes: Uint8Array,
  mimeType: ImageMimeType
): ImageInspection | null {
  const inspectors: Record<
    ImageMimeType,
    (input: Uint8Array) => ImageInspection | null
  > = {
    'image/png': inspectPng,
    'image/jpeg': inspectJpeg,
    'image/webp': inspectWebp,
    'image/gif': inspectGif,
  }
  const inspection = inspectors[mimeType](bytes)

  if (
    !inspection ||
    !validImageResources(
      inspection.width,
      inspection.height,
      inspection.frameCount
    )
  ) {
    return null
  }
  return inspection
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
  const inspection = inspectImageBytes(args.bytes, args.mimeType)
  if (
    !inspection ||
    !dimensionsMatch(
      inspection,
      { width: args.width, height: args.height },
      args.mimeType
    )
  ) {
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
    !validImageResources(value.width, value.height, 1) ||
    !Number.isFinite(value.ts) ||
    value.ts <= 0 ||
    value.filename !== sanitizeImageFilename(value.filename, value.mime_type) ||
    value.sha256.length !== 64 ||
    !/^[0-9a-f]+$/i.test(value.sha256)
  ) {
    return null
  }
  if (bytesToHex(sha256(bytes)) !== value.sha256.toLowerCase()) return null

  const inspection = inspectImageBytes(bytes, value.mime_type)
  if (
    !inspection ||
    !dimensionsMatch(
      inspection,
      { width: value.width, height: value.height },
      value.mime_type
    )
  ) {
    return null
  }

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
    frameCount: inspection.frameCount,
  }
}

function inspectPng(bytes: Uint8Array): ImageInspection | null {
  if (!matches(bytes, 0, PNG_SIGNATURE)) return null
  const view = viewOf(bytes)
  let offset: number = PNG_SIGNATURE.length
  let width: number | null = null
  let height: number | null = null
  let declaredFrames: number | null = null
  let frameControls = 0
  let sawImageData = false
  let sawEnd = false

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false)
    const type = ascii(bytes, offset + 4, 4)
    const dataStart = offset + 8
    if (length > bytes.length - dataStart - 4) return null
    const chunkEnd = dataStart + length + 4

    if (width === null && type !== 'IHDR') return null
    if (type === 'IHDR') {
      if (width !== null || length !== 13) return null
      width = view.getUint32(dataStart, false)
      height = view.getUint32(dataStart + 4, false)
    } else if (type === 'acTL') {
      if (declaredFrames !== null || length !== 8) return null
      declaredFrames = view.getUint32(dataStart, false)
    } else if (type === 'fcTL') {
      if (length !== 26) return null
      frameControls += 1
    } else if (type === 'IDAT') {
      sawImageData = true
    } else if (type === 'IEND') {
      if (length !== 0) return null
      sawEnd = true
    }

    offset = chunkEnd
    if (sawEnd) break
  }

  if (
    width === null ||
    height === null ||
    !sawImageData ||
    !sawEnd ||
    offset !== bytes.length
  ) {
    return null
  }
  if (declaredFrames === null && frameControls !== 0) return null
  if (declaredFrames !== null && declaredFrames !== frameControls) return null
  return { width, height, frameCount: declaredFrames ?? 1 }
}

function inspectJpeg(bytes: Uint8Array): ImageInspection | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const view = viewOf(bytes)
  let offset = 2

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) return null
    const marker = bytes[offset]
    offset += 1
    if (marker === 0xd9 || marker === 0xda) return null
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) return null
    const length = view.getUint16(offset, false)
    if (length < 2 || length > bytes.length - offset) return null
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) return null
      return {
        width: view.getUint16(offset + 5, false),
        height: view.getUint16(offset + 3, false),
        frameCount: 1,
      }
    }
    offset += length
  }
  return null
}

function inspectGif(bytes: Uint8Array): ImageInspection | null {
  const header = ascii(bytes, 0, 6)
  if (header !== 'GIF87a' && header !== 'GIF89a') return null
  if (bytes.length < 14) return null
  const view = viewOf(bytes)
  const width = view.getUint16(6, true)
  const height = view.getUint16(8, true)
  let offset = 13
  if ((bytes[10] & 0x80) !== 0) {
    offset += 3 * (1 << ((bytes[10] & 0x07) + 1))
    if (offset > bytes.length) return null
  }

  let frameCount = 0
  while (offset < bytes.length) {
    const marker = bytes[offset]
    offset += 1
    if (marker === 0x3b) {
      return offset === bytes.length && frameCount > 0
        ? { width, height, frameCount }
        : null
    }
    if (marker === 0x21) {
      if (offset >= bytes.length) return null
      offset += 1
      const next = skipGifSubBlocks(bytes, offset)
      if (next === null) return null
      offset = next
      continue
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) return null
    const frameWidth = view.getUint16(offset + 4, true)
    const frameHeight = view.getUint16(offset + 6, true)
    const packed = bytes[offset + 8]
    if (
      frameWidth <= 0 ||
      frameHeight <= 0 ||
      frameWidth > IMAGE_MAX_DIMENSION ||
      frameHeight > IMAGE_MAX_DIMENSION
    ) {
      return null
    }
    offset += 9
    if ((packed & 0x80) !== 0) {
      offset += 3 * (1 << ((packed & 0x07) + 1))
      if (offset > bytes.length) return null
    }
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) {
      return null
    }
    offset += 1
    const next = skipGifSubBlocks(bytes, offset)
    if (next === null) return null
    offset = next
    frameCount += 1
    if (frameCount > IMAGE_MAX_ANIMATION_FRAMES) return null
  }
  return null
}

function inspectWebp(bytes: Uint8Array): ImageInspection | null {
  if (
    bytes.length < 20 ||
    ascii(bytes, 0, 4) !== 'RIFF' ||
    ascii(bytes, 8, 4) !== 'WEBP'
  ) {
    return null
  }
  const view = viewOf(bytes)
  if (view.getUint32(4, true) + 8 !== bytes.length) return null

  let offset = 12
  let width: number | null = null
  let height: number | null = null
  let frameCount = 0
  let animationFlag = false
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return null
    const type = ascii(bytes, offset, 4)
    const length = view.getUint32(offset + 4, true)
    const dataStart = offset + 8
    if (length > bytes.length - dataStart) return null
    const chunkEnd = dataStart + length + (length & 1)
    if (chunkEnd > bytes.length) return null

    if (type === 'VP8X') {
      if (length !== 10 || width !== null) return null
      animationFlag = (bytes[dataStart] & 0x02) !== 0
      width = readUint24Le(bytes, dataStart + 4) + 1
      height = readUint24Le(bytes, dataStart + 7) + 1
    } else if (type === 'VP8 ') {
      if (length < 10) return null
      const dimensions = inspectVp8(bytes, dataStart)
      if (!dimensions) return null
      width ??= dimensions.width
      height ??= dimensions.height
    } else if (type === 'VP8L') {
      if (length < 5) return null
      const dimensions = inspectVp8l(bytes, dataStart)
      if (!dimensions) return null
      width ??= dimensions.width
      height ??= dimensions.height
    } else if (type === 'ANMF') {
      if (length < 16 || width === null || height === null) return null
      const left = readUint24Le(bytes, dataStart) * 2
      const top = readUint24Le(bytes, dataStart + 3) * 2
      const frameWidth = readUint24Le(bytes, dataStart + 6) + 1
      const frameHeight = readUint24Le(bytes, dataStart + 9) + 1
      if (left + frameWidth > width || top + frameHeight > height) return null
      frameCount += 1
      if (frameCount > IMAGE_MAX_ANIMATION_FRAMES) return null
    }
    offset = chunkEnd
  }

  if (width === null || height === null) return null
  if (animationFlag && frameCount === 0) return null
  if (!animationFlag && frameCount !== 0) return null
  return { width, height, frameCount: frameCount || 1 }
}

function inspectVp8(
  bytes: Uint8Array,
  offset: number
): { width: number; height: number } | null {
  if (
    bytes[offset + 3] !== 0x9d ||
    bytes[offset + 4] !== 0x01 ||
    bytes[offset + 5] !== 0x2a
  ) {
    return null
  }
  const view = viewOf(bytes)
  return {
    width: view.getUint16(offset + 6, true) & 0x3fff,
    height: view.getUint16(offset + 8, true) & 0x3fff,
  }
}

function inspectVp8l(
  bytes: Uint8Array,
  offset: number
): { width: number; height: number } | null {
  if (bytes[offset] !== 0x2f) return null
  const bits = viewOf(bytes).getUint32(offset + 1, true)
  return {
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
  }
}

function dimensionsMatch(
  inspected: Pick<ImageInspection, 'width' | 'height'>,
  decoded: { width: number; height: number },
  mimeType: ImageMimeType
): boolean {
  if (
    inspected.width === decoded.width &&
    inspected.height === decoded.height
  ) {
    return true
  }
  return (
    mimeType === 'image/jpeg' &&
    inspected.width === decoded.height &&
    inspected.height === decoded.width
  )
}

function validImageResources(
  width: number,
  height: number,
  frameCount: number
): boolean {
  if (
    !validDimension(width) ||
    !validDimension(height) ||
    !Number.isSafeInteger(frameCount) ||
    frameCount <= 0 ||
    frameCount > IMAGE_MAX_ANIMATION_FRAMES
  ) {
    return false
  }
  const pixels = width * height
  return (
    pixels <= IMAGE_MAX_PIXELS &&
    (frameCount === 1 || pixels * frameCount <= IMAGE_MAX_ANIMATION_PIXELS)
  )
}

function validDimension(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value > 0 && value <= IMAGE_MAX_DIMENSION
  )
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number | null {
  let offset = start
  while (offset < bytes.length) {
    const length = bytes[offset]
    offset += 1
    if (length === 0) return offset
    if (length > bytes.length - offset) return null
    offset += length
  }
  return null
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || length < 0 || offset + length > bytes.length) return ''
  let value = ''
  for (let index = offset; index < offset + length; index += 1) {
    value += String.fromCharCode(bytes[index])
  }
  return value
}

function matches(
  bytes: Uint8Array,
  offset: number,
  expected: ReadonlyArray<number>
): boolean {
  if (offset < 0 || offset + expected.length > bytes.length) return false
  return expected.every((value, index) => bytes[offset + index] === value)
}

function normalizeBinaryPayload(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  return null
}
