import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { LazyStore } from '@tauri-apps/plugin-store'

export type ThemeMode = 'dark' | 'light' | 'auto'
export type TurnPreference = 'auto' | 'always' | 'never'

export type SettingsValues = {
  theme: ThemeMode
  reduceMotion: boolean
  incomingInviteNotificationEnabled: boolean
  minimizeToTrayOnClose: boolean
  debugLogEnabled: boolean
  turnPreference: TurnPreference
  // V2 AI feature gate. Defaults to `false` so V1 builds and the first V2
  // launch keep the llama-server sidecar dormant. The toggle UI + setter
  // land in V2-P9; for V2-P1 the value is read-only and consumed by
  // src/features/ai/sidecar.ts to gate `startSidecar`.
  aiFeaturesEnabled: boolean
}

export const SETTINGS_FILE = 'settings.json'
export const LEGACY_THEME_LOCALSTORAGE_KEY = 'studyvis.theme'
export const SETTINGS_KEY_THEME = 'theme'
export const SETTINGS_KEY_REDUCE_MOTION = 'reduce_motion'
export const SETTINGS_KEY_INVITE_NOTIFY = 'incoming_invite_notification_enabled'
export const SETTINGS_KEY_MINIMIZE_TRAY = 'minimize_to_tray_on_close'
export const SETTINGS_KEY_DEBUG_LOG = 'debug_log_enabled'
export const SETTINGS_KEY_TURN_PREF = 'turn_preference'
export const SETTINGS_KEY_AI_FEATURES = 'ai_features_enabled'

// Defaults match the V1 acceptance criteria + DESIGN-SYSTEM.md §8.5: dark
// theme on, reduce-motion off, OS notification on for invites, minimize-to-
// tray on (preserves V1-P7 behavior), debug log off, TURN auto, AI off.
export const DEFAULT_SETTINGS: SettingsValues = {
  theme: 'dark',
  reduceMotion: false,
  incomingInviteNotificationEnabled: true,
  minimizeToTrayOnClose: true,
  debugLogEnabled: false,
  turnPreference: 'auto',
  aiFeaturesEnabled: false,
}

export type SettingsStatus = 'loading' | 'ready' | 'error'

type SettingsState = {
  status: SettingsStatus
  values: SettingsValues
  error: string | null
  hydrate: () => Promise<void>
  setTheme: (mode: ThemeMode) => Promise<void>
  setReduceMotion: (enabled: boolean) => Promise<void>
  setIncomingInviteNotificationEnabled: (enabled: boolean) => Promise<void>
  setMinimizeToTrayOnClose: (enabled: boolean) => Promise<void>
  setDebugLogEnabled: (enabled: boolean) => Promise<void>
  setTurnPreference: (pref: TurnPreference) => Promise<void>
}

export type StoreLike = {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  save(): Promise<void>
}

export type StoreFactory = () => StoreLike

export type Migrator = {
  // Read the legacy theme key, returning null if absent. Implementations may
  // also clear the source after reading; the store only consults this when
  // the persistent store has no theme value.
  readLegacyTheme: () => ThemeMode | null
  clearLegacyTheme: () => void
}

export type RuntimeBridge = {
  // Pushes the minimize-to-tray flag to Rust so `on_window_event` reads the
  // user's preference. Best-effort; failures are surfaced via the store's
  // error field but don't block the local UI update.
  pushMinimizeToTray: (enabled: boolean) => Promise<void>
}

export type SettingsStoreDeps = {
  storeFactory: StoreFactory | null
  migrator: Migrator
  runtime: RuntimeBridge
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

function readLegacyThemeFromLocalStorage(): ThemeMode | null {
  if (typeof window === 'undefined') return null
  try {
    const v = window.localStorage.getItem(LEGACY_THEME_LOCALSTORAGE_KEY)
    if (v === 'dark' || v === 'light' || v === 'auto') return v
  } catch {
    // localStorage may be unavailable (private mode, sandboxed iframes).
    // Treat as no legacy value.
  }
  return null
}

function clearLegacyThemeInLocalStorage(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(LEGACY_THEME_LOCALSTORAGE_KEY)
  } catch {
    // Same fallthrough as the read path; nothing to do if localStorage is
    // gone. The next boot will look one more time and find nothing.
  }
}

let cachedLazyStore: LazyStore | null = null
function defaultLazyStoreFactory(): StoreLike {
  if (!cachedLazyStore) cachedLazyStore = new LazyStore(SETTINGS_FILE)
  return cachedLazyStore as unknown as StoreLike
}

const defaultDeps: SettingsStoreDeps = {
  storeFactory: isTauriRuntime() ? defaultLazyStoreFactory : null,
  migrator: {
    readLegacyTheme: readLegacyThemeFromLocalStorage,
    clearLegacyTheme: clearLegacyThemeInLocalStorage,
  },
  runtime: {
    pushMinimizeToTray: async (enabled) => {
      if (!isTauriRuntime()) return
      await invoke('system_minimize_to_tray_set_enabled', { enabled })
    },
  },
}

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'dark' || v === 'light' || v === 'auto'
}

export function isTurnPreference(v: unknown): v is TurnPreference {
  return v === 'auto' || v === 'always' || v === 'never'
}

function readBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

