import { createMirrorPeer, MirrorCodec } from './transport.js'

const results = document.querySelector('#results')
const events = []
const outbox = []
let socket = null
let peer = null
let codec = new MirrorCodec()
let camera = null
let screen = null
let generation = 0
let attempt = 0
let opens = 0
let screenRequest = 0
let context = null
let hostPeer = null
let hostCodec = new MirrorCodec()
let stopPattern = () => {}
const observers = new Map()

function show(text) {
  const line = document.createElement('p')
  line.textContent = text
  results.append(line)
}

function report(kind, data = {}) {
  const event = { type: 'ipad-probe', kind, data, at: performance.now() }
  events.push(event)
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event))
  else outbox.push(event)
}

function errorInfo(error) {
  return {
    name: String(error?.name ?? 'Error'),
    message: String(error?.message ?? error).slice(0, 500),
  }
}

function trackInfo(stream) {
  return (
    stream?.getTracks().map((track) => {
      const settings = track.getSettings()
      return {
        kind: track.kind,
        readyState: track.readyState,
        enabled: track.enabled,
        muted: track.muted,
        settings: Object.fromEntries(
          ['width', 'height', 'frameRate', 'displaySurface'].flatMap((key) =>
            settings[key] === undefined ? [] : [[key, settings[key]]]
          )
        ),
      }
    }) ?? []
  )
}

function stop(stream) {
  stream?.getTracks().forEach((track) => track.stop())
}

function release(reason) {
  generation++
  screenRequest++
  stop(camera)
  stop(screen)
  const stopped = [...trackInfo(camera), ...trackInfo(screen)]
  camera = null
  screen = null
  peer?.close()
  peer = null
  report('released', { reason, stopped, consentReset: true })
}

