import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  combosEqual,
  comboFromKeyboardEvent,
  comboToAccelerator,
  comboToInlineDisplay,
  comboToKbdLabels,
  DEFAULT_PTT_AI_COMBO,
  DEFAULT_PTT_FRIENDS_COMBO,
  isModifierCode,
  parseAccelerator,
  PTT_AI_DEFAULT_ACCELERATOR,
  PTT_FRIENDS_DEFAULT_ACCELERATOR,
  reservedCombos,
  validateCombo,
  type Combo,
} from '@/lib/keybindings'
import { describeConflict } from '@/lib/keybindings-copy'
import {
  __resetSettingsStoreDeps,
  __setSettingsStoreDeps,
  DEFAULT_SETTINGS,
  hydrateValuesFromStore,
  SETTINGS_KEY_PTT_AI_ACCELERATOR,
  SETTINGS_KEY_PTT_FRIENDS_ACCELERATOR,
  useSettingsStore,
  type SettingsStoreDeps,
  type StoreLike,
} from '@/stores/settingsStore'

describe('keybindings — combo serialization round-trips', () => {
  test('Cmd/Ctrl+[ serializes to the default accelerator', () => {
    expect(comboToAccelerator(DEFAULT_PTT_FRIENDS_COMBO)).toBe(
      PTT_FRIENDS_DEFAULT_ACCELERATOR
    )
    expect(comboToAccelerator(DEFAULT_PTT_AI_COMBO)).toBe(
      PTT_AI_DEFAULT_ACCELERATOR
    )
  })

  test('parseAccelerator inverts comboToAccelerator', () => {
    const samples: Combo[] = [
      DEFAULT_PTT_FRIENDS_COMBO,
      DEFAULT_PTT_AI_COMBO,
      { mod: true, ctrl: false, alt: false, shift: true, code: 'Period' },
      { mod: true, ctrl: false, alt: true, shift: false, code: 'KeyF' },
      { mod: false, ctrl: false, alt: true, shift: false, code: 'F11' },
      { mod: true, ctrl: false, alt: false, shift: false, code: 'ArrowUp' },
    ]
    for (const combo of samples) {
      const accel = comboToAccelerator(combo)
      const parsed = parseAccelerator(accel)
      expect(parsed).not.toBeNull()
      expect(parsed && combosEqual(parsed, combo)).toBe(true)
    }
  })

  test('parseAccelerator accepts the mac-only Cmd token and collapses to mod', () => {
    const parsed = parseAccelerator('Cmd+[')
    expect(parsed).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: false,
      code: 'BracketLeft',
    })
  })

  test('parseAccelerator rejects unknown tokens', () => {
    expect(parseAccelerator('Meta+SuperWeird+Q')).toBeNull()
    expect(parseAccelerator('')).toBeNull()
  })

  test('comboFromKeyboardEvent maps platform-primary mod correctly', () => {
    const macCmd = comboFromKeyboardEvent(
      makeKeyEvent({ code: 'BracketLeft', metaKey: true }),
      'mac'
    )
    expect(macCmd).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: false,
      code: 'BracketLeft',
    })

    const winCtrl = comboFromKeyboardEvent(
      makeKeyEvent({ code: 'BracketLeft', ctrlKey: true }),
      'other'
    )
    expect(winCtrl).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: false,
      code: 'BracketLeft',
    })

    const macCtrl = comboFromKeyboardEvent(
      makeKeyEvent({ code: 'BracketLeft', ctrlKey: true }),
      'mac'
    )
    expect(macCtrl).toEqual({
      mod: false,
      ctrl: true,
      alt: false,
      shift: false,
      code: 'BracketLeft',
    })
  })
})

describe('keybindings — display tokens', () => {
  test('mac uses ⌘ glyphs and no separator', () => {
    const labels = comboToKbdLabels(DEFAULT_PTT_FRIENDS_COMBO, 'mac')
    expect(labels).toEqual(['⌘', '['])
    expect(comboToInlineDisplay(DEFAULT_PTT_FRIENDS_COMBO, 'mac')).toBe('⌘[')
  })

  test('other platforms use Ctrl + separator', () => {
    const labels = comboToKbdLabels(DEFAULT_PTT_FRIENDS_COMBO, 'other')
    expect(labels).toEqual(['Ctrl', '['])
    expect(comboToInlineDisplay(DEFAULT_PTT_FRIENDS_COMBO, 'other')).toBe(
      'Ctrl+['
    )
  })

  test('renders Shift + key combos in canonical order', () => {
    const combo: Combo = {
      mod: true,
      ctrl: false,
      alt: false,
      shift: true,
      code: 'Period',
    }
    expect(comboToKbdLabels(combo, 'mac')).toEqual(['⇧', '⌘', '.'])
    expect(comboToKbdLabels(combo, 'other')).toEqual(['Ctrl', 'Shift', '.'])
  })
})

