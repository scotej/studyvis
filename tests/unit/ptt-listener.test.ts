import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}))

vi.mock('react', () => ({
  useEffect: (effect: () => void | (() => void)) => {
    bridge.cleanup = effect() ?? undefined
  },
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (
    eventName: string,
    handler: (event: { payload: unknown }) => void
  ) => {
    bridge.handlers.set(eventName, handler)
    return () => bridge.handlers.delete(eventName)
  },
}))

import {
  PTT_FRIENDS_PRESSED,
  PTT_FRIENDS_RELEASED,
  PttListener,
} from '@/features/system/PttListener'
import { __resetLog, __setLogRecordSink, type LogRecord } from '@/lib/log'
import type { TopicRoom } from '@/lib/trystero'
import { __resetPttScheduler, usePttStore } from '@/stores/pttStore'
import { useSessionStore } from '@/stores/sessionStore'

function mediaRoom(
  track: MediaStreamTrack,
  includeReceiver = false
): TopicRoom {
  const sender = {
    track,
    getStats: async () => new Map() as unknown as RTCStatsReport,
  } as unknown as RTCRtpSender
  const receiver = {
    track: {
      kind: 'audio',
      readyState: 'live',
    } as MediaStreamTrack,
    getStats: async () => new Map() as unknown as RTCStatsReport,
  } as unknown as RTCRtpReceiver
  const connection = {
    getSenders: () => [sender],
    getReceivers: () => (includeReceiver ? [receiver] : []),
  } as unknown as RTCPeerConnection
  return {
    getPeers: () => ({ peer: connection }),
  } as unknown as TopicRoom
}

async function mountListener(): Promise<void> {
  PttListener()
  // The bridge registers physical state, Released, and Pressed serially.
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
  expect(bridge.handlers.has(PTT_FRIENDS_PRESSED)).toBe(true)
  expect(bridge.handlers.has(PTT_FRIENDS_RELEASED)).toBe(true)
}

function emit(name: string, payload: unknown = undefined): void {
  const handler = bridge.handlers.get(name)
  expect(handler).toBeDefined()
  handler?.({ payload })
}

function recordFor(
  records: readonly LogRecord[],
  message: string,
  edgeSeq: number,
  source?: 'local' | 'peer'
): LogRecord | undefined {
  return records.find(
    (record) =>
      record.msg === message &&
      record.data?.edgeSeq === edgeSeq &&
      (source === undefined || record.data?.source === source)
  )
}

