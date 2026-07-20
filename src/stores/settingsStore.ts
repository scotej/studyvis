// Zustand store for every persisted user setting, backed by Tauri's
// `LazyStore` file `settings.json` (in Tauri's app_data_dir — NOT
// localStorage, and a different directory from the SQLite data dir). Setters
// update memory optimistically and write through to disk; per-key validators
// fail closed where a bad persisted value would brick the app at boot.
//
// Two coupling patterns to keep in mind when editing:
// - Boot caches: theme, windowStyle, and reduceMotion are ALSO mirrored to
//   localStorage ('studyvis.theme', 'studyvis.windowStyle', …) because inline
//   pre-paint scripts in index.html / ai-dialog.html read them synchronously
//   to avoid a first-paint flash. Dropping a mirror write reintroduces FOUC.
// - Rust push-downs: some keys must reach Rust to take effect
//   (minimize-to-tray, AI-features flag, shortcut accelerators — the latter
//   registers with the OS before persisting and rolls back on failure).
//   `lib.rs` also reads this file directly at boot, before JS hydrates.
//
// Not everything applies live: relay-URL changes need an app relaunch (rooms
// open at boot and never close), windowStyle applies at next process start,
// captureDisplays at the next sample-loop boot.

import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { LazyStore } from '@tauri-apps/plugin-store'

import { writeReduceMotionBootCache } from '@/design/reduce-motion'
import {
  PTT_AI_DEFAULT_ACCELERATOR,
  PTT_FRIENDS_DEFAULT_ACCELERATOR,
  type ShortcutAction,
} from '@/lib/keybindings'

export type ThemeMode = 'dark' | 'light' | 'auto'
export type TurnPreference = 'auto' | 'always' | 'never'
// F3 — user-supplied TURN server (url/username/credential). `null` (the
// default) means "no TURN" — every cross-network session stays STUN-only, the
// shipped behavior. All three fields are required for the server to activate;
// the setter rejects a partial or scheme-invalid config (see setTurnServer).
export type CustomTurnServer = {
  url: string
  username: string
  credential: string
}
// V3-P4 — Multi-monitor capture toggle for the AI sample loop. `'primary'`
// (default) preserves the V2 behavior: one long-lived getDisplayMedia stream,
// one OS picker at session start. `'all'` enumerates connected displays at
// boot, acquires a long-lived stream per display, and composites them into a
// single image each tick. Setting only takes effect on the NEXT loop boot —
// switching mid-session does not re-prompt or reshape an in-flight loop.
export type CaptureDisplaysMode = 'primary' | 'all'
// V3-P6 — Opt-in custom window chrome. `'system'` (default) keeps the OS
// titlebar untouched and matches the v1.0.3 shipped behavior. `'custom'`
// asks Rust to apply `set_decorations(false)` (Windows) or
// `set_title_bar_style(TitleBarStyle::Overlay)` (macOS) at the next boot
// and renders the `<TitleBar />` component. The change requires a process
// relaunch because live decoration swaps are unreliable on macOS (see
// tauri-apps/tauri#9673, #12042).
export type WindowStyleMode = 'system' | 'custom'
// Floating-window geometry in physical pixels — the units Tauri's
// onResized/onMoved payloads and getters report. `maximized` is tracked
// separately from the floating rect: while maximized only the flag
// updates, so unmaximizing after a relaunch returns to the remembered
// floating size instead of the maximized one. Rust reads this at boot
// (before the hidden window is shown) and re-validates against the
// connected monitors, so a stale rect from an unplugged display can never
// strand the window off-screen.
export type WindowLayout = {
  width: number
  height: number
  x: number
  y: number
  // Scale factor of the display the geometry was captured on. Physical
  // pixels are only meaningful relative to a scale: restoring them through
  // a differently-scaled monitor (retina laptop + 1x external is the
  // textbook Mac setup) would resize or misplace the window, so Rust uses
  // this to convert into the space each platform restores correctly.
  scaleFactor: number
  maximized: boolean
}

