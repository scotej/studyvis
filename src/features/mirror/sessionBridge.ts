import type { FocusState } from '@/components/FocusIndicator'
import type { AiStatus } from '@/components/AiStatusChip'
import type { AuditLogEntry } from '@/components/AuditLogPanel'
import type { SessionTimerProps } from '@/components/SessionTimer'
import type { Friend } from '@/lib/db/friends'
import type { PomodoroStartArgs } from '@/lib/pomodoro-types'
import type { PeerSnapshot } from '@/stores/sessionStore'
import type { SessionNote } from '@/features/session/notesStore'
import { isAuditEventKind } from '@/lib/audit-types'
import {
  IMAGE_MAX_DIMENSION,
  IMAGE_MAX_PIXELS,
  IMAGE_MAX_ANIMATION_FRAMES,
} from '@/features/session/images'

export type MirrorChatMessage = {
  id: string
  mine: boolean
  text: string
  ts: number
}

export type MirrorAiMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  failed?: boolean
}

export type MirrorChatSnapshot = {
  directMessages: Record<string, MirrorChatMessage[]>
  aiMessages: MirrorAiMessage[]
  aiSending: boolean
  directSending: boolean
}

export type MirrorChatControls = {
  sendDirectMessage: (recipient: string, text: string) => Promise<void>
  sendAi: (text: string) => Promise<void>
}

export function activeMirrorChat(
  chat: MirrorChatSnapshot,
  peers: Record<string, PeerSnapshot>
): MirrorChatSnapshot {
  const participants = new Set(
    Object.values(peers).flatMap((peer) =>
      peer.edPubkeyHex ? [peer.edPubkeyHex] : []
    )
  )
  return {
    ...chat,
    directMessages: Object.fromEntries(
      Object.entries(chat.directMessages).filter(([key]) =>
        participants.has(key)
      )
    ),
  }
}

export type MirrorImage = {
  id: string
  fromEdPubkeyHex: string
  mine: boolean
  filename: string
  mimeType: string
  width: number
  height: number
  frameCount: number
  ts: number
  data: string
}

export type MirrorTile = {
  key: string
  peerId: string | null
  name: string
  local: boolean
  variant: 'camera' | 'screen'
  state?: FocusState
  ptt: boolean
  cameraOff: boolean
  alertReasoning?: string
}

export type MirrorSessionSnapshot = {
  version: 1
  sessionId: string
  status: 'active' | 'ended'
  self: { edPubkeyHex: string; displayName: string }
  startedAt: number
  elapsedMs: number
  declaredTopic: string
  aiEnabled: boolean
  aiAvailable: boolean
  aiStatus: AiStatus
  aiAction: {
    pending: boolean
    text: string
    tone: 'neutral' | 'approved' | 'denied'
  } | null
  controlError?: string | null
  peers: Record<string, PeerSnapshot>
  names: Record<string, string>
  tiles: MirrorTile[]
  hadAnyPeer: boolean
  cameraOn: boolean
  pttActive: boolean
  screenSharing: boolean
  audit: AuditLogEntry[]
  notes: SessionNote[]
  images: MirrorImage[]
  chat: MirrorChatSnapshot
  pomodoro: Pick<
    SessionTimerProps,
    'phase' | 'preset' | 'endsAt' | 'iAmBroadcaster' | 'broadcasterName'
  >
  warning: { reasoning: string } | null
  breakEndsAt: number | null
  canInvite: boolean
  sessionFull: boolean
  friends: Friend[]
  onlineFriends: string[]
  offlineImagesOmitted?: boolean
  aiEnableNeedsConsent: boolean
}