async function inspectAudio(stream, label) {
  if (!stream?.getAudioTracks().length) return
  context ??= new AudioContext()
  await context.resume()
  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  source.connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  let peakRms = 0
  for (let i = 0; i < 12; i++) {
    analyser.getFloatTimeDomainData(samples)
    peakRms = Math.max(
      peakRms,
      Math.sqrt(
        samples.reduce((sum, value) => sum + value * value, 0) / samples.length
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  source.disconnect()
  report('audio', { label, peakRms, tracks: trackInfo(stream) })
}

function inspectVideo(stream, label) {
  if (!stream?.getVideoTracks().length) return
  if (observers.get(label)?.stream === stream) return
  observers.get(label)?.stop()
  const video = document.createElement('video')
  video.autoplay = true
  video.muted = true
  video.playsInline = true
  video.width = 320
  video.height = 180
  video.srcObject = stream
  video.setAttribute('aria-label', label)
  document.querySelector('#videos').append(video)
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 18
  const drawing = canvas.getContext('2d', { willReadFrequently: true })
  let frames = 0
  let sampled = 0
  const signatures = new Set()
  let nonblack = false
  let closed = false
  function frame() {
    if (closed) return
    frames++
    video.requestVideoFrameCallback(frame)
  }
  video.requestVideoFrameCallback?.(frame)
  video
    .play()
    .catch((error) => report('play-error', { label, ...errorInfo(error) }))
  const timer = setInterval(() => {
    if (!video.videoWidth || !video.videoHeight || sampled >= 600) return
    try {
      drawing.drawImage(video, 0, 0, canvas.width, canvas.height)
      const pixels = drawing.getImageData(
        0,
        0,
        canvas.width,
        canvas.height
      ).data
      let hash = 2166136261
      let lit = 0
      for (let i = 0; i < pixels.length; i += 4) {
        lit += pixels[i] + pixels[i + 1] + pixels[i + 2] > 30 ? 1 : 0
        hash = Math.imul(
          hash ^ pixels[i] ^ (pixels[i + 1] << 8) ^ pixels[i + 2],
          16777619
        )
      }
      sampled++
      nonblack ||= lit > 10
      signatures.add(hash >>> 0)
      report('video', {
        label,
        width: video.videoWidth,
        height: video.videoHeight,
        decodedFrames: Math.max(
          frames,
          video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
        ),
        sampled,
        distinctFrames: signatures.size,
        nonblack,
        tracks: trackInfo(stream),
      })
    } catch (error) {
      report('frame-error', { label, ...errorInfo(error) })
    }
  }, 500)
  observers.set(label, {
    stream,
    stop() {
      closed = true
      clearInterval(timer)
      video.srcObject = null
      video.remove()
    },
  })
}

function makePeer() {
  codec = new MirrorCodec()
  peer = createMirrorPeer({
    role: 'browser',
    send: (signal) => {
      const current = socket
      void codec
        .send({ type: 'signal', signal }, async (data) => {
          if (current === socket && current?.readyState === WebSocket.OPEN)
            current.send(data)
        })
        .catch((error) => report('transport-error', errorInfo(error)))
    },
    onStreams: (streams) => {
      for (const [label, stream] of Object.entries(streams))
        inspectVideo(stream, `host-${label}`)
    },
    onFailure: () => report('peer-failure'),
  })
}

async function connect(reason) {
  const current = new WebSocket(
    `${location.origin.replace('https:', 'wss:')}/api/socket`
  )
  const old = socket
  socket = current
  makePeer()
  current.onopen = () => {
    if (current !== socket) return current.close()
    current.send(JSON.stringify({ type: 'ready' }))
    for (const event of outbox.splice(0)) current.send(JSON.stringify(event))
    report('socket-open', {
      reason,
      opens: ++opens,
      camera: trackInfo(camera),
      screen: trackInfo(screen),
    })
    show(opens === 1 ? 'Probe ready' : `Transport ready ${opens}`)
  }
  current.onmessage = (event) => {
    if (current !== socket) return
    if (event.data === 'ipad-probe:ack') {
      report('host-ack', { opens })
      return
    }
    try {
      const message = codec.receive(event.data)
      if (message?.type === 'signal') peer?.receive(message.signal)
    } catch (error) {
      report('transport-error', errorInfo(error))
    }
  }
  current.onclose = (event) => {
    report('socket-close', {
      current: current === socket,
      code: event.code,
      reason,
    })
    if (current === socket) release('socket-close')
  }
  current.onerror = () => report('socket-error', { reason })
  if (reason === 'reconnect') old?.close()
}

function requestDisplay(event, mode) {
  for (const line of results.querySelectorAll('p'))
    if (line.textContent.startsWith(`${mode}:`)) line.remove()
  const id = ++attempt
  const request = ++screenRequest
  const owner = generation
  const activation = {
    trusted: event.isTrusted,
    active: navigator.userActivation?.isActive === true,
  }
  if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
    report('display-result', { id, mode, outcome: 'not_exposed', activation })
    show(`${mode}: not_exposed`)
    return
  }
  // The call must precede all awaits, transport reporting and permission automation.
  let pending
  try {
    pending = navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    })
  } catch (error) {
    pending = Promise.reject(error)
  }
  report('display-request', { id, mode, activation })
  const timer = setTimeout(() => {
    if (request !== screenRequest) return
    screenRequest++
    report('display-result', {
      id,
      mode,
      outcome: 'request_timeout',
      activation,
    })
    show(`${mode}: request_timeout`)
  }, 35_000)
  void pending
    .then(
      (stream) => {
        if (owner !== generation || request !== screenRequest) {
          stop(stream)
          report('stale-display-stopped', { id, tracks: trackInfo(stream) })
          return
        }
        stop(screen)
        screen = stream
        const tracks = trackInfo(stream)
        report('display-result', {
          id,
          mode,
          outcome: 'live_track',
          activation,
          tracks,
        })
        show(`${mode}: live_track`)
        peer?.setCapture('screen', stream)
        inspectVideo(stream, `local-screen-${id}`)
        for (const track of stream.getTracks())
          track.addEventListener('ended', () => {
            report('display-ended', { id, tracks: trackInfo(stream) })
            if (screen === stream) {
              screen = null
              peer?.setCapture('screen', null)
            }
          })
      },
      (error) => {
        if (owner !== generation || request !== screenRequest) return
        const outcome =
          error?.name === 'NotAllowedError'
            ? 'permission_denied'
            : 'picker_unavailable'
        report('display-result', {
          id,
          mode,
          outcome,
          activation,
          error: errorInfo(error),
        })
        show(`${mode}: ${outcome}`)
      }
    )
    .finally(() => clearTimeout(timer))
}

document.querySelector('#deny').onclick = (event) =>
  requestDisplay(event, 'deny')
document.querySelector('#capture').onclick = (event) =>
  requestDisplay(event, 'capture')
