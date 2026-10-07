import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createBrowserConnection } from '@/features/mirror/browserConnection'
import { createMirrorHost } from '@/features/mirror/runtime'
import { MirrorCodec, type MirrorMessage } from '@/features/mirror/wire'
import type { MirrorSessionSnapshot } from '@/features/mirror/sessionBridge'

const doubles = vi.hoisted(() => ({
  invoke: vi.fn(),
  events: new Map<string, (event: { payload: unknown }) => void>(),
  peers: [] as {
    close: ReturnType<typeof vi.fn>
    receive: ReturnType<typeof vi.fn>
    setCapture: ReturnType<typeof vi.fn>
    setStreams: ReturnType<typeof vi.fn>
  }[],
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: doubles.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (name: string, listener: (event: { payload: unknown }) => void) => {
      doubles.events.set(name, listener)
      return () => {
        if (doubles.events.get(name) === listener) doubles.events.delete(name)
      }
    }
  ),
}))
vi.mock('@/features/mirror/peer', () => ({
  createMirrorPeer: vi.fn(() => {
    const peer = {
      close: vi.fn(),
      receive: vi.fn(),
      setCapture: vi.fn(),
      setStreams: vi.fn(),
    }
    doubles.peers.push(peer)
    return peer
  }),
}))

class TestSocket {
  static OPEN = 1
  static instances: TestSocket[] = []
  readonly url: string
  readyState = 0
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  send = vi.fn()
  constructor(url: string) {
    this.url = url
    TestSocket.instances.push(this)
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  close(code = 1000) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

const configuration = {
  urls: ['https://127.0.0.1:12345'],
  password: 'ABCDEFGH',
  fingerprint: 'fingerprint',
  certificateUrl: 'http://127.0.0.1:12346/certificate.crt',
  expiresAt: 123456,
  generation: 'one',
}
const report = {
  session: {
    id: 'session-1',
    started_at: 1,
    ended_at: 61,
    total_minutes: 1,
    score: null,
    focused_pct: null,
    generated_at: 61,
    confident_samples: 0,
    skipped_samples: 0,
    ai_enabled: 0,
    declared_topic: 'Read chapter one',
    peer_pubkeys: null,
  },
  auditEvents: [],
  nameByEdPubkey: {},
  myEdPubkeyHex: null,
}
const storage = new Map<string, string>()
const cleanup: (() => void | Promise<void>)[] = []

function snapshot(): MirrorSessionSnapshot {
  return {
    version: 1,
    sessionId: 'session-1',
    status: 'active',
    self: { edPubkeyHex: 'a'.repeat(64), displayName: 'Alice' },
    startedAt: 1,
    elapsedMs: 1000,
    declaredTopic: 'Read chapter one',
    aiEnabled: false,
    aiAvailable: false,
    aiEnableNeedsConsent: true,
    aiStatus: 'off',
    aiAction: null,
    peers: {},
    names: {},
    tiles: [],
    hadAnyPeer: false,
    cameraOn: false,
    pttActive: false,
    screenSharing: false,
    audit: [],
    notes: [],
    images: [
      {
        id: 'image',
        fromEdPubkeyHex: 'a'.repeat(64),
        mine: true,
        filename: 'reading.png',
        mimeType: 'image/png',
        width: 1,
        height: 1,
        frameCount: 1,
        ts: 1,
        data: 'a'.repeat(40000),
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

async function frames(message: MirrorMessage) {
  const result: string[] = []
  await new MirrorCodec().send(message, async (frame) => {
    result.push(frame)
  })
  return result
}
async function incoming(socket: TestSocket, message: MirrorMessage) {
  for (const data of await frames(message)) socket.onmessage?.({ data })
  await vi.advanceTimersByTimeAsync(100)
}
async function activate(socket: TestSocket) {
  socket.open()
  await incoming(socket, { type: 'snapshot', snapshot: snapshot() })
}
function sent(socket: TestSocket) {
  const codec = new MirrorCodec()
  return socket.send.mock.calls
    .map(([frame]) => codec.receive(frame as string))
    .filter(Boolean)
}
async function hostIncoming(clientId: string, message: MirrorMessage) {
  for (const data of await frames(message))
    doubles.events.get('mirror:message')?.({ payload: { clientId, data } })
  await vi.advanceTimersByTimeAsync(100)
}
function capture() {
  const track = Object.assign(new EventTarget(), {
    kind: 'video',
    readyState: 'live',
    stop: vi.fn(),
  })
  const stream = { getTracks: () => [track] } as unknown as MediaStream
  return { track, stream }
}

beforeEach(() => {
  vi.useFakeTimers()
  doubles.invoke.mockReset()
  doubles.invoke.mockImplementation(async (command: string) =>
    command === 'mirror_start' ? configuration : undefined
  )
  doubles.events.clear()
  doubles.peers.length = 0
  storage.clear()
  TestSocket.instances = []
  vi.stubGlobal('WebSocket', TestSocket)
  vi.stubGlobal('window', { isSecureContext: true })
  vi.stubGlobal('location', {
    protocol: 'https:',
    origin: 'https://127.0.0.1:12345',
  })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
})

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('desktop mirror lifecycle', () => {
  test('a late cancelled start only stops its own request after a newer start succeeds', async () => {
    let completeFirst!: (value: unknown) => void
    let starts = 0
    doubles.invoke.mockImplementation((command: string) => {
      if (command !== 'mirror_start') return Promise.resolve()
      if (++starts === 1)
        return new Promise((resolve) => {
          completeFirst = resolve
        })
      return Promise.resolve({ ...configuration, generation: 'two' })
    })
    const control = vi.fn()
    const host = createMirrorHost({
      onConnected: vi.fn(),
      onControl: control,
      onCapture: vi.fn(),
    })
    cleanup.push(host.stop)
    const first = host.start('session-1')
    const cancelled = expect(first).rejects.toThrow('cancelled')
    await vi.advanceTimersByTimeAsync(0)
    const firstRequest = doubles.invoke.mock.calls.find(
      ([command]) => command === 'mirror_start'
    )![1].requestId
    await host.stop()
    await host.start('session-1')
    const secondRequest = doubles.invoke.mock.calls.filter(
      ([command]) => command === 'mirror_start'
    )[1][1].requestId
    expect(firstRequest).not.toBe(secondRequest)
    completeFirst(configuration)
    await cancelled
    const stops = doubles.invoke.mock.calls.filter(
      ([command]) => command === 'mirror_stop'
    )
    expect(stops).toHaveLength(2)
    expect(stops.every(([, args]) => args.requestId === firstRequest)).toBe(
      true
    )
    doubles.events.get('mirror:client')!({
      payload: { clientId: 'new', connected: true },
    })
    await hostIncoming('new', {
      type: 'control',
      control: { type: 'note', text: 'New generation remains active' },
    })
    expect(control).toHaveBeenCalledWith({
      type: 'note',
      text: 'New generation remains active',
    })
  })
  test('cancelling a pending start cannot resurrect an endpoint or its listeners', async () => {
    let complete!: (value: unknown) => void
    doubles.invoke.mockImplementation((command: string) =>
      command === 'mirror_start'
        ? new Promise((resolve) => {
            complete = resolve
          })
        : Promise.resolve()
    )
    const connected = vi.fn()
    const host = createMirrorHost({
      onConnected: connected,
      onControl: vi.fn(),
      onCapture: vi.fn(),
    })
    const starting = host.start('session-1')
    const rejection = expect(starting).rejects.toThrow('cancelled')
    await vi.advanceTimersByTimeAsync(0)
    const stale = doubles.events.get('mirror:client')!
    await host.stop()
    complete(configuration)
    await rejection
    stale({ payload: { clientId: 'stale', connected: true } })
    expect(doubles.peers).toHaveLength(0)
    expect(doubles.events.size).toBe(0)
    expect(connected).not.toHaveBeenCalledWith(true)
    expect(
      doubles.invoke.mock.calls.filter(([command]) => command === 'mirror_stop')
    ).toHaveLength(2)
  })

  test('only the current authenticated client can control the host; replacement closes media', async () => {
    const control = vi.fn()
    const host = createMirrorHost({
      onConnected: vi.fn(),
      onControl: control,
      onCapture: vi.fn(),
    })
    cleanup.push(host.stop)
    await host.start('session-1')
    doubles.events.get('mirror:client')!({
      payload: { clientId: 'one', connected: true },
    })
    await hostIncoming('other', { type: 'control', control: { type: 'leave' } })
    expect(control).not.toHaveBeenCalled()
    await hostIncoming('one', {
      type: 'control',
      control: { type: 'note', text: 'Read together' },
    })
    expect(control).toHaveBeenCalledWith({
      type: 'note',
      text: 'Read together',
    })
    doubles.events.get('mirror:client')!({
      payload: { clientId: 'two', connected: true },
    })
    expect(doubles.peers[0].close).toHaveBeenCalledOnce()
    doubles.events.get('mirror:client')!({
      payload: { clientId: 'one', connected: false },
    })
    expect(doubles.peers[1].close).not.toHaveBeenCalled()
  })

  test('the durable report handoff waits for the companion acknowledgment before finishing', async () => {
    const host = createMirrorHost({
      onConnected: vi.fn(),
      onControl: vi.fn(),
      onCapture: vi.fn(),
    })
    cleanup.push(host.stop)
    await host.start('session-1')
    doubles.events.get('mirror:client')!({
      payload: { clientId: 'one', connected: true },
    })
    let finished = false
    const handingOff = host.finishReport(report).then(() => {
      finished = true
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(finished).toBe(false)
    await hostIncoming('one', { type: 'report_saved' })
    await handingOff
    expect(finished).toBe(true)
    expect(
      doubles.invoke.mock.calls.some(([command]) => command === 'mirror_send')
    ).toBe(true)
  })
  test('a report acknowledgment still succeeds after a bounded queued image transmission', async () => {
    let release!: () => void
    let sends = 0
    doubles.invoke.mockImplementation((command: string) => {
      if (command === 'mirror_start') return Promise.resolve(configuration)
      if (command === 'mirror_send' && ++sends === 1)
        return new Promise<void>((resolve) => {
          release = resolve
        })
      return Promise.resolve()
    })
    const host = createMirrorHost({
      onConnected: vi.fn(),
      onControl: vi.fn(),
      onCapture: vi.fn(),
    })
    cleanup.push(host.stop)
    await host.start('session-1')
    doubles.events.get('mirror:client')!({
      payload: { clientId: 'one', connected: true },
    })
    await vi.advanceTimersByTimeAsync(0)
    let finished = false
    const handedOff = host.finishReport(report).then(() => {
      finished = true
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(finished).toBe(false)
    release()
    await vi.advanceTimersByTimeAsync(799)
    expect(finished).toBe(false)
    await hostIncoming('one', { type: 'report_saved' })
    await handedOff
    expect(finished).toBe(true)
  })
  test('a stalled report send cannot hold Leave beyond the total handoff deadline', async () => {
    doubles.invoke.mockImplementation((command: string) => {
      if (command === 'mirror_start') return Promise.resolve(configuration)
      if (command === 'mirror_send') return new Promise(() => {})
      return Promise.resolve()
    })
    const host = createMirrorHost({
      onConnected: vi.fn(),
      onControl: vi.fn(),
      onCapture: vi.fn(),
    })
    cleanup.push(host.stop)
    await host.start('session-1')
    doubles.events.get('mirror:client')!({
      payload: { clientId: 'one', connected: true },
    })
    let finished = false
    const handingOff = host.finishReport(report).then(() => {
      finished = true
    })
    await vi.advanceTimersByTimeAsync(2999)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await handingOff
    expect(finished).toBe(true)
  })
})

describe('browser recovery and local custody', () => {
  test('a replaced tab releases capture and stays read-only until an explicit new pairing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    )
    const connection = createBrowserConnection()
    cleanup.push(connection.disconnect)
    const socket = TestSocket.instances[0]
    await activate(socket)
    const camera = capture()
    connection.setCapture('camera', camera.stream)
    socket.close(4001)
    expect(camera.track.stop).toHaveBeenCalledOnce()
    expect(connection.getState()).toMatchObject({
      status: 'disconnected',
      error: 'session_moved',
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(TestSocket.instances).toHaveLength(1)
    await connection.pair('ABCDEFGH')
    expect(TestSocket.instances).toHaveLength(2)
    await activate(TestSocket.instances[1])
    expect(connection.getState().status).toBe('connected')
  })
  test('an open socket cannot enable cached controls or capture before a fresh valid snapshot arrives', async () => {
    storage.set('studyvis.mirror.snapshot.v1', JSON.stringify(snapshot()))
    const connection = createBrowserConnection()
    cleanup.push(connection.disconnect)
    const socket = TestSocket.instances[0]
    socket.open()
    expect(connection.getState().status).toBe('connecting')
    const denied = capture()
    connection.setCapture('camera', denied.stream)
    expect(denied.track.stop).toHaveBeenCalledOnce()
    connection.sendControl({ type: 'leave' })
    await vi.advanceTimersByTimeAsync(100)
    expect(sent(socket).some((message) => message?.type === 'control')).toBe(
      false
    )
    await incoming(socket, { type: 'snapshot', snapshot: snapshot() })
    expect(connection.getState().status).toBe('connected')
    connection.sendControl({ type: 'note', text: 'Fresh host' })
    await vi.advanceTimersByTimeAsync(100)
    expect(sent(socket).some((message) => message?.type === 'control')).toBe(
      true
    )
  })
  test('forgetting the companion releases capture and clears cached session and report data', async () => {
    storage.set('studyvis.mirror.report.v1', JSON.stringify(report))
    const connection = createBrowserConnection()
    const socket = TestSocket.instances[0]
    await activate(socket)
    await incoming(socket, { type: 'snapshot', snapshot: snapshot() })
    const camera = capture()
    const screen = capture()
    connection.setCapture('camera', camera.stream)
    connection.setCapture('screen', screen.stream)
    connection.disconnect()
    expect(camera.track.stop).toHaveBeenCalledOnce()
    expect(screen.track.stop).toHaveBeenCalledOnce()
    expect(storage.has('studyvis.mirror.snapshot.v1')).toBe(false)
    expect(storage.has('studyvis.mirror.report.v1')).toBe(false)
    expect(connection.getState()).toMatchObject({
      status: 'pairing',
      snapshot: null,
      report: null,
      streams: {},
      error: null,
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(TestSocket.instances).toHaveLength(1)
  })
  test.each(['started_at', 'ended_at', 'generated_at'])(
    'cached out-of-range %s cannot crash a report render',
    (field) => {
      storage.set(
        'studyvis.mirror.report.v1',
        JSON.stringify({
          ...report,
          session: { ...report.session, [field]: 1e100 },
        })
      )
      const connection = createBrowserConnection()
      cleanup.push(connection.disconnect)
      expect(connection.getState().report).toBeNull()
    }
  )
  test('host loss releases capture immediately, disables commands, and reconnects without reopening devices', async () => {
    const connection = createBrowserConnection()
    cleanup.push(connection.disconnect)
    const original = TestSocket.instances[0]
    expect(original.url).toBe('wss://127.0.0.1:12345/api/socket')
    await activate(original)
    const camera = capture()
    const screen = capture()
    connection.setCapture('camera', camera.stream)
    connection.setCapture('screen', screen.stream)
    await vi.advanceTimersByTimeAsync(100)
    original.close()
    expect(camera.track.stop).toHaveBeenCalledOnce()
    expect(screen.track.stop).toHaveBeenCalledOnce()
    expect(connection.getState().status).toBe('disconnected')
    const count = original.send.mock.calls.length
    connection.sendControl({ type: 'note', text: 'offline' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(original.send.mock.calls).toHaveLength(count)
    const replacement = TestSocket.instances[1]
    await activate(replacement)
    expect(connection.getState().status).toBe('connected')
    expect(doubles.peers[1].setCapture.mock.calls).toEqual([
      ['camera', null],
      ['screen', null],
    ])
    const denied = capture()
    replacement.close()
    connection.setCapture('camera', denied.stream)
    expect(denied.track.stop).toHaveBeenCalledOnce()
  })

  test('a malformed live snapshot closes the connection and releases owned capture', async () => {
    const connection = createBrowserConnection()
    cleanup.push(connection.disconnect)
    const socket = TestSocket.instances[0]
    await activate(socket)
    await incoming(socket, { type: 'snapshot', snapshot: snapshot() })
    const camera = capture()
    const screen = capture()
    connection.setCapture('camera', camera.stream)
    connection.setCapture('screen', screen.stream)
    await incoming(socket, {
      type: 'snapshot',
      snapshot: { version: 1, notes: null },
    })
    expect(socket.readyState).toBe(3)
    expect(camera.track.stop).toHaveBeenCalledOnce()
    expect(screen.track.stop).toHaveBeenCalledOnce()
    expect(connection.getState().status).toBe('disconnected')
    expect(connection.getState().streams).toEqual({})
    const cached = JSON.parse(storage.get('studyvis.mirror.snapshot.v1')!)
    expect(cached.version).toBe(1)
    expect(cached.sessionId).toBe('session-1')
  })

  test('pairing normalizes the displayed password and keeps it out of persistent browser storage', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ clientId: 'one' }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetch)
    const connection = createBrowserConnection()
    cleanup.push(connection.disconnect)
    await connection.pair(' abcd-efgh ')
    expect(fetch).toHaveBeenCalledWith(
      '/api/pair',
      expect.objectContaining({
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ password: 'ABCDEFGH' }),
      })
    )
    expect([...storage.values()].join('')).not.toContain('ABCDEFGH')
  })

  test('offline snapshots retain notes and omit bulky image pixels while the live state keeps images', async () => {
    const connection = createBrowserConnection()
    cleanup.push(connection.disconnect)
    await activate(TestSocket.instances[0])
    const live = snapshot()
    await incoming(TestSocket.instances[0], {
      type: 'snapshot',
      snapshot: live,
    })
    expect(connection.getState().snapshot).toEqual(live)
    const cached = JSON.parse(storage.get('studyvis.mirror.snapshot.v1')!)
    expect(cached.images).toEqual([])
    expect(cached.offlineImagesOmitted).toBe(true)
    expect(cached.declaredTopic).toBe(live.declaredTopic)
    expect(JSON.stringify(cached)).not.toContain(live.images[0].data)
  })

  test('only a validated report is acknowledged and restored after reload', async () => {
    const connection = createBrowserConnection()
    cleanup.push(connection.disconnect)
    const socket = TestSocket.instances[0]
    await activate(socket)
    await incoming(socket, {
      type: 'report',
      report: { session: { id: 'broken' } },
    })
    expect(connection.getState().report).toBeNull()
    expect(
      sent(socket).some((message) => message?.type === 'report_saved')
    ).toBe(false)
    await incoming(socket, { type: 'report', report })
    expect(connection.getState().report).toEqual(report)
    expect(connection.getState().snapshot).toBeNull()
    await incoming(socket, { type: 'snapshot', snapshot: snapshot() })
    expect(connection.getState().report).toEqual(report)
    expect(connection.getState().snapshot).toBeNull()
    expect(
      sent(socket).some((message) => message?.type === 'report_saved')
    ).toBe(true)
    const reloaded = createBrowserConnection()
    cleanup.push(reloaded.disconnect)
    expect(reloaded.getState().report).toEqual(report)
  })
  test('storage denial preserves the live report and honestly marks it as unavailable offline', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new Error('Storage denied')
      },
    })
    const connection = createBrowserConnection()
    cleanup.push(connection.disconnect)
    const socket = TestSocket.instances[0]
    socket.open()
    await incoming(socket, { type: 'report', report })
    expect(connection.getState().report).toEqual(report)
    expect(connection.getState().reportCached).toBe(false)
    expect(
      sent(socket).some((message) => message?.type === 'report_saved')
    ).toBe(true)
  })

  test('a platform notification failure cannot tear down the authenticated media connection', async () => {
    const notification = { permission: 'granted' }
    vi.stubGlobal('window', {
      isSecureContext: true,
      Notification: notification,
    })
    vi.stubGlobal('Notification', notification)
    const registration = {
      showNotification: vi.fn(async () => {
        throw new Error('Platform notifications unavailable')
      }),
    }
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: vi.fn(async () => registration) },
    })
    const connection = createBrowserConnection()
    cleanup.push(connection.disconnect)
    const socket = TestSocket.instances[0]
    await activate(socket)
    await incoming(socket, {
      type: 'notification',
      title: 'Break finished',
      body: 'Return to your session',
    })
    expect(registration.showNotification).toHaveBeenCalledWith(
      'Break finished',
      { body: 'Return to your session' }
    )
    expect(connection.getState().status).toBe('connected')
    expect(socket.readyState).toBe(TestSocket.OPEN)
  })

  test.each([
    ['visible', true, false],
    ['visible', false, true],
    ['hidden', false, true],
  ] as const)(
    'background-only notifications respect visibility %s and focus %s',
    async (visibilityState, focused, expected) => {
      vi.stubGlobal('window', { isSecureContext: true, Notification: {} })
      vi.stubGlobal('Notification', { permission: 'granted' })
      vi.stubGlobal('document', { visibilityState, hasFocus: () => focused })
      const registration = { showNotification: vi.fn(async () => {}) }
      vi.stubGlobal('navigator', {
        serviceWorker: { getRegistration: vi.fn(async () => registration) },
      })
      const connection = createBrowserConnection()
      cleanup.push(connection.disconnect)
      const socket = TestSocket.instances[0]
      await activate(socket)
      await incoming(socket, {
        type: 'notification',
        title: 'New session note',
        body: 'Bob',
        onlyWhenHidden: true,
      })
      expect(registration.showNotification).toHaveBeenCalledTimes(
        expected ? 1 : 0
      )
      expect(connection.getState().status).toBe('connected')
    }
  )

  test('an insecure LAN page never opens the authenticated websocket', () => {
    vi.stubGlobal('window', { isSecureContext: false })
    vi.stubGlobal('location', {
      protocol: 'http:',
      origin: 'http://192.168.1.2:12345',
    })
    const connection = createBrowserConnection()
    cleanup.push(connection.disconnect)
    expect(TestSocket.instances).toHaveLength(0)
    expect(connection.getState().status).toBe('pairing')
  })
})
