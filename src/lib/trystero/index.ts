import {
  joinRoom,
  selfId,
  type ActionReceiver,
  type ActionSender,
  type DataPayload,
  type JoinRoomCallbacks,
  type JsonValue,
  type Room,
  type TargetPeers,
  type TurnServerConfig,
} from 'trystero'

export const APP_ID = 'studyvis'

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
  { topic, password, turnConfig, rtcConfig },
  callbacks
) => {
  const room: Room = joinRoom(
    { appId: APP_ID, password, turnConfig, rtcConfig },
    topic,
    callbacks
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
