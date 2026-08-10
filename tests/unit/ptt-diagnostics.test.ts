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

function peer(senders: RTCRtpSender[]): RTCPeerConnection {
  return {
    getSenders: () => senders,
  } as unknown as RTCPeerConnection
}

function room(peers: RTCPeerConnection[]): TopicRoom {
  return {
    getPeers: () =>
      Object.fromEntries(peers.map((connection, i) => [`peer-${i}`, connection])),
  } as unknown as TopicRoom
}

function snapshot(overrides: Partial<PttMediaSnapshot>): PttMediaSnapshot {
  return {
    roomActive: true,
    peerConnectionCount: 1,
    audioSenderCount: 1,
    enabledAudioSenderCount: 1,
    liveAudioSenderCount: 1,
    outboundReportCount: 1,
    bytesSent: 0,
    packetsSent: 0,
    statsErrorCount: 0,
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
      outboundReportCount: 0,
      bytesSent: 0,
      packetsSent: 0,
      statsErrorCount: 0,
      collectionError: false,
    })
  })

  test('aggregates only outbound audio senders and RTP counters', async () => {
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

    await expect(
      collectPttMediaSnapshot(room([peer([firstAudio, video]), peer([secondAudio])]))
    ).resolves.toEqual({
      roomActive: true,
      peerConnectionCount: 2,
      audioSenderCount: 2,
      enabledAudioSenderCount: 1,
      liveAudioSenderCount: 1,
      outboundReportCount: 2,
      bytesSent: 150,
      packetsSent: 15,
      statsErrorCount: 0,
      collectionError: false,
    })
  })

  test('getStats failures are counted but never reject the diagnostic sample', async () => {
    const broken = sender({
      track: track('audio', true),
      rejectStats: true,
    })

    await expect(collectPttMediaSnapshot(room([peer([broken])]))).resolves.toMatchObject({
      audioSenderCount: 1,
      enabledAudioSenderCount: 1,
      liveAudioSenderCount: 1,
      outboundReportCount: 0,
      statsErrorCount: 1,
      collectionError: false,
    })
  })

  test('room/sender inspection failures degrade to a flagged snapshot', async () => {
    const badRoom = {
      getPeers: () => {
        throw new Error('peer map unavailable')
      },
    } as unknown as TopicRoom

    await expect(collectPttMediaSnapshot(badRoom)).resolves.toMatchObject({
      roomActive: true,
      collectionError: true,
      audioSenderCount: 0,
    })
  })

  test('computes monotonic RTP deltas and rejects reset counters', () => {
    expect(
      diffPttMediaSnapshot(
        snapshot({ bytesSent: 100, packetsSent: 10 }),
        snapshot({ bytesSent: 175, packetsSent: 13 })
      )
    ).toEqual({ bytesSentDelta: 75, packetsSentDelta: 3 })

    expect(
      diffPttMediaSnapshot(
        snapshot({ bytesSent: 175, packetsSent: 13 }),
        snapshot({ bytesSent: 20, packetsSent: 2 })
      )
    ).toEqual({ bytesSentDelta: null, packetsSentDelta: null })
  })
})