export type MirrorControl =
  | { type: 'ptt'; active: boolean }
  | { type: 'camera'; on: boolean }
  | { type: 'screen_sharing'; sharing: boolean }
  | { type: 'note'; text: string }
  | { type: 'direct_message'; recipient: string; text: string }
  | { type: 'ai_message'; text: string }
  | { type: 'ai_action'; text: string }
  | { type: 'ai_enabled'; enabled: boolean; consent?: boolean }
  | { type: 'image'; filename: string; mimeType: string; data: string }
  | { type: 'pomodoro_start'; args: PomodoroStartArgs }
  | { type: 'pomodoro_stop' }
  | { type: 'topic'; topic: string }
  | { type: 'break'; durationSec: number }
  | { type: 'invite'; edPubkeyHex: string }
  | { type: 'dismiss_warning' }
  | { type: 'dismiss_error' }
  | { type: 'leave' }

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const publicKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)

export function parseMirrorControl(value: unknown): MirrorControl | null {
  if (!record(value)) return null
  switch (value.type) {
    case 'leave':
    case 'pomodoro_stop':
    case 'dismiss_warning':
    case 'dismiss_error':
      return { type: value.type }
    case 'ptt':
      return typeof value.active === 'boolean'
        ? { type: 'ptt', active: value.active }
        : null
    case 'camera':
      return typeof value.on === 'boolean'
        ? { type: 'camera', on: value.on }
        : null
    case 'screen_sharing':
      return typeof value.sharing === 'boolean'
        ? { type: 'screen_sharing', sharing: value.sharing }
        : null
    case 'note':
    case 'ai_message':
    case 'ai_action':
      return text(value.text, 500)
        ? { type: value.type, text: value.text }
        : null
    case 'ai_enabled':
      return typeof value.enabled === 'boolean'
        ? {
            type: 'ai_enabled',
            enabled: value.enabled,
            consent: value.consent === true,
          }
        : null
    case 'direct_message':
      return publicKey(value.recipient) && text(value.text, 500)
        ? {
            type: 'direct_message',
            recipient: value.recipient.toLowerCase(),
            text: value.text,
          }
        : null
    case 'topic':
      return text(value.topic, 120) && value.topic.trim().length > 0
        ? { type: 'topic', topic: value.topic.trim() }
        : null
    case 'invite':
      return publicKey(value.edPubkeyHex)
        ? { type: 'invite', edPubkeyHex: value.edPubkeyHex.toLowerCase() }
        : null
    case 'break':
      return typeof value.durationSec === 'number' &&
        Number.isInteger(value.durationSec) &&
        value.durationSec >= 60 &&
        value.durationSec <= 1800
        ? { type: 'break', durationSec: value.durationSec }
        : null
    case 'image':
      return text(value.filename, 255) &&
        typeof value.mimeType === 'string' &&
        ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(
          value.mimeType
        ) &&
        text(value.data, 7_000_000) &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(value.data) &&
        value.data.length % 4 === 0
        ? {
            type: 'image',
            filename: value.filename,
            mimeType: value.mimeType,
            data: value.data,
          }
        : null
    case 'pomodoro_start': {
      if (!record(value.args)) return null
      const args = value.args
      if (args.preset === '25/5' || args.preset === '50/10')
        return { type: 'pomodoro_start', args: { preset: args.preset } }
      if (
        args.preset === 'custom' &&
        typeof args.workMs === 'number' &&
        typeof args.restMs === 'number' &&
        Number.isSafeInteger(args.workMs) &&
        Number.isSafeInteger(args.restMs) &&
        args.workMs >= 300_000 &&
        args.workMs <= 7_200_000 &&
        args.restMs >= 60_000 &&
        args.restMs <= 3_600_000
      ) {
        return {
          type: 'pomodoro_start',
          args: { preset: 'custom', workMs: args.workMs, restMs: args.restMs },
        }
      }
      return null
    }
    default:
      return null
  }
}

