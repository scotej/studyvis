// Wrapper over trystero's joinRoom: every room in the app goes through
// `joinTopic`, which returns a `TopicRoom` that (a) fans out
// onPeerJoin/Leave/Stream to MULTIPLE subscribers — raw trystero rooms are
// last-listener-wins, so calling room.onPeerJoin directly silently clobbers
// every other subscriber — and (b) can race several discovery transports
// (Nostr + MQTT) on one topic and merge them, deduping peers by their shared
// peerId. Merged rooms are for short-lived pairing only; long-lived rooms
// (inbox, presence, session) stay single-strategy Nostr to avoid duplicate
// peer connections.

import {
  getRelaySockets as getMqttRelaySockets,
  joinRoom as joinRoomMqtt,
} from '@trystero-p2p/mqtt'
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

// Discovery transports trystero can rendezvous over. 'nostr' is the default
// (curated relay pin in ./relays); 'mqtt' uses @trystero-p2p/mqtt's public
// brokers and is raced alongside Nostr for pairing so a single failing layer
// (dead relays, blocked relay hostnames, or a clock-skewed peer) doesn't strand
// the pair. Both share one @trystero-p2p/core, hence one peerId per peer.
export type Strategy = 'nostr' | 'mqtt'

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

// PR-21 — the MQTT strategy's live broker-socket map. Pairing races Nostr + MQTT
// (see joinTopic/mergeRooms), so a "network down" verdict must consider BOTH
// transports: when every curated Nostr relay is blocked but MQTT connects,
// pairing still completes and the user must not be told their network is down.
// Empty when no MQTT room has ever been joined (e.g. during a Nostr-only invite).
export function getMqttRelaySocketMap(): RelaySocketMap {
  try {
    return (getMqttRelaySockets() as RelaySocketMap | undefined) ?? {}
  } catch {
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
  // Only consumed by the Nostr strategy — it is NOT forwarded to MQTT (those are
  // Nostr wss relays, not MQTT brokers).
  relayConfig?: { urls?: string[]; redundancy?: number }
  // Discovery transports to race. Defaults to ['nostr'] (the prior behavior).
  // Passing more than one opens one room per strategy on the SAME topic +
  // password and merges them, so rendezvous succeeds if ANY transport connects.
  // This is how pairing survives a dark/blocked Nostr relay set OR a clock-skewed
  // peer: trystero's Nostr strategy filters incoming announces on `since: now()`
  // over ephemeral (never-replayed) events, so a peer whose system clock is
  // behind is silently invisible forever — the MQTT strategy has no such
  // time filter and rides entirely separate infrastructure, so the two fail
  // independently. Every strategy shares the one @trystero-p2p/core instance, so
  // a peer keeps a single stable `selfId`/peerId across transports and the merge
  // dedups joins by peerId. See mergeRooms.
  strategies?: Strategy[]
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
  {
    topic,
    password,
    turnConfig,
    rtcConfig,
    relayConfig,
    onJoinError,
    strategies = ['nostr'],
  },
  callbacks
) => {
  // Merge the config-level onJoinError (the ergonomic call-site path) with any
  // explicit `callbacks` object (used by tests / advanced callers). The config
  // form wins when both are present; either alone works.
  const mergedCallbacks: JoinRoomCallbacks | undefined =
    onJoinError || callbacks
      ? { ...callbacks, ...(onJoinError ? { onJoinError } : {}) }
      : undefined

  const rooms = strategies.map((strategy): TopicRoom => {
    if (strategy === 'mqtt') {
      // MQTT rendezvouses over @trystero-p2p/mqtt's own broker list — the Nostr
      // `relayConfig` is deliberately NOT forwarded (wss Nostr relays are not
      // MQTT brokers). turnConfig/rtcConfig still apply: the WebRTC leg is the
      // same regardless of which strategy carried the signaling.
      const mqttRoom: Room = joinRoomMqtt(
        { appId: APP_ID, password, turnConfig, rtcConfig },
        topic,
        mergedCallbacks
      )
      return wrapRoom(mqttRoom)
    }
    const nostrRoom: Room = joinRoom(
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
    return wrapRoom(nostrRoom)
  })

  return rooms.length === 1 ? rooms[0] : mergeRooms(rooms)
}

// Fan a single TopicRoom API out over several underlying transport rooms (one
// per strategy) joined on the same topic/password. Discovery succeeds the moment
// ANY transport sees the peer. Because every strategy shares the one
// @trystero-p2p/core, a peer has the SAME peerId on each transport, so:
//   - onPeerJoin is deduped by peerId (first transport to see the peer wins; the
//     other transport's duplicate join for that peerId is swallowed),
//   - makeAction sends on every transport and receives from every transport.
// Intended for short-lived PAIRING rooms, where racing two transports and then
// leaving both is cheap and the duplicate datachannel (if both transports
// connect) is torn down on leave. Long-lived rooms (session mesh, presence) stay
// single-strategy to avoid duplicate peer connections — they pass no `strategies`
// and never reach this path.
function mergeRooms(rooms: TopicRoom[]): TopicRoom {
  const joinedPeers = new Set<string>()

  return {
    selfId: rooms[0].selfId,
    makeAction<T extends DataPayload>(namespace: string): TopicAction<T> {
      const actions = rooms.map((r) => r.makeAction<T>(namespace))
      const send = ((data, targetPeers, metadata, onProgress) =>
        Promise.all(
          actions.map((a) => a.send(data, targetPeers, metadata, onProgress))
        ).then((results) => results.flat())) as ActionSender<T>
      const receive = ((onData) => {
        for (const a of actions) a.receive(onData)
      }) as ActionReceiver<T>
      return { send, receive }
    },
    onPeerJoin: (fn) => {
      const unsubs = rooms.map((r) =>
        r.onPeerJoin((peerId) => {
          if (joinedPeers.has(peerId)) return
          joinedPeers.add(peerId)
          fn(peerId)
        })
      )
      return () => {
        for (const u of unsubs) u()
      }
    },
    onPeerLeave: (fn) => {
      const unsubs = rooms.map((r) =>
        r.onPeerLeave((peerId) => {
          joinedPeers.delete(peerId)
          fn(peerId)
        })
      )
      return () => {
        for (const u of unsubs) u()
      }
    },
    onPeerStream: (fn) => {
      const unsubs = rooms.map((r) => r.onPeerStream(fn))
      return () => {
        for (const u of unsubs) u()
      }
    },
    addStream: (stream, targetPeers, metadata) => {
      for (const r of rooms) r.addStream(stream, targetPeers, metadata)
    },
    removeStream: (stream, targetPeers) => {
      for (const r of rooms) r.removeStream(stream, targetPeers)
    },
    getPeers: () => Object.assign({}, ...rooms.map((r) => r.getPeers())),
    leave: () => Promise.all(rooms.map((r) => r.leave())).then(() => {}),
  }
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