export type SettingsValues = {
  theme: ThemeMode
  reduceMotion: boolean
  incomingInviteNotificationEnabled: boolean
  // N2 — OS notification on a LOCAL pomodoro work↔rest flip. Opt-out: ON by
  // default (the boundary is invisible when minimized to tray, the most-wanted
  // study nudge). Read by PomodoroNotifyListener; setter is the Notifications
  // toggle.
  pomodoroNotificationEnabled: boolean
  // N6 — gentle chime on the same local transition. Opt-IN: OFF by default
  // (the calm default IS the reduced-motion accommodation — nothing plays
  // unless asked). Read by PomodoroNotifyListener.
  pomodoroSoundEnabled: boolean
  // N3 — OS notification when a friend flips offline→online. Opt-IN: OFF by
  // default. Read by InboxBoot's presence detector; ~60s presence latency.
  friendOnlineNotificationEnabled: boolean
  // X6 — auto-update, ON by default. Widens PLAN §3's carve-out from X4's
  // opt-in tag check to a recurring check + background download against
  // GitHub Releases. Still no identifiers, no payload, no telemetry. When
  // OFF, `features/updater` never calls check() — zero outbound, the same
  // guarantee the X4 toggle carried.
  autoUpdateEnabled: boolean
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
  // A3 — off-task confidence floor ∈ [0,1] for the score machine. An off-task
  // judgment whose `on_topic_confidence` is at or above this floor is treated
  // as uncertain (skipped) rather than extending the off-task streak. Read
  // per-sample by `features/ai/focusStore.ts`; the Settings → AI slider sets
  // it. 0 disables the gate.
  offTaskConfidenceFloor: number
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
  // V3-P4 multi-monitor capture toggle. See `CaptureDisplaysMode` above.
  captureDisplays: CaptureDisplaysMode
  // V3-P6 opt-in custom window chrome. See `WindowStyleMode` above.
  windowStyle: WindowStyleMode
  // Remember the window's size and position across launches. On by default:
  // reopening where you left off is the expected desktop behavior, and a
  // fresh install is unaffected until the user actually moves or resizes
  // the window. Rust gates its boot-time restore on this flag.
  rememberWindowLayout: boolean
  // Last observed floating geometry (see `WindowLayout` above). `null` until
  // the first tracked move/resize; written debounced by WindowLayoutListener.
  windowLayout: WindowLayout | null
  // F3 — optional user-supplied Nostr signaling relays (wss:// each). Empty
  // (the default) keeps the curated DEFAULT_RELAY_URLS. When non-empty, these
  // EXTEND the built-in list (#47 A5: union via mergedRelayUrls, custom
  // first — never a replacement, which would sever discovery with friends on
  // the defaults). Stored already-validated (only wss:// entries survive the
  // setter).
  customRelayUrls: string[]
  // F3 — optional user-supplied TURN server. `null` (default) = STUN-only.
  // Stored already-validated (turn:/turns: url + non-empty creds).
  turnServer: CustomTurnServer | null
  // #47 B4 — audio preferences that used to reset every session. Device ids
  // persist the user's last explicit pick (null = OS default; acquisition
  // uses `ideal` so an unplugged device falls back gracefully). peerVolumes
  // is keyed by friend ed_pubkey_hex (peerIds are per-session), clamped 0..1.
  audioInputDeviceId: string | null
  audioOutputDeviceId: string | null
  peerVolumes: Record<string, number>
}

export const SETTINGS_FILE = 'settings.json'
// `studyvis.theme` was originally the V1 storage key (migrated into the Tauri
// store at V1-P11). V3-P5 keeps the key alive as a write-through boot cache
// so the inline script in index.html can resolve the theme synchronously
// before first paint, avoiding a FOUC of the dark canvas under light/auto.
export const THEME_LOCALSTORAGE_KEY = 'studyvis.theme'
// Backwards-compat alias for the migration code path. New code should import
// THEME_LOCALSTORAGE_KEY directly.
export const LEGACY_THEME_LOCALSTORAGE_KEY = THEME_LOCALSTORAGE_KEY
export const SETTINGS_KEY_THEME = 'theme'
export const SETTINGS_KEY_REDUCE_MOTION = 'reduce_motion'
export const SETTINGS_KEY_INVITE_NOTIFY = 'incoming_invite_notification_enabled'
export const SETTINGS_KEY_POMODORO_NOTIFY = 'pomodoro_notification_enabled'
export const SETTINGS_KEY_POMODORO_SOUND = 'pomodoro_sound_enabled'
export const SETTINGS_KEY_FRIEND_ONLINE_NOTIFY =
  'friend_online_notification_enabled'
