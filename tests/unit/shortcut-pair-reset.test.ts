import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  __resetSettingsStoreDeps,
  __setSettingsStoreDeps,
  DEFAULT_SETTINGS,
  SETTINGS_KEY_MIC_TOGGLE_ACCELERATOR,
  SETTINGS_KEY_PTT_AI_ACCELERATOR,
  SETTINGS_KEY_PTT_FRIENDS_ACCELERATOR,
  useSettingsStore,
  type SettingsStoreDeps,
} from '@/stores/settingsStore'
import {
  MIC_TOGGLE_DEFAULT_ACCELERATOR,
  PTT_AI_DEFAULT_ACCELERATOR,
  PTT_FRIENDS_DEFAULT_ACCELERATOR,
} from '@/lib/keybindings'

const keys = [
  SETTINGS_KEY_PTT_FRIENDS_ACCELERATOR,
  SETTINGS_KEY_PTT_AI_ACCELERATOR,
  SETTINGS_KEY_MIC_TOGGLE_ACCELERATOR,
] as const
const previous = [
  PTT_AI_DEFAULT_ACCELERATOR,
  PTT_FRIENDS_DEFAULT_ACCELERATOR,
  MIC_TOGGLE_DEFAULT_ACCELERATOR,
] as const
const defaults = [
  PTT_FRIENDS_DEFAULT_ACCELERATOR,
  PTT_AI_DEFAULT_ACCELERATOR,
  MIC_TOGGLE_DEFAULT_ACCELERATOR,
] as const

function install(
  failure?: 'friends-set' | 'ai-set' | 'mic-set' | 'save' | 'runtime'
) {
  let live: readonly string[] = previous
  let durable: Record<string, unknown> = {
    [keys[0]]: previous[0],
    [keys[1]]: previous[1],
    [keys[2]]: previous[2],
  }
  const cache = { ...durable }
  const saved: Record<string, unknown>[] = []
  let fail = failure
  const runtime = vi.fn(
    async (friends: string, ai: string, micToggle: string) => {
      if (fail === 'runtime') {
        fail = undefined
        throw new Error('Native registration refused')
      }
      live = [friends, ai, micToggle]
    }
  )
  const save = vi.fn(async () => {
    if (fail === 'save') {
      fail = undefined
      throw new Error('Persistence refused')
    }
    durable = { ...cache }
    saved.push({ ...durable })
  })
  const deps: SettingsStoreDeps = {
    storeFactory: () => ({
      get: async <T>(key: string) => cache[key] as T | undefined,
      set: async (key, value) => {
        if (
          (fail === 'friends-set' && key === keys[0]) ||
          (fail === 'ai-set' && key === keys[1]) ||
          (fail === 'mic-set' && key === keys[2])
        ) {
          fail = undefined
          throw new Error('Persistence refused')
        }
        cache[key] = value
      },
      delete: async () => true,
      save,
    }),
    migrator: { readLegacyTheme: () => null, clearLegacyTheme: () => {} },
    runtime: {
      pushMinimizeToTray: async () => {},
      pushAiFeaturesEnabled: async () => {},
      setGlobalShortcut: async () => {},
      setGlobalShortcuts: runtime,
      relaunchApp: async () => {},
    },
  }
  __setSettingsStoreDeps(deps)
  useSettingsStore.setState({
    status: 'ready',
    error: null,
    values: {
      ...DEFAULT_SETTINGS,
      pttFriendsAccelerator: previous[0],
      pttAiAccelerator: previous[1],
      micToggleAccelerator: previous[2],
    },
  })
  return {
    deps,
    runtime,
    save,
    cache,
    saved,
    live: () => live,
    durable: () => durable,
  }
}
function shown() {
  const values = useSettingsStore.getState().values
  return [
    values.pttFriendsAccelerator,
    values.pttAiAccelerator,
    values.micToggleAccelerator,
  ]
}

afterEach(__resetSettingsStoreDeps)

describe('coordinated shortcut reset (#394)', () => {
  it('commits a fully swapped pair with one native call and one durable save', async () => {
    const fixture = install()
    await useSettingsStore.getState().resetShortcutsToDefaults()
    expect(fixture.runtime).toHaveBeenCalledExactlyOnceWith(...defaults)
    expect(fixture.save).toHaveBeenCalledTimes(1)
    expect(shown()).toEqual(defaults)
    expect(fixture.live()).toEqual(defaults)
    expect(keys.map((key) => fixture.durable()[key])).toEqual(defaults)
  })

  for (const failure of [
    'friends-set',
    'ai-set',
    'mic-set',
    'save',
    'runtime',
  ] as const) {
    it(`keeps native, durable and displayed pairs aligned after ${failure} failure`, async () => {
      const fixture = install(failure)
      await expect(
        useSettingsStore.getState().resetShortcutsToDefaults()
      ).rejects.toThrow(/refused/)
      expect(shown()).toEqual(previous)
      expect(fixture.live()).toEqual(previous)
      expect(keys.map((key) => fixture.durable()[key])).toEqual(previous)
      expect(keys.map((key) => fixture.cache[key])).toEqual(previous)
      expect(useSettingsStore.getState().error).toMatch(/refused/)
    })
  }

  for (const failSave of [false, true]) {
    it(`prevents another settings save from exposing a partial pair during ${failSave ? 'rollback' : 'reset'}`, async () => {
      const fixture = install(failSave ? 'save' : undefined)
      const store = fixture.deps.storeFactory!()
      const originalSet = store.set
      let first = true
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      let release!: () => void
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      store.set = async (key, value) => {
        await originalSet(key, value)
        if (first && key === keys[0] && value === defaults[0]) {
          first = false
          entered()
          await blocked
        }
      }
      fixture.deps.storeFactory = () => store
      const reset = useSettingsStore.getState().resetShortcutsToDefaults()
      const result = reset.then(
        () => null,
        (error: unknown) => error
      )
      await started
      const otherWrite = useSettingsStore.getState().setTheme('light')
      // Flush the independent setter's runnable promise callbacks while the
      // native first-set acknowledgement remains held by the fixture.
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(fixture.save).not.toHaveBeenCalled()
        expect(fixture.cache[keys[0]]).toBe(defaults[0])
        expect(fixture.cache[keys[1]]).toBe(previous[1])
      } finally {
        release()
        await result
        await otherWrite
      }
      const error = await result
      if (failSave) expect(error).toBeInstanceOf(Error)
      else expect(error).toBeNull()
      await otherWrite
      expect(fixture.saved).toHaveLength(2)
      const expected = failSave ? previous : defaults
      for (const snapshot of fixture.saved)
        expect(keys.map((key) => snapshot[key])).toEqual(expected)
      expect(fixture.saved.at(-1)?.theme).toBe('light')
    })
  }

  it('queues a reset behind a pending individual registration and persistence', async () => {
    const fixture = install()
    let release!: () => void
    fixture.deps.runtime.setGlobalShortcut = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const rebind = useSettingsStore
      .getState()
      .setShortcutAccelerator('ptt-friends', 'CmdOrCtrl+K')
    const reset = useSettingsStore.getState().resetShortcutsToDefaults()
    await vi.waitFor(() =>
      expect(fixture.deps.runtime.setGlobalShortcut).toHaveBeenCalledTimes(1)
    )
    expect(fixture.runtime).not.toHaveBeenCalled()
    release()
    await Promise.all([rebind, reset])
    expect(shown()).toEqual(defaults)
    expect(fixture.live()).toEqual(defaults)
    expect(keys.map((key) => fixture.durable()[key])).toEqual(defaults)
  })
})
