import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

import { strings } from '@/strings'

type InviteNotificationDeps = {
  isPermissionGranted: typeof isPermissionGranted
  requestPermission: typeof requestPermission
  sendNotification: typeof sendNotification
}

const defaultDeps: InviteNotificationDeps = {
  isPermissionGranted,
  requestPermission,
  sendNotification,
}

export type NotifyIncomingInviteArgs = {
  body: string
  enabled: boolean
}

export async function notifyIncomingInvite(
  args: NotifyIncomingInviteArgs,
  deps: InviteNotificationDeps = defaultDeps
): Promise<void> {
  if (!args.enabled) return

  try {
    let granted = await deps.isPermissionGranted()
    if (!granted) {
      const result = await deps.requestPermission()
      granted = result === 'granted'
    }
    if (granted) {
      await deps.sendNotification({
        title: strings.notifications.invite.title,
        body: args.body,
      })
    }
  } catch {
    // The persistent invite row and in-app toast remain the source of truth.
  }
}
