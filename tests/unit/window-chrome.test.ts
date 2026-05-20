import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { tokens } from '@/design/tokens'
import {
  detectChromePlatformFromUA,
  titleBarHeightPx,
  titleBarLeftInsetPx,
  windowControlOrder,
} from '@/lib/windowChrome'
import {
  __resetSettingsStoreDeps,
  __setSettingsStoreDeps,
  DEFAULT_SETTINGS,
  readWindowStyleBootCache,
  useSettingsStore,
  type SettingsStoreDeps,
} from '@/stores/settingsStore'

// V3-P6 — Pure-function tests for the opt-in custom-chrome helpers. The
// titlebar's visual rendering is inherently user-verifiable (it depends
// on the live Tauri window state, the OS overlay band, traffic-light
// positioning), so this file only covers the JS logic that decides
// platform shape + layout math.

describe('detectChromePlatformFromUA', () => {
  test.each([
    [
      'macOS Safari/WebKit (Tauri WKWebView)',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/618.0.0',
      'mac' as const,
    ],
    [
      'macOS Apple Silicon (Mac OS X token)',
      'Mozilla/5.0 (Macintosh; Mac OS X) AppleWebKit/618.0.0',
      'mac' as const,
    ],
    [
      'iPad Safari (iPad token)',
      'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) Safari/605.1.15',
      'mac' as const,
    ],
    [
      'Windows 11 WebView2',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0.0.0',
      'windows' as const,
    ],
    [
      "Ubuntu (Linux falls through to windows-shape — V3-P6 doesn't ship Linux)",
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'windows' as const,
    ],
    ['Empty UA', '', 'windows' as const],
  ])('%s → %s', (_label, ua, expected) => {
    expect(detectChromePlatformFromUA(ua)).toBe(expected)
  })
})

describe('windowControlOrder', () => {
  test('macOS hosts traffic lights system-side; the cluster is empty', () => {
    expect(windowControlOrder('mac')).toEqual([])
  })

  test('Windows shows min / maximize / close in platform-standard order', () => {
    expect(windowControlOrder('windows')).toEqual([
      'minimize',
      'maximize',
      'close',
    ])
  })

  test('returns a stable reference / order across calls (sanity)', () => {
    // The function is pure — calling it twice produces equal arrays even
    // if the references differ. Guards against an accidental in-place
    // mutation if the array is ever returned from a module-level const.
    const first = windowControlOrder('windows')
    const second = windowControlOrder('windows')
    expect(first).toEqual(second)
  })
})

describe('titleBarLeftInsetPx', () => {
  test('macOS reserves the traffic-light gutter token', () => {
    expect(titleBarLeftInsetPx('mac')).toBe(tokens.sizes.titleBarMacInset)
    // The advisor's geometry: 12px left margin + 3 × 14px lights + 2 × 8px
    // gaps + 12px calm gap before the wordmark = 78px.
    expect(tokens.sizes.titleBarMacInset).toBe(78)
  })

  test('Windows uses the calm space.4 left padding (no traffic lights)', () => {
    expect(titleBarLeftInsetPx('windows')).toBe(tokens.space[4])
    expect(tokens.space[4]).toBe(16)
  })
})

describe('titleBarHeightPx', () => {
  test('matches the design token', () => {
    expect(titleBarHeightPx()).toBe(tokens.sizes.titleBarHeight)
    expect(tokens.sizes.titleBarHeight).toBe(38)
  })
})

// Settings setter round-trip. Mirrors `tests/unit/v2p9-ai-toggle.test.ts`'s
// pattern: drive the real `useSettingsStore` setter against a fake store
// seam, observe persistence + side effects. The boot cache write goes
// through `writeWindowStyleBootCache` which guards on `typeof window`,
// so under vitest's node-env it no-ops silently — that's intentional
// (project convention: no jsdom / RTL harness). The path is exercised
// in the Storybook + live-app walks listed in the PR's manual test plan.
describe('useSettingsStore — windowStyle setter + relaunchApp bridge', () => {
  let saved: Record<string, unknown>
  let relaunchCalls: number
  let relaunchShouldFail: boolean
  let installedDeps: SettingsStoreDeps

  beforeEach(() => {
    saved = {}
    relaunchCalls = 0
    relaunchShouldFail = false
    installedDeps = {
      storeFactory: () => ({
        async get<T>(key: string) {
          const v = saved[key]
          return (v === undefined ? undefined : (v as T)) as T | undefined
        },
        async set(key: string, value: unknown) {
          saved[key] = value
        },
        async delete(key: string) {
          const had = key in saved
          delete saved[key]
          return had
        },
        async save() {},
      }),
      migrator: { readLegacyTheme: () => null, clearLegacyTheme: () => {} },
      runtime: {
        pushMinimizeToTray: async () => {},
        pushAiFeaturesEnabled: async () => {},
        setGlobalShortcut: async () => {},
        relaunchApp: async () => {
          relaunchCalls++
          if (relaunchShouldFail) throw new Error('restart refused')
        },
      },
    }
    __setSettingsStoreDeps(installedDeps)
    useSettingsStore.setState({
      status: 'ready',
      values: { ...DEFAULT_SETTINGS },
      error: null,
    })
  })

  afterEach(() => {
    __resetSettingsStoreDeps()
    useSettingsStore.setState({
      status: 'loading',
      values: { ...DEFAULT_SETTINGS },
      error: null,
    })
  })

  test('setWindowStyle("custom") persists under the window_style key', async () => {
    await useSettingsStore.getState().setWindowStyle('custom')
    expect(useSettingsStore.getState().values.windowStyle).toBe('custom')
    expect(saved['window_style']).toBe('custom')
  })

  test('toggling back to "system" overwrites the persisted value', async () => {
    await useSettingsStore.getState().setWindowStyle('custom')
    await useSettingsStore.getState().setWindowStyle('system')
    expect(useSettingsStore.getState().values.windowStyle).toBe('system')
    expect(saved['window_style']).toBe('system')
  })

  test('relaunchApp invokes the runtime bridge', async () => {
    await useSettingsStore.getState().relaunchApp()
    expect(relaunchCalls).toBe(1)
    expect(useSettingsStore.getState().error).toBeNull()
  })

  test('relaunchApp surfaces runtime failure via store.error', async () => {
    relaunchShouldFail = true
    await useSettingsStore.getState().relaunchApp()
    expect(useSettingsStore.getState().error).toBe('restart refused')
  })

  test('readWindowStyleBootCache defaults to system in node-env', () => {
    // No `window`, so the function takes the `typeof window === 'undefined'`
    // fallback. Mirrors the v1.0.3 default-on-first-launch state.
    expect(readWindowStyleBootCache()).toBe('system')
  })
})
