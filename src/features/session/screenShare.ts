// Screen sharing — every participant can publish their screen alongside their
// camera, so "what are you working on?" is answerable without describing it.
//
// The camera stream is the only stream a pre-1.9 build has ever received, and
// its `onPeerStream` handler binds whatever arrives to that peer's tile. Handing
// such a build a second stream would silently replace the friend's face with
// their screen and strand it there — trystero has no stream-removed event, so
// nothing could ever clear it. Publishing is therefore gated on the peer having
// spoken this protocol at least once: every 1.9+ peer announces on join, an
// older peer never does and never receives a screen stream.
//
// Wire shape (`screen-share` action on the session room):
//   { sharing: boolean, stream_id: string | null }
// Sent on peer join (announce + current state), on every local start/stop, and
// targeted at a peer just before its copy of the stream is added. `sharing:
// false` is what retires a peer's screen tile.

import type { TopicRoom } from '@/lib/trystero'
import { logger } from '@/lib/log'

const log = logger.child('session.screenshare')

export const SCREEN_SHARE_ACTION = 'screen-share'

// Tagged onto the published stream. Secondary classifier only: trystero pairs
// stream metadata to incoming streams FIFO (@trystero-p2p/core room.mjs:438-443
// — `pendingStreamMetas[id].shift()`), so it is position-addressed and a single
// orphaned meta would mislabel every later stream on that connection. The
// announced stream id is content-addressed and wins; this covers the case where
// media outruns the announce.
export const SCREEN_STREAM_METADATA = { kind: 'screen' } as const

// Screens are read, not watched. Capping the frame rate (rather than the
// resolution, which is what makes text legible) is the cheap win: a full 4-user
// mesh where everyone shares is eight concurrent video streams.
export const SCREEN_SHARE_MAX_FPS = 15

export type ScreenSharePayload = {
  sharing: boolean
  stream_id: string | null
}

export type IncomingStreamKind = 'camera' | 'screen'

export function isScreenSharePayload(
  value: unknown
): value is ScreenSharePayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.sharing !== 'boolean') return false
  return v.stream_id === null || typeof v.stream_id === 'string'
}

export function isScreenStreamMetadata(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  return (value as Record<string, unknown>).kind === SCREEN_STREAM_METADATA.kind
}

export type ScreenShareController = {
  // Publish `stream` to every peer that speaks this protocol, now and as they
  // arrive. Replaces any previously published stream.
  publish: (stream: MediaStream) => void
  // Retire the published stream: peers drop the tile on the announce, and the
  // tracks are pulled from each RTCPeerConnection. Stopping the tracks stays
  // with the owner of the MediaStream.
  unpublish: () => void
  // Which tile an incoming peer stream belongs to. Called from the camera
  // binding so a screen stream never lands on the face tile.
  classify: (
    peerId: string,
    stream: MediaStream,
    metadata?: unknown
  ) => IncomingStreamKind
  teardown: () => void
}

export type ScreenShareControllerArgs = {
  room: TopicRoom
  // Fires on a peer's start/stop, and with `false` when a peer leaves, so the
  // consumer retires the tile in one place.
  onPeerSharingChange: (peerId: string, sharing: boolean) => void
}