describe('keybindings — validation', () => {
  const otherCombo = DEFAULT_PTT_AI_COMBO

  test('flags self-collision against the other StudyVis binding', () => {
    const conflict = validateCombo(DEFAULT_PTT_AI_COMBO, {
      otherCombo,
      otherAction: 'ptt-ai',
      platform: 'other',
    })
    expect(conflict?.kind).toBe('self_conflict')
    if (conflict?.kind === 'self_conflict') {
      expect(conflict.otherAction).toBe('ptt-ai')
    }
  })

  test('flags a reserved system combo on the active platform', () => {
    const reservedCombo: Combo = {
      mod: true,
      ctrl: false,
      alt: false,
      shift: false,
      code: 'KeyC',
    }
    expect(
      validateCombo(reservedCombo, {
        otherCombo,
        otherAction: 'ptt-ai',
        platform: 'other',
      })?.kind
    ).toBe('reserved')
    expect(
      validateCombo(reservedCombo, {
        otherCombo,
        otherAction: 'ptt-ai',
        platform: 'mac',
      })?.kind
    ).toBe('reserved')
  })

  test('reserved set is platform-specific (Alt+F4 only on non-mac)', () => {
    expect(reservedCombos('other').has('Alt+F4')).toBe(true)
    expect(reservedCombos('mac').has('Alt+F4')).toBe(false)
    expect(reservedCombos('mac').has('CmdOrCtrl+Q')).toBe(true)
  })

  test('refuses a combo with no real modifier (Shift alone)', () => {
    const shiftOnly: Combo = {
      mod: false,
      ctrl: false,
      alt: false,
      shift: true,
      code: 'KeyA',
    }
    expect(
      validateCombo(shiftOnly, {
        otherCombo,
        otherAction: 'ptt-ai',
        platform: 'other',
      })?.kind
    ).toBe('no_modifier')
  })

  test('refuses a standalone modifier press', () => {
    const modOnly: Combo = {
      mod: true,
      ctrl: false,
      alt: false,
      shift: false,
      code: 'MetaLeft',
    }
    expect(
      validateCombo(modOnly, {
        otherCombo,
        otherAction: 'ptt-ai',
        platform: 'mac',
      })?.kind
    ).toBe('modifier_only')
  })

  test('passes a fresh, unreserved combo', () => {
    const candidate: Combo = {
      mod: true,
      ctrl: false,
      alt: false,
      shift: false,
      code: 'Period',
    }
    expect(
      validateCombo(candidate, {
        otherCombo,
        otherAction: 'ptt-ai',
        platform: 'other',
      })
    ).toBeNull()
  })

  test('describeConflict emits specific, calm one-liners', () => {
    const reservedCombo: Combo = {
      mod: true,
      ctrl: false,
      alt: false,
      shift: false,
      code: 'KeyC',
    }
    expect(
      describeConflict(reservedCombo, { kind: 'reserved' }, 'other')
    ).toMatch(/Ctrl\+C is reserved by the system/)
    expect(
      describeConflict(reservedCombo, { kind: 'reserved' }, 'mac')
    ).toMatch(/⌘C is reserved by the system/)
    expect(
      describeConflict(
        DEFAULT_PTT_AI_COMBO,
        { kind: 'self_conflict', otherAction: 'ptt-ai' },
        'other'
      )
    ).toMatch(/already bound to Talk to AI/)
  })
})

describe('isModifierCode', () => {
  test('recognises both lefts and rights for every modifier', () => {
    for (const code of [
      'ShiftLeft',
      'ShiftRight',
      'ControlLeft',
      'ControlRight',
      'AltLeft',
      'AltRight',
      'MetaLeft',
      'MetaRight',
    ]) {
      expect(isModifierCode(code)).toBe(true)
    }
    expect(isModifierCode('KeyA')).toBe(false)
    expect(isModifierCode('BracketLeft')).toBe(false)
  })
})

