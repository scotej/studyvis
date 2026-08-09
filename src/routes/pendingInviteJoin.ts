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
      onPeerAuthenticated: (edPubkeyHex) => {
        // Shared session credentials can admit another invitee before the
        // sender. Keep this sender-specific retry credential until the
        // original inviter authenticates in the room.
        if (
          consumed ||
          edPubkeyHex.toLowerCase() !== invite.from_ed_pubkey.toLowerCase()
        )
          return
        consumed = true
        deps.removePendingInviteIfCurrent(identityEdPubkeyHex, key, invite)
      },
    }
  )
}
