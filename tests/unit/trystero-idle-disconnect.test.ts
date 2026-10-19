import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  createResilientPeerConnection,
  TRANSIENT_DISCONNECT_HOLD_MS,
} from '@/lib/webrtc/resilientPeerConnection'

const moduleUrl = (file: string) =>
  new URL(
    `../../node_modules/@trystero-p2p/core/dist/${file}.mjs`,
    import.meta.url
  ).href
const { default: createPeer } = await import(moduleUrl('peer'))
const { SharedPeerManager, getConnectedPeerHealth } = await import(
  moduleUrl('shared-peer')
)
const { createSignalHandler, getState } = await import(
  moduleUrl('signal-handler')
)

class NativeConnection extends EventTarget {
  connection: RTCPeerConnectionState = 'new'
  ice: RTCIceConnectionState = 'new'
  signalingState = 'stable'
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  ondatachannel:
    ((event: { channel: NativeConnection['channel'] }) => void) | null = null
  private stateHandler: EventListener | null = null
  readonly events: string[] = []
  readonly channel = {
    readyState: 'open',
    onclose: null as (() => void) | null,
    send: vi.fn(),
    close: () => {
      this.events.push('channel.close')
      this.channel.readyState = 'closed'
      this.channel.onclose?.()
    },
  }
  get connectionState() {
    return this.connection
  }
  get iceConnectionState() {
    return this.ice
  }
  set onconnectionstatechange(fn: EventListener | null) {
    if (this.stateHandler)
      this.removeEventListener('connectionstatechange', this.stateHandler)
    this.stateHandler = fn
    if (fn) this.addEventListener('connectionstatechange', fn)
  }
  transition(state: RTCPeerConnectionState) {
    if (this.connection === 'closed') return
    this.connection = state
    this.ice = state as RTCIceConnectionState
    this.dispatchEvent(new Event('connectionstatechange'))
    this.dispatchEvent(new Event('iceconnectionstatechange'))
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description
  }
  async setLocalDescription() {
    this.localDescription = { type: 'answer', sdp: 'v=0\r\n' }
  }
  close() {
    this.events.push('connection.close')
    this.connection = 'closed'
    this.ice = 'closed'
  }
}

function endpoint(manager = new SharedPeerManager()) {
  const peer = createPeer(false, {
    rtcPolyfill: createResilientPeerConnection(
      NativeConnection as unknown as typeof RTCPeerConnection
    ),
  })
  const connection = peer.connection as NativeConnection
  connection.ondatachannel?.({ channel: connection.channel })
  const shared = manager.register('studyvis', 'friend', peer, 1000)
  for (const room of ['presence', 'inbox']) {
    const { proxy } = manager.bind(room, Promise.resolve(room), shared, {
      onDetach() {},
    })
    proxy.setHandlers({ close: () => connection.events.push(`${room}.close`) })
  }
  connection.transition('connected')
  return { manager, peer, connection, shared }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('non-session abandonment closes native channels before room departures, including repeated losses', () => {
  const manager = new SharedPeerManager()
  for (let i = 0; i < 3; i++) {
    const { peer, connection } = endpoint(manager)
    connection.transition('disconnected')
    vi.advanceTimersByTime(TRANSIENT_DISCONNECT_HOLD_MS + 4_999)
    expect(manager.get('studyvis', 'friend')).toBeDefined()
    expect(connection.channel.readyState).toBe('open')
    vi.advanceTimersByTime(1)
    connection.transition('connected') // Recovery can no longer revive an abandoned PC.
    expect(connection.connectionState).toBe('closed')
    expect(connection.channel.readyState).toBe('closed')
    expect(manager.get('studyvis', 'friend')).toBeUndefined()
    expect(getConnectedPeerHealth(peer)).toBe('stale')
    expect(connection.events).toEqual([
      'channel.close',
      'connection.close',
      'presence.close',
      'inbox.close',
    ])
  }
  expect(vi.getTimerCount()).toBe(0)
})

test('an abandoned peer no longer blocks a fresh same-friend offer', async () => {
  const { manager, connection, peer } = endpoint()
  const ctx = {
    appId: 'studyvis',
    roomId: 'presence',
    config: {},
    peerStates: {},
    rootTopicPlaintext: 'fixture',
    rootTopicP: Promise.resolve('root'),
    selfTopicP: Promise.resolve('self'),
    isLeaving: () => false,
    isPassive: false,
    isActive: true,
    sharedPeers: manager,
    initPeer: () => createPeer(false, { rtcPolyfill: NativeConnection }),
    toPlain: vi.fn(async (signal) => signal),
    toCipher: async (signal: unknown) => signal,
    connectPeer: vi.fn(),
    disconnectPeer: vi.fn(),
    checkDeactivate: vi.fn(),
  }
  const state = getState(ctx.peerStates, 'friend')
  state.connectedPeer = peer
  connection.transition('disconnected')
  vi.advanceTimersByTime(TRANSIENT_DISCONNECT_HOLD_MS + 5_000)
  connection.transition('connected')
  await createSignalHandler(ctx)(0)(
    'root',
    { peerId: 'friend', offer: 'v=0\r\n' },
    () => {}
  )
  expect(ctx.toPlain).toHaveBeenCalledOnce()
  expect(state.connectedPeer).toBeNull()
  expect(state.answeringPeer?.connection.remoteDescription?.sdp).toBe('v=0\r\n')
  state.answeringPeer?.destroy()
})

test('a transient recovery keeps both bindings and terminal failure still closes immediately', () => {
  const { manager, connection, shared } = endpoint()
  connection.transition('disconnected')
  vi.advanceTimersByTime(TRANSIENT_DISCONNECT_HOLD_MS - 1)
  connection.transition('connected')
  vi.advanceTimersByTime(30_000)
  expect(manager.get('studyvis', 'friend')).toBe(shared)
  expect(connection.channel.readyState).toBe('open')
  const { proxy } = manager.bind(
    'presence',
    Promise.resolve('presence'),
    shared,
    { onDetach() {} }
  )
  proxy.destroy()
  expect(Object.keys(shared.bindings)).toEqual(['inbox'])
  expect(connection.channel.readyState).toBe('open')
  connection.transition('failed')
  expect(connection.connectionState).toBe('closed')
  expect(connection.channel.readyState).toBe('closed')
})
