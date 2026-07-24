// N3 — "friend came online" OS notification.
//
// Fires on a debounced offline→online presence edge. This module owns the
// decision (`shouldNotifyFriendOnline`) plus the permission dance + copy,
// reusing the InboxBoot invite pattern; InboxBoot owns the per-friend state
// the decision reads. Opt-in, OFF by default, local read only. Honest about
// the ~60s presence latency in the settings copy — there's no faster signal
// than the heartbeat window.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

import { strings } from '@/strings'

// How long after we start watching a friend before their FIRST online
// resolution counts as a genuine arrival rather than boot-sweep noise. This is
// deliberately NOT the 60s presence-heartbeat window (ONLINE_WINDOW_MS): a
// friend who was online the whole time can take tens of seconds to resolve
// online here (their presence room's WebRTC handshake plus one heartbeat, worse
// on a congested relay or a cold launch), and reusing the 60s window let that
// slow resolve read as an arrival — the exact boot-sweep false positive the
// baseline exists to prevent. Sized well above realistic establishment latency
// so an already-online friend resolves inside it; the cost is only that a
// genuine arrival in the first few minutes after launch waits for the next edge.
export const NOTIFY_SETTLE_MS = 180_000

export type ShouldNotifyFriendOnlineArgs = {
  // This tick's resolved presence for the friend, and the previous tick's.
  online: boolean
  was: boolean
  // Whether this friend has already resolved ONLINE once since we started
  // watching them (see InboxBoot's baseline set).
  hadBaseline: boolean
  // When we started watching THIS friend: the presence subscribe for the seed
  // set, the add for anyone imported later. Undefined means we only just
  // started, so nothing has settled.
  watchStartedAt: number | undefined
  now: number
}

// The baseline suppression exists to swallow boot's initial sweep — a friend
// who was already online when we subscribed resolves ONLINE for the first
// time and must not read as an arrival. But "first ONLINE resolution" alone
// can't tell that apart from a friend who was genuinely offline at subscribe
// and walked in hours later, which is the single event this feature exists
// for (the app parks in the tray all day). So the suppression is bounded to
// one NOTIFY_SETTLE_MS per friend: inside their settle window we still need
// the baseline, past it a first arrival is a real arrival.
export function shouldNotifyFriendOnline({
  online,
  was,
  hadBaseline,
  watchStartedAt,
  now,
}: ShouldNotifyFriendOnlineArgs): boolean {
  if (!online || was) return false
  if (hadBaseline) return true
  return now - (watchStartedAt ?? now) >= NOTIFY_SETTLE_MS
}

export type NotifyFriendOnlineArgs = {
  edPubkeyHex: string
  // Friend's display name, or null when unpaired/blank — falls back to a
  // generic label so the body always reads sensibly.
  displayName: string | null
  // The settings gate, read at call-time by the caller.
  enabled: boolean
}

export async function notifyFriendOnline(
  args: NotifyFriendOnlineArgs
): Promise<void> {
  if (!args.enabled) return
  const name = args.displayName?.trim() || strings.friends.inbox.senderFallback
  try {
    let granted = await isPermissionGranted()
    if (!granted) {
      const result = await requestPermission()
      granted = result === 'granted'
    }
    if (granted)
      await sendNotification({
        title: strings.notifications.friendOnline.title,
        body: strings.notifications.friendOnline.body(name),
      })
  } catch {
    // Notification plugin is best-effort; a failure is silent.
  }
}
