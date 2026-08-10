import { describe, expect, test } from 'vitest'

import {
  collectPttMediaSnapshot,
  diffPttMediaSnapshot,
  type PttMediaSnapshot,
} from '@/features/system/pttDiagnostics'
import type { TopicRoom } from '@/lib/trystero'

function track(
  kind: 'audio' | 'video',
  enabled: boolean,
  readyState: MediaStreamTrackState = 'live'
): MediaStreamTrack {
  return { kind, enabled, readyState } as unknown as MediaStreamTrack
}

function sender(args: {
  track: MediaStreamTrack
  bytesSent?: number
  packetsSent?: number
  mediaTypeField?: boolean
  rejectStats?: boolean
}): RTCRtpSender {
  return {
    track: args.track,
    getStats: async () => {
      if (args.rejectStats) throw new Error('stats unavailable')
      const stat = {
        id: 'outbound-audio',
        timestamp: 1,
        type: 'outbound-rtp',
        ...(args.mediaTypeField ? { mediaType: 'audio' } : { kind: 'audio' }),
        bytesSent: args.bytesSent ?? 0,
        packetsSent: args.packetsSent ?? 0,
      }
      return new Map([[stat.id, stat]]) as unknown as RTCStatsReport
    },
  } as unknown as RTCRtpSender
}

function receiver(args: {
  track: MediaStreamTrack
  bytesReceived?: number
  packetsReceived?: number
  mediaTypeField?: boolean
  rejectStats?: boolean
}): RTCRtpReceiver {
  return {
    track: args.track,
    getStats: async () => {
      if (args.rejectStats) throw new Error('stats unavailable')
      const stat = {
        id: 'inbound-audio',
        timestamp: 1,
        type: 'inbound-rtp',
        ...(args.mediaTypeField ? { mediaType: 'audio' } : { kind: 'audio' }),
        bytesReceived: args.bytesReceived ?? 0,
        packetsReceived: args.packetsReceived ?? 0,
      }
      return new Map([[stat.id, stat]]) as unknown as RTCStatsReport
    },
  } as unknown as RTCRtpReceiver
}

function peer(
  senders: RTCRtpSender[],
  receivers: RTCRtpReceiver[] = []
): RTCPeerConnection {
  return {
    getSenders: () => senders,
    getReceivers: () => receivers,
  } as unknown as RTCPeerConnection
}

function room(peers: RTCPeerConnection[]): TopicRoom {
  return {
    getPeers: () =>
      Object.fromEntries(
        peers.map((connection, i) => [`peer-${i}`, connection])
      ),
  } as unknown as TopicRoom
}

function snapshot(overrides: Partial<PttMediaSnapshot>): PttMediaSnapshot {
  return {
    roomActive: true,
    peerConnectionCount: 1,
    audioSenderCount: 1,
    enabledAudioSenderCount: 1,
    liveAudioSenderCount: 1,
    audioReceiverCount: 1,
    liveAudioReceiverCount: 1,
    outboundReportCount: 1,
    inboundReportCount: 1,
    bytesSent: 0,
    packetsSent: 0,
    bytesReceived: 0,
    packetsReceived: 0,
    senderStatsErrorCount: 0,
    receiverStatsErrorCount: 0,
    collectionError: false,
    ...overrides,
  }
}

describe('PTT media diagnostics', () => {
  test('returns an empty snapshot outside a session', async () => {
    await expect(collectPttMediaSnapshot(null)).resolves.toEqual({
      roomActive: false,
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
    })
  })

  test('aggregates audio senders, receivers, and RTP counters', async () => {
    const firstAudio = sender({
      track: track('audio', true),
      bytesSent: 100,
      packetsSent: 10,
    })
    const secondAudio = sender({
      track: track('audio', false, 'ended'),
      bytesSent: 50,
      packetsSent: 5,
      mediaTypeField: true,
    })
    const video = sender({
      track: track('video', true),
      bytesSent: 9_999,
      packetsSent: 999,
    })
    const firstInbound = receiver({
      track: track('audio', true),
      bytesReceived: 200,
      packetsReceived: 20,
    })
    const secondInbound = receiver({
      track: track('audio', true, 'ended'),
      bytesReceived: 75,
      packetsReceived: 7,
      mediaTypeField: true,
    })

    await expect(
      collectPttMediaSnapshot(
        room([
          peer([firstAudio, video], [firstInbound]),
          peer([secondAudio], [secondInbound]),
        ])
      )
    ).resolves.toEqual({
      roomActive: true,
      peerConnectionCount: 2,
      audioSenderCount: 2,
      enabledAudioSenderCount: 1,
      liveAudioSenderCount: 1,
      audioReceiverCount: 2,
      liveAudioReceiverCount: 1,
      outboundReportCount: 2,
      inboundReportCount: 2,
      bytesSent: 150,
      packetsSent: 15,
      bytesReceived: 275,
      packetsReceived: 27,
      senderStatsErrorCount: 0,
      receiverStatsErrorCount: 0,
      collectionError: false,
    })
  })

  test('getStats failures are non-fatal and counted', async () => {
    const brokenSender = sender({
      track: track('audio', true),
      rejectStats: true,
    })
    const brokenReceiver = receiver({
      track: track('audio', true),
      rejectStats: true,
    })

    await expect(
      collectPttMediaSnapshot(room([peer([brokenSender], [brokenReceiver])]))
    ).resolves.toMatchObject({
      audioSenderCount: 1,
      enabledAudioSenderCount: 1,
      liveAudioSenderCount: 1,
      audioReceiverCount: 1,
      liveAudioReceiverCount: 1,
      outboundReportCount: 0,
      inboundReportCount: 0,
      senderStatsErrorCount: 1,
      receiverStatsErrorCount: 1,
      collectionError: false,
    })
  })

  test('inspection failures return a flagged snapshot', async () => {
    const badRoom = {
      getPeers: () => {
        throw new Error('peer map unavailable')
      },
    } as unknown as TopicRoom

    await expect(collectPttMediaSnapshot(badRoom)).resolves.toMatchObject({
      roomActive: true,
      collectionError: true,
      audioSenderCount: 0,
      audioReceiverCount: 0,
    })
  })

  test('computes monotonic RTP deltas and rejects reset counters', () => {
    expect(
      diffPttMediaSnapshot(
        snapshot({
          bytesSent: 100,
          packetsSent: 10,
          bytesReceived: 300,
          packetsReceived: 30,
        }),
        snapshot({
          bytesSent: 175,
          packetsSent: 13,
          bytesReceived: 450,
          packetsReceived: 35,
        })
      )
    ).toEqual({
      bytesSentDelta: 75,
      packetsSentDelta: 3,
      bytesReceivedDelta: 150,
      packetsReceivedDelta: 5,
    })

    expect(
      diffPttMediaSnapshot(
        snapshot({
          bytesSent: 175,
          packetsSent: 13,
          bytesReceived: 450,
          packetsReceived: 35,
        }),
        snapshot({
          bytesSent: 20,
          packetsSent: 2,
          bytesReceived: 40,
          packetsReceived: 4,
        })
      )
    ).toEqual({
      bytesSentDelta: null,
      packetsSentDelta: null,
      bytesReceivedDelta: null,
      packetsReceivedDelta: null,
    })
  })
})
