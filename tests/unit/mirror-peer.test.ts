import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createMirrorPeer } from '@/features/mirror/peer'
import type { SignalMessage } from '@/features/mirror/wire'

let streamId = 0
class TestStream extends EventTarget {
  readonly id = `stream-${++streamId}`
  private readonly tracks: MediaStreamTrack[]
  constructor(tracks: MediaStreamTrack[] = []) {
    super()
    this.tracks = tracks
  }
  getTracks() {
    return this.tracks
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video')
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio')
  }
  removeTrack(track: MediaStreamTrack) {
    const index = this.tracks.indexOf(track)
    if (index < 0) return
    this.tracks.splice(index, 1)
    this.dispatchEvent(new Event('removetrack'))
  }
  override addEventListener = vi.fn(
    (...args: Parameters<EventTarget['addEventListener']>) =>
      super.addEventListener(...args)
  )
  override removeEventListener = vi.fn(
    (...args: Parameters<EventTarget['removeEventListener']>) =>
      super.removeEventListener(...args)
  )
}

function track(kind: 'video' | 'audio', id: string): MediaStreamTrack {
  return {
    kind,
    id,
    readyState: 'live',
    stop: vi.fn(),
  } as unknown as MediaStreamTrack
}

type TestTransceiver = {
  direction: RTCRtpTransceiverDirection
  receiver: { track: MediaStreamTrack }
  sender: {
    track: MediaStreamTrack | null
    replaceTrack: ReturnType<typeof vi.fn>
    setStreams: ReturnType<typeof vi.fn>
  }
}

