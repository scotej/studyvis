import { joinRoom } from 'trystero'
import type {
  ActionReceiver,
  ActionSender,
  DataPayload,
  JoinRoomCallbacks,
  Room,
} from '@trystero-p2p/core'

export const APP_ID = 'studyvis'

export type TopicConfig = {
  topic: string
  password: string
}

export type TopicAction<T extends DataPayload> = {
  send: ActionSender<T>
  receive: ActionReceiver<T>
}

export type TopicRoom = {
  makeAction: <T extends DataPayload>(namespace: string) => TopicAction<T>
  onPeerJoin: (fn: (peerId: string) => void) => void
  onPeerLeave: (fn: (peerId: string) => void) => void
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
    leave: () => room.leave(),
  }
}
