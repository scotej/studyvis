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

import { notifyFriendOnline } from './friendOnlineNotify'
import { subscribeToOwnInbox, type ValidInvite } from './inbox'
import { usePendingInvitesStore } from './pendingInvitesStore'
import { inviteRetryManager } from './invite'
import {
  isOnline,
  startPresence,
  type PresenceMap,
  type PresenceSubscription,
} from './presence'

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
  // N3 — friends whose presence has been resolved at least once since this
  // subscription mounted. The FIRST resolution establishes a baseline only —
  // it must not fire a "came online" notification (that's boot's initial
  // sweep, not a transition). Since #47 C6 the subscription survives friend
  // list edits, so baselines persist across them; a removed friend's entries
  // are pruned by the updateFriends effect below so a re-add starts fresh.
  const baselineSeenRef = useRef<Set<string>>(new Set())
  // #47 C6 — the live subscription handle, so the friend-set effect below can
  // diff rooms in place instead of tearing the whole subscription down.
  const presenceRef = useRef<PresenceSubscription | null>(null)

  useEffect(() => {
    const myEd = hexToBytes(myEdPubkeyHex)
    // Reset the per-friend notify state on a genuine (re)subscribe — identity
    // change or remount — so stale state can't leak a phantom transition.
    wasOnlineRef.current = {}
    baselineSeenRef.current = new Set()
    const presence = startPresence({
      myEdPubkey: myEd,
      // #47 C6 — the effect no longer keys on the friend set; seed with the
      // current list and let updateFriends churn only what changes.
      friends: useFriendsStore
        .getState()
        .friends.map((f) => ({ ed_pubkey_hex: f.ed_pubkey_hex })),
      onPresenceChange: (map) => {
        const at = Date.now()
        // Read the LIVE friend list per tick (#47 C6): the subscription now
        // outlives list edits, so a mount-time snapshot would miss friends
        // added since.
        for (const row of useFriendsStore.getState().friends) {
          const ed = row.ed_pubkey_hex
          const online = isOnline(map, ed, at)
          const was = wasOnlineRef.current[ed] ?? false
          wasOnlineRef.current[ed] = online
          // N3 — baseline is the first time we resolve a friend ONLINE since
          // this subscription mounted, NOT the first tick. The presence map
          // starts empty, so a sweep (or another friend's heartbeat) can fire
          // an offline tick for this friend before their first heartbeat lands;
          // consuming the baseline on that offline tick would make their genuine
          // first heartbeat look like an offline→online edge and ping
          // spuriously. Only an online resolution establishes the baseline, so
          // an already-online friend's first heartbeat is correctly treated as
          // baseline, not a transition.
          const hadBaseline = baselineSeenRef.current.has(ed)
          if (online) baselineSeenRef.current.add(ed)
          if (online && !was) {
            // Fire-and-forget; the manager dedupes and only retries entries
            // still inside the window.
            void inviteRetryManager.onPresenceOnline(ed)
            // N3 — only an offline→online edge AFTER the baseline is a real
            // "came online" transition. Suppressing the first online resolution
            // dodges boot's initial sweep (a friend already online at mount).
            // The debounce against flapping rides on the 60s ONLINE_WINDOW_MS:
            // once online, brief gaps stay "online" so we don't re-fire until
            // a true offline first.
            if (hadBaseline) {
              void notifyFriendOnline({
                edPubkeyHex: ed,
                displayName: row.display_name ?? null,
                enabled:
                  useSettingsStore.getState().values
                    .friendOnlineNotificationEnabled,
              })
            }
          }
        }
        onPresenceChange(map)
      },
    })
    presenceRef.current = presence
    // F7 — a hard quit (tray Quit, Cmd+Q, OS terminate) tears the webview down
    // without running React cleanup, so the goodbye in `leave()` never fires.
    // `pagehide` is the most reliable last-gasp the webview gives us; fire the
    // goodbye synchronously there so subscribed friends flip us offline at once.
    const onPageHide = () => presence.sendGoodbye()
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      presenceRef.current = null
      void presence.leave()
    }
  }, [myEdPubkeyHex, onPresenceChange])

  // #47 C6 (the recorded I49 pass) — a friend add/remove churns ONLY the
  // changed friend's room. The old effect keyed on the whole friend set, so
  // any list edit rebuilt the own room too, broadcasting a goodbye that
  // flickered our dot offline→online on every friend's screen — and since
  // N3's opt-in notification, could ping their desktops. leave()'s tested
  // goodbye semantics are untouched (the own room never churns here).
  useEffect(() => {
    const presence = presenceRef.current
    if (!presence) return
    const ids = friendsKey ? friendsKey.split('|') : []
    presence.updateFriends(ids.map((ed_pubkey_hex) => ({ ed_pubkey_hex })))
    // Prune notify state for removed friends so a re-add starts from a fresh
    // baseline instead of inheriting months-old transition state.
    const keep = new Set(ids)
    for (const ed of Object.keys(wasOnlineRef.current)) {
      if (!keep.has(ed)) delete wasOnlineRef.current[ed]
    }
    for (const ed of [...baselineSeenRef.current]) {
      if (!keep.has(ed)) baselineSeenRef.current.delete(ed)
    }
  }, [friendsKey])

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

  // #47 B1 — hold the invite on the persistent main-view surface for its
  // full 5-minute validity; the toast below is just the immediate nudge.
  usePendingInvitesStore.getState().add(invite)

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
