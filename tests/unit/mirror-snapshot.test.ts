import { describe, expect, test } from 'vitest'
import {
  projectOfflineSnapshot,
  activeMirrorChat,
  readMirrorSnapshot,
  type MirrorSessionSnapshot,
} from '@/features/mirror/sessionBridge'

const PUBLIC_KEY = 'a'.repeat(64)
function session(): MirrorSessionSnapshot {
  return {
    version: 1,
    sessionId: 'session',
    status: 'active',
    self: { edPubkeyHex: PUBLIC_KEY, displayName: 'You' },
    startedAt: 1,
    elapsedMs: 1000,
    declaredTopic: 'Study',
    aiEnabled: false,
    aiAvailable: false,
    aiEnableNeedsConsent: false,
    aiStatus: 'off',
    aiAction: null,
    peers: {},
    names: { [PUBLIC_KEY]: 'You' },
    tiles: [
      {
        key: 'self:camera',
        peerId: null,
        name: 'You',
        local: true,
        variant: 'camera',
        state: 'online',
        ptt: false,
        cameraOff: false,
      },
    ],
    hadAnyPeer: false,
    cameraOn: true,
    pttActive: false,
    screenSharing: false,
    audit: [
      { seq: 1, name: 'You', description: 'joined', ts: 1, iconKind: 'joined' },
    ],
    notes: [
      {
        id: 'note',
        fromEdPubkeyHex: PUBLIC_KEY,
        mine: true,
        text: 'Review chapter two',
        ts: 1,
      },
    ],
    images: [
      {
        id: 'image',
        fromEdPubkeyHex: PUBLIC_KEY,
        mine: true,
        filename: 'notes.png',
        mimeType: 'image/png',
        width: 1,
        height: 1,
        frameCount: 1,
        ts: 1,
        data: 'YQ==',
      },
    ],
    chat: {
      directMessages: {},
      aiMessages: [],
      aiSending: false,
      directSending: false,
    },
    pomodoro: {
      phase: 'idle',
      preset: null,
      endsAt: null,
      iAmBroadcaster: false,
      broadcasterName: null,
    },
    warning: null,
    breakEndsAt: null,
    canInvite: false,
    sessionFull: false,
    friends: [],
    onlineFriends: [],
  }
}

describe('browser snapshot and offline storage boundary', () => {
  test('peer turnover keeps only currently visible DM threads without discarding desktop history', () => {
    const snapshot = session()
    const keys = Array.from({ length: 6 }, (_, index) =>
      index.toString(16).repeat(64)
    )
    snapshot.chat.directMessages = Object.fromEntries(
      keys.map((key) => [key, [{ id: key, mine: true, text: 'Ready?', ts: 1 }]])
    )
    snapshot.peers = {
      current: {
        peerId: 'current',
        hasStream: false,
        ptt: false,
        reconnecting: false,
        edPubkeyHex: keys[5],
        displayName: 'Current',
        joinedAt: 1,
      },
    }
    const chat = activeMirrorChat(snapshot.chat, snapshot.peers)
    expect(Object.keys(chat.directMessages)).toEqual([keys[5]])
    expect(Object.keys(snapshot.chat.directMessages)).toHaveLength(6)
    expect(readMirrorSnapshot({ ...snapshot, chat })).not.toBeNull()
  })
  test('accepts the authoritative complete session', () => {
    const snapshot = session()
    expect(readMirrorSnapshot(snapshot)).toBe(snapshot)
  })
  test('accepts bounded action errors and older snapshots without an error field', () => {
    expect(readMirrorSnapshot(session())?.controlError ?? null).toBeNull()
    expect(
      readMirrorSnapshot({ ...session(), controlError: 'Try again.' })
        ?.controlError
    ).toBe('Try again.')
    expect(
      readMirrorSnapshot({ ...session(), controlError: null })
    ).not.toBeNull()
    expect(
      readMirrorSnapshot({ ...session(), controlError: 'x'.repeat(501) })
    ).toBeNull()
    expect(readMirrorSnapshot({ ...session(), controlError: 42 })).toBeNull()
  })
  test.each([
    (snapshot: MirrorSessionSnapshot) => ({ ...snapshot, notes: null }),
    (snapshot: MirrorSessionSnapshot) => ({
      ...snapshot,
      chat: { ...snapshot.chat, directMessages: { secret: [] } },
    }),
    (snapshot: MirrorSessionSnapshot) => ({
      ...snapshot,
      tiles: [{ ...snapshot.tiles[0], state: 'unknown' }],
    }),
    (snapshot: MirrorSessionSnapshot) => ({
      ...snapshot,
      audit: [{ ...snapshot.audit[0], ts: 1e100 }],
    }),
    (snapshot: MirrorSessionSnapshot) => ({
      ...snapshot,
      audit: [{ ...snapshot.audit[0], iconKind: 'constructor' }],
    }),
    (snapshot: MirrorSessionSnapshot) => ({
      ...snapshot,
      images: [{ ...snapshot.images[0], data: 'evil html' }],
    }),
    (snapshot: MirrorSessionSnapshot) => ({
      ...snapshot,
      friends: [{ ed_pubkey_hex: PUBLIC_KEY }],
    }),
    (snapshot: MirrorSessionSnapshot) => ({
      ...snapshot,
      pomodoro: { ...snapshot.pomodoro, phase: 'invalid' },
    }),
  ])(
    'rejects malformed nested data before rendering stored state',
    (mutate) => {
      expect(readMirrorSnapshot(mutate(session()))).toBeNull()
    }
  )
  test('keeps public session metadata and chat while dropping image bytes and pending gestures', () => {
    const snapshot = session()
    snapshot.pttActive = true
    snapshot.aiAction = { pending: true, text: 'Waiting', tone: 'neutral' }
    snapshot.chat.aiSending = true
    snapshot.chat.directSending = true
    const offline = projectOfflineSnapshot(snapshot)!
    expect(offline.self).toEqual(snapshot.self)
    expect(offline.notes).toEqual(snapshot.notes)
    expect(offline.images).toEqual([])
    expect(offline.offlineImagesOmitted).toBe(true)
    expect(offline.pttActive).toBe(false)
    expect(offline.chat).toMatchObject({
      aiSending: false,
      directSending: false,
    })
    expect(offline.aiAction?.pending).toBe(false)
    expect(snapshot.images).toHaveLength(1)
    expect(readMirrorSnapshot(offline)).not.toBeNull()
  })
  test('retains valid narrow images allowed by the desktop dimensions contract', () => {
    const snapshot = session()
    snapshot.images[0].width = 32_768
    expect(readMirrorSnapshot(snapshot)).not.toBeNull()
    snapshot.images[0].height = 32_768
    expect(readMirrorSnapshot(snapshot)).toBeNull()
  })
})