describe('settingsStore — V3-P3 shortcut persistence & runtime push', () => {
  let saved: Record<string, unknown>
  let pushed: Array<{ action: string; accelerator: string }>
  let registerShouldFail: boolean

  beforeEach(() => {
    saved = {}
    pushed = []
    registerShouldFail = false
    const fakeStore: StoreLike = {
      async get<T>(k: string): Promise<T | undefined> {
        return k in saved ? (saved[k] as T) : undefined
      },
      set: async (k, v) => {
        saved[k] = v
      },
      delete: async () => true,
      save: async () => {},
    }
    const deps: SettingsStoreDeps = {
      storeFactory: () => fakeStore,
      migrator: { readLegacyTheme: () => null, clearLegacyTheme: () => {} },
      runtime: {
        pushMinimizeToTray: async () => {},
        pushAiFeaturesEnabled: async () => {},
        setGlobalShortcut: async (action, accelerator) => {
          if (registerShouldFail) throw new Error('OS refused')
          pushed.push({ action, accelerator })
        },
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
  })

  test('setShortcutAccelerator pushes and persists the new combo', async () => {
    await useSettingsStore
      .getState()
      .setShortcutAccelerator('ptt-friends', 'CmdOrCtrl+.')
    expect(useSettingsStore.getState().values.pttFriendsAccelerator).toBe(
      'CmdOrCtrl+.'
    )
    expect(pushed).toEqual([
      { action: 'ptt-friends', accelerator: 'CmdOrCtrl+.' },
    ])
    expect(saved[SETTINGS_KEY_PTT_FRIENDS_ACCELERATOR]).toBe('CmdOrCtrl+.')
  })

  test('a runtime rejection rolls back and surfaces error', async () => {
    registerShouldFail = true
    await expect(
      useSettingsStore
        .getState()
        .setShortcutAccelerator('ptt-friends', 'CmdOrCtrl+.')
    ).rejects.toThrow('OS refused')
    expect(useSettingsStore.getState().values.pttFriendsAccelerator).toBe(
      PTT_FRIENDS_DEFAULT_ACCELERATOR
    )
    expect(useSettingsStore.getState().error).toBe('OS refused')
    expect(saved[SETTINGS_KEY_PTT_FRIENDS_ACCELERATOR]).toBeUndefined()
  })

  test('resetShortcutsToDefaults re-registers both bindings', async () => {
    await useSettingsStore
      .getState()
      .setShortcutAccelerator('ptt-friends', 'CmdOrCtrl+.')
    await useSettingsStore
      .getState()
      .setShortcutAccelerator('ptt-ai', 'CmdOrCtrl+;')
    pushed.length = 0

    await useSettingsStore.getState().resetShortcutsToDefaults()
    expect(useSettingsStore.getState().values.pttFriendsAccelerator).toBe(
      PTT_FRIENDS_DEFAULT_ACCELERATOR
    )
    expect(useSettingsStore.getState().values.pttAiAccelerator).toBe(
      PTT_AI_DEFAULT_ACCELERATOR
    )
    expect(pushed).toEqual([
      { action: 'ptt-friends', accelerator: PTT_FRIENDS_DEFAULT_ACCELERATOR },
      { action: 'ptt-ai', accelerator: PTT_AI_DEFAULT_ACCELERATOR },
    ])
  })
})

describe('resetShortcutsToDefaults — collision recovery (item 22)', () => {
  // Stateful fake: each action "holds" a combo, and registering a combo the
  // *other* action currently holds throws AlreadyRegistered, mirroring
  // global-hotkey's real duplicate-registration error on both shipped OSes.
  let held: Record<'ptt-friends' | 'ptt-ai', string>
  let attempts: Array<{ action: string; accelerator: string }>

  function install(friends: string, ai: string) {
    held = { 'ptt-friends': friends, 'ptt-ai': ai }
    attempts = []
    const saved: Record<string, unknown> = {}
    const fakeStore: StoreLike = {
      async get<T>(k: string): Promise<T | undefined> {
        return k in saved ? (saved[k] as T) : undefined
      },
      set: async (k, v) => {
        saved[k] = v
      },
      delete: async () => true,
      save: async () => {},
    }
    const deps: SettingsStoreDeps = {
      storeFactory: () => fakeStore,
      migrator: { readLegacyTheme: () => null, clearLegacyTheme: () => {} },
      runtime: {
        pushMinimizeToTray: async () => {},
        pushAiFeaturesEnabled: async () => {},
        setGlobalShortcut: async (action, accelerator) => {
          attempts.push({ action, accelerator })
          const other = action === 'ptt-friends' ? 'ptt-ai' : 'ptt-friends'
          if (held[other] === accelerator) {
            throw new Error('AlreadyRegistered')
          }
          held[action] = accelerator
        },
        relaunchApp: async () => {},
      },
    }
    __setSettingsStoreDeps(deps)
    useSettingsStore.setState({
      status: 'ready',
      values: {
        ...DEFAULT_SETTINGS,
        pttFriendsAccelerator: friends,
        pttAiAccelerator: ai,
      },
      error: null,
    })
  }

  afterEach(() => {
    __resetSettingsStoreDeps()
  })

  test('reorders so a single collision still lands both bindings on defaults', async () => {
    // AI squats on the friends-default combo. A fixed friends-first order would
    // collide (friends -> '[' while AI holds '['); resetting AI first frees it.
    install('CmdOrCtrl+K', PTT_FRIENDS_DEFAULT_ACCELERATOR)

    await useSettingsStore.getState().resetShortcutsToDefaults()

    expect(useSettingsStore.getState().values.pttFriendsAccelerator).toBe(
      PTT_FRIENDS_DEFAULT_ACCELERATOR
    )
    expect(useSettingsStore.getState().values.pttAiAccelerator).toBe(
      PTT_AI_DEFAULT_ACCELERATOR
    )
    expect(held).toEqual({
      'ptt-friends': PTT_FRIENDS_DEFAULT_ACCELERATOR,
      'ptt-ai': PTT_AI_DEFAULT_ACCELERATOR,
    })
    expect(attempts[0]?.action).toBe('ptt-ai')
  })

  test('runs the second setter even when the first rejects', async () => {
    // Fully swapped pair — no order can break a mutual swap, so the first
    // register throws; the second must still be attempted, then the last
    // failure rethrows for the toast.
    install(PTT_AI_DEFAULT_ACCELERATOR, PTT_FRIENDS_DEFAULT_ACCELERATOR)

    await expect(
      useSettingsStore.getState().resetShortcutsToDefaults()
    ).rejects.toThrow('AlreadyRegistered')

    expect(attempts).toHaveLength(2)
    expect(attempts.map((a) => a.action).sort()).toEqual([
      'ptt-ai',
      'ptt-friends',
    ])
  })
})

describe('hydrateValuesFromStore — V3-P3 shortcut keys', () => {
  test('rehydrates persisted accelerators', async () => {
    const store: StoreLike = makeFakeStore({
      [SETTINGS_KEY_PTT_FRIENDS_ACCELERATOR]: 'CmdOrCtrl+.',
      [SETTINGS_KEY_PTT_AI_ACCELERATOR]: 'CmdOrCtrl+;',
    })
    const { values } = await hydrateValuesFromStore(store, {
      readLegacyTheme: () => null,
      clearLegacyTheme: () => {},
    })
    expect(values.pttFriendsAccelerator).toBe('CmdOrCtrl+.')
    expect(values.pttAiAccelerator).toBe('CmdOrCtrl+;')
  })

  test('falls back to defaults for missing or non-string entries', async () => {
    const store: StoreLike = makeFakeStore({
      [SETTINGS_KEY_PTT_FRIENDS_ACCELERATOR]: 42,
      [SETTINGS_KEY_PTT_AI_ACCELERATOR]: '',
    })
    const { values } = await hydrateValuesFromStore(store, {
      readLegacyTheme: () => null,
      clearLegacyTheme: () => {},
    })
    expect(values.pttFriendsAccelerator).toBe(PTT_FRIENDS_DEFAULT_ACCELERATOR)
    expect(values.pttAiAccelerator).toBe(PTT_AI_DEFAULT_ACCELERATOR)
  })
})

function makeKeyEvent(init: {
  code: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}): KeyboardEvent {
  // The Combo lib only reads `code`, `metaKey`, `ctrlKey`, `altKey`, and
  // `shiftKey` off the event, so a plain object cast is enough and keeps the
  // node-env test free of DOM dependencies.
  return {
    code: init.code,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  } as unknown as KeyboardEvent
}

function makeFakeStore(initial: Record<string, unknown>): StoreLike {
  const data = { ...initial }
  return {
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
