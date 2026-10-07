import type { CaptureKind, SignalMessage } from './wire'

export type MirrorPeerOptions = {
  role: 'host' | 'browser'
  send: (message: SignalMessage) => void
  onCapture?: (kind: CaptureKind, stream: MediaStream | null) => void
  onStreams?: (streams: Record<string, MediaStream>) => void
  onFailure: () => void
}

export type MirrorPeer = {
  receive: (signal: SignalMessage) => void
  setCapture: (kind: CaptureKind, stream: MediaStream | null) => void
  setStreams: (streams: Record<string, MediaStream>) => void
  close: () => void
}

// Only the host offers. Reserved capture slots let browser track replacement
// run without glare, while host-to-browser peer tracks renegotiate serially.
export function createMirrorPeer(options: MirrorPeerOptions): MirrorPeer {
  const pc = new RTCPeerConnection({ iceServers: [] })
  const captures: Record<CaptureKind, MediaStream | null> = {
    camera: null,
    screen: null,
  }
  const sent = new Map<
    string,
    { stream: MediaStream; slots: RTCRtpTransceiver[] }
  >()
  const reusable: RTCRtpTransceiver[] = []
  let requestedStreams: Record<string, MediaStream> | null = null
  const received = new Map<string, MediaStream>()
  let descriptors: Record<string, string> = {}
  let captureFlags = { camera: false, screen: false }
  let closed = false
  let pendingOffer = false
  let queue = Promise.resolve()
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null
  let answerTimer: ReturnType<typeof setTimeout> | null = null
  let stopGather: (() => void) | null = null
  let cameraReceiver: MediaStream | null = null
  let screenReceiver: MediaStream | null = null

  const enqueue = (job: () => Promise<void>) => {
    queue = queue
      .then(async () => {
        if (!closed) await job()
      })
      .catch(() => {
        if (!closed) options.onFailure()
      })
  }

  const gatheredDescription = async (): Promise<string> => {
    if (pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer)
          pc.removeEventListener('icegatheringstatechange', check)
          stopGather = null
          if (error) reject(error)
          else resolve()
        }
        const check = () => {
          if (pc.iceGatheringState === 'complete') finish()
        }
        const timer = setTimeout(
          () => finish(new Error('LAN ICE gathering timed out')),
          10_000
        )
        stopGather = () => finish(new Error('Mirror connection closed'))
        pc.addEventListener('icegatheringstatechange', check)
        check()
      })
    }
    return pc.localDescription?.sdp ?? ''
  }

  const requestOffer = () => {
    if (closed || options.role !== 'host') return
    pendingOffer = true
    enqueue(async () => {
      if (!pendingOffer || pc.signalingState !== 'stable') return
      pendingOffer = false
      await pc.setLocalDescription(await pc.createOffer())
      const sdp = await gatheredDescription()
      if (closed) return
      options.send({ type: 'offer', sdp })
      if (answerTimer) clearTimeout(answerTimer)
      answerTimer = setTimeout(() => {
        if (!closed) options.onFailure()
      }, 15_000)
    })
  }

  const renderStreams = () => {
    const streams: Record<string, MediaStream> = {}
    for (const [key, id] of Object.entries(descriptors)) {
      const stream = received.get(id)
      if (stream) streams[key] = stream
    }
    options.onStreams?.(streams)
  }

  const renderCaptures = () => {
    const connected = pc.connectionState === 'connected'
    const transceivers = pc.getTransceivers()
    const video = transceivers[0]?.receiver.track
    const audio = transceivers[1]?.receiver.track
    const screen = transceivers[2]?.receiver.track
    if (!cameraReceiver && video && audio)
      cameraReceiver = new MediaStream([video, audio])
    if (!screenReceiver && screen) screenReceiver = new MediaStream([screen])
    options.onCapture?.(
      'camera',
      connected && captureFlags.camera ? cameraReceiver : null
    )
    options.onCapture?.(
      'screen',
      connected && captureFlags.screen ? screenReceiver : null
    )
  }

  const applyCapture = async () => {
    const slots = pc.getTransceivers().slice(0, 3)
    if (slots.length !== 3) return
    const tracks = [
      captures.camera?.getVideoTracks()[0] ?? null,
      captures.camera?.getAudioTracks()[0] ?? null,
      captures.screen?.getVideoTracks()[0] ?? null,
    ]
    for (let index = 0; index < slots.length; index++) {
      slots[index].direction = 'sendonly'
      await slots[index].sender.replaceTrack(tracks[index])
    }
    if (!closed)
      options.send({
        type: 'capture',
        camera: captures.camera !== null,
        screen: captures.screen !== null,
      })
  }

  pc.ontrack = (event) => {
    if (options.role === 'host') {
      renderCaptures()
    } else {
      for (const stream of event.streams) {
        received.set(stream.id, stream)
        stream.addEventListener('removetrack', renderStreams)
      }
      renderStreams()
    }
  }
  pc.onconnectionstatechange = () => {
    if (options.role === 'host') renderCaptures()
    if (disconnectTimer) clearTimeout(disconnectTimer)
    if (pc.connectionState === 'failed') options.onFailure()
    else if (pc.connectionState === 'disconnected') {
      disconnectTimer = setTimeout(() => {
        if (!closed) options.onFailure()
      }, 5000)
    }
  }
  pc.onnegotiationneeded = requestOffer

  if (options.role === 'host') {
    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.addTransceiver('audio', { direction: 'recvonly' })
    pc.addTransceiver('video', { direction: 'recvonly' })
    // Keeps a usable offer even on engines that defer empty media slots.
    pc.createDataChannel('mirror-liveness')
    requestOffer()
  }

  return {
    receive(signal) {
      if (closed) return
      if (signal.type === 'streams' && options.role === 'browser') {
        descriptors = signal.streams
        const active = new Set(Object.values(descriptors))
        for (const id of received.keys())
          if (!active.has(id)) received.delete(id)
        renderStreams()
      } else if (signal.type === 'capture' && options.role === 'host') {
        captureFlags = { camera: signal.camera, screen: signal.screen }
        renderCaptures()
      } else if (signal.type === 'negotiate') {
        requestOffer()
      } else if (signal.type === 'offer' && options.role === 'browser') {
        enqueue(async () => {
          await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp })
          await applyCapture()
          await pc.setLocalDescription(await pc.createAnswer())
          const sdp = await gatheredDescription()
          if (!closed) options.send({ type: 'answer', sdp })
        })
      } else if (signal.type === 'answer' && options.role === 'host') {
        enqueue(async () => {
          await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
          if (answerTimer) clearTimeout(answerTimer)
          answerTimer = null
          renderCaptures()
          if (pendingOffer) requestOffer()
        })
      }
    },
    setCapture(kind, stream) {
      if (closed || options.role !== 'browser') return
      captures[kind] = stream
      enqueue(applyCapture)
    },
    setStreams(streams) {
      if (closed || options.role !== 'host') return
      const entries = Object.entries(streams)
      if (
        requestedStreams &&
        entries.length === Object.keys(requestedStreams).length &&
        entries.every(([key, stream]) => requestedStreams?.[key] === stream)
      )
        return
      requestedStreams = { ...streams }
      const next = requestedStreams
      enqueue(async () => {
        for (const [key, old] of sent) {
          if (next[key] === old.stream) continue
          for (const slot of old.slots) {
            await slot.sender.replaceTrack(null)
            slot.sender.setStreams()
            slot.direction = 'inactive'
            reusable.push(slot)
          }
          sent.delete(key)
        }
        for (const [key, stream] of Object.entries(next)) {
          if (sent.has(key)) continue
          const slots: RTCRtpTransceiver[] = []
          for (const track of stream.getTracks()) {
            const index = reusable.findIndex(
              (slot) => slot.receiver.track.kind === track.kind
            )
            let slot: RTCRtpTransceiver
            if (index < 0) {
              slot = pc.addTransceiver(track, {
                direction: 'sendonly',
                streams: [stream],
              })
            } else {
              slot = reusable.splice(index, 1)[0]
              await slot.sender.replaceTrack(track)
              slot.sender.setStreams(stream)
              slot.direction = 'sendonly'
            }
            slots.push(slot)
          }
          sent.set(key, { stream, slots })
        }
        if (closed) return
        options.send({
          type: 'streams',
          streams: Object.fromEntries(
            [...sent].map(([key, entry]) => [key, entry.stream.id])
          ),
        })
        requestOffer()
      })
    },
    close() {
      if (closed) return
      closed = true
      stopGather?.()
      if (disconnectTimer) clearTimeout(disconnectTimer)
      if (answerTimer) clearTimeout(answerTimer)
      pc.ontrack = null
      pc.onconnectionstatechange = null
      pc.onnegotiationneeded = null
      pc.close()
      received.clear()
      options.onStreams?.({})
      options.onCapture?.('camera', null)
      options.onCapture?.('screen', null)
    },
  }
}
