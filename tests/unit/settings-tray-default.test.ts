import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  DEFAULT_SETTINGS,
  defaultMinimizeToTray,
  hydrateValuesFromStore,
  SETTINGS_KEY_MINIMIZE_TRAY,
  type Migrator,
  type StoreLike,
} from '@/stores/settingsStore'
import {
  detectChromePlatform,
  detectChromePlatformFromUA,
} from '@/lib/windowChrome'

// #263 — close-to-tray must never strand a Linux user with a hidden window
// and no tray icon. The default is platform-aware (OFF on Linux), an explicit
// stored value always wins, and a backend refusal to enable reverts the local
// toggle instead of leaving the UI lying about the active behavior.

function fakeStore(initial: Record<string, unknown> = {}): StoreLike & {
  __dump: Record<string, unknown>
} {
  const data: Record<string, unknown> = { ...initial }
  return {
    __dump: data,
    async get<T>(key: string) {
      const v = data[key]
      return (v === undefined ? undefined : (v as T)) as T | undefined
    },
    async set(key, value) {
      data[key] = value
    },
    async delete(key) {
      const had = key in data
      delete data[key]
      return had
    },
    async save() {},
  }
}

function makeMigrator(): Migrator {
  return {
    readLegacyTheme: vi.fn().mockReturnValue(null),
    clearLegacyTheme: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('defaultMinimizeToTray (#263)', () => {
  test('off for linux, on for mac and windows', () => {
    expect(defaultMinimizeToTray('linux')).toBe(false)
    expect(defaultMinimizeToTray('mac')).toBe(true)
    expect(defaultMinimizeToTray('windows')).toBe(true)
  })

  test('shipped DEFAULT_SETTINGS follows the host the bundle runs on', () => {
    // The constant is evaluated once at import time from navigator.userAgent;
    // whatever host that resolves to, the shipped default and the helper must
    // agree for it.
    expect(DEFAULT_SETTINGS.minimizeToTrayOnClose).toBe(
      defaultMinimizeToTray(detectChromePlatform())
    )
  })

  test('UA detection classifies the three platforms', () => {
    expect(
      detectChromePlatformFromUA(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
      )
    ).toBe('mac')
    expect(
      detectChromePlatformFromUA('Mozilla/5.0 X11; Linux x86_64; CachyOS')
    ).toBe('linux')
    expect(
      detectChromePlatformFromUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    ).toBe('windows')
  })
})

describe('hydration honors an explicit stored value over the platform default', () => {
  test('a stored true survives even on linux', async () => {
    const store = fakeStore({ [SETTINGS_KEY_MINIMIZE_TRAY]: true })
    const { values } = await hydrateValuesFromStore(store, makeMigrator())
    expect(values.minimizeToTrayOnClose).toBe(true)
  })

  test('a stored false survives even where the default is true', async () => {
    const store = fakeStore({ [SETTINGS_KEY_MINIMIZE_TRAY]: false })
    const { values } = await hydrateValuesFromStore(store, makeMigrator())
    expect(values.minimizeToTrayOnClose).toBe(false)
  })

  test('an absent value falls back to the platform-aware default', async () => {
    const store = fakeStore()
    const { values } = await hydrateValuesFromStore(store, makeMigrator())
    expect(values.minimizeToTrayOnClose).toBe(
      DEFAULT_SETTINGS.minimizeToTrayOnClose
    )
  })
})