// X4's opt-in tag check. X6 superseded it with the real updater; the key is
// still READ (never written) so a friend who deliberately turned the old
// check OFF doesn't get outbound traffic switched back on by the upgrade.
export const SETTINGS_KEY_VERSION_CHECK = 'version_check_enabled'
export const SETTINGS_KEY_AUTO_UPDATE = 'auto_update_enabled'
export const SETTINGS_KEY_MINIMIZE_TRAY = 'minimize_to_tray_on_close'
export const SETTINGS_KEY_DEBUG_LOG = 'debug_log_enabled'
export const SETTINGS_KEY_TURN_PREF = 'turn_preference'
export const SETTINGS_KEY_AI_FEATURES = 'ai_features_enabled'
export const SETTINGS_KEY_WARNING_THRESHOLD = 'warning_threshold'
export const SETTINGS_KEY_ALERT_THRESHOLD = 'alert_threshold'
export const SETTINGS_KEY_CONFIDENCE_FLOOR = 'off_task_confidence_floor'
export const SETTINGS_KEY_SAMPLE_INTERVAL = 'sample_interval_s'
export const SETTINGS_KEY_PTT_FRIENDS_ACCELERATOR = 'ptt_friends_accelerator'
export const SETTINGS_KEY_PTT_AI_ACCELERATOR = 'ptt_ai_accelerator'
export const SETTINGS_KEY_CAPTURE_DISPLAYS = 'capture_displays'
export const SETTINGS_KEY_WINDOW_STYLE = 'window_style'
export const SETTINGS_KEY_REMEMBER_WINDOW_LAYOUT = 'remember_window_layout'
export const SETTINGS_KEY_WINDOW_LAYOUT = 'window_layout'
export const SETTINGS_KEY_CUSTOM_RELAYS = 'custom_relay_urls'
export const SETTINGS_KEY_TURN_SERVER = 'turn_server'
export const SETTINGS_KEY_AUDIO_INPUT_DEVICE = 'audio_input_device_id'
export const SETTINGS_KEY_AUDIO_OUTPUT_DEVICE = 'audio_output_device_id'
export const SETTINGS_KEY_PEER_VOLUMES = 'peer_volumes'

