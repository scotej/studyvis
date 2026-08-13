import { expect, test } from 'vitest'

import {
  startScreenShareController,
  type ScreenSharePayload,
} from '@/features/session/screenShare'
import type { TopicRoom } from '@/lib/trystero'

test('a same-id replacement can reuse the active screen id before announcing', () => {
  let join: (peerId: string) => void = () => {}
  let receive: (payload: ScreenSharePayload, peerId: string) => void = () => {}

  const room = {
    selfId: 'self',
    makeAction: () => ({
      send: async () => [],
      receive: (
        handler: (payload: ScreenSharePayload, peerId: string) => void
      ) => {
        receive = handler
      },
    }),
    onPeerJoin: (handler: (peerId: string) => void) => {
      join = handler
      return () => {}
    },
    onPeerLeave: () => () => {},
    onPeerStream: () => () => {},
    addStream: () => {},
    removeStream: () => {},
    getPeers: () => ({}),
    leave: async () => {},
  } as unknown as TopicRoom

  const controller = startScreenShareController({
    room,
    onPeerSharingChange: () => {},
  })

  join('friend')
  receive({ sharing: true, stream_id: 'their-screen' }, 'friend')

  // Trystero's same-id replacement detaches the old room binding before it
  // emits this new join. A stream arriving now belongs to the replacement
  // transport and may precede its screen-share announce while retaining the
  // surviving sharer's original MediaStream.id.
  join('friend')

  expect(
    controller.classify(
      'friend',
      { id: 'their-screen' } as unknown as MediaStream,
      { kind: 'screen', stream_id: 'their-screen' }
    )
  ).toBe('screen')

  controller.teardown()
})
