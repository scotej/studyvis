import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'

import {
  AddFriendDialog,
  FriendsList,
  InboxBoot,
  inviteFriend,
  type PresenceMap,
} from '@/features/friends'
import { IdentitySetupGate, useIdentity } from '@/features/identity'
import { DebugSystemPanel } from '@/features/system'
import { bytesToHex } from '@/lib/crypto/identity'
import { sessionTopic } from '@/lib/crypto/topics'
import type { Friend } from '@/lib/db/friends'
import { boxEncryptWithKeyring } from '@/lib/db/identity'
import { useFriendsStore } from '@/stores/friendsStore'

const isDev = import.meta.env.DEV

export function Home() {
  const { identity, status, actions } = useIdentity()
  const friendsStatus = useFriendsStore((s) => s.status)
  const loadFriends = useFriendsStore((s) => s.load)
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
      // Placeholder session topic + password until V1-P8 generates the real
      // ones from a host-side session_id. The receive path treats both as
      // opaque strings, so this stays consistent end-to-end.
      const sessionId = new Uint8Array(32)
      crypto.getRandomValues(sessionId)
      const sessionPwBytes = new Uint8Array(32)
      crypto.getRandomValues(sessionPwBytes)
      try {
        await inviteFriend(
          {
            edPubkeyHex: identity.ed_pubkey_hex,
            displayName: identity.display_name,
            sign: actions.signWithKeyring,
            encryptTo: boxEncryptWithKeyring,
          },
          {
            edPubkeyHex: friend.ed_pubkey_hex,
            xPubkeyHex: friend.x_pubkey_hex,
          },
          {
            sessionTopic: sessionTopic(sessionId),
            sessionPassword: bytesToHex(sessionPwBytes),
          }
        )
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
