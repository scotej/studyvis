// N3 — "friend came online" OS notification.
//
// Fires on a debounced offline→online presence edge (the debounce + the
// "skip the first resolution" guard live in InboxBoot; this module just owns
// the permission dance + copy, reusing the InboxBoot invite pattern). Opt-in,
// OFF by default, local read only. Honest about the ~60s presence latency in
// the settings copy — there's no faster signal than the heartbeat window.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

import { strings } from '@/strings'

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