// Defaults match the V1 acceptance criteria + DESIGN-SYSTEM.md §8.5: dark
// theme on, reduce-motion off, OS notification on for invites, minimize-to-
// tray on (preserves V1-P7 behavior), debug log off, TURN auto, AI off.
// Threshold defaults are PLAN.md §5 V2 "first 2 / next 2".
export const DEFAULT_SETTINGS: SettingsValues = {
  theme: 'dark',
  reduceMotion: false,
  incomingInviteNotificationEnabled: true,
  // N2 opt-out (on), N6 opt-in (off), N3 opt-in (off), X6 opt-out (on).
  pomodoroNotificationEnabled: true,
  pomodoroSoundEnabled: false,
  friendOnlineNotificationEnabled: false,
  autoUpdateEnabled: true,
  minimizeToTrayOnClose: true,
  debugLogEnabled: false,
  turnPreference: 'auto',
  aiFeaturesEnabled: false,
  warningThreshold: 2,
  alertThreshold: 4,
  // A3 — mirrors scoreMachine.DEFAULT_CONFIDENCE_FLOOR (0.6). Duplicated here
  // rather than imported to keep the settings store free of any
  // `@/features/ai` import (same boundary the threshold defaults respect).
  offTaskConfidenceFloor: 0.6,
  sampleIntervalSec: null,
  pttFriendsAccelerator: PTT_FRIENDS_DEFAULT_ACCELERATOR,
  pttAiAccelerator: PTT_AI_DEFAULT_ACCELERATOR,
  captureDisplays: 'primary',
  // System chrome is the v1.0.3 shipped behavior — keep it as the default
  // so a fresh install or a missing-key file matches what users have today.
  windowStyle: 'system',
  // On by default (see the field comment): no visible change until the user
  // moves or resizes the window, after which reopening in place is the
  // behavior every other desktop app trained them to expect.
  rememberWindowLayout: true,
  windowLayout: null,
  // F3 — empty by default: the curated relays + STUN-only behavior is exactly
  // what ships today, so a fresh install is unchanged.
  customRelayUrls: [],
  turnServer: null,
  // #47 B4 — no persisted device/volume prefs until the user picks some.
  audioInputDeviceId: null,
  audioOutputDeviceId: null,
  peerVolumes: {},
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
  setPomodoroNotificationEnabled: (enabled: boolean) => Promise<void>
  setPomodoroSoundEnabled: (enabled: boolean) => Promise<void>
  setFriendOnlineNotificationEnabled: (enabled: boolean) => Promise<void>
  setAutoUpdateEnabled: (enabled: boolean) => Promise<void>
  setMinimizeToTrayOnClose: (enabled: boolean) => Promise<void>
  setDebugLogEnabled: (enabled: boolean) => Promise<void>
  setTurnPreference: (pref: TurnPreference) => Promise<void>
  // F3 — persist the user's custom signaling relays. The argument is the raw
  // textarea text; the store parses + validates + dedupes via parseRelayUrls
  // and stores only the clean wss:// list (empty = use the built-in defaults).
  setCustomRelayUrls: (text: string) => Promise<void>
  // #47 B4 — audio preference setters (null clears back to OS default).
  setAudioInputDeviceId: (deviceId: string | null) => Promise<void>
  setAudioOutputDeviceId: (deviceId: string | null) => Promise<void>
  setPeerVolume: (edPubkeyHex: string, volume: number) => Promise<void>
  // F3 — persist (or clear) the user's TURN server. Pass the three raw fields;
  // the store normalizes them. A partial/invalid config clears the server
  // (stores null) so an incomplete edit can never leave a dead config behind.
  setTurnServer: (input: {
    url?: string
    username?: string
    credential?: string
  }) => Promise<void>
  setAiFeaturesEnabled: (enabled: boolean) => Promise<void>
  setWarningThreshold: (count: number) => Promise<void>
  setAlertThreshold: (count: number) => Promise<void>
  // A3 — persist the off-task confidence floor ∈ [0,1]. The slider UI clamps;
  // focusStore re-clamps via `clampConfidenceFloor` at apply-time so an
  // out-of-range persisted value can never break a run.
  setOffTaskConfidenceFloor: (floor: number) => Promise<void>
  // `null` clears the override, falling back to the model benchmark cadence.
  setSampleIntervalSec: (seconds: number | null) => Promise<void>
  // V3-P3 — set the accelerator for one of the two global shortcuts. The
  // order intentionally inverts `setMinimizeToTrayOnClose` because shortcut
  // semantics are binary: registration must succeed before persistence is
  // committed, otherwise the on-disk value would disagree with the live OS
  // binding. So: optimistic in-memory set → runtime push (Rust unregister +
  // register) → on success persist via writeKey; on failure roll back the
  // in-memory value, surface the message in `error`, and rethrow so the
  // KeybindCapture stays armed for retry.
  setShortcutAccelerator: (
    action: ShortcutAction,
    accelerator: string
  ) => Promise<void>
  // Reset both accelerators to their DESIGN-SYSTEM §17 defaults.
  resetShortcutsToDefaults: () => Promise<void>
  // V3-P4 — Persist the multi-monitor capture mode. Takes effect on the next
  // sample-loop boot; in-flight loops are not reshaped.
  setCaptureDisplays: (mode: CaptureDisplaysMode) => Promise<void>
  // V3-P6 — Persist the chrome mode. Takes effect on the next process
  // launch (Rust reads the value during `setup()` and applies decorations
  // / title-bar style before the window paints). The Appearance row exposes
  // a "Relaunch now" button that calls the runtime bridge.
  setWindowStyle: (mode: WindowStyleMode) => Promise<void>
  // Toggle boot-time window-geometry restore. The tracked layout is kept
  // when this flips off — Rust gates the restore on the flag, and flipping
  // back on re-captures the live geometry immediately (WindowLayoutListener
  // does a capture whenever the flag becomes true).
  setRememberWindowLayout: (enabled: boolean) => Promise<void>
  // Persist the latest observed geometry. Called debounced by
  // WindowLayoutListener — never from UI code.
  saveWindowLayout: (layout: WindowLayout) => Promise<void>
  // Forget the remembered geometry (the Appearance → Window reset row).
  clearWindowLayout: () => Promise<void>
  // V3-P6 — Relaunch the app via the Rust runtime bridge. Used by the
  // Appearance row after a chrome toggle. Resolves immediately so the UI
  // can disarm; the process is replaced before the resolved promise is
  // observed in practice.
  relaunchApp: () => Promise<void>
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
  // V3-P6 — Calls the Rust `system_relaunch_app` command to replace the
  // process. Returns void so the JS resolution shape matches the other
  // bridges; in practice the runtime never observes the resolved promise
  // because the process is replaced.
  relaunchApp: () => Promise<void>
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
    const v = window.localStorage.getItem(THEME_LOCALSTORAGE_KEY)
    if (v === 'dark' || v === 'light' || v === 'auto') return v
  } catch {
    // localStorage may be unavailable (private mode, sandboxed iframes).
    // Treat as no legacy value.
  }
  return null
}

// V3-P5: no longer called by the migration path — localStorage now also
// serves as the boot-time theme cache (read synchronously by the inline
// script in index.html), so clearing it would re-introduce a FOUC on the
// next launch. Kept for the dep-injection seam used by existing tests.
function clearLegacyThemeInLocalStorage(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(THEME_LOCALSTORAGE_KEY)
  } catch {
    // No-op: same fallthrough as the read path.
  }
}

function writeThemeBootCache(mode: ThemeMode): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(THEME_LOCALSTORAGE_KEY, mode)
  } catch {
    // localStorage may be unavailable — boot cache is best-effort. The
    // persistent Tauri store is still the source of truth; the next boot
    // just won't get the pre-paint hint.
  }
}