document.querySelector('#camera').onclick = async (event) => {
  const owner = generation
  const activation = {
    trusted: event.isTrusted,
    active: navigator.userActivation?.isActive === true,
  }
  try {
    context ??= new AudioContext()
    void context.resume()
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    })
    if (owner !== generation) return stop(stream)
    stop(camera)
    camera = stream
    peer?.setCapture('camera', stream)
    report('camera-result', {
      outcome: 'live_track',
      tracks: trackInfo(stream),
      activation,
    })
    inspectVideo(stream, 'local-camera')
    void inspectAudio(stream, 'local-microphone')
    show('camera: live_track')
  } catch (error) {
    report('camera-result', {
      outcome: 'unavailable',
      error: errorInfo(error),
      activation,
    })
    show('camera: unavailable')
  }
}
document.querySelector('#stop').onclick = () => {
  screenRequest++
  stop(screen)
  report('screen-stopped', {
    tracks: trackInfo(screen),
    camera: trackInfo(camera),
  })
  screen = null
  peer?.setCapture('screen', null)
  show('Screen stopped')
}
document.querySelector('#takeover').onclick = () => {
  release('takeover')
  void connect('takeover')
}
document.querySelector('#reconnect').onclick = () => {
  release('reconnect')
  void connect('reconnect')
}
document.querySelector('#finish').onclick = () => {
  release('finish')
  report('complete', { opens, events: events.length })
  show('Probe complete')
}
for (const name of [
  'visibilitychange',
  'pagehide',
  'pageshow',
  'resize',
  'orientationchange',
])
  window.addEventListener(name, () =>
    report('lifecycle', {
      event: name,
      visibility: document.visibilityState,
      orientation: screenOrientation(),
      camera: trackInfo(camera),
      screen: trackInfo(screen),
    })
  )
function screenOrientation() {
  return {
    width: innerWidth,
    height: innerHeight,
    angle: window.screen.orientation?.angle ?? null,
  }
}
window.addEventListener('error', (event) =>
  report('page-error', { message: event.message })
)
window.addEventListener('unhandledrejection', (event) =>
  report('page-error', errorInfo(event.reason))
)

// The desktop's generated pattern is a labelled fixture; it never replaces Safari display capture.
window.ipadProbeHost = {
  start(send) {
    hostPeer?.close()
    stopPattern()
    hostCodec = new MirrorCodec()
    hostPeer = createMirrorPeer({
      role: 'host',
      send: (signal) => void hostCodec.send({ type: 'signal', signal }, send),
      onCapture: (kind, stream) => {
        if (!stream) return
        inspectVideo(stream, `received-${kind}`)
        if (kind === 'camera') void inspectAudio(stream, 'received-microphone')
      },
      onFailure: () =>
        window.ipadHostEvidence?.({ kind: 'peer-failure', data: {} }),
    })
    const pattern = document.createElement('canvas')
    pattern.width = 320
    pattern.height = 180
    const draw = pattern.getContext('2d')
    let tick = 0
    const timer = setInterval(() => {
      tick++
      draw.fillStyle = `hsl(${(tick * 37) % 360} 100% 50%)`
      draw.fillRect(0, 0, pattern.width, pattern.height)
      draw.fillStyle = 'white'
      draw.fillText(`Owned desktop test pattern ${tick}`, 10, 40)
    }, 200)
    const stream = pattern.captureStream(10)
    stopPattern = () => {
      clearInterval(timer)
      stop(stream)
    }
    hostPeer.setStreams({ pattern: stream })
  },
  async receive(data) {
    const message = await hostCodec.receive(data)
    if (message?.type === 'signal') hostPeer?.receive(message.signal)
  },
  evidence: () => events,
}

if (new URLSearchParams(location.search).get('role') === 'host') {
  document.querySelectorAll('button').forEach((button) => {
    button.disabled = true
  })
  setInterval(() => {
    for (const event of events.splice(0)) window.ipadHostEvidence?.(event)
  }, 250)
} else {
  const password = new URLSearchParams(location.hash.slice(1)).get('password')
  history.replaceState(null, '', location.pathname)
  report('runtime', {
    browser: 'Simulator Safari',
    userAgent: navigator.userAgent,
    secureContext: window.isSecureContext,
    maxTouchPoints: navigator.maxTouchPoints,
    displayApi: typeof navigator.mediaDevices?.getDisplayMedia === 'function',
    userMediaApi: typeof navigator.mediaDevices?.getUserMedia === 'function',
    frameCallbackApi:
      typeof HTMLVideoElement.prototype.requestVideoFrameCallback ===
      'function',
    orientation: screenOrientation(),
  })
  try {
    const response = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (!response.ok) throw new Error(`Pair HTTP ${response.status}`)
    report('paired', { status: response.status })
    await connect('initial')
  } catch (error) {
    show('Probe pairing failed')
    report('pair-error', errorInfo(error))
  }
}
