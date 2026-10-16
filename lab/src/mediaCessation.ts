export type MediaTransportSnapshot = {
  index: number
  connectionState: string
  receivers: { id: string; kind: string; original: boolean }[]
  rtp: Record<string, unknown>[]
}

export type InboundVideoCounters = {
  connection: number
  statId: string
  bytes: number
  packets: number
  frames: number
}

/** Original receiver objects can outlive their closed transport. A live
 * receiver must expose its matching inbound counters; missing instrumentation
 * cannot establish that transmission stopped. */
export function originalInboundVideoCounters(
  transports: MediaTransportSnapshot[],
  { requireLive = false }: { requireLive?: boolean } = {}
): InboundVideoCounters[] {
  const counters = transports.flatMap((transport) => {
    const originalIds = transport.receivers
      .filter((receiver) => receiver.original && receiver.kind === 'video')
      .map((receiver) => receiver.id)
    if (originalIds.length === 0 || transport.connectionState === 'closed')
      return []
    const inbound = transport.rtp.filter(
      (stat) =>
        stat.type === 'inbound-rtp' &&
        stat.kind === 'video' &&
        typeof stat.trackIdentifier === 'string' &&
        originalIds.includes(stat.trackIdentifier)
    )
    if (inbound.length === 0)
      throw new Error(
        'original live video receiver has no matching RTP counters'
      )
    return inbound.map((stat) => {
      const values = [
        stat.bytesReceived,
        stat.packetsReceived,
        stat.framesReceived,
      ]
      if (
        typeof stat.id !== 'string' ||
        values.some(
          (value) =>
            typeof value !== 'number' ||
            !Number.isSafeInteger(value) ||
            value < 0
        )
      )
        throw new Error('original video receiver has incomplete RTP counters')
      return {
        connection: transport.index,
        statId: stat.id,
        bytes: stat.bytesReceived as number,
        packets: stat.packetsReceived as number,
        frames: stat.framesReceived as number,
      }
    })
  })
  if (requireLive && counters.length === 0)
    throw new Error('no live original video receiver RTP mapping was observed')
  return counters
}

/** A removed/closed original receiver is stopped. Any new counter identity,
 * reset, or incoming byte/packet/frame change on a surviving receiver is live. */
export function originalInboundVideoStopped(
  before: InboundVideoCounters[],
  after: InboundVideoCounters[]
): boolean {
  return after.every((next) => {
    const previous = before.find(
      (old) => old.connection === next.connection && old.statId === next.statId
    )
    return (
      previous !== undefined &&
      previous.bytes === next.bytes &&
      previous.packets === next.packets &&
      previous.frames === next.frames
    )
  })
}

export function originalMediaWindowStopped(
  rendered: {
    before: { frames: number; matchingVideos: number }
    after: { frames: number; matchingVideos: number }
  },
  inboundBefore: InboundVideoCounters[],
  inboundAfter: InboundVideoCounters[]
): boolean {
  return (
    rendered.before.frames === rendered.after.frames &&
    rendered.before.matchingVideos === rendered.after.matchingVideos &&
    originalInboundVideoStopped(inboundBefore, inboundAfter)
  )
}