// V3-P6 — Window style boot cache. App.tsx reads this synchronously on
// first render to decide whether to mount the TitleBar component, and
// freezes the value for the process's lifetime (toggling mid-process
// would paint a custom titlebar over the still-native decoration). Mirror
// of the theme boot cache pattern in `writeThemeBootCache`.
export const WINDOW_STYLE_LOCALSTORAGE_KEY = 'studyvis.windowStyle'

function writeWindowStyleBootCache(mode: WindowStyleMode): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(WINDOW_STYLE_LOCALSTORAGE_KEY, mode)
  } catch {
    // Best-effort: Rust still reads the canonical value from settings.json
    // during `setup()`, so a missing cache only costs us one frame of
    // potential mismatch between the OS chrome and the React layer at
    // launch — which is harmless if both agree on 'system'.
  }
}

// Reads the persisted window-style choice from localStorage. Returns
// `'system'` for any failure path (missing key, value not in the enum,
// localStorage unavailable) so a fresh install matches the default.
export function readWindowStyleBootCache(): WindowStyleMode {
  if (typeof window === 'undefined') return 'system'
  try {
    const v = window.localStorage.getItem(WINDOW_STYLE_LOCALSTORAGE_KEY)
    return v === 'custom' ? 'custom' : 'system'
  } catch {
    return 'system'
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
    relaunchApp: async () => {
      if (!isTauriRuntime()) return
      await invoke('system_relaunch_app')
    },
  },
}

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'dark' || v === 'light' || v === 'auto'
}

export function isTurnPreference(v: unknown): v is TurnPreference {
  return v === 'auto' || v === 'always' || v === 'never'
}

// F3 — a signaling relay must be a wss:// URL (Nostr over secure WebSocket).
// ws:// is rejected: trystero's Nostr strategy and the relays it talks to are
// wss-only, and a plaintext relay would also break under the app's CSP.
//
// Validation parses with `new URL()` rather than a regex so it mirrors what
// `new WebSocket(url)` itself will accept. A regex like /^wss:\/\/\S+$/ admits
// values the WebSocket constructor rejects synchronously — `wss://[bad` and
// `wss://#x` fail URL parsing (SyntaxError), and `wss://host/#frag` parses but
// WebSocket throws on a non-empty fragment. Any of those, once persisted,
// would throw out of trystero's first `new WebSocket()` inside `joinTopic` at
// boot and (with no React error boundary) blank the app. We reject them here
// so a saved relay can never brick discovery.
export function isValidRelayUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false
  let parsed: URL
  try {
    parsed = new URL(v.trim())
  } catch {
    return false
  }
  // protocol includes the trailing colon. WebSocket also forbids a fragment.
  return parsed.protocol === 'wss:' && parsed.hash === ''
}

