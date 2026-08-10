import type { TopicRoom } from '@/lib/trystero'

export type PttMediaSnapshot = {
  roomActive: boolean
  peerConnectionCount: number
  audioSenderCount: number
  enabledAudioSenderCount: number
  liveAudioSenderCount: number
  audioReceiverCount: number
  liveAudioReceiverCount: number
  outboundReportCount: number
  inboundReportCount: number
  bytesSent: number
  packetsSent: number
  bytesReceived: number
  packetsReceived: number
  senderStatsErrorCount: number
  receiverStatsErrorCount: number
  collectionError: boolean
}

export type PttMediaDelta = {
  bytesSentDelta: number | null
  packetsSentDelta: number | null
  bytesReceivedDelta: number | null
  packetsReceivedDelta: number | null
}

type RtpStats = RTCStats & {
  kind?: string
  mediaType?: string
  bytesSent?: number
  packetsSent?: number
  bytesReceived?: number
  packetsReceived?: number
}

function emptySnapshot(roomActive: boolean): PttMediaSnapshot {
  return {
    roomActive,
    peerConnectionCount: 0,
    audioSenderCount: 0,
    enabledAudioSenderCount: 0,
    liveAudioSenderCount: 0,
    audioReceiverCount: 0,
    liveAudioReceiverCount: 0,
    outboundReportCount: 0,
    inboundReportCount: 0,
    bytesSent: 0,
    packetsSent: 0,
    bytesReceived: 0,
    packetsReceived: 0,
    senderStatsErrorCount: 0,
    receiverStatsErrorCount: 0,
    collectionError: false,
  }
}

function isAudioRtp(stat: RtpStats): boolean {
  return stat.kind === 'audio' || stat.mediaType === 'audio'
}

// Privacy-safe PTT telemetry. This deliberately records only aggregate media
// state and RTP counters: no peer IDs, device labels, track IDs, codecs,
// addresses, SDP, session topics, or audio contents ever leave this function.
// Diagnostics are observational only, so every WebRTC read is best-effort and
// a broken getStats implementation can never break PTT itself.
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
  const audioReceivers: RTCRtpReceiver[] = []
  try {
    for (const peer of peers) {
      for (const sender of peer.getSenders()) {
        if (sender.track?.kind === 'audio') audioSenders.push(sender)
      }
      for (const receiver of peer.getReceivers()) {
        if (receiver.track?.kind === 'audio') audioReceivers.push(receiver)
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
        const stat = raw as RtpStats
        if (stat.type !== 'outbound-rtp' || !isAudioRtp(stat)) return
        snapshot.outboundReportCount += 1
        if (typeof stat.bytesSent === 'number')
          snapshot.bytesSent += stat.bytesSent
        if (typeof stat.packetsSent === 'number') {
          snapshot.packetsSent += stat.packetsSent
        }
      })
    } catch {
      snapshot.senderStatsErrorCount += 1
    }
  }

  snapshot.audioReceiverCount = audioReceivers.length
  for (const receiver of audioReceivers) {
    if (receiver.track?.readyState === 'live')
      snapshot.liveAudioReceiverCount += 1

    try {
      const report = await receiver.getStats()
      report.forEach((raw) => {
        const stat = raw as RtpStats
        if (stat.type !== 'inbound-rtp' || !isAudioRtp(stat)) return
        snapshot.inboundReportCount += 1
        if (typeof stat.bytesReceived === 'number') {
          snapshot.bytesReceived += stat.bytesReceived
        }
        if (typeof stat.packetsReceived === 'number') {
          snapshot.packetsReceived += stat.packetsReceived
        }
      })
    } catch {
      snapshot.receiverStatsErrorCount += 1
    }
  }

  return snapshot
}

function counterDelta(previous: number, current: number): number | null {
  // Aggregate counters can legitimately reset when a peer reconnects or an RTP
  // sender/receiver is replaced. A negative delta is therefore "not
  // comparable", not evidence of bytes moving backwards.
  return current >= previous ? current - previous : null
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
    return {
      bytesSentDelta: null,
      packetsSentDelta: null,
      bytesReceivedDelta: null,
      packetsReceivedDelta: null,
    }
  }

  return {
    bytesSentDelta: counterDelta(previous.bytesSent, current.bytesSent),
    packetsSentDelta: counterDelta(previous.packetsSent, current.packetsSent),
    bytesReceivedDelta: counterDelta(
      previous.bytesReceived,
      current.bytesReceived
    ),
    packetsReceivedDelta: counterDelta(
      previous.packetsReceived,
      current.packetsReceived
    ),
  }
}