// Hydrates `values` from persistent storage, applies the V1-P11 one-shot
// migration of the legacy `studyvis.theme` localStorage key, and returns the
// resolved settings + whether anything was written. Pure (deps-injected) so
// the unit test can drive the migration logic without Tauri.
export async function hydrateValuesFromStore(
  store: StoreLike,
  migrator: Migrator
): Promise<{ values: SettingsValues; wroteMigration: boolean }> {
  const stored: Partial<Record<string, unknown>> = {
    theme: await store.get(SETTINGS_KEY_THEME),
    reduceMotion: await store.get(SETTINGS_KEY_REDUCE_MOTION),
    invite: await store.get(SETTINGS_KEY_INVITE_NOTIFY),
    tray: await store.get(SETTINGS_KEY_MINIMIZE_TRAY),
    debug: await store.get(SETTINGS_KEY_DEBUG_LOG),
    turn: await store.get(SETTINGS_KEY_TURN_PREF),
    ai: await store.get(SETTINGS_KEY_AI_FEATURES),
  }

  let theme: ThemeMode = isThemeMode(stored.theme)
    ? stored.theme
    : DEFAULT_SETTINGS.theme
  let wroteMigration = false

  // The legacy localStorage key is consulted exactly once — when the
  // persistent store has no theme value yet. After folding it in, the legacy
  // key is cleared so subsequent boots short-circuit.
  if (!isThemeMode(stored.theme)) {
    const legacy = migrator.readLegacyTheme()
    if (legacy) {
      theme = legacy
      await store.set(SETTINGS_KEY_THEME, legacy)
      await store.save()
      migrator.clearLegacyTheme()
      wroteMigration = true
    }
  }

  const turn: TurnPreference = isTurnPreference(stored.turn)
    ? stored.turn
    : DEFAULT_SETTINGS.turnPreference

  return {
    values: {
      theme,
      reduceMotion: readBool(
        stored.reduceMotion,
        DEFAULT_SETTINGS.reduceMotion
      ),
      incomingInviteNotificationEnabled: readBool(
        stored.invite,
        DEFAULT_SETTINGS.incomingInviteNotificationEnabled
      ),
      minimizeToTrayOnClose: readBool(
        stored.tray,
        DEFAULT_SETTINGS.minimizeToTrayOnClose
      ),
      debugLogEnabled: readBool(stored.debug, DEFAULT_SETTINGS.debugLogEnabled),
      turnPreference: turn,
      aiFeaturesEnabled: readBool(
        stored.ai,
        DEFAULT_SETTINGS.aiFeaturesEnabled
      ),
    },
    wroteMigration,
  }
}

let activeDeps: SettingsStoreDeps = defaultDeps

// Test seam — Vitest replaces the deps before driving the store.
export function __setSettingsStoreDeps(deps: SettingsStoreDeps): void {
  activeDeps = deps
}

export function __resetSettingsStoreDeps(): void {
  activeDeps = defaultDeps
}

// Setters fire-and-forget (call sites use `void setTheme(...)`), so any
// rejection here would surface as an unhandled promise rejection. We catch,
// log, and surface the failure via the store's `error` field — the
// optimistic in-memory `set()` above the call still wins, so the UI
// reflects the user's intent and the next call retries the write.
async function writeKey(
  set: (partial: Partial<SettingsState>) => void,
  key: string,
  value: unknown
): Promise<void> {
  const factory = activeDeps.storeFactory
  if (!factory) return
  try {
    const store = factory()
    await store.set(key, value)
    await store.save()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`settingsStore.writeKey(${key}) failed:`, err)
    set({ error: message })
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  status: 'loading',
  values: DEFAULT_SETTINGS,
  error: null,

  hydrate: async () => {
    if (get().status === 'ready') return
    const factory = activeDeps.storeFactory
    if (!factory) {
      // Storybook / non-Tauri: no persistent store; surface the defaults
      // immediately so consumers can still render.
      set({ status: 'ready', values: DEFAULT_SETTINGS, error: null })
      return
    }
    try {
      const store = factory()
      const { values } = await hydrateValuesFromStore(
        store,
        activeDeps.migrator
      )
      set({ status: 'ready', values, error: null })
      // Push the minimize-to-tray flag to Rust so the close-to-tray path
      // honors the user's saved preference even before the user opens
      // settings.
      try {
        await activeDeps.runtime.pushMinimizeToTray(
          values.minimizeToTrayOnClose
        )
      } catch {
        // Best-effort: settings UI continues to work; the desktop flag falls
        // back to its `MinimizeToTrayFlag::new()` default.
      }
    } catch (err) {
      set({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  setTheme: async (mode) => {
    set((s) => ({ values: { ...s.values, theme: mode } }))
    await writeKey(set, SETTINGS_KEY_THEME, mode)
  },

  setReduceMotion: async (enabled) => {
    set((s) => ({ values: { ...s.values, reduceMotion: enabled } }))
    await writeKey(set, SETTINGS_KEY_REDUCE_MOTION, enabled)
  },

  setIncomingInviteNotificationEnabled: async (enabled) => {
    set((s) => ({
      values: { ...s.values, incomingInviteNotificationEnabled: enabled },
    }))
    await writeKey(set, SETTINGS_KEY_INVITE_NOTIFY, enabled)
  },

  setMinimizeToTrayOnClose: async (enabled) => {
    set((s) => ({ values: { ...s.values, minimizeToTrayOnClose: enabled } }))
    await writeKey(set, SETTINGS_KEY_MINIMIZE_TRAY, enabled)
    try {
      await activeDeps.runtime.pushMinimizeToTray(enabled)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('pushMinimizeToTray failed:', err)
      set({ error: message })
    }
  },

  setDebugLogEnabled: async (enabled) => {
    set((s) => ({ values: { ...s.values, debugLogEnabled: enabled } }))
    await writeKey(set, SETTINGS_KEY_DEBUG_LOG, enabled)
  },

  setTurnPreference: async (pref) => {
    set((s) => ({ values: { ...s.values, turnPreference: pref } }))
    await writeKey(set, SETTINGS_KEY_TURN_PREF, pref)
  },
}))
