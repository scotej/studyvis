import { describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  hydrateValuesFromStore,
  readManagedTurnIdentities,
  SETTINGS_KEY_MANAGED_TURN_IDENTITIES,
  type StoreLike,
} from '@/stores/settingsStore'

describe('backup relay consent migration', () => {
  test('existing settings keep relay enrollment off without a write or identity migration', async () => {
    const old = new Map<string, unknown>([
      ['theme', 'dark'],
      ['turn_preference', 'auto'],
    ])
    const store: StoreLike = {
      get: async <T>(key: string) => old.get(key) as T | undefined,
      set: vi.fn(),
      delete: vi.fn(),
      save: vi.fn(),
    }
    const result = await hydrateValuesFromStore(store, {
      readLegacyTheme: () => null,
      clearLegacyTheme: vi.fn(),
    })
    expect(result.values.managedTurnIdentities).toEqual([])
    expect(result.values.turnPreference).toBe('auto')
    expect(result.wroteMigration).toBe(false)
    expect(store.set).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
    expect(DEFAULT_SETTINGS.managedTurnIdentities).toEqual([])
  })
  test('consent remains scoped to exact public identities and rejects malformed persisted entries', async () => {
    const key = 'a'.repeat(64)
    expect(
      readManagedTurnIdentities([
        key,
        key,
        'b'.repeat(64),
        'A'.repeat(64),
        true,
        null,
        '__proto__',
      ])
    ).toEqual([key, 'b'.repeat(64)])
    expect(readManagedTurnIdentities(true)).toEqual([])
    expect(readManagedTurnIdentities({ [key]: true })).toEqual([])
    const store: StoreLike = {
      get: async <T>(name: string) =>
        (name === SETTINGS_KEY_MANAGED_TURN_IDENTITIES ? [key] : undefined) as
          T | undefined,
      set: vi.fn(),
      delete: vi.fn(),
      save: vi.fn(),
    }
    const result = await hydrateValuesFromStore(store, {
      readLegacyTheme: () => null,
      clearLegacyTheme: vi.fn(),
    })
    expect(result.values.managedTurnIdentities.includes('b'.repeat(64))).toBe(
      false
    )
    expect(result.values.managedTurnIdentities).toEqual([key])
  })
})
