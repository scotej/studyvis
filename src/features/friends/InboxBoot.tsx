import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

import { joinSession } from '@/features/session'
import { hexToBytes } from '@/lib/crypto/identity'
import { boxDecryptWithKeyring } from '@/lib/db/identity'
import { getFriendXPubkey } from '@/lib/db/friends'
import { useFriendsStore } from '@/stores/friendsStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'

import { subscribeToOwnInbox, type ValidInvite } from './inbox'
import { startPresence, type PresenceMap } from './presence'

export type InboxBootProps = {
  myEdPubkeyHex: string
  onPresenceChange: (presence: PresenceMap) => void
}

// Mounted once after identity is ready (see Home.tsx). On mount it joins the
// user's own inbox topic and the presence channels for every friend, and
// surfaces any valid invite as both an in-app toast and an OS notification.
// Acceptance for V1-P6: clicking the notification (or toast) just logs
// "would join session"; V1-P8 wires the real session-accept flow.
export function InboxBoot({ myEdPubkeyHex, onPresenceChange }: InboxBootProps) {
  const friends = useFriendsStore((s) => s.friends)
  // Stable key that only changes when the *identity-relevant* friend set
  // does — not on every store mutation (e.g. last_studied_with bump). The
  // presence effect resubscribes when this string changes; otherwise it
  // keeps the same trystero rooms open across re-renders.
  const friendsKey = useMemo(
    () =>
      friends
        .map((f) => f.ed_pubkey_hex)
        .sort()
        .join('|'),
    [friends]
  )

  useEffect(() => {
    let cancelled = false

    const myEd = hexToBytes(myEdPubkeyHex)

    const inbox = subscribeToOwnInbox({
      myEdPubkey: myEd,
      lookupFriendXPub: async (edPubkeyHex) => {
        const cached = useFriendsStore
          .getState()
          .friends.find((f) => f.ed_pubkey_hex === edPubkeyHex)
        if (cached) return cached.x_pubkey_hex
        return getFriendXPubkey(edPubkeyHex)
      },
      boxDecrypt: boxDecryptWithKeyring,
      onValidInvite: (invite) => {
        if (cancelled) return
        void handleValidInvite(invite)
      },
    })

    return () => {
      cancelled = true
      void inbox.leave()
    }
  }, [myEdPubkeyHex])

  useEffect(() => {
    const myEd = hexToBytes(myEdPubkeyHex)
    const friendIds = friendsKey
      ? friendsKey.split('|').map((ed_pubkey_hex) => ({ ed_pubkey_hex }))
      : []
    const presence = startPresence({
      myEdPubkey: myEd,
      friends: friendIds,
      onPresenceChange,
    })
    return () => {
      void presence.leave()
    }
  }, [myEdPubkeyHex, friendsKey, onPresenceChange])

  return null
}

async function handleValidInvite(invite: ValidInvite) {
  const senderName = invite.payload.our_display_name?.trim() || 'A friend'
  const message = `${senderName} invites you to study`

  toast(message, {
    action: {
      label: 'Accept',
      onClick: () => acceptInvite(invite),
    },
  })

  // Settings → Notifications gate (V1-P11). The in-app toast above always
  // fires; only the OS-level prompt is opt-out so a user who's silenced
  // notifications still sees the invite when the app is foreground.
  if (!useSettingsStore.getState().values.incomingInviteNotificationEnabled) {
    return
  }

  try {
    let granted = await isPermissionGranted()
    if (!granted) {
      const result = await requestPermission()
      granted = result === 'granted'
    }
    if (granted) await sendNotification({ title: 'StudyVis', body: message })
  } catch {
    // Notification plugin is best-effort; the in-app toast is the
    // user-visible source of truth.
  }
}

function acceptInvite(invite: ValidInvite) {
  // Joining while already in a session would tear down the existing one.
  // For V1, refuse — the user explicitly leaves first.
  if (useSessionStore.getState().status === 'active') {
    toast.error('Leave the current session before joining another.')
    return
  }
  try {
    joinSession(invite.payload.session_topic, invite.payload.session_password)
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Could not join the session.'
    toast.error(message)
  }
}
