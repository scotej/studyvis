import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  nextWindowLayout,
  windowLayoutsEqual,
  type WindowSnapshot,
} from '@/features/system/windowLayout'
import {
  DEFAULT_SETTINGS,
  isWindowLayout,
  useSettingsStore,
  __resetSettingsStoreDeps,
  __setSettingsStoreDeps,
  type SettingsStoreDeps,
  type WindowLayout,
} from '@/stores/settingsStore'

// The capture policy is pure so vitest's node-env can drive it without a
// Tauri runtime (project convention: no jsdom / RTL harness). The live
// event wiring in WindowLayoutListener is walked in the manual test plan.

const FLOATING: WindowLayout = {
  width: 1280,
  height: 800,
  x: 120,
  y: 60,
  scaleFactor: 1,
  maximized: false,
}

function snap(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    width: 1440,
    height: 900,
    x: 200,
    y: 100,
    scaleFactor: 1,
    maximized: false,
    minimized: false,
    ...overrides,
  }
}

describe('nextWindowLayout', () => {
  test('records floating geometry', () => {
    expect(nextWindowLayout(null, snap())).toEqual({
      width: 1440,
      height: 900,
      x: 200,
      y: 100,
      scaleFactor: 1,
      maximized: false,
    })
  })

  test('skips while minimized — placeholder geometry must never persist', () => {
    expect(nextWindowLayout(FLOATING, snap({ minimized: true }))).toBeNull()
    expect(
      nextWindowLayout(FLOATING, snap({ minimized: true, maximized: true }))
    ).toBeNull()
  })

  test('maximized flips only the flag, preserving the floating rect', () => {
    expect(
      nextWindowLayout(FLOATING, snap({ maximized: true, width: 2560 }))
    ).toEqual({ ...FLOATING, maximized: true })
  })

  test('maximized with no prior floating rect records nothing', () => {
    expect(nextWindowLayout(null, snap({ maximized: true }))).toBeNull()
  })

  test('unmaximizing back to a tracked rect records the floating state', () => {
    const maximized = { ...FLOATING, maximized: true }
    expect(
      nextWindowLayout(
        maximized,
        snap({
          width: FLOATING.width,
          height: FLOATING.height,
          x: FLOATING.x,
          y: FLOATING.y,
        })
      )
    ).toEqual(FLOATING)
  })

  test('returns null for an unchanged snapshot — no redundant disk write', () => {
    expect(
      nextWindowLayout(
        FLOATING,
        snap({
          width: FLOATING.width,
          height: FLOATING.height,
          x: FLOATING.x,
          y: FLOATING.y,
        })
      )
    ).toBeNull()
  })
})

describe('windowLayoutsEqual', () => {
  test('compares every field', () => {
    expect(windowLayoutsEqual(FLOATING, { ...FLOATING })).toBe(true)
    for (const change of [
      { width: 1 },
      { height: 1 },
      { x: 1 },
      { y: 1 },
      { scaleFactor: 2 },
      { maximized: true },
    ]) {
      expect(windowLayoutsEqual(FLOATING, { ...FLOATING, ...change })).toBe(
        false
      )
    }
  })
})

describe('isWindowLayout', () => {
  test('accepts a complete layout, negative positions included', () => {
    expect(isWindowLayout(FLOATING)).toBe(true)
    expect(isWindowLayout({ ...FLOATING, x: -1920, y: -200 })).toBe(true)
  })

  test('rejects malformed values', () => {
    for (const bad of [
      null,
      'layout',
      {},
      { ...FLOATING, width: 0 },
      { ...FLOATING, height: Number.NaN },
      { ...FLOATING, x: '10' },
      { ...FLOATING, scaleFactor: 0 },
      { ...FLOATING, maximized: 'yes' },
    ]) {
      expect(isWindowLayout(bad)).toBe(false)
    }
  })
})

// Setter round-trips against the fake store seam — the same harness as
// `window-chrome.test.ts`'s windowStyle coverage.
describe('useSettingsStore — window layout setters', () => {
  let saved: Record<string, unknown>

  beforeEach(() => {
    saved = {}
    const deps: SettingsStoreDeps = {
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
        relaunchApp: async () => {},
      },
    }
    __setSettingsStoreDeps(deps)
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

  test('setRememberWindowLayout(false) persists under remember_window_layout', async () => {
    await useSettingsStore.getState().setRememberWindowLayout(false)
    expect(useSettingsStore.getState().values.rememberWindowLayout).toBe(false)
    expect(saved['remember_window_layout']).toBe(false)
  })

  test('saveWindowLayout persists the geometry under window_layout', async () => {
    await useSettingsStore.getState().saveWindowLayout(FLOATING)
    expect(useSettingsStore.getState().values.windowLayout).toEqual(FLOATING)
    expect(saved['window_layout']).toEqual(FLOATING)
  })

  test('clearWindowLayout persists null', async () => {
    await useSettingsStore.getState().saveWindowLayout(FLOATING)
    await useSettingsStore.getState().clearWindowLayout()
    expect(useSettingsStore.getState().values.windowLayout).toBeNull()
    expect(saved['window_layout']).toBeNull()
  })
})
