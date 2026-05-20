import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { LazyStore } from '@tauri-apps/plugin-store'

import {
  PTT_AI_DEFAULT_ACCELERATOR,
  PTT_FRIENDS_DEFAULT_ACCELERATOR,
  type ShortcutAction,
} from '@/lib/keybindings'

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
  // src/features/ai/sidecar.ts to gate `useSidecarStore.start(...)`.
  aiFeaturesEnabled: boolean
  // V2-P5 score-machine thresholds (ARCHITECTURE.md §8). Defaults match the
  // PLAN.md §5 V2 "first 2 / next 2" framing. Setters land in V2-P9 (Settings
  // → AI sliders, ranges [2,8] / [3,12] enforced there); for V2-P5 the fields
  // are read-only and consumed by `features/ai/focusStore.ts` at apply-time.
  warningThreshold: number
  alertThreshold: number
  // V2-P9 user override for the AI sample interval (seconds). `null` means
  // "use the V2-P2 benchmark's measured cadence" (the default). When set, the
  // sample loop clamps it to the model's measured floor so the user can only
  // slow sampling down, never push it below what the machine can sustain.
  sampleIntervalSec: number | null
  // V3-P3 custom keybindings. Persisted as tauri-plugin-global-shortcut
  // accelerator strings ("CmdOrCtrl+["). The defaults match DESIGN-SYSTEM
  // §17. The Rust side parses these via `Shortcut::from_str`, so the JS
  // side and the Rust handler agree on the wire shape.
  pttFriendsAccelerator: string
  pttAiAccelerator: string
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
export const SETTINGS_KEY_WARNING_THRESHOLD = 'warning_threshold'
export const SETTINGS_KEY_ALERT_THRESHOLD = 'alert_threshold'
export const SETTINGS_KEY_SAMPLE_INTERVAL = 'sample_interval_s'
export const SETTINGS_KEY_PTT_FRIENDS_ACCELERATOR = 'ptt_friends_accelerator'
export const SETTINGS_KEY_PTT_AI_ACCELERATOR = 'ptt_ai_accelerator'

// Defaults match the V1 acceptance criteria + DESIGN-SYSTEM.md §8.5: dark
// theme on, reduce-motion off, OS notification on for invites, minimize-to-
// tray on (preserves V1-P7 behavior), debug log off, TURN auto, AI off.
// Threshold defaults are PLAN.md §5 V2 "first 2 / next 2".
export const DEFAULT_SETTINGS: SettingsValues = {
  theme: 'dark',
  reduceMotion: false,
  incomingInviteNotificationEnabled: true,
  minimizeToTrayOnClose: true,
  debugLogEnabled: false,
  turnPreference: 'auto',
  aiFeaturesEnabled: false,
  warningThreshold: 2,
  alertThreshold: 4,
  sampleIntervalSec: null,
  pttFriendsAccelerator: PTT_FRIENDS_DEFAULT_ACCELERATOR,
  pttAiAccelerator: PTT_AI_DEFAULT_ACCELERATOR,
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
  setAiFeaturesEnabled: (enabled: boolean) => Promise<void>
  setWarningThreshold: (count: number) => Promise<void>
  setAlertThreshold: (count: number) => Promise<void>
  // `null` clears the override, falling back to the model benchmark cadence.
  setSampleIntervalSec: (seconds: number | null) => Promise<void>
  // V3-P3 — set the accelerator for one of the two global shortcuts. The
  // optimistic-in-memory + writeKey-then-runtime-push pattern matches
  // setMinimizeToTrayOnClose: UI intent wins immediately, the persisted
  // value follows, and any runtime registration error surfaces in `error`.
  setShortcutAccelerator: (
    action: ShortcutAction,
    accelerator: string
  ) => Promise<void>
  // Reset both accelerators to their DESIGN-SYSTEM §17 defaults.
  resetShortcutsToDefaults: () => Promise<void>
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
  // Pushes the AI-features gate to Rust so the global Ctrl+] shortcut handler
  // can no-op when AI is off (the floating dialog is an AI surface). Same
  // best-effort contract as `pushMinimizeToTray`.
  pushAiFeaturesEnabled: (enabled: boolean) => Promise<void>
  // V3-P3 — re-registers a global shortcut via the Rust command. Awaited so
  // a registration failure (busy combo on the OS side, parse error) can be
  // surfaced in the store's `error` field and the rejecting setter can
  // unwind. Rust uses the V1-P7 interior-mutability pattern (`Mutex<Shortcut>`
  // in `ShortcutBindings`) to swap the live shortcut without restart.
  setGlobalShortcut: (
    action: ShortcutAction,
    accelerator: string
  ) => Promise<void>
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
    pushAiFeaturesEnabled: async (enabled) => {
      if (!isTauriRuntime()) return
      await invoke('system_ai_features_set_enabled', { enabled })
    },
    setGlobalShortcut: async (action, accelerator) => {
      if (!isTauriRuntime()) return
      await invoke('system_set_global_shortcut', { action, accelerator })
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
    warning: await store.get(SETTINGS_KEY_WARNING_THRESHOLD),
    alert: await store.get(SETTINGS_KEY_ALERT_THRESHOLD),
    sampleInterval: await store.get(SETTINGS_KEY_SAMPLE_INTERVAL),
    pttFriends: await store.get(SETTINGS_KEY_PTT_FRIENDS_ACCELERATOR),
    pttAi: await store.get(SETTINGS_KEY_PTT_AI_ACCELERATOR),
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
      warningThreshold: readNumber(
        stored.warning,
        DEFAULT_SETTINGS.warningThreshold
      ),
      alertThreshold: readNumber(stored.alert, DEFAULT_SETTINGS.alertThreshold),
      sampleIntervalSec: readNullableNumber(stored.sampleInterval),
      pttFriendsAccelerator: readAccelerator(
        stored.pttFriends,
        DEFAULT_SETTINGS.pttFriendsAccelerator
      ),
      pttAiAccelerator: readAccelerator(
        stored.pttAi,
        DEFAULT_SETTINGS.pttAiAccelerator
      ),
    },
    wroteMigration,
  }
}

