import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  hydrateValuesFromStore,
  type Migrator,
  type StoreLike,
} from '@/stores/settingsStore'

// Each test mocks an in-memory store + migrator so the V1-P11 one-shot
// migration of `localStorage["studyvis.theme"]` into the LazyStore can be
// exercised without a Tauri runtime. Logic-only — the React store wrapping
// this is straightforward state plumbing.

function fakeStore(initial: Record<string, unknown> = {}): StoreLike & {
  __dump: Record<string, unknown>
  __saveCount: number
} {
  const data: Record<string, unknown> = { ...initial }
  let saveCount = 0
  return {
    __dump: data,
    get __saveCount() {
      return saveCount
    },
    set __saveCount(value) {
      saveCount = value
    },
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
    async save() {
      saveCount += 1
    },
  }
}

function makeMigrator(
  legacyValue: 'dark' | 'light' | 'auto' | null
): Migrator & {
  __cleared: boolean
} {
  let cleared = false
  return {
    readLegacyTheme: vi.fn().mockReturnValue(legacyValue),
    clearLegacyTheme: vi.fn().mockImplementation(() => {
      cleared = true
    }),
    get __cleared() {
      return cleared
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('hydrateValuesFromStore — V1-P11 settings migration', () => {
  test('uses store theme when present and ignores any legacy value', async () => {
    const store = fakeStore({ theme: 'light' })
    const migrator = makeMigrator('dark') // legacy disagrees with store
    const { values, wroteMigration } = await hydrateValuesFromStore(
      store,
      migrator
    )
    expect(values.theme).toBe('light')
    expect(wroteMigration).toBe(false)
    expect(migrator.readLegacyTheme).not.toHaveBeenCalled()
    expect(migrator.clearLegacyTheme).not.toHaveBeenCalled()
  })

  test('folds the localStorage theme into the store and leaves the cache intact', async () => {
    // V3-P5: localStorage now doubles as the pre-paint boot cache the inline
    // script in index.html reads to avoid a FOUC of the dark canvas. The
    // migration copies the value into the Tauri store but no longer clears
    // localStorage — the cache must survive the round trip.
    const store = fakeStore({})
    const migrator = makeMigrator('auto')
    const { values, wroteMigration } = await hydrateValuesFromStore(
      store,
      migrator
    )
    expect(values.theme).toBe('auto')
    expect(wroteMigration).toBe(true)
    expect(store.__dump.theme).toBe('auto')
    expect(store.__saveCount).toBeGreaterThan(0)
    expect(migrator.readLegacyTheme).toHaveBeenCalledTimes(1)
    expect(migrator.clearLegacyTheme).not.toHaveBeenCalled()
    expect(migrator.__cleared).toBe(false)
  })

  test('falls back to default theme when neither store nor legacy has a value', async () => {
    const store = fakeStore({})
    const migrator = makeMigrator(null)
    const { values, wroteMigration } = await hydrateValuesFromStore(
      store,
      migrator
    )
    expect(values.theme).toBe('dark')
    expect(wroteMigration).toBe(false)
    expect(store.__dump.theme).toBeUndefined()
    expect(migrator.readLegacyTheme).toHaveBeenCalledTimes(1)
    expect(migrator.clearLegacyTheme).not.toHaveBeenCalled()
  })

  test('rejects an invalid theme value in the store and falls through to legacy', async () => {
    const store = fakeStore({ theme: 'sepia' })
    const migrator = makeMigrator('light')
    const { values } = await hydrateValuesFromStore(store, migrator)
    expect(values.theme).toBe('light')
  })

  test('reads boolean toggles with sensible defaults when missing', async () => {
    const store = fakeStore({})
    const migrator = makeMigrator(null)
    const { values } = await hydrateValuesFromStore(store, migrator)
    expect(values.reduceMotion).toBe(false)
    expect(values.incomingInviteNotificationEnabled).toBe(true)
    expect(values.minimizeToTrayOnClose).toBe(true)
    expect(values.debugLogEnabled).toBe(false)
    expect(values.turnPreference).toBe('auto')
  })

  test('preserves boolean toggles set by the user', async () => {
    const store = fakeStore({
      reduce_motion: true,
      incoming_invite_notification_enabled: false,
      minimize_to_tray_on_close: false,
      debug_log_enabled: true,
      turn_preference: 'always',
    })
    const migrator = makeMigrator(null)
    const { values } = await hydrateValuesFromStore(store, migrator)
    expect(values.reduceMotion).toBe(true)
    expect(values.incomingInviteNotificationEnabled).toBe(false)
    expect(values.minimizeToTrayOnClose).toBe(false)
    expect(values.debugLogEnabled).toBe(true)
    expect(values.turnPreference).toBe('always')
  })

  test('rejects an invalid turn_preference value', async () => {
    const store = fakeStore({ turn_preference: 'sometimes' })
    const migrator = makeMigrator(null)
    const { values } = await hydrateValuesFromStore(store, migrator)
    expect(values.turnPreference).toBe('auto')
  })

  // V3-P6 — windowStyle hydrates from `window_style`. Default 'system'
  // matches the v1.0.3 shipped behavior, so a fresh install or any
  // missing/invalid value lands on system chrome (the toggle has to be
  // an active user choice).
  test('defaults windowStyle to "system" when missing', async () => {
    const store = fakeStore({})
    const migrator = makeMigrator(null)
    const { values } = await hydrateValuesFromStore(store, migrator)
    expect(values.windowStyle).toBe('system')
  })

  test('reads windowStyle "custom" when persisted', async () => {
    const store = fakeStore({ window_style: 'custom' })
    const migrator = makeMigrator(null)
    const { values } = await hydrateValuesFromStore(store, migrator)
    expect(values.windowStyle).toBe('custom')
  })

  test('reads windowStyle "system" when persisted', async () => {
    const store = fakeStore({ window_style: 'system' })
    const migrator = makeMigrator(null)
    const { values } = await hydrateValuesFromStore(store, migrator)
    expect(values.windowStyle).toBe('system')
  })

  test('rejects invalid windowStyle values', async () => {
    const store = fakeStore({ window_style: 'native' })
    const migrator = makeMigrator(null)
    const { values } = await hydrateValuesFromStore(store, migrator)
    expect(values.windowStyle).toBe('system')
  })

  // A3 — offTaskConfidenceFloor round-trips through `off_task_confidence_floor`.
  // Default 0.6 (mirrors scoreMachine.DEFAULT_CONFIDENCE_FLOOR) when missing;
  // a persisted finite number is read back verbatim (including 0, which is the
  // "gate disabled" sentinel — readNumber keeps it because 0 is finite).
  test('defaults offTaskConfidenceFloor to 0.6 when missing', async () => {
    const store = fakeStore({})
    const migrator = makeMigrator(null)
    const { values } = await hydrateValuesFromStore(store, migrator)
    expect(values.offTaskConfidenceFloor).toBe(0.6)
  })

  test('reads a persisted offTaskConfidenceFloor verbatim', async () => {
    const store = fakeStore({ off_task_confidence_floor: 0.8 })
    const migrator = makeMigrator(null)
    const { values } = await hydrateValuesFromStore(store, migrator)
    expect(values.offTaskConfidenceFloor).toBe(0.8)
  })

  test('preserves a persisted offTaskConfidenceFloor of 0', async () => {
    const store = fakeStore({ off_task_confidence_floor: 0 })
    const migrator = makeMigrator(null)
    const { values } = await hydrateValuesFromStore(store, migrator)
    expect(values.offTaskConfidenceFloor).toBe(0)
  })

  test('falls back to the default when offTaskConfidenceFloor is non-numeric', async () => {
    const store = fakeStore({ off_task_confidence_floor: 'high' })
    const migrator = makeMigrator(null)
    const { values } = await hydrateValuesFromStore(store, migrator)
    expect(values.offTaskConfidenceFloor).toBe(0.6)
  })
})

// #47 B4 — audio device + per-friend volume persistence.
describe('hydrateValuesFromStore — audio preferences (#47 B4)', () => {
  test('defaults: null devices, empty volume map', async () => {
    const { values } = await hydrateValuesFromStore(
      fakeStore(),
      makeMigrator(null)
    )
    expect(values.audioInputDeviceId).toBeNull()
    expect(values.audioOutputDeviceId).toBeNull()
    expect(values.peerVolumes).toEqual({})
  })

  test('round-trips stored device ids and volumes', async () => {
    const { values } = await hydrateValuesFromStore(
      fakeStore({
        audio_input_device_id: 'mic-usb',
        audio_output_device_id: 'headset-1',
        peer_volumes: { abc: 0.4 },
      }),
      makeMigrator(null)
    )
    expect(values.audioInputDeviceId).toBe('mic-usb')
    expect(values.audioOutputDeviceId).toBe('headset-1')
    expect(values.peerVolumes).toEqual({ abc: 0.4 })
  })

  test('rejects garbage device ids and clamps/strips volumes', async () => {
    const { values } = await hydrateValuesFromStore(
      fakeStore({
        audio_input_device_id: 42,
        audio_output_device_id: '',
        peer_volumes: { a: 2, b: -1, c: 'loud', d: 0.7 },
      }),
      makeMigrator(null)
    )
    expect(values.audioInputDeviceId).toBeNull()
    expect(values.audioOutputDeviceId).toBeNull()
    expect(values.peerVolumes).toEqual({ a: 1, b: 0, d: 0.7 })
  })
})