class TestConnection {
  static instances: TestConnection[] = []
  readonly config: RTCConfiguration
  readonly transceivers: TestTransceiver[] = []
  signalingState = 'stable'
  connectionState = 'new'
  iceGatheringState = 'complete'
  localDescription: RTCSessionDescriptionInit | null = null
  ontrack: ((event: RTCTrackEvent) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  onnegotiationneeded: (() => void) | null = null
  createDataChannel = vi.fn()
  removeTrack = vi.fn()
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
  close = vi.fn(() => {
    this.connectionState = 'closed'
  })
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer' }) as const)
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'answer' }) as const)

  constructor(config: RTCConfiguration) {
    this.config = config
    TestConnection.instances.push(this)
  }

  addTransceiver(
    input: string | MediaStreamTrack,
    options: RTCRtpTransceiverInit
  ) {
    const kind = typeof input === 'string' ? input : input.kind
    const sender = {
      track: typeof input === 'string' ? null : input,
      replaceTrack: vi.fn(async (next: MediaStreamTrack | null) => {
        sender.track = next
      }),
      setStreams: vi.fn(),
    }
    const transceiver = {
      direction: options.direction ?? 'sendrecv',
      sender,
      receiver: {
        track: track(
          kind as 'video' | 'audio',
          `received-${this.transceivers.length}`
        ),
      },
    }
    this.transceivers.push(transceiver)
    return transceiver
  }

  getTransceivers() {
    return this.transceivers
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description
    this.signalingState =
      description.type === 'offer' ? 'have-local-offer' : 'stable'
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.signalingState =
      description.type === 'answer' ? 'stable' : 'have-remote-offer'
    if (description.type === 'offer' && this.transceivers.length === 0) {
      for (const kind of ['video', 'audio', 'video'])
        this.addTransceiver(kind, { direction: 'recvonly' })
    }
  }
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  TestConnection.instances = []
  streamId = 0
  vi.stubGlobal('RTCPeerConnection', TestConnection)
  vi.stubGlobal('MediaStream', TestStream)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('LAN peer media ownership', () => {
  test('unchanged streams do not renegotiate and removed sender slots are reused across screen restarts', async () => {
    const send = vi.fn()
    const host = createMirrorPeer({ role: 'host', send, onFailure: vi.fn() })
    await flush()
    host.receive({ type: 'answer', sdp: 'answer' })
    await flush()
    const first = new TestStream([
      track('video', 'screen-one'),
    ]) as unknown as MediaStream
    host.setStreams({ 'bob-screen': first })
    await flush()
    const connection = TestConnection.instances[0]
    expect(connection.transceivers).toHaveLength(4)
    const slot = connection.transceivers[3]
    host.receive({ type: 'answer', sdp: 'answer' })
    await flush()
    const offers = connection.createOffer.mock.calls.length
    host.setStreams({ 'bob-screen': first })
    await flush()
    expect(connection.createOffer.mock.calls).toHaveLength(offers)
    host.setStreams({})
    await flush()
    expect(slot.sender.track).toBeNull()
    expect(slot.direction).toBe('inactive')
    host.receive({ type: 'answer', sdp: 'answer' })
    await flush()
    const replacement = new TestStream([
      track('video', 'screen-two'),
    ]) as unknown as MediaStream
    host.setStreams({ 'bob-screen': replacement })
    await flush()
    expect(connection.transceivers).toHaveLength(4)
    expect(slot.sender.track?.id).toBe('screen-two')
    expect(slot.sender.setStreams).toHaveBeenLastCalledWith(replacement)
    expect(slot.direction).toBe('sendonly')
    expect(send).toHaveBeenCalledWith({
      type: 'streams',
      streams: { 'bob-screen': replacement.id },
    })
    host.close()
  })
  test('only the desktop offers, with no external STUN or TURN service', async () => {
    const messages: SignalMessage[] = []
    const host = createMirrorPeer({
      role: 'host',
      send: (signal) => messages.push(signal),
      onFailure: vi.fn(),
    })
    const browser = createMirrorPeer({
      role: 'browser',
      send: vi.fn(),
      onFailure: vi.fn(),
    })
    await flush()
    expect(
      TestConnection.instances.map((connection) => connection.config)
    ).toEqual([{ iceServers: [] }, { iceServers: [] }])
    expect(
      TestConnection.instances[0].transceivers
        .slice(0, 3)
        .map((slot) => slot.receiver.track.kind)
    ).toEqual(['video', 'audio', 'video'])
    expect(messages.filter((signal) => signal.type === 'offer')).toHaveLength(1)
    expect(TestConnection.instances[1].createOffer).not.toHaveBeenCalled()
    host.close()
    browser.close()
  })

  test('camera, microphone and screen occupy stable slots across replacement', async () => {
    const send = vi.fn()
    const browser = createMirrorPeer({
      role: 'browser',
      send,
      onFailure: vi.fn(),
    })
    const camera = new TestStream([
      track('video', 'camera-1'),
      track('audio', 'mic-1'),
    ]) as unknown as MediaStream
    const screen = new TestStream([
      track('video', 'screen-1'),
    ]) as unknown as MediaStream
    browser.setCapture('camera', camera)
    browser.setCapture('screen', screen)
    browser.receive({ type: 'offer', sdp: 'the-host-offer' })
    await flush()
    const connection = TestConnection.instances[0]
    expect(
      connection.transceivers.map((slot) => slot.sender.track?.id)
    ).toEqual(['camera-1', 'mic-1', 'screen-1'])
    expect(send).toHaveBeenCalledWith({
      type: 'capture',
      camera: true,
      screen: true,
    })
    expect(send).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer' })

    const replacement = new TestStream([
      track('video', 'camera-2'),
      track('audio', 'mic-2'),
    ]) as unknown as MediaStream
    browser.setCapture('camera', replacement)
    await flush()
    expect(
      connection.transceivers.map((slot) => slot.sender.track?.id)
    ).toEqual(['camera-2', 'mic-2', 'screen-1'])
    browser.setCapture('screen', null)
    await flush()
    expect(
      connection.transceivers.map((slot) => slot.sender.track?.id)
    ).toEqual(['camera-2', 'mic-2', undefined])
    expect(send).toHaveBeenLastCalledWith({
      type: 'capture',
      camera: true,
      screen: false,
    })
    expect(connection.createOffer).not.toHaveBeenCalled()
    browser.close()
  })

  test('tracks arriving before their manifest resolve only to declared participant keys', () => {
    const onStreams = vi.fn()
    const browser = createMirrorPeer({
      role: 'browser',
      send: vi.fn(),
      onStreams,
      onFailure: vi.fn(),
    })
    const stream = new TestStream([
      track('video', 'bob-camera'),
    ]) as unknown as MediaStream
    TestConnection.instances[0].ontrack?.({
      streams: [stream],
    } as unknown as RTCTrackEvent)
    expect(onStreams).toHaveBeenLastCalledWith({})
    browser.receive({ type: 'streams', streams: { bob: stream.id } })
    expect(onStreams).toHaveBeenLastCalledWith({ bob: stream })
    browser.receive({ type: 'streams', streams: {} })
    expect(onStreams).toHaveBeenLastCalledWith({})
    browser.close()
  })

  test('a stream removed and restored before renegotiation returns without a second track event', () => {
    const onStreams = vi.fn()
    const browser = createMirrorPeer({
      role: 'browser',
      send: vi.fn(),
      onStreams,
      onFailure: vi.fn(),
    })
    const stream = new TestStream([
      track('video', 'bob-camera'),
    ]) as unknown as MediaStream
    TestConnection.instances[0].ontrack?.({
      streams: [stream],
    } as unknown as RTCTrackEvent)
    browser.receive({ type: 'streams', streams: { bob: stream.id } })
    expect(onStreams).toHaveBeenLastCalledWith({ bob: stream })
    browser.receive({ type: 'streams', streams: {} })
    expect(onStreams).toHaveBeenLastCalledWith({})
    browser.receive({ type: 'streams', streams: { bob: stream.id } })
    expect(onStreams).toHaveBeenLastCalledWith({ bob: stream })
    browser.close()
  })

  test('a withdrawn stream remains recoverable until WebRTC removes its last track', () => {
    const onStreams = vi.fn()
    const browser = createMirrorPeer({
      role: 'browser',
      send: vi.fn(),
      onStreams,
      onFailure: vi.fn(),
    })
    const video = track('video', 'bob-camera')
    const audio = track('audio', 'bob-mic')
    const stream = new TestStream([video, audio])
    TestConnection.instances[0].ontrack?.({
      streams: [stream],
    } as unknown as RTCTrackEvent)
    browser.receive({ type: 'streams', streams: { bob: stream.id } })
    browser.receive({ type: 'streams', streams: {} })
    stream.removeTrack(video)
    expect(onStreams).toHaveBeenLastCalledWith({})
    browser.receive({ type: 'streams', streams: { bob: stream.id } })
    expect(onStreams).toHaveBeenLastCalledWith({ bob: stream })
    browser.receive({ type: 'streams', streams: {} })
    stream.removeTrack(audio)
    expect(stream.removeEventListener).toHaveBeenCalledOnce()
    browser.receive({ type: 'streams', streams: { bob: stream.id } })
    expect(onStreams).toHaveBeenLastCalledWith({})
    browser.close()
  })

  test('repeated track events keep one stream listener and peer close detaches it', () => {
    const onStreams = vi.fn()
    const browser = createMirrorPeer({
      role: 'browser',
      send: vi.fn(),
      onStreams,
      onFailure: vi.fn(),
    })
    const video = track('video', 'bob-camera')
    const stream = new TestStream([video])
    const connection = TestConnection.instances[0]
    const event = { streams: [stream] } as unknown as RTCTrackEvent
    connection.ontrack?.(event)
    connection.ontrack?.(event)
    browser.receive({ type: 'streams', streams: { bob: stream.id } })
    expect(stream.addEventListener).toHaveBeenCalledOnce()
    browser.close()
    expect(stream.removeEventListener).toHaveBeenCalledOnce()
    const renders = onStreams.mock.calls.length
    stream.removeTrack(video)
    expect(onStreams).toHaveBeenCalledTimes(renders)
  })

  test('prototype-like descriptor keys remain own data properties without inheriting stream fields', () => {
    const onStreams = vi.fn()
    const browser = createMirrorPeer({
      role: 'browser',
      send: vi.fn(),
      onStreams,
      onFailure: vi.fn(),
    })
    const stream = new TestStream([
      track('video', 'bob-camera'),
    ]) as unknown as MediaStream
    TestConnection.instances[0].ontrack?.({
      streams: [stream],
    } as unknown as RTCTrackEvent)
    browser.receive({
      type: 'streams',
      streams: JSON.parse(
        `{"__proto__":"${stream.id}","constructor":"${stream.id}"}`
      ) as Record<string, string>,
    })
    const rendered = onStreams.mock.lastCall?.[0] as Record<string, MediaStream>
    expect(Object.getPrototypeOf(rendered)).toBe(Object.prototype)
    expect(Object.keys(rendered)).toEqual(['__proto__', 'constructor'])
    expect(Object.hasOwn(rendered, '__proto__')).toBe(true)
    expect(Object.hasOwn(rendered, 'constructor')).toBe(true)
    expect(rendered['__proto__']).toBe(stream)
    expect(rendered['constructor']).toBe(stream)
    expect('id' in rendered).toBe(false)
    expect('getTracks' in rendered).toBe(false)
    browser.close()
  })

  test('descriptor-first arrival and screen removal never leave a stale displayed stream', () => {
    const onStreams = vi.fn()
    const browser = createMirrorPeer({
      role: 'browser',
      send: vi.fn(),
      onStreams,
      onFailure: vi.fn(),
    })
    const screen = new TestStream([
      track('video', 'bob-screen'),
    ]) as unknown as MediaStream
    browser.receive({ type: 'streams', streams: { 'bob-screen': screen.id } })
    TestConnection.instances[0].ontrack?.({
      streams: [screen],
    } as unknown as RTCTrackEvent)
    expect(onStreams).toHaveBeenLastCalledWith({ 'bob-screen': screen })
    browser.receive({ type: 'streams', streams: {} })
    expect(onStreams).toHaveBeenLastCalledWith({})
    browser.close()
    expect(onStreams).toHaveBeenLastCalledWith({})
  })

  test('closing during ICE gathering cancels timers and releases remote capture references', async () => {
    vi.useFakeTimers()
    const onCapture = vi.fn()
    const failure = vi.fn()
    const host = createMirrorPeer({
      role: 'host',
      send: vi.fn(),
      onCapture,
      onFailure: failure,
    })
    TestConnection.instances[0].iceGatheringState = 'gathering'
    await flush()
    host.close()
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(TestConnection.instances[0].close).toHaveBeenCalledOnce()
    expect(onCapture).toHaveBeenCalledWith('camera', null)
    expect(onCapture).toHaveBeenCalledWith('screen', null)
    expect(failure).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('camera capture restart publishes a new stream identity without stopping its reusable receiver tracks', async () => {
    const onCapture = vi.fn()
    const host = createMirrorPeer({
      role: 'host',
      send: vi.fn(),
      onCapture,
      onFailure: vi.fn(),
    })
    await flush()
    const connection = TestConnection.instances[0]
    connection.connectionState = 'connected'
    connection.onconnectionstatechange?.()
    expect(onCapture.mock.calls.slice(-2)[0]).toEqual(['camera', null])
    host.receive({ type: 'capture', camera: true, screen: false })
    const first = onCapture.mock.calls.findLast(
      ([kind, stream]) => kind === 'camera' && stream !== null
    )![1] as MediaStream
    const tracks = first.getTracks()
    host.receive({ type: 'capture', camera: true, screen: false })
    connection.ontrack?.({ streams: [] } as unknown as RTCTrackEvent)
    expect(onCapture.mock.calls.slice(-2)[0]).toEqual(['camera', first])

    host.receive({ type: 'capture', camera: false, screen: false })
    expect(onCapture.mock.calls.slice(-2)[0]).toEqual(['camera', null])
    for (const item of tracks) expect(item.stop).not.toHaveBeenCalled()
    host.receive({ type: 'capture', camera: true, screen: false })
    const restarted = onCapture.mock.calls.slice(-2)[0][1] as MediaStream
    expect(restarted).not.toBe(first)
    expect(restarted.id).not.toBe(first.id)
    expect(restarted.getTracks()).toEqual(tracks)
    for (const item of tracks) expect(item.stop).not.toHaveBeenCalled()
    host.close()
  })

  test('active camera receiver track replacement publishes a new wrapper for the current tracks', async () => {
    const onCapture = vi.fn()
    const host = createMirrorPeer({
      role: 'host',
      send: vi.fn(),
      onCapture,
      onFailure: vi.fn(),
    })
    await flush()
    const connection = TestConnection.instances[0]
    connection.connectionState = 'connected'
    connection.onconnectionstatechange?.()
    host.receive({ type: 'capture', camera: true, screen: false })
    const first = onCapture.mock.calls.slice(-2)[0][1] as MediaStream
    const nextAudio = track('audio', 'replacement-mic')
    connection.transceivers[1].receiver.track = nextAudio
    connection.ontrack?.({ streams: [] } as unknown as RTCTrackEvent)
    const replacement = onCapture.mock.calls.slice(-2)[0][1] as MediaStream
    expect(replacement).not.toBe(first)
    expect(replacement.getTracks()).toEqual([
      first.getVideoTracks()[0],
      nextAudio,
    ])
    for (const item of first.getTracks())
      expect(item.stop).not.toHaveBeenCalled()
    host.close()
  })

  test('a transient ICE disconnect republishes camera with a fresh stream ID and the same receiver tracks within the grace period', async () => {
    vi.useFakeTimers()
    const onCapture = vi.fn()
    const failure = vi.fn()
    const host = createMirrorPeer({
      role: 'host',
      send: vi.fn(),
      onCapture,
      onFailure: failure,
    })
    await flush()
    host.receive({ type: 'answer', sdp: 'answer' })
    await flush()
    const connection = TestConnection.instances[0]
    connection.connectionState = 'connected'
    connection.onconnectionstatechange?.()
    host.receive({ type: 'capture', camera: true, screen: true })
    const camera = onCapture.mock.calls.findLast(
      ([kind, stream]) => kind === 'camera' && stream !== null
    )?.[1]
    const screen = onCapture.mock.calls.findLast(
      ([kind, stream]) => kind === 'screen' && stream !== null
    )?.[1]
    expect(
      camera?.getTracks().map((item: MediaStreamTrack) => item.kind)
    ).toEqual(['video', 'audio'])
    expect(
      screen?.getTracks().map((item: MediaStreamTrack) => item.kind)
    ).toEqual(['video'])

    connection.connectionState = 'disconnected'
    connection.onconnectionstatechange?.()
    expect(onCapture.mock.calls.slice(-2)).toEqual([
      ['camera', null],
      ['screen', null],
    ])
    await vi.advanceTimersByTimeAsync(4000)
    expect(failure).not.toHaveBeenCalled()

    connection.connectionState = 'connected'
    connection.onconnectionstatechange?.()
    const restored = onCapture.mock.calls.slice(-2)[0][1] as MediaStream
    expect(restored).not.toBe(camera)
    expect(restored.id).not.toBe(camera.id)
    expect(restored.getTracks()).toEqual(camera.getTracks())
    for (const item of camera.getTracks())
      expect(item.stop).not.toHaveBeenCalled()
    expect(onCapture.mock.calls.at(-1)).toEqual(['screen', screen])
    await vi.advanceTimersByTimeAsync(2000)
    expect(failure).not.toHaveBeenCalled()
    expect(TestConnection.instances).toHaveLength(1)
    expect(connection.close).not.toHaveBeenCalled()
    host.close()
    expect(vi.getTimerCount()).toBe(0)
  })
})
