import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'

import {
  AddFriendDialog,
  FriendsList,
  InboxBoot,
  type PresenceMap,
} from '@/features/friends'
import { IdentitySetupGate, useIdentity } from '@/features/identity'
import { inviteToCurrentSession, SessionView } from '@/features/session'
import { DebugSystemPanel } from '@/features/system'
import type { Friend } from '@/lib/db/friends'
import { boxEncryptWithKeyring } from '@/lib/db/identity'
import { useFriendsStore } from '@/stores/friendsStore'
import { useSessionStore } from '@/stores/sessionStore'

const isDev = import.meta.env.DEV

export function Home() {
  const { identity, status, actions } = useIdentity()
  const friendsStatus = useFriendsStore((s) => s.status)
  const loadFriends = useFriendsStore((s) => s.load)
  const sessionStatus = useSessionStore((s) => s.status)
  const [addOpen, setAddOpen] = useState(false)
  const [presence, setPresence] = useState<PresenceMap>({})

  useEffect(() => {
    if (status === 'ready' && friendsStatus === 'idle') {
      void loadFriends()
    }
  }, [status, friendsStatus, loadFriends])

  const handleInvite = useCallback(
    async (friend: Friend) => {
      if (!identity) return
      try {
        await inviteToCurrentSession({
          friend,
          sender: {
            edPubkeyHex: identity.ed_pubkey_hex,
            displayName: identity.display_name,
            sign: actions.signWithKeyring,
            encryptTo: boxEncryptWithKeyring,
          },
        })
        toast.success(
          `Invite sent to ${friend.display_name?.trim() || 'your friend'}.`
        )
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Could not send invite.'
        toast.error(message)
      }
    },
    [identity, actions.signWithKeyring]
  )

  if (status === 'loading') {
    return (
      <main
        className="flex min-h-screen items-center justify-center bg-bg-base text-text-secondary"
        aria-busy="true"
      />
    )
  }

  if (status === 'absent') {
    return <IdentitySetupGate create={actions.create} />
  }

  if (sessionStatus === 'active') {
    return (
      <>
        <SessionView />
        {identity ? (
          <InboxBoot
            myEdPubkeyHex={identity.ed_pubkey_hex}
            onPresenceChange={setPresence}
          />
        ) : null}
      </>
    )
  }

  return (
    <main className="min-h-screen bg-bg-base text-text-primary">
      <FriendsList
        presence={presence}
        onAddFriend={() => setAddOpen(true)}
        onInvite={(friend) => void handleInvite(friend)}
      />
      <div className="px-6 pb-8">
        <DebugSystemPanel />
      </div>
      <AddFriendDialog open={addOpen} onOpenChange={setAddOpen} />
      {identity ? (
        <InboxBoot
          myEdPubkeyHex={identity.ed_pubkey_hex}
          onPresenceChange={setPresence}
        />
      ) : null}
      {isDev ? (
        <div className="px-6 pb-8 text-center">
          <Link to="/style" className="text-sm text-text-secondary underline">
            /style
          </Link>
        </div>
      ) : null}
    </main>
  )
}