export function startScreenShareController({
  room,
  onPeerSharingChange,
}: ScreenShareControllerArgs): ScreenShareController {
  // Peers that have sent us an announce — i.e. builds that can render a screen
  // tile. See the capability note at the top of this file.
  const announced = new Set<string>()
  // peerId → the stream id that peer is currently sharing.
  const screenStreamIds = new Map<string, string>()
  // peerId → we have already handed them the current local stream. A repeat
  // `addStream` of the same stream object is a no-op inside trystero's shared
  // peer (shared-peer.mjs:206-211, `shouldAttach = owners.size === 0`) but
  // room.mjs still emits the stream-meta packet, and that orphan meta desyncs
  // the receiver's FIFO for every later stream. "Exactly once per (peer,
  // stream)" is the invariant this set exists to hold.
  const publishedTo = new Set<string>()
  let localStream: MediaStream | null = null
  let stopped = false

  const action = room.makeAction<ScreenSharePayload>(SCREEN_SHARE_ACTION)

  const payload = (): ScreenSharePayload => ({
    sharing: localStream !== null,
    stream_id: localStream?.id ?? null,
  })

  const announce = (target?: string): void => {
    void action.send(payload(), target).catch((err) => {
      log.warn('announce.failed', {
        target: target ?? 'broadcast',
        sharing: localStream !== null,
        err,
      })
    })
  }

  // The one and only place a screen stream is handed to a peer. Both entry
  // points (a peer announcing, and us starting to share) route through here so
  // the exactly-once invariant is structural rather than a rule to remember.
  //
  // The targeted announce goes out first: for a small JSON payload trystero
  // writes to the data channel synchronously inside `send`, ahead of the
  // stream-meta `addStream` emits, so the receiver knows the stream id before
  // the media lands. `classify` tolerates the reverse order anyway.
  const publishTo = (peerId: string): void => {
    if (stopped) return
    const stream = localStream
    if (!stream) return
    if (!announced.has(peerId)) return
    if (publishedTo.has(peerId)) return
    publishedTo.add(peerId)
    announce(peerId)
    room.addStream(stream, peerId, SCREEN_STREAM_METADATA)
  }

  action.receive((data, peerId) => {
    if (stopped) return
    if (!isScreenSharePayload(data)) return
    announced.add(peerId)
    if (data.sharing && data.stream_id) {
      screenStreamIds.set(peerId, data.stream_id)
    } else {
      screenStreamIds.delete(peerId)
    }
    onPeerSharingChange(peerId, data.sharing && data.stream_id !== null)
    publishTo(peerId)
  })

  const offJoin = room.onPeerJoin((peerId) => {
    if (stopped) return
    // Announce only — publishing waits for their announce back, which is what
    // proves they can render a screen tile.
    announce(peerId)
  })

  const offLeave = room.onPeerLeave((peerId) => {
    announced.delete(peerId)
    screenStreamIds.delete(peerId)
    // A blip inside the S1 grace window rejoins under the same peerId with a
    // brand-new RTCPeerConnection, so the stream has to be added again. Holding
    // them here would leave their screen tile permanently blank.
    publishedTo.delete(peerId)
    if (!stopped) onPeerSharingChange(peerId, false)
  })

  // Peers already active when this controller mounts (an HMR remount, or a
  // dependency change): our wrapper's onPeerJoin does not replay, so sweep.
  for (const peerId of Object.keys(room.getPeers())) announce(peerId)

  return {
    publish: (stream) => {
      if (stopped) return
      if (localStream === stream) return
      const previous = localStream
      localStream = stream
      publishedTo.clear()
      if (previous) removeStream(room, previous)
      // No untargeted announce here — publishTo sends a targeted one to every
      // peer that can act on it, and a peer who has not announced yet gets the
      // state when they do. Sending both would just duplicate the message.
      for (const peerId of announced) publishTo(peerId)
    },
    unpublish: () => {
      const stream = localStream
      localStream = null
      publishedTo.clear()
      if (stream) removeStream(room, stream)
      if (!stopped) announce()
    },
    classify: (peerId, stream, metadata) => {
      if (screenStreamIds.get(peerId) === stream.id) return 'screen'
      return isScreenStreamMetadata(metadata) ? 'screen' : 'camera'
    },
    teardown: () => {
      stopped = true
      offJoin()
      offLeave()
      if (localStream) removeStream(room, localStream)
      localStream = null
      publishedTo.clear()
      announced.clear()
      screenStreamIds.clear()
    },
  }
}

function removeStream(room: TopicRoom, stream: MediaStream): void {
  try {
    room.removeStream(stream)
  } catch {
    // best-effort: the connection may already be gone.
  }
}

// getDisplayMedia must run inside live transient user activation on every call
// in WKWebView / WebView2 (the same constraint V2-P9 hit for the AI loop), so
// this is called synchronously from the click handler — never after an await.
export function requestScreenShareStream(): Promise<MediaStream> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getDisplayMedia !== 'function'
  ) {
    return Promise.reject(
      new DOMException('getDisplayMedia is unavailable', 'NotSupportedError')
    )
  }
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { max: SCREEN_SHARE_MAX_FPS } },
    // System audio would echo against the live mic, and PTT already owns the
    // audio story. Video only.
    audio: false,
  })
}
