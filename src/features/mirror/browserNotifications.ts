import type { MirrorNotification } from './wire'

export type BrowserNotificationPermission =
  NotificationPermission | 'unavailable'

export function browserNotificationPermission(): BrowserNotificationPermission {
  return window.isSecureContext && 'Notification' in window
    ? Notification.permission
    : 'unavailable'
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  const permission = browserNotificationPermission()
  if (permission !== 'default') return permission
  try {
    // Call before any await so Safari retains the button's user activation.
    return await Notification.requestPermission()
  } catch {
    return 'unavailable'
  }
}

async function notificationRegistration(): Promise<ServiceWorkerRegistration | null> {
  const workers = navigator.serviceWorker
  if (!workers) return null
  const registration = await workers.getRegistration()
  if (!registration) return null
  if (registration.active) return registration
  // The first session can receive an event while the offline worker installs.
  // A failed installation must not leave notification delivery waiting forever.
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      workers.ready,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), 2000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

export async function showBrowserNotification(
  message: MirrorNotification
): Promise<boolean> {
  if (browserNotificationPermission() !== 'granted') return false
  if (
    message.onlyWhenHidden &&
    document.visibilityState === 'visible' &&
    document.hasFocus()
  )
    return false

  try {
    const registration = await notificationRegistration()
    if (registration) {
      await registration.showNotification(message.title, { body: message.body })
      return true
    }
  } catch {
    // Desktop notifications can still work if offline worker setup failed.
  }
  try {
    const notification = new Notification(message.title, { body: message.body })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
    return true
  } catch {
    // Mobile browsers require an active worker instead of the constructor.
    return false
  }
}
