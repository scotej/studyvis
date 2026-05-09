import {
  joinRoom,
  type ActionReceiver,
  type ActionSender,
  type DataPayload,
  type JoinRoomCallbacks,
  type JsonValue,
  type Room,
  type TargetPeers,
} from 'trystero'

export const APP_ID = 'studyvis'

export type TopicConfig = {
  topic: string
  password: string
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

export type TopicRoom = {
  makeAction: <T extends DataPayload>(namespace: string) => TopicAction<T>
  onPeerJoin: (fn: (peerId: string) => void) => void
  onPeerLeave: (fn: (peerId: string) => void) => void
  onPeerStream: (fn: PeerStreamHandler) => void
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

export const joinTopic: JoinTopicFn = ({ topic, password }, callbacks) => {
  const room: Room = joinRoom({ appId: APP_ID, password }, topic, callbacks)
  return wrapRoom(room)
}

function wrapRoom(room: Room): TopicRoom {
  return {
    makeAction<T extends DataPayload>(namespace: string): TopicAction<T> {
      const [send, receive] = room.makeAction<T>(namespace)
      return { send, receive }
    },
    onPeerJoin: (fn) => room.onPeerJoin(fn),
    onPeerLeave: (fn) => room.onPeerLeave(fn),
    onPeerStream: (fn) => room.onPeerStream(fn),
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
