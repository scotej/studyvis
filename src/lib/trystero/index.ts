import {
  getRelaySockets,
  joinRoom,
  selfId,
  type ActionReceiver,
  type ActionSender,
  type DataPayload,
  type JoinError,
  type JoinRoomCallbacks,
  type JsonValue,
  type Room,
  type TargetPeers,
  type TurnServerConfig,
} from 'trystero'

import { DEFAULT_RELAY_URLS } from './relays'

export const APP_ID = 'studyvis'

export type { JoinError }

// F1 — surface trystero's join-error stream to consumers. The underlying
// callback fires on a room-level failure (a peer's offer/answer fails to
// decrypt under the room password, or a peer handshake errors out) — distinct
// from "the relays are unreachable", which F2 reads from getRelaySockets. A
// thrown handler must never crash the room, so the wrapper wraps each fan-out
// call in a try/catch the same way onPeerJoinedTopic notifications are guarded.
export type JoinErrorHandler = (details: JoinError) => void

// F2 — live per-relay socket map for the connection-diagnostics panel. Keyed by
// relay URL; each value is the raw WebSocket whose `readyState` (0 CONNECTING,
// 1 OPEN, 2 CLOSING, 3 CLOSED) drives the per-relay dot. trystero types this as
// `any`; we narrow it to the shape the panel actually reads. Pure local read —
// no telemetry, no network call of our own.
export type RelaySocketMap = Record<string, { readyState: number; url: string }>

export function getRelaySocketMap(): RelaySocketMap {
  try {
    return (getRelaySockets() as RelaySocketMap | undefined) ?? {}
  } catch {
    // trystero throws if no room was ever joined; treat as "nothing connected".
    return {}
  }
}

// Trystero's `selfId` is a process-global string (one trystero instance per
// Tauri webview), so production `wrapRoom` exposes that module-global value
// as `room.selfId`. Consumers MUST read `room.selfId` (never import `selfId`
// directly): integration tests substitute their own mock room objects, each
// carrying a distinct per-peer `selfId`, so a simulated multi-peer session
// works without monkey-patching the trystero module.

export type TopicConfig = {
  topic: string
  password: string
  // Optional ICE config forwarded to the underlying RTCPeerConnection. When
  // absent, trystero uses its STUN-only defaults. Callers that want TURN (so a
  // connection survives strict NAT / firewalls) pass these — see
  // `buildIceOptions` in ./ice.
  turnConfig?: TurnServerConfig[]
  rtcConfig?: RTCConfiguration
  // Optional override for the Nostr signaling relays used for room rendezvous.
  // When absent, joinTopic pins DEFAULT_RELAY_URLS (see ./relays) so peers don't
  // depend on whichever relays trystero's appId-seeded shuffle happens to pick.
  // Passing `urls` makes trystero use that entire list (`redundancy` ignored).
  relayConfig?: { urls?: string[]; redundancy?: number }
  // F1 — fires on a trystero room-level join error (offer/answer decrypt
  // failure under the room password, or a peer handshake error). Forwarded to
  // trystero's `onJoinError` callback. Callers that omit it stay on the prior
  // behavior (errors are swallowed). Distinct from relay-down, which the
  // diagnostics panel reads from getRelaySocketMap.
  onJoinError?: JoinErrorHandler
}

export type TopicAction<T extends DataPayload> = {
  send: ActionSender<T>
  receive: ActionReceiver<T>
}

export type PeerStreamHandler = (
  stream: MediaStream,
  peerId: string,
  metadata?: JsonValue
) => void

export type Unsubscribe = () => void

// Trystero's underlying onPeerJoin / onPeerLeave / onPeerStream are last-wins:
// only the most recently registered callback fires (per Trystero README + our
// Context7 lookup). Multiple unrelated subscribers in this app (cap-evict,
// hello-targeted-resend, stream binding, etc.) used to silently overwrite
// each other. The wrapper fans out from a single underlying registration to
// any number of subscribers and returns an unsubscribe so a re-mounting
// effect can drop its registration on cleanup.
export type TopicRoom = {
  selfId: string
  makeAction: <T extends DataPayload>(namespace: string) => TopicAction<T>
  onPeerJoin: (fn: (peerId: string) => void) => Unsubscribe
  onPeerLeave: (fn: (peerId: string) => void) => Unsubscribe
  onPeerStream: (fn: PeerStreamHandler) => Unsubscribe
  addStream: (
    stream: MediaStream,
    targetPeers?: TargetPeers,
    metadata?: JsonValue
  ) => void
  removeStream: (stream: MediaStream, targetPeers?: TargetPeers) => void
  getPeers: () => Record<string, RTCPeerConnection>
  leave: () => Promise<void>
}

export type JoinTopicFn = (
  config: TopicConfig,
  callbacks?: JoinRoomCallbacks
) => TopicRoom

export const joinTopic: JoinTopicFn = (
  { topic, password, turnConfig, rtcConfig, relayConfig, onJoinError },
  callbacks
) => {
  // Merge the config-level onJoinError (the ergonomic call-site path) with any
  // explicit `callbacks` object (used by tests / advanced callers). The config
  // form wins when both are present; either alone works.
  const mergedCallbacks: JoinRoomCallbacks | undefined =
    onJoinError || callbacks
      ? { ...callbacks, ...(onJoinError ? { onJoinError } : {}) }
      : undefined
  const room: Room = joinRoom(
    {
      appId: APP_ID,
      password,
      turnConfig,
      rtcConfig,
      // Default-merge so the curated relay pin always applies when a caller
      // omits `urls`. A caller passing only `{ redundancy }` (no urls) would
      // otherwise short-circuit the pin and fall back to trystero's
      // appId-seeded shuffle of its bundled pool — see ARCHITECTURE.md
      // "Relay selection". An explicit `urls`/`redundancy` still wins.
      relayConfig: { urls: DEFAULT_RELAY_URLS, ...relayConfig },
    },
    topic,
    mergedCallbacks
  )
  return wrapRoom(room)
}

function wrapRoom(room: Room): TopicRoom {
  const joinSubs = new Set<(peerId: string) => void>()
  const leaveSubs = new Set<(peerId: string) => void>()
  const streamSubs = new Set<PeerStreamHandler>()

  room.onPeerJoin((peerId) => {
    for (const fn of joinSubs) fn(peerId)
  })
  room.onPeerLeave((peerId) => {
    for (const fn of leaveSubs) fn(peerId)
  })
  room.onPeerStream((stream, peerId, metadata) => {
    for (const fn of streamSubs) fn(stream, peerId, metadata)
  })

  return {
    selfId,
    makeAction<T extends DataPayload>(namespace: string): TopicAction<T> {
      const [send, receive] = room.makeAction<T>(namespace)
      return { send, receive }
    },
    onPeerJoin: (fn) => {
      joinSubs.add(fn)
      return () => {
        joinSubs.delete(fn)
      }
    },
    onPeerLeave: (fn) => {
      leaveSubs.add(fn)
      return () => {
        leaveSubs.delete(fn)
      }
    },
    onPeerStream: (fn) => {
      streamSubs.add(fn)
      return () => {
        streamSubs.delete(fn)
      }
    },
    addStream: (stream, targetPeers, metadata) => {
      room.addStream(stream, targetPeers, metadata)
    },
    removeStream: (stream, targetPeers) => {
      room.removeStream(stream, targetPeers)
    },
    getPeers: () => room.getPeers(),
    leave: () => room.leave(),
  }
}
