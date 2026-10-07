export type MirrorConfig = {
  urls: string[]
  password: string
  fingerprint: string
  certificateUrl: string
  expiresAt: number
  generation: string
}

export type CaptureKind = 'camera' | 'screen'

export type MirrorNotification = {
  title: string
  body: string
  onlyWhenHidden?: boolean
}

export type SignalMessage =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'negotiate' }
  | { type: 'streams'; streams: Record<string, string> }
  | { type: 'capture'; camera: boolean; screen: boolean }

export type MirrorMessage =
  | { type: 'signal'; signal: SignalMessage }
  | { type: 'snapshot'; snapshot: unknown }
  | { type: 'report'; report: unknown }
  | { type: 'report_saved' }
  | { type: 'control'; control: unknown }
  | ({ type: 'notification' } & MirrorNotification)
  | { type: 'ready' }
  | { type: 'reconnect' }
  | { type: 'ping' | 'pong' }

export function isSignalMessage(value: unknown): value is SignalMessage {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  switch (v.type) {
    case 'offer':
    case 'answer':
      return typeof v.sdp === 'string' && v.sdp.length <= 192 * 1024
    case 'negotiate':
      return true
    case 'capture':
      return typeof v.camera === 'boolean' && typeof v.screen === 'boolean'
    case 'streams':
      return (
        !!v.streams &&
        typeof v.streams === 'object' &&
        !Array.isArray(v.streams) &&
        Object.entries(v.streams).length <= 16 &&
        Object.entries(v.streams).every(
          ([key, id]) =>
            key.length <= 256 && typeof id === 'string' && id.length <= 256
        )
      )
    default:
      return false
  }
}

export function isMirrorMessage(value: unknown): value is MirrorMessage {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  switch (v.type) {
    case 'signal':
      return isSignalMessage(v.signal)
    case 'snapshot':
      return v.snapshot !== undefined
    case 'report':
      return v.report !== undefined
    case 'control':
      return v.control !== undefined
    case 'notification':
      return (
        typeof v.title === 'string' &&
        v.title.length <= 256 &&
        typeof v.body === 'string' &&
        v.body.length <= 2048 &&
        (v.onlyWhenHidden === undefined ||
          typeof v.onlyWhenHidden === 'boolean')
      )
    case 'ready':
    case 'report_saved':
    case 'reconnect':
    case 'ping':
    case 'pong':
      return true
    default:
      return false
  }
}

const CHUNK_SIZE = 24_000
export const MIRROR_MAX_MESSAGE = 32 * 1024 * 1024
const MAX_CACHED_STRINGS = 40 * 1024 * 1024

type Frame = {
  v: 1
  type: 'message' | 'blob'
  id: number
  index: number
  total: number
  data: string
}

// Large image strings travel once per connection; successive timer/status
// snapshots refer to those strings. Frames never cache authentication material.
export class MirrorCodec {
  private nextId = 0
  private sent = new Map<string, number>()
  private received = new Map<number, string>()
  private sentSize = 0
  private receivedSize = 0
  private partial: { frame: Frame; parts: string[]; size: number } | null = null
  private sending = Promise.resolve()

  send(
    message: MirrorMessage,
    write: (data: string) => Promise<void>
  ): Promise<void> {
    const job = this.sending.then(() => this.encode(message, write))
    this.sending = job.catch(() => {})
    return job
  }

  private async encode(
    message: MirrorMessage,
    write: (data: string) => Promise<void>
  ) {
    if (this.sentSize > MAX_CACHED_STRINGS || this.sent.size >= 256) {
      this.sent.clear()
      this.sentSize = 0
      await write(JSON.stringify({ v: 1, type: 'reset' }))
    }
    const blobs: Array<[number, string]> = []
    const staged = new Map<string, number>()
    const serialized = JSON.stringify(message, (_key, value: unknown) => {
      if (typeof value !== 'string' || value.length < 8192) return value
      let id = this.sent.get(value) ?? staged.get(value)
      if (id === undefined) {
        id = ++this.nextId
        staged.set(value, id)
        blobs.push([id, value])
      }
      return { $mirrorString: id }
    })
    if (
      serialized.length + blobs.reduce((n, [, s]) => n + s.length, 0) >
      MIRROR_MAX_MESSAGE
    ) {
      throw new Error('Mirror message is too large')
    }
    for (const [id, data] of blobs)
      await this.writeChunks('blob', id, data, write)
    await this.writeChunks('message', ++this.nextId, serialized, write)
    for (const [value, id] of staged) {
      this.sent.set(value, id)
      this.sentSize += value.length
    }
  }

  private async writeChunks(
    type: Frame['type'],
    id: number,
    data: string,
    write: (data: string) => Promise<void>
  ) {
    const total = Math.max(1, Math.ceil(data.length / CHUNK_SIZE))
    for (let index = 0; index < total; index++) {
      await write(
        JSON.stringify({
          v: 1,
          type,
          id,
          index,
          total,
          data: data.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
        })
      )
    }
  }

  receive(data: string): MirrorMessage | null {
    if (data.length > 256 * 1024) throw new Error('Mirror frame is too large')
    const v = JSON.parse(data) as Omit<Partial<Frame>, 'type'> & {
      type?: string
    }
    if (v.v === 1 && v.type === 'reset') {
      if (this.partial) throw new Error('Interrupted mirror frame')
      this.received.clear()
      this.receivedSize = 0
      return null
    }
    if (
      v.v !== 1 ||
      (v.type !== 'blob' && v.type !== 'message') ||
      !Number.isSafeInteger(v.id) ||
      !Number.isSafeInteger(v.index) ||
      !Number.isSafeInteger(v.total) ||
      typeof v.data !== 'string' ||
      v.data.length > CHUNK_SIZE ||
      v.id! < 1 ||
      v.index! < 0 ||
      v.total! < 1 ||
      v.total! > Math.ceil(MIRROR_MAX_MESSAGE / CHUNK_SIZE) ||
      v.index! >= v.total!
    )
      throw new Error('Invalid mirror frame')
    const frame = v as Frame
    if (!this.partial) {
      if (frame.index !== 0) throw new Error('Missing mirror frame')
      this.partial = { frame, parts: [], size: 0 }
    }
    const p = this.partial
    if (
      p.frame.id !== frame.id ||
      p.frame.type !== frame.type ||
      p.frame.total !== frame.total ||
      p.parts.length !== frame.index
    ) {
      throw new Error('Out-of-order mirror frame')
    }
    p.size += frame.data.length
    if (p.size > MIRROR_MAX_MESSAGE)
      throw new Error('Mirror message is too large')
    p.parts.push(frame.data)
    if (p.parts.length !== frame.total) return null
    this.partial = null
    const complete = p.parts.join('')
    if (frame.type === 'blob') {
      if (
        this.received.has(frame.id) ||
        this.received.size >= 512 ||
        this.receivedSize + complete.length >
          MAX_CACHED_STRINGS + MIRROR_MAX_MESSAGE
      ) {
        throw new Error('Mirror attachment limit exceeded')
      }
      this.received.set(frame.id, complete)
      this.receivedSize += complete.length
      return null
    }
    const result: unknown = JSON.parse(complete, (_key, value: unknown) => {
      if (
        value &&
        typeof value === 'object' &&
        Object.keys(value).length === 1 &&
        '$mirrorString' in value
      ) {
        const text = this.received.get(
          (value as { $mirrorString: number }).$mirrorString
        )
        if (text === undefined) throw new Error('Unknown mirror attachment')
        return text
      }
      return value
    })
    if (!isMirrorMessage(result)) throw new Error('Invalid mirror message')
    return result
  }
}
