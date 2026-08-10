import type { TopicRoom } from '@/lib/trystero'

export type PttMediaSnapshot = {
  roomActive: boolean
  peerConnectionCount: number
  audioSenderCount: number
  enabledAudioSenderCount: number
  liveAudioSenderCount: number
  outboundReportCount: number
  bytesSent: number
  packetsSent: number
  statsErrorCount: number
  collectionError: boolean
}

export type PttMediaDelta = {
  bytesSentDelta: number | null
  packetsSentDelta: number | null
}

type OutboundRtpStats = RTCStats & {
  kind?: string
  mediaType?: string
  bytesSent?: number
  packetsSent?: number
}

function emptySnapshot(roomActive: boolean): PttMediaSnapshot {
  return {
    roomActive,
    peerConnectionCount: 0,
    audioSenderCount: 0,
    enabledAudioSenderCount: 0,
    liveAudioSenderCount: 0,
    outboundReportCount: 0,
    bytesSent: 0,
    packetsSent: 0,
    statsErrorCount: 0,
    collectionError: false,
  }
}

// Privacy-safe PTT telemetry. This deliberately records only aggregate sender
// state and counters: no peer IDs, device labels, track IDs, codecs, addresses,
// SDP, session topics, or audio contents ever leave this function. Diagnostics
// must also be observational only, so every WebRTC read is best-effort and a
// broken getStats implementation can never break PTT itself.
export async function collectPttMediaSnapshot(
  room: TopicRoom | null
): Promise<PttMediaSnapshot> {
  if (!room) return emptySnapshot(false)

  const snapshot = emptySnapshot(true)
  let peers: RTCPeerConnection[]
  try {
    peers = Object.values(room.getPeers())
  } catch {
    snapshot.collectionError = true
    return snapshot
  }
  snapshot.peerConnectionCount = peers.length

  const audioSenders: RTCRtpSender[] = []
  try {
    for (const peer of peers) {
      for (const sender of peer.getSenders()) {
        if (sender.track?.kind === 'audio') audioSenders.push(sender)
      }
    }
  } catch {
    snapshot.collectionError = true
    return snapshot
  }

  snapshot.audioSenderCount = audioSenders.length
  for (const sender of audioSenders) {
    const track = sender.track
    if (track?.enabled) snapshot.enabledAudioSenderCount += 1
    if (track?.readyState === 'live') snapshot.liveAudioSenderCount += 1

    try {
      const report = await sender.getStats()
      report.forEach((raw) => {
        const stat = raw as OutboundRtpStats
        if (stat.type !== 'outbound-rtp') return
        if (stat.kind !== 'audio' && stat.mediaType !== 'audio') return
        snapshot.outboundReportCount += 1
        if (typeof stat.bytesSent === 'number') {
          snapshot.bytesSent += stat.bytesSent
        }
        if (typeof stat.packetsSent === 'number') {
          snapshot.packetsSent += stat.packetsSent
        }
      })
    } catch {
      snapshot.statsErrorCount += 1
    }
  }

  return snapshot
}

export function diffPttMediaSnapshot(
  previous: PttMediaSnapshot | null,
  current: PttMediaSnapshot
): PttMediaDelta {
  if (
    !previous ||
    !previous.roomActive ||
    !current.roomActive ||
    previous.collectionError ||
    current.collectionError
  ) {
    return { bytesSentDelta: null, packetsSentDelta: null }
  }

  return {
    // Aggregate counters can legitimately reset when a peer reconnects or a
    // sender is replaced. Negative deltas are therefore "not comparable", not
    // evidence of packets moving backwards.
    bytesSentDelta:
      current.bytesSent >= previous.bytesSent
        ? current.bytesSent - previous.bytesSent
        : null,
    packetsSentDelta:
      current.packetsSent >= previous.packetsSent
        ? current.packetsSent - previous.packetsSent
        : null,
  }
}
