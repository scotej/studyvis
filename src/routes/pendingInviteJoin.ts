import type { ValidInvite } from '@/features/friends'

export type PendingInviteJoinDeps = {
  joinSession: (sessionTopic: string, sessionPassword: string) => unknown
  removePendingInvite: (key: string) => void
}

export function joinAndRemovePendingInvite(
  invite: ValidInvite,
  key: string,
  deps: PendingInviteJoinDeps
): void {
  deps.joinSession(
    invite.payload.session_topic,
    invite.payload.session_password
  )
  deps.removePendingInvite(key)
}