describe('PTT listener diagnostic timers', () => {
  let records: LogRecord[]

  beforeEach(() => {
    vi.useFakeTimers()
    bridge.handlers.clear()
    bridge.cleanup = undefined
    records = []
    __resetLog()
    __setLogRecordSink((record) => records.push(record))
    __resetPttScheduler()
    usePttStore.setState({
      active: false,
      awaitingRelease: false,
      heldSources: [],
      revision: 0,
    })
    useSessionStore.getState().reset()
  })

  afterEach(() => {
    bridge.cleanup?.()
    bridge.cleanup = undefined
    bridge.handlers.clear()
    __setLogRecordSink(null)
    __resetLog()
    __resetPttScheduler()
    usePttStore.setState({
      active: false,
      awaitingRelease: false,
      heldSources: [],
      revision: 0,
    })
    useSessionStore.getState().reset()
    vi.useRealTimers()
  })

  test('marks a local edge raced before its timer fires and never baselines it', async () => {
    const track = {
      kind: 'audio',
      enabled: false,
      readyState: 'live',
    } as unknown as MediaStreamTrack
    useSessionStore.setState({ room: mediaRoom(track) })
    await mountListener()

    emit(PTT_FRIENDS_PRESSED)
    track.enabled = true
    await vi.advanceTimersByTimeAsync(20)

    emit(PTT_FRIENDS_RELEASED)
    track.enabled = false
    await vi.advanceTimersByTimeAsync(20)

    const initialPress = recordFor(records, 'media.snapshot_raced', 1)
    expect(initialPress?.data).toMatchObject({
      source: 'local',
      localActive: true,
      localRevisionAtEdge: 1,
      localRevisionNow: 2,
      peerEdgeSeqAtEdge: 0,
      peerEdgeSeqNow: 0,
      stateChangedBeforeSample: true,
      stateChangedDuringSample: true,
    })

    // Race the release's own timer too, then let the third edge sample. Its
    // delta must remain empty: neither raced timer was allowed to become the
    // baseline for the new hold.
    await vi.advanceTimersByTimeAsync(5)
    emit(PTT_FRIENDS_PRESSED)
    track.enabled = true
    await vi.advanceTimersByTimeAsync(40)

    expect(recordFor(records, 'media.snapshot_raced', 2)?.data).toMatchObject({
      localRevisionAtEdge: 2,
      localRevisionNow: 3,
      stateChangedBeforeSample: true,
    })
    expect(recordFor(records, 'media.snapshot', 3)?.data?.delta).toEqual({
      bytesSentDelta: null,
      packetsSentDelta: null,
      bytesReceivedDelta: null,
      packetsReceivedDelta: null,
    })
  })

  test('binds remote PTT generation to the edge that started the timer', async () => {
    const track = {
      kind: 'audio',
      enabled: true,
      readyState: 'live',
    } as unknown as MediaStreamTrack
    useSessionStore.setState({ room: mediaRoom(track) })
    await mountListener()

    useSessionStore.getState().peerJoined('peer')
    useSessionStore.getState().setPeerPtt('peer', true)
    await vi.advanceTimersByTimeAsync(20)
    useSessionStore.getState().setPeerPtt('peer', false)
    await vi.advanceTimersByTimeAsync(20)

    expect(recordFor(records, 'media.snapshot_raced', 1)?.data).toMatchObject({
      source: 'peer',
      peerActiveCount: 1,
      localRevisionAtEdge: 0,
      peerEdgeSeqAtEdge: 1,
      peerEdgeSeqNow: 2,
      stateChangedBeforeSample: true,
      stateChangedDuringSample: true,
    })
  })

  test('does not race a local sender sample when only peer PTT changes', async () => {
    const track = {
      kind: 'audio',
      enabled: false,
      readyState: 'live',
    } as unknown as MediaStreamTrack
    useSessionStore.setState({ room: mediaRoom(track, true) })
    await mountListener()

    emit(PTT_FRIENDS_PRESSED)
    track.enabled = true
    useSessionStore.getState().peerJoined('peer')
    useSessionStore.getState().setPeerPtt('peer', true)
    await vi.advanceTimersByTimeAsync(40)

    expect(
      recordFor(records, 'media.snapshot_raced', 1, 'local')
    ).toBeUndefined()
    expect(
      recordFor(records, 'media.snapshot', 1, 'local')?.data
    ).toMatchObject({
      localRevisionAtEdge: 1,
      localRevisionNow: 1,
      peerEdgeSeqAtEdge: 0,
      peerEdgeSeqNow: 1,
      stateChangedDuringSample: false,
    })
  })

  test('does not race a peer receiver sample when only local PTT changes', async () => {
    const track = {
      kind: 'audio',
      enabled: false,
      readyState: 'live',
    } as unknown as MediaStreamTrack
    useSessionStore.setState({ room: mediaRoom(track, true) })
    await mountListener()

    useSessionStore.getState().peerJoined('peer')
    useSessionStore.getState().setPeerPtt('peer', true)
    emit(PTT_FRIENDS_PRESSED)
    track.enabled = true
    await vi.advanceTimersByTimeAsync(40)

    expect(
      recordFor(records, 'media.snapshot_raced', 1, 'peer')
    ).toBeUndefined()
    expect(recordFor(records, 'media.snapshot', 1, 'peer')?.data).toMatchObject(
      {
        localRevisionAtEdge: 0,
        localRevisionNow: 1,
        peerEdgeSeqAtEdge: 1,
        peerEdgeSeqNow: 1,
        stateChangedDuringSample: false,
      }
    )
  })

  test('keeps a session-button hold active across a later native press and release', async () => {
    await mountListener()

    const { press, release } = usePttStore.getState()
    press('session-button')
    emit(PTT_FRIENDS_PRESSED)

    expect(usePttStore.getState()).toMatchObject({
      active: true,
      awaitingRelease: true,
      heldSources: ['session-button', 'native-shortcut'],
      revision: 1,
    })

    emit(PTT_FRIENDS_RELEASED)
    expect(usePttStore.getState()).toMatchObject({
      active: true,
      awaitingRelease: true,
      heldSources: ['session-button'],
      revision: 1,
    })

    release('session-button')
    expect(usePttStore.getState()).toMatchObject({
      active: false,
      awaitingRelease: false,
      heldSources: [],
      revision: 2,
    })
  })

  test('clears an unreleased native hold when the session room changes', async () => {
    const track = {
      kind: 'audio',
      enabled: false,
      readyState: 'live',
    } as unknown as MediaStreamTrack
    useSessionStore.setState({ room: mediaRoom(track) })
    await mountListener()

    emit(PTT_FRIENDS_PRESSED)
    expect(usePttStore.getState()).toMatchObject({
      active: true,
      awaitingRelease: true,
    })

    // Teardown unregisters the shortcut before this hold's native Released
    // arrives. The session owner resets the store and publishes a new room,
    // while the app-lifetime listener instance remains mounted.
    usePttStore.getState().reset()
    useSessionStore.setState({ room: null })
    useSessionStore.setState({ room: mediaRoom(track) })

    emit(PTT_FRIENDS_PRESSED)
    expect(usePttStore.getState()).toMatchObject({
      active: true,
      awaitingRelease: true,
    })
    expect(
      records.some(
        (record) =>
          record.msg === 'edge.failsafe_mute' && record.data?.edgeSeq === 2
      )
    ).toBe(false)
  })
})
