import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  browserNotificationPermission,
  requestBrowserNotificationPermission,
  showBrowserNotification,
} from '@/features/mirror/browserNotifications'

const message = { title: 'New session message', body: 'Bob: Ready to study?' }

function platform(permission: NotificationPermission = 'granted') {
  const close = vi.fn()
  const notification = { close, onclick: null as (() => void) | null }
  const constructor = Object.assign(
    vi.fn(function () {
      return notification
    }),
    {
      permission,
      requestPermission: vi.fn(async () => permission),
    }
  )
  const focus = vi.fn()
  vi.stubGlobal('Notification', constructor)
  vi.stubGlobal('window', {
    isSecureContext: true,
    Notification: constructor,
    focus,
  })
  vi.stubGlobal('navigator', {})
  vi.stubGlobal('document', {
    visibilityState: 'hidden',
    hasFocus: () => false,
  })
  return { constructor, notification, close, focus }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('browser notification permission', () => {
  test('requests permission within the initiating click and preserves a dismissed prompt', async () => {
    const { constructor } = platform('default')
    const pending = requestBrowserNotificationPermission()
    expect(constructor.requestPermission).toHaveBeenCalledOnce()
    expect(await pending).toBe('default')
    expect(browserNotificationPermission()).toBe('default')
  })

  test.each(['granted', 'denied'] as const)(
    'does not prompt again for an existing %s decision',
    async (permission) => {
      const { constructor } = platform(permission)
      expect(await requestBrowserNotificationPermission()).toBe(permission)
      expect(constructor.requestPermission).not.toHaveBeenCalled()
    }
  )

  test('reports unsupported or insecure contexts without touching notifications', async () => {
    const { constructor } = platform()
    vi.stubGlobal('window', {
      isSecureContext: false,
      Notification: constructor,
    })
    expect(await requestBrowserNotificationPermission()).toBe('unavailable')
    expect(await showBrowserNotification(message)).toBe(false)
    vi.stubGlobal('window', { isSecureContext: true })
    expect(await requestBrowserNotificationPermission()).toBe('unavailable')
    expect(constructor).not.toHaveBeenCalled()
  })

  test('turns a platform permission error into unavailable status', async () => {
    const { constructor } = platform('default')
    constructor.requestPermission.mockRejectedValue(new Error('Not supported'))
    expect(await requestBrowserNotificationPermission()).toBe('unavailable')
  })
})

describe('browser notification delivery', () => {
  test('uses the active service worker on devices without a Notification constructor', async () => {
    const { constructor } = platform()
    constructor.mockImplementation(() => {
      throw new TypeError('Illegal constructor')
    })
    const registration = { active: {}, showNotification: vi.fn(async () => {}) }
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: vi.fn(async () => registration) },
    })
    expect(await showBrowserNotification(message)).toBe(true)
    expect(registration.showNotification).toHaveBeenCalledWith(message.title, {
      body: message.body,
    })
    expect(constructor).not.toHaveBeenCalled()
  })

  test('waits for first-install activation before displaying a notification', async () => {
    const { constructor } = platform()
    let activate!: (registration: unknown) => void
    const registration = {
      active: null,
      showNotification: vi.fn(async () => {}),
    }
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn(async () => registration),
        ready: new Promise((resolve) => {
          activate = resolve
        }),
      },
    })
    const pending = showBrowserNotification(message)
    await vi.advanceTimersByTimeAsync(10)
    expect(registration.showNotification).not.toHaveBeenCalled()
    activate({ ...registration, active: {} })
    expect(await pending).toBe(true)
    expect(registration.showNotification).toHaveBeenCalledOnce()
    expect(constructor).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a stalled worker installation has a bounded fallback to desktop notifications', async () => {
    const { constructor } = platform()
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn(async () => ({ active: null })),
        ready: new Promise(() => {}),
      },
    })
    const pending = showBrowserNotification(message)
    await vi.advanceTimersByTimeAsync(1999)
    expect(constructor).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBe(true)
    expect(constructor).toHaveBeenCalledOnce()
  })

  test.each(['lookup', 'display'])(
    'falls back when service worker %s fails and clicking focuses the companion',
    async (failure) => {
      const { constructor, notification, focus, close } = platform()
      vi.stubGlobal('navigator', {
        serviceWorker: {
          getRegistration: vi.fn(async () => {
            if (failure === 'lookup') throw new Error('Worker unavailable')
            return {
              active: {},
              showNotification: vi.fn(async () => {
                throw new Error('Worker display failed')
              }),
            }
          }),
        },
      })
      expect(await showBrowserNotification(message)).toBe(true)
      expect(constructor).toHaveBeenCalledWith(message.title, {
        body: message.body,
      })
      notification.onclick?.()
      expect(focus).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledOnce()
    }
  )

  test('reports failed display instead of claiming delivery succeeded', async () => {
    const { constructor } = platform()
    constructor.mockImplementation(() => {
      throw new TypeError('Illegal constructor')
    })
    expect(await showBrowserNotification(message)).toBe(false)
  })

  test('permission is never requested by an incoming notification', async () => {
    const { constructor } = platform('default')
    expect(await showBrowserNotification(message)).toBe(false)
    expect(constructor).not.toHaveBeenCalled()
    expect(constructor.requestPermission).not.toHaveBeenCalled()
  })

  test('suppresses background-only notifications while the companion is focused', async () => {
    const { constructor } = platform()
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      hasFocus: () => true,
    })
    expect(
      await showBrowserNotification({ ...message, onlyWhenHidden: true })
    ).toBe(false)
    expect(constructor).not.toHaveBeenCalled()
    expect(await showBrowserNotification(message)).toBe(true)
  })
})
