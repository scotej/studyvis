import type { TopicRoom } from '@/lib/trystero'

export type PttMediaSnapshot = {
  roomActive: boolean
  peerConnectionCount: number
  activePeerCount: number
  activePeerConnectionCount: number
  activePeersMissingConnection: number
  activePeersMissingAudioReceiver: number
  activePeersWithoutLiveAudioReceiver: number
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

export type PttMediaIssue = {
  level: 'warn' | 'error'
  message:
    | 'media.active_no_audio_sender'
    | 'media.active_sender_disabled'
    | 'media.inactive_sender_enabled'
    | 'media.audio_track_not_live'
    | 'media.peer_active_no_connection'
    | 'media.peer_active_no_audio_receiver'
    | 'media.peer_audio_track_not_live'
}

type RtpStats = RTCStats & {
  kind?: string
  mediaType?: string
  bytesSent?: number
  packetsSent?: number
  bytesReceived?: number
  packetsReceived?: number
}

type RtpSummary = {
  reportCount: number
  bytes: number
  packets: number
  error: boolean
}

const EMPTY_ACTIVE_PEERS: ReadonlySet<string> = new Set<string>()

function emptySnapshot(
  roomActive: boolean,
  activePeerCount: number
): PttMediaSnapshot {
  return {
    roomActive,
    peerConnectionCount: 0,
    activePeerCount,
    activePeerConnectionCount: 0,
    activePeersMissingConnection: roomActive ? activePeerCount : 0,
    activePeersMissingAudioReceiver: 0,
    activePeersWithoutLiveAudioReceiver: 0,
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

async function collectSenderStats(sender: RTCRtpSender): Promise<RtpSummary> {
  try {
    const report = await sender.getStats()
    const summary: RtpSummary = {
      reportCount: 0,
      bytes: 0,
      packets: 0,
      error: false,
    }
    report.forEach((raw) => {
      const stat = raw as RtpStats
      if (stat.type !== 'outbound-rtp' || !isAudioRtp(stat)) return
      summary.reportCount += 1
      if (typeof stat.bytesSent === 'number') summary.bytes += stat.bytesSent
      if (typeof stat.packetsSent === 'number')
        summary.packets += stat.packetsSent
    })
    return summary
  } catch {
    return { reportCount: 0, bytes: 0, packets: 0, error: true }
  }
}

async function collectReceiverStats(
  receiver: RTCRtpReceiver
): Promise<RtpSummary> {
  try {
    const report = await receiver.getStats()
    const summary: RtpSummary = {
      reportCount: 0,
      bytes: 0,
      packets: 0,
      error: false,
    }
    report.forEach((raw) => {
      const stat = raw as RtpStats
      if (stat.type !== 'inbound-rtp' || !isAudioRtp(stat)) return
      summary.reportCount += 1
      if (typeof stat.bytesReceived === 'number')
        summary.bytes += stat.bytesReceived
      if (typeof stat.packetsReceived === 'number')
        summary.packets += stat.packetsReceived
    })
    return summary
  } catch {
    return { reportCount: 0, bytes: 0, packets: 0, error: true }
  }
}

// Privacy-safe PTT telemetry. Peer IDs are accepted only as an in-memory
// correlation key so receiver health is matched to the peer that actually
// claims PTT; no identifier is returned or logged. Track enabled/readyState is
// captured synchronously before any `await`, then every getStats() call runs in
// parallel. This keeps one slow peer from stretching the observation window
// and prevents track state from being paired with PTT state sampled later.
export async function collectPttMediaSnapshot(
  room: TopicRoom | null,
  activePeerIds: ReadonlySet<string> = EMPTY_ACTIVE_PEERS
): Promise<PttMediaSnapshot> {
  if (!room) return emptySnapshot(false, activePeerIds.size)

  const snapshot = emptySnapshot(true, activePeerIds.size)
  let peersById: Record<string, RTCPeerConnection>
  try {
    peersById = room.getPeers()
  } catch {
    snapshot.collectionError = true
    return snapshot
  }

  const peerEntries = Object.entries(peersById)
  snapshot.peerConnectionCount = peerEntries.length
  snapshot.activePeerConnectionCount = [...activePeerIds].reduce(
    (count, peerId) =>
      count + (Object.prototype.hasOwnProperty.call(peersById, peerId) ? 1 : 0),
    0
  )
  snapshot.activePeersMissingConnection = Math.max(
    0,
    activePeerIds.size - snapshot.activePeerConnectionCount
  )

  const audioSenders: RTCRtpSender[] = []
  const audioReceivers: RTCRtpReceiver[] = []

  for (const [peerId, peer] of peerEntries) {
    let senders: RTCRtpSender[]
    let receivers: RTCRtpReceiver[]
    try {
      senders = peer.getSenders()
      receivers = peer.getReceivers()
    } catch {
      snapshot.collectionError = true
      continue
    }

    const peerAudioSenders = senders.filter(
      (sender) => sender.track?.kind === 'audio'
    )
    const peerAudioReceivers = receivers.filter(
      (receiver) => receiver.track?.kind === 'audio'
    )
    audioSenders.push(...peerAudioSenders)
    audioReceivers.push(...peerAudioReceivers)

    if (activePeerIds.has(peerId)) {
      if (peerAudioReceivers.length === 0) {
        snapshot.activePeersMissingAudioReceiver += 1
      } else if (
        !peerAudioReceivers.some(
          (receiver) => receiver.track?.readyState === 'live'
        )
      ) {
        snapshot.activePeersWithoutLiveAudioReceiver += 1
      }
    }
  }

  snapshot.audioSenderCount = audioSenders.length
  for (const sender of audioSenders) {
    const track = sender.track
    if (track?.enabled) snapshot.enabledAudioSenderCount += 1
    if (track?.readyState === 'live') snapshot.liveAudioSenderCount += 1
  }

  snapshot.audioReceiverCount = audioReceivers.length
  for (const receiver of audioReceivers) {
    if (receiver.track?.readyState === 'live')
      snapshot.liveAudioReceiverCount += 1
  }

  const [senderSummaries, receiverSummaries] = await Promise.all([
    Promise.all(audioSenders.map(collectSenderStats)),
    Promise.all(audioReceivers.map(collectReceiverStats)),
  ])

  for (const summary of senderSummaries) {
    snapshot.outboundReportCount += summary.reportCount
    snapshot.bytesSent += summary.bytes
    snapshot.packetsSent += summary.packets
    if (summary.error) snapshot.senderStatsErrorCount += 1
  }
  for (const summary of receiverSummaries) {
    snapshot.inboundReportCount += summary.reportCount
    snapshot.bytesReceived += summary.bytes
    snapshot.packetsReceived += summary.packets
    if (summary.error) snapshot.receiverStatsErrorCount += 1
  }

  return snapshot
}

export function classifyPttMediaSnapshot(args: {
  source: 'local' | 'peer'
  localActive: boolean
  stateChangedDuringSample: boolean
  snapshot: PttMediaSnapshot
}): PttMediaIssue | null {
  const { source, localActive, stateChangedDuringSample, snapshot } = args
  if (
    stateChangedDuringSample ||
    snapshot.collectionError ||
    !snapshot.roomActive
  ) {
    return null
  }

  if (source === 'local') {
    if (
      localActive &&
      snapshot.peerConnectionCount > 0 &&
      snapshot.audioSenderCount === 0
    ) {
      return { level: 'warn', message: 'media.active_no_audio_sender' }
    }
    if (
      localActive &&
      snapshot.audioSenderCount > 0 &&
      snapshot.enabledAudioSenderCount !== snapshot.audioSenderCount
    ) {
      return { level: 'error', message: 'media.active_sender_disabled' }
    }
    if (!localActive && snapshot.enabledAudioSenderCount > 0) {
      return { level: 'error', message: 'media.inactive_sender_enabled' }
    }
    if (
      localActive &&
      snapshot.audioSenderCount > 0 &&
      snapshot.liveAudioSenderCount !== snapshot.audioSenderCount
    ) {
      return { level: 'warn', message: 'media.audio_track_not_live' }
    }
    return null
  }

  if (snapshot.activePeerCount === 0) return null
  if (snapshot.activePeersMissingConnection > 0) {
    return { level: 'warn', message: 'media.peer_active_no_connection' }
  }
  if (snapshot.activePeersMissingAudioReceiver > 0) {
    return { level: 'warn', message: 'media.peer_active_no_audio_receiver' }
  }
  if (snapshot.activePeersWithoutLiveAudioReceiver > 0) {
    return { level: 'warn', message: 'media.peer_audio_track_not_live' }
  }
  return null
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