// Rejects any persisted value that isn't a non-empty string. A
// `parseAccelerator(...) === null` check would let us reject malformed
// strings too, but that's a runtime concern: an unparseable accelerator
// will fail at Rust-side register-time with a specific error, surfaced
// through the store's normal error field. Treat hydration leniently and
// validate-on-write.
function readAccelerator(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

function readNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

// `null`/absent/garbage all collapse to `null` ("use the benchmark cadence").
// Only a finite positive number is a real user override.
function readNullableNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
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
      // Same one-shot push for the AI gate so the Ctrl+] shortcut honors the
      // saved preference even before the user opens Settings → AI. Rust also
      // seeds this from settings.json at boot; this just closes the hydration
      // window.
      try {
        await activeDeps.runtime.pushAiFeaturesEnabled(values.aiFeaturesEnabled)
      } catch {
        // Best-effort: falls back to `AiFeaturesFlag`'s boot value.
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

  setAiFeaturesEnabled: async (enabled) => {
    set((s) => ({ values: { ...s.values, aiFeaturesEnabled: enabled } }))
    await writeKey(set, SETTINGS_KEY_AI_FEATURES, enabled)
    try {
      await activeDeps.runtime.pushAiFeaturesEnabled(enabled)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('pushAiFeaturesEnabled failed:', err)
      set({ error: message })
    }
  },

  // Range/`warning < alert` enforcement lives in the Settings → AI slider UI
  // (it has the sibling value to compare against); the store persists the
  // raw number and `focusStore` re-clamps via `normaliseThresholds` at
  // apply-time, so an out-of-range persisted value can never break a run.
  setWarningThreshold: async (count) => {
    set((s) => ({ values: { ...s.values, warningThreshold: count } }))
    await writeKey(set, SETTINGS_KEY_WARNING_THRESHOLD, count)
  },

  setAlertThreshold: async (count) => {
    set((s) => ({ values: { ...s.values, alertThreshold: count } }))
    await writeKey(set, SETTINGS_KEY_ALERT_THRESHOLD, count)
  },

  setSampleIntervalSec: async (seconds) => {
    set((s) => ({ values: { ...s.values, sampleIntervalSec: seconds } }))
    await writeKey(set, SETTINGS_KEY_SAMPLE_INTERVAL, seconds)
  },

  setShortcutAccelerator: async (action, accelerator) => {
    const key =
      action === 'ptt-friends'
        ? SETTINGS_KEY_PTT_FRIENDS_ACCELERATOR
        : SETTINGS_KEY_PTT_AI_ACCELERATOR
    const valuesKey =
      action === 'ptt-friends' ? 'pttFriendsAccelerator' : 'pttAiAccelerator'
    const previous = get().values[valuesKey]
    set((s) => ({ values: { ...s.values, [valuesKey]: accelerator } }))
    try {
      await activeDeps.runtime.setGlobalShortcut(action, accelerator)
    } catch (err) {
      // Runtime registration failed (parse error, OS-reserved combo, etc.).
      // Roll back the optimistic update and surface the message so the
      // rebind UI can render a refusal next to the row.
      set((s) => ({
        values: { ...s.values, [valuesKey]: previous },
        error: err instanceof Error ? err.message : String(err),
      }))
      throw err
    }
    await writeKey(set, key, accelerator)
  },

  resetShortcutsToDefaults: async () => {
    const setter = get().setShortcutAccelerator
    await setter('ptt-friends', PTT_FRIENDS_DEFAULT_ACCELERATOR)
    await setter('ptt-ai', PTT_AI_DEFAULT_ACCELERATOR)
  },
}))
