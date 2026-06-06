import {
  inviteFriend,
  type InviteOptions,
  type InviteSender,
} from '@/features/friends/invite'
import type { Friend } from '@/lib/db/friends'
import { useSessionStore } from '@/stores/sessionStore'

import { hostSession } from './host'

export type InviteToSessionArgs = {
  friend: Friend
  sender: InviteSender
  options?: InviteOptions
}

// Developer-facing message; user-facing copy is strings.friends.inviteWhileGuest,
// mapped by type at the call site (Home.tsx).
export class InviteWhileGuestError extends Error {
  constructor() {
    super('cannot invite while a guest')
    this.name = 'InviteWhileGuestError'
  }
}

// Sends an invite to `friend` for the *currently active* session. If no
// session is active, transparently bootstraps one as host (V1-P8 deviation
// from the V1-P6 placeholder, where Home.tsx generated a fresh session_id
// per click — see InboxBoot for the receive side). If the user is already a
// guest in someone else's session, throws — guests can't add others.
export async function inviteToCurrentSession({
  friend,
  sender,
  options,
}: InviteToSessionArgs): Promise<void> {
  let topic: string
  let password: string
  const state = useSessionStore.getState()
  if (state.status === 'active') {
    if (!state.isHost || !state.sessionTopic || !state.sessionPassword) {
      throw new InviteWhileGuestError()
    }
    topic = state.sessionTopic
    password = state.sessionPassword
  } else {
    const hosted = hostSession()
    topic = hosted.sessionTopic
    password = hosted.sessionPassword
  }
  await inviteFriend(
    sender,
    {
      edPubkeyHex: friend.ed_pubkey_hex,
      xPubkeyHex: friend.x_pubkey_hex,
    },
    { sessionTopic: topic, sessionPassword: password },
    options
  )
}