// F3 — split a multiline textarea into a clean, validated, deduped relay list.
// Blank lines and anything that isn't a wss:// URL are dropped silently; the UI
// flags "some lines were ignored" so the user isn't left guessing.
export function parseRelayUrls(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[\r\n]+/)) {
    const url = raw.trim()
    if (!isValidRelayUrl(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

// F3 — a TURN url must be turn:/turns: (RFC 7065). turns: is TURN-over-TLS.
export function isValidTurnUrl(v: unknown): v is string {
  return typeof v === 'string' && /^turns?:\S+$/i.test(v.trim())
}

// F3 — accept a TURN server only when all three fields are present and the url
// scheme is valid. A partial config returns null so the store never persists a
// half-built server that would silently never activate.
export function normalizeTurnServer(input: {
  url?: string
  username?: string
  credential?: string
}): CustomTurnServer | null {
  const url = (input.url ?? '').trim()
  const username = (input.username ?? '').trim()
  const credential = (input.credential ?? '').trim()
  if (
    !isValidTurnUrl(url) ||
    username.length === 0 ||
    credential.length === 0
  ) {
    return null
  }
  return { url, username, credential }
}

function isCustomTurnServer(v: unknown): v is CustomTurnServer {
  if (!v || typeof v !== 'object') return false
  const t = v as Partial<CustomTurnServer>
  return (
    isValidTurnUrl(t.url) &&
    typeof t.username === 'string' &&
    t.username.length > 0 &&
    typeof t.credential === 'string' &&
    t.credential.length > 0
  )
}

function readCustomRelayUrls(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of v) {
    if (!isValidRelayUrl(item)) continue
    const url = (item as string).trim()
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

export function isCaptureDisplaysMode(v: unknown): v is CaptureDisplaysMode {
  return v === 'primary' || v === 'all'
}

export function isWindowStyleMode(v: unknown): v is WindowStyleMode {
  return v === 'system' || v === 'custom'
}

// Fail closed on any malformed persisted geometry: Rust re-validates against
// live monitors at boot, but the JS side also refuses to hydrate garbage so
// a hand-edited settings.json can't feed NaN/negative sizes back into the
// tracker's merge path. Positions may legitimately be negative (a monitor
// left of or above the primary), sizes may not.
export function isWindowLayout(v: unknown): v is WindowLayout {
  if (!v || typeof v !== 'object') return false
  const l = v as Partial<WindowLayout>
  return (
    typeof l.width === 'number' &&
    Number.isFinite(l.width) &&
    l.width > 0 &&
    typeof l.height === 'number' &&
    Number.isFinite(l.height) &&
    l.height > 0 &&
    typeof l.x === 'number' &&
    Number.isFinite(l.x) &&
    typeof l.y === 'number' &&
    Number.isFinite(l.y) &&
    typeof l.scaleFactor === 'number' &&
    Number.isFinite(l.scaleFactor) &&
    l.scaleFactor > 0 &&
    typeof l.maximized === 'boolean'
  )
}

function readBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

// #47 B4 — `null`/absent/garbage all collapse to null ("OS default").
function readNullableString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

// #47 B4 — per-friend volumes: keep only finite numeric entries, clamped to
// the 0..1 range VideoTile's volume prop expects.
function readPeerVolumes(v: unknown): Record<string, number> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(v)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = Math.min(1, Math.max(0, value))
    }
  }
  return out
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
    pomodoroNotify: await store.get(SETTINGS_KEY_POMODORO_NOTIFY),
    pomodoroSound: await store.get(SETTINGS_KEY_POMODORO_SOUND),
    friendOnline: await store.get(SETTINGS_KEY_FRIEND_ONLINE_NOTIFY),
    versionCheck: await store.get(SETTINGS_KEY_VERSION_CHECK),
    autoUpdate: await store.get(SETTINGS_KEY_AUTO_UPDATE),
    tray: await store.get(SETTINGS_KEY_MINIMIZE_TRAY),
    debug: await store.get(SETTINGS_KEY_DEBUG_LOG),
    turn: await store.get(SETTINGS_KEY_TURN_PREF),
    ai: await store.get(SETTINGS_KEY_AI_FEATURES),
    warning: await store.get(SETTINGS_KEY_WARNING_THRESHOLD),
    alert: await store.get(SETTINGS_KEY_ALERT_THRESHOLD),
    confidenceFloor: await store.get(SETTINGS_KEY_CONFIDENCE_FLOOR),
    sampleInterval: await store.get(SETTINGS_KEY_SAMPLE_INTERVAL),
    pttFriends: await store.get(SETTINGS_KEY_PTT_FRIENDS_ACCELERATOR),
    pttAi: await store.get(SETTINGS_KEY_PTT_AI_ACCELERATOR),
    captureDisplays: await store.get(SETTINGS_KEY_CAPTURE_DISPLAYS),
    windowStyle: await store.get(SETTINGS_KEY_WINDOW_STYLE),
    rememberWindowLayout: await store.get(SETTINGS_KEY_REMEMBER_WINDOW_LAYOUT),
    windowLayout: await store.get(SETTINGS_KEY_WINDOW_LAYOUT),
    customRelays: await store.get(SETTINGS_KEY_CUSTOM_RELAYS),
    turnServer: await store.get(SETTINGS_KEY_TURN_SERVER),
    audioInput: await store.get(SETTINGS_KEY_AUDIO_INPUT_DEVICE),
    audioOutput: await store.get(SETTINGS_KEY_AUDIO_OUTPUT_DEVICE),
    peerVolumes: await store.get(SETTINGS_KEY_PEER_VOLUMES),
  }

  let theme: ThemeMode = isThemeMode(stored.theme)
    ? stored.theme
    : DEFAULT_SETTINGS.theme
  let wroteMigration = false

  // The localStorage key is consulted on hydration when the persistent
  // Tauri store has no theme value — typically a fresh install with a V1
  // history, or now also when the boot cache disagrees with the store.
  // localStorage is left intact (V3-P5): it doubles as the pre-paint cache
  // for the inline script in index.html, and clearing it would re-introduce
  // a FOUC on the next launch.
  if (!isThemeMode(stored.theme)) {
    const legacy = migrator.readLegacyTheme()
    if (legacy) {
      theme = legacy
      await store.set(SETTINGS_KEY_THEME, legacy)
      await store.save()
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
      pomodoroNotificationEnabled: readBool(
        stored.pomodoroNotify,
        DEFAULT_SETTINGS.pomodoroNotificationEnabled
      ),
      pomodoroSoundEnabled: readBool(
        stored.pomodoroSound,
        DEFAULT_SETTINGS.pomodoroSoundEnabled
      ),
      friendOnlineNotificationEnabled: readBool(
        stored.friendOnline,
        DEFAULT_SETTINGS.friendOnlineNotificationEnabled
      ),
      // X6 one-way migration, evaluated newest-key-first:
      //   auto_update_enabled set        → honor it;
      //   only the X4 version_check key  → honor that (an explicit OFF stays
      //                                    OFF — we don't switch outbound
      //                                    traffic back on behind their back);
      //   neither                        → default ON.
      autoUpdateEnabled: readBool(
        stored.autoUpdate,
        readBool(stored.versionCheck, DEFAULT_SETTINGS.autoUpdateEnabled)
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
      offTaskConfidenceFloor: readNumber(
        stored.confidenceFloor,
        DEFAULT_SETTINGS.offTaskConfidenceFloor
      ),
      sampleIntervalSec: readNullableNumber(stored.sampleInterval),
      pttFriendsAccelerator: readAccelerator(
        stored.pttFriends,
        DEFAULT_SETTINGS.pttFriendsAccelerator
      ),
      pttAiAccelerator: readAccelerator(
        stored.pttAi,
        DEFAULT_SETTINGS.pttAiAccelerator
      ),
      captureDisplays: isCaptureDisplaysMode(stored.captureDisplays)
        ? stored.captureDisplays
        : DEFAULT_SETTINGS.captureDisplays,
      windowStyle: isWindowStyleMode(stored.windowStyle)
        ? stored.windowStyle
        : DEFAULT_SETTINGS.windowStyle,
      rememberWindowLayout: readBool(
        stored.rememberWindowLayout,
        DEFAULT_SETTINGS.rememberWindowLayout
      ),
      windowLayout: isWindowLayout(stored.windowLayout)
        ? stored.windowLayout
        : DEFAULT_SETTINGS.windowLayout,
      customRelayUrls: readCustomRelayUrls(stored.customRelays),
      turnServer: isCustomTurnServer(stored.turnServer)
        ? stored.turnServer
        : DEFAULT_SETTINGS.turnServer,
      audioInputDeviceId: readNullableString(stored.audioInput),
      audioOutputDeviceId: readNullableString(stored.audioOutput),
      peerVolumes: readPeerVolumes(stored.peerVolumes),
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
      // Keep the boot cache in sync with the authoritative Tauri store value.
      // Idempotent — covers the transition launch for existing installs that
      // never re-picked their theme after V3-P5 landed.
      writeThemeBootCache(values.theme)
      // Same one-shot sync for the V3-P6 window-style boot cache: existing
      // installs that ship default 'system' get the cache seeded so the
      // next launch agrees with disk without waiting for hydration. A user
      // who has already opted into 'custom' was the one who set the cache,
      // so this rewrites the same value (idempotent).
      writeWindowStyleBootCache(values.windowStyle)
      // V3-P7 — Same one-shot sync for the reduced-motion boot cache so
      // the inline pre-paint script in index.html / ai-dialog.html resolves
      // the right value on the next launch (and on the ai-dialog window,
      // which never hydrates this store).
      writeReduceMotionBootCache(values.reduceMotion)
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
    // Write-through to the localStorage boot cache so the next launch's
    // inline script (index.html) applies the right token map before first
    // paint. Synchronous; fire-and-forget the Tauri-store write after.
    writeThemeBootCache(mode)
    await writeKey(set, SETTINGS_KEY_THEME, mode)
  },

  setReduceMotion: async (enabled) => {
    set((s) => ({ values: { ...s.values, reduceMotion: enabled } }))
    // V3-P7 — write-through to the localStorage boot cache before the
    // persistent store. Synchronous, mirrors the theme pattern. Cross-window
    // sync (main writes → ai-dialog reads) rides the `storage` event the
    // browser fires in other same-origin windows.
    writeReduceMotionBootCache(enabled)
    await writeKey(set, SETTINGS_KEY_REDUCE_MOTION, enabled)
  },

  setIncomingInviteNotificationEnabled: async (enabled) => {
    set((s) => ({
      values: { ...s.values, incomingInviteNotificationEnabled: enabled },
    }))
    await writeKey(set, SETTINGS_KEY_INVITE_NOTIFY, enabled)
  },

  setPomodoroNotificationEnabled: async (enabled) => {
    set((s) => ({
      values: { ...s.values, pomodoroNotificationEnabled: enabled },
    }))
    await writeKey(set, SETTINGS_KEY_POMODORO_NOTIFY, enabled)
  },

  setPomodoroSoundEnabled: async (enabled) => {
    set((s) => ({ values: { ...s.values, pomodoroSoundEnabled: enabled } }))
    await writeKey(set, SETTINGS_KEY_POMODORO_SOUND, enabled)
  },

  setFriendOnlineNotificationEnabled: async (enabled) => {
    set((s) => ({
      values: { ...s.values, friendOnlineNotificationEnabled: enabled },
    }))
    await writeKey(set, SETTINGS_KEY_FRIEND_ONLINE_NOTIFY, enabled)
  },

  setAutoUpdateEnabled: async (enabled) => {
    set((s) => ({ values: { ...s.values, autoUpdateEnabled: enabled } }))
    await writeKey(set, SETTINGS_KEY_AUTO_UPDATE, enabled)
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

  setCustomRelayUrls: async (text) => {
    const urls = parseRelayUrls(text)
    set((s) => ({ values: { ...s.values, customRelayUrls: urls } }))
    await writeKey(set, SETTINGS_KEY_CUSTOM_RELAYS, urls)
  },

  setAudioInputDeviceId: async (deviceId) => {
    set((s) => ({ values: { ...s.values, audioInputDeviceId: deviceId } }))
    await writeKey(set, SETTINGS_KEY_AUDIO_INPUT_DEVICE, deviceId)
  },

  setAudioOutputDeviceId: async (deviceId) => {
    set((s) => ({ values: { ...s.values, audioOutputDeviceId: deviceId } }))
    await writeKey(set, SETTINGS_KEY_AUDIO_OUTPUT_DEVICE, deviceId)
  },

  setPeerVolume: async (edPubkeyHex, volume) => {
    const clamped = Math.min(1, Math.max(0, volume))
    const next = { ...get().values.peerVolumes, [edPubkeyHex]: clamped }
    set((s) => ({ values: { ...s.values, peerVolumes: next } }))
    await writeKey(set, SETTINGS_KEY_PEER_VOLUMES, next)
  },

  setTurnServer: async (input) => {
    const server = normalizeTurnServer(input)
    set((s) => ({ values: { ...s.values, turnServer: server } }))
    await writeKey(set, SETTINGS_KEY_TURN_SERVER, server)
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

  // Range enforcement lives in the Settings → AI slider UI; focusStore
  // re-clamps via `clampConfidenceFloor` at apply-time, so an out-of-range
  // persisted value can never break a run.
  setOffTaskConfidenceFloor: async (floor) => {
    set((s) => ({ values: { ...s.values, offTaskConfidenceFloor: floor } }))
    await writeKey(set, SETTINGS_KEY_CONFIDENCE_FLOOR, floor)
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

  setCaptureDisplays: async (mode) => {
    set((s) => ({ values: { ...s.values, captureDisplays: mode } }))
    await writeKey(set, SETTINGS_KEY_CAPTURE_DISPLAYS, mode)
  },

  setWindowStyle: async (mode) => {
    // Optimistic in-memory set, then write through to the localStorage
    // boot cache *and* the Tauri persistent store. The decoration /
    // title-bar-style swap happens at the *next* Rust `setup()` boot —
    // the Appearance row surfaces a "Relaunch now" button so the user
    // can act on the toggle immediately. No runtime push: a live swap
    // would be unreliable on macOS (tauri-apps/tauri#9673, #12042), and
    // rendering the TitleBar immediately would paint over the still-
    // native decoration (double titlebar). The boot-cache write is
    // synchronous so the very next process launch — including the one
    // started by `relaunchApp` — sees the right value before paint.
    set((s) => ({ values: { ...s.values, windowStyle: mode } }))
    writeWindowStyleBootCache(mode)
    await writeKey(set, SETTINGS_KEY_WINDOW_STYLE, mode)
  },

  setRememberWindowLayout: async (enabled) => {
    set((s) => ({ values: { ...s.values, rememberWindowLayout: enabled } }))
    await writeKey(set, SETTINGS_KEY_REMEMBER_WINDOW_LAYOUT, enabled)
  },

  saveWindowLayout: async (layout) => {
    set((s) => ({ values: { ...s.values, windowLayout: layout } }))
    await writeKey(set, SETTINGS_KEY_WINDOW_LAYOUT, layout)
  },

  clearWindowLayout: async () => {
    set((s) => ({ values: { ...s.values, windowLayout: null } }))
    await writeKey(set, SETTINGS_KEY_WINDOW_LAYOUT, null)
  },

  relaunchApp: async () => {
    try {
      await activeDeps.runtime.relaunchApp()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('relaunchApp failed:', err)
      set({ error: message })
    }
  },
}))
