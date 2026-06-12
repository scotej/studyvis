import { useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

import { hexToBytes } from '@/lib/crypto/identity'
import { boxDecryptWithKeyring } from '@/lib/db/identity'
import { getFriendXPubkey } from '@/lib/db/friends'
import { useFriendsStore } from '@/stores/friendsStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'

import { subscribeToOwnInbox, type ValidInvite } from './inbox'
import { inviteRetryManager } from './invite'
import { isOnline, startPresence, type PresenceMap } from './presence'

export type InboxBootProps = {
  myEdPubkeyHex: string
  onPresenceChange: (presence: PresenceMap) => void
  // V2-P9: InboxBoot keeps owning the always-on inbox/presence subscriptions
  // but no longer decides how a session starts. It forwards an accepted
  // invite to Home, which applies the AI-on topic gate before `joinSession`.
  onInviteAccepted: (invite: ValidInvite) => void
}

// Mounted once after identity is ready (see Home.tsx). On mount it joins the
// user's own inbox topic and the presence channels for every friend, and
// surfaces any valid invite as both an in-app toast and an OS notification.
// Acceptance for V1-P6: clicking the notification (or toast) just logs
// "would join session"; V1-P8 wires the real session-accept flow.
export function InboxBoot({
  myEdPubkeyHex,
  onPresenceChange,
  onInviteAccepted,
}: InboxBootProps) {
  // Ref so the inbox subscription effect (keyed on myEdPubkeyHex only) never
  // resubscribes just because Home re-rendered with a new callback identity.
  const onInviteAcceptedRef = useRef(onInviteAccepted)
  useEffect(() => {
    onInviteAcceptedRef.current = onInviteAccepted
  }, [onInviteAccepted])

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
        void handleValidInvite(invite, (i) => onInviteAcceptedRef.current(i))
      },
    })

    return () => {
      cancelled = true
      void inbox.leave()
    }
  }, [myEdPubkeyHex])

  // F6 — detect offline→online presence transitions so a queued invite can be
  // re-delivered the instant a friend comes online. The per-friend online state
  // is derived from the presence map (last-heartbeat within the online window),
  // compared against the previous tick. Kept in a ref so the detector survives
  // re-renders without resubscribing.
  const wasOnlineRef = useRef<Record<string, boolean>>({})

  useEffect(() => {
    const myEd = hexToBytes(myEdPubkeyHex)
    const friendIds = friendsKey
      ? friendsKey.split('|').map((ed_pubkey_hex) => ({ ed_pubkey_hex }))
      : []
    const presence = startPresence({
      myEdPubkey: myEd,
      friends: friendIds,
      onPresenceChange: (map) => {
        const at = Date.now()
        for (const friend of friendIds) {
          const ed = friend.ed_pubkey_hex
          const online = isOnline(map, ed, at)
          const was = wasOnlineRef.current[ed] ?? false
          wasOnlineRef.current[ed] = online
          if (online && !was) {
            // Fire-and-forget; the manager dedupes and only retries entries
            // still inside the window.
            void inviteRetryManager.onPresenceOnline(ed)
          }
        }
        onPresenceChange(map)
      },
    })
    // F7 — a hard quit (tray Quit, Cmd+Q, OS terminate) tears the webview down
    // without running React cleanup, so the goodbye in `leave()` never fires.
    // `pagehide` is the most reliable last-gasp the webview gives us; fire the
    // goodbye synchronously there so subscribed friends flip us offline at once.
    const onPageHide = () => presence.sendGoodbye()
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      void presence.leave()
    }
  }, [myEdPubkeyHex, friendsKey, onPresenceChange])

  // F6 — drop every queued retry when the local session ends (or the user
  // cancels by leaving): a friend coming online afterward shouldn't be pulled
  // into a session that's already over.
  useEffect(() => {
    let prev = useSessionStore.getState().status
    const unsub = useSessionStore.subscribe((state) => {
      const next = state.status
      if (prev === 'active' && next !== 'active') {
        inviteRetryManager.cancelAll()
      }
      prev = next
    })
    return () => unsub()
  }, [])

  return null
}

async function handleValidInvite(
  invite: ValidInvite,
  onAccept: (invite: ValidInvite) => void
) {
  const senderName =
    invite.payload.our_display_name?.trim() ||
    strings.friends.inbox.senderFallback
  const message = strings.friends.inbox.inviteBody(senderName)

  toast(message, {
    action: {
      label: strings.friends.inbox.acceptAction,
      onClick: () => onAccept(invite),
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
    if (granted)
      await sendNotification({
        title: strings.notifications.invite.title,
        body: message,
      })
  } catch {
    // Notification plugin is best-effort; the in-app toast is the
    // user-visible source of truth.
  }
}