export function readMirrorSnapshot(
  value: unknown
): MirrorSessionSnapshot | null {
  const string = (v: unknown, max: number) =>
    typeof v === 'string' && v.length <= max
  const number = (v: unknown): v is number =>
    typeof v === 'number' &&
    Number.isFinite(v) &&
    v >= 0 &&
    v <= 8_640_000_000_000_000
  const nullableNumber = (v: unknown) => v === null || number(v)
  const array = (v: unknown, max: number, check: (item: unknown) => boolean) =>
    Array.isArray(v) && v.length <= max && v.every(check)
  const focus = new Set([
    'focused',
    'warning',
    'alerted',
    'offline',
    'online',
    'on_break',
    'connecting',
    'reconnecting',
    'failed',
  ])
  if (
    !record(value) ||
    value.version !== 1 ||
    (value.status !== 'active' && value.status !== 'ended') ||
    !text(value.sessionId, 128) ||
    !record(value.self) ||
    !publicKey(value.self.edPubkeyHex) ||
    !string(value.self.displayName, 128) ||
    !number(value.startedAt) ||
    !number(value.elapsedMs) ||
    !string(value.declaredTopic, 120) ||
    !['off', 'active', 'paused', 'error', 'unconfigured'].includes(
      String(value.aiStatus)
    )
  )
    return null
  for (const key of [
    'aiEnabled',
    'aiAvailable',
    'aiEnableNeedsConsent',
    'hadAnyPeer',
    'cameraOn',
    'pttActive',
    'screenSharing',
    'canInvite',
    'sessionFull',
  ])
    if (typeof value[key] !== 'boolean') return null
  if (
    (value.controlError !== undefined &&
      value.controlError !== null &&
      !string(value.controlError, 500)) ||
    !nullableNumber(value.breakEndsAt) ||
    (value.warning !== null &&
      (!record(value.warning) || !string(value.warning.reasoning, 4096))) ||
    (value.aiAction !== null &&
      (!record(value.aiAction) ||
        typeof value.aiAction.pending !== 'boolean' ||
        !string(value.aiAction.text, 4096) ||
        !['neutral', 'approved', 'denied'].includes(
          String(value.aiAction.tone)
        )))
  )
    return null
  if (
    !array(
      value.tiles,
      8,
      (tile) =>
        record(tile) &&
        text(tile.key, 256) &&
        (tile.peerId === null || text(tile.peerId, 256)) &&
        string(tile.name, 128) &&
        typeof tile.local === 'boolean' &&
        ['camera', 'screen'].includes(String(tile.variant)) &&
        typeof tile.ptt === 'boolean' &&
        typeof tile.cameraOff === 'boolean' &&
        (tile.state === undefined || focus.has(String(tile.state))) &&
        (tile.alertReasoning === undefined || string(tile.alertReasoning, 4096))
    )
  )
    return null
  if (
    !array(
      value.audit,
      100_000,
      (event) =>
        record(event) &&
        number(event.seq) &&
        string(event.name, 128) &&
        string(event.description, 4096) &&
        number(event.ts) &&
        (event.hoverDetail === undefined || string(event.hoverDetail, 4096)) &&
        (event.iconKind === undefined || isAuditEventKind(event.iconKind))
    )
  )
    return null
  if (
    !array(
      value.notes,
      100,
      (note) =>
        record(note) &&
        text(note.id, 256) &&
        publicKey(note.fromEdPubkeyHex) &&
        typeof note.mine === 'boolean' &&
        string(note.text, 500) &&
        number(note.ts)
    )
  )
    return null
  let imageBytes = 0
  if (
    !array(value.images, 12, (image) => {
      if (
        !record(image) ||
        !text(image.id, 256) ||
        !publicKey(image.fromEdPubkeyHex) ||
        typeof image.mine !== 'boolean' ||
        !text(image.filename, 255) ||
        !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(
          String(image.mimeType)
        ) ||
        !number(image.width) ||
        !number(image.height) ||
        !number(image.frameCount) ||
        !number(image.ts) ||
        !text(image.data, 7_000_000) ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) ||
        image.data.length % 4 !== 0
      )
        return false
      imageBytes += image.data.length
      return (
        Number.isInteger(image.width) &&
        image.width > 0 &&
        image.width <= IMAGE_MAX_DIMENSION &&
        Number.isInteger(image.height) &&
        image.height > 0 &&
        image.height <= IMAGE_MAX_DIMENSION &&
        image.width * image.height <= IMAGE_MAX_PIXELS &&
        Number.isInteger(image.frameCount) &&
        image.frameCount > 0 &&
        image.frameCount <= IMAGE_MAX_ANIMATION_FRAMES
      )
    }) ||
    imageBytes > 28_000_000
  )
    return null
  if (
    !record(value.chat) ||
    !record(value.chat.directMessages) ||
    Object.keys(value.chat.directMessages).length > 4 ||
    typeof value.chat.aiSending !== 'boolean' ||
    typeof value.chat.directSending !== 'boolean'
  )
    return null
  const chatMessage = (message: unknown) =>
    record(message) &&
    text(message.id, 256) &&
    typeof message.mine === 'boolean' &&
    string(message.text, 500) &&
    number(message.ts)
  if (
    !Object.entries(value.chat.directMessages).every(
      ([key, messages]) => publicKey(key) && array(messages, 100, chatMessage)
    ) ||
    !array(
      value.chat.aiMessages,
      40,
      (message) =>
        record(message) &&
        text(message.id, 256) &&
        ['user', 'assistant'].includes(String(message.role)) &&
        string(message.content, 4096) &&
        (message.failed === undefined || typeof message.failed === 'boolean')
    )
  )
    return null
  if (
    !record(value.pomodoro) ||
    ![
      'idle',
      'work-25',
      'rest-5',
      'work-50',
      'rest-10',
      'work-custom',
      'rest-custom',
    ].includes(String(value.pomodoro.phase)) ||
    (value.pomodoro.preset !== null &&
      !['25/5', '50/10', 'custom'].includes(String(value.pomodoro.preset))) ||
    !nullableNumber(value.pomodoro.endsAt) ||
    typeof value.pomodoro.iAmBroadcaster !== 'boolean' ||
    (value.pomodoro.broadcasterName !== null &&
      !string(value.pomodoro.broadcasterName, 128))
  )
    return null
  if (
    !record(value.peers) ||
    Object.keys(value.peers).length > 3 ||
    !Object.entries(value.peers).every(
      ([key, peer]) =>
        text(key, 256) &&
        record(peer) &&
        peer.peerId === key &&
        typeof peer.hasStream === 'boolean' &&
        typeof peer.ptt === 'boolean' &&
        typeof peer.reconnecting === 'boolean' &&
        (peer.edPubkeyHex === null || publicKey(peer.edPubkeyHex)) &&
        (peer.displayName === null || string(peer.displayName, 128)) &&
        nullableNumber(peer.joinedAt)
    )
  )
    return null
  if (
    !record(value.names) ||
    Object.keys(value.names).length > 1024 ||
    !Object.entries(value.names).every(
      ([key, name]) => publicKey(key) && string(name, 128)
    )
  )
    return null
  if (
    !array(
      value.friends,
      1024,
      (friend) =>
        record(friend) &&
        publicKey(friend.ed_pubkey_hex) &&
        publicKey(friend.x_pubkey_hex) &&
        (friend.display_name === null || string(friend.display_name, 128)) &&
        nullableNumber(friend.paired_at) &&
        nullableNumber(friend.last_studied_with)
    ) ||
    !array(value.onlineFriends, 1024, publicKey)
  )
    return null
  return value as unknown as MirrorSessionSnapshot
}

export function projectOfflineSnapshot(
  value: unknown
): MirrorSessionSnapshot | null {
  const snapshot = readMirrorSnapshot(value)
  if (!snapshot) return null
  return {
    ...snapshot,
    audit: snapshot.audit.slice(-100),
    images: [],
    offlineImagesOmitted: snapshot.images.length > 0,
    chat: { ...snapshot.chat, aiSending: false, directSending: false },
    aiAction: snapshot.aiAction
      ? { ...snapshot.aiAction, pending: false }
      : null,
    pttActive: false,
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
    }
    return btoa(binary)
  })
}

export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(data), (character) => character.charCodeAt(0))
}
