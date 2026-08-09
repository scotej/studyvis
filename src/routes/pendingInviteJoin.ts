import type { ValidInvite } from '@/features/friends'

export type PendingInviteJoinDeps = {
  // A room is only locally constructed when joinSession returns. The pending
  // invite is a retry credential, so it must survive until an admitted peer
  // has completed the signed session-hello protocol.
  joinSession: (
    sessionTopic: string,
    sessionPassword: string,
    options: {
      onPeerAuthenticated: (edPubkeyHex: string) => void
    }
  ) => unknown
  // This is conditional so a delayed room attempt cannot consume a replacement
  // invite (or a row that belongs to another identity after a switch).
  removePendingInviteIfCurrent: (
    identityEdPubkeyHex: string,
    key: string,
    invite: ValidInvite
  ) => void
}

export function joinAndRemovePendingInvite(
  invite: ValidInvite,
  key: string,
  identityEdPubkeyHex: string,
  deps: PendingInviteJoinDeps
): void {
  let consumed = false
  deps.joinSession(
    invite.payload.session_topic,
    invite.payload.session_password,
    {
      onPeerAuthenticated: () => {
        // Any authenticated, lifecycle-admitted peer proves the room
        // credential worked. Consume this attempt only once, and only if the
        // original identity still holds this exact signed invite revision.
        if (consumed) return
        consumed = true
        deps.removePendingInviteIfCurrent(identityEdPubkeyHex, key, invite)
      },
    }
  )
}
