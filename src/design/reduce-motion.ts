import { useEffect, useLayoutEffect, useMemo, useState } from 'react'

import { useSettingsStore } from '@/stores/settingsStore'

// V3-P7 — Central reduced-motion source of truth.
//
// Two inputs, OR'd: the V1-P11 `reduce_motion` setting and the OS
// `prefers-reduced-motion: reduce` media query. Either one enables reduced
// motion, and a CSS-layer kill switch in `src/design/index.css` (keyed off
// `documentElement[data-reduce-motion='true']`) makes every animation and
// transition near-instant. Three writers keep that attribute in sync:
//   1. Inline scripts in `index.html` + `ai-dialog.html` (pre-paint, no
//      one-frame flash of motion if the user opted in).
//   2. `<ApplyReduceMotion />` after React hydrates.
//   3. matchMedia + storage listeners for runtime changes.
//
// Today the §6 enter/leave animations (dialog/sheet/popover/tooltip) don't
// run anyway because no animate-css plugin is installed — what this
// mechanism actually kills today is the ScoreGauge sweep, `animate-pulse`
// skeletons, sonner's slide-in, and every state-change transition. The
// kill switch is still the right shape: any motion added later
// (e.g. V3-P8's audit may install `tw-animate-css`) is automatically
// gated, so no future component can forget to respect the preference.

export const REDUCE_MOTION_LOCALSTORAGE_KEY = 'studyvis.reduceMotion'

// Pure decision function — OR semantics. Either source turns motion off;
// the setting is the active opt-in, the OS query is the passive one.
// Exported separately from the React hook so it's node-testable without a
// matchMedia / window stub.
export function resolveReduceMotion(
  setting: boolean,
  osPrefersReduce: boolean
): boolean {
  return setting || osPrefersReduce
}

// Write-through to the localStorage boot cache. Mirrors the theme cache
// pattern in settingsStore.ts so the inline pre-paint script can resolve
// the value synchronously before React hydrates.
//
// A `storage` event fires in OTHER same-origin windows (not the writer) —
// that's how the ai-dialog window reacts when the main window's settings
// toggle changes. Web-standard behaviour: same-window writes don't trigger
// the same-window event; the React hook there is driven by the Zustand
// store update instead, so both windows stay coherent.
export function writeReduceMotionBootCache(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      REDUCE_MOTION_LOCALSTORAGE_KEY,
      enabled ? 'true' : 'false'
    )
  } catch {
    // localStorage may be unavailable (private mode, sandboxed iframes).
    // Best-effort: the persistent Tauri store remains the source of truth
    // and the next launch will re-seed the cache during hydrate().
  }
}

// Reads the boot cache. Defaults to `false` (motion enabled) on every
// failure path so a fresh install matches `DEFAULT_SETTINGS.reduceMotion`.
export function readReduceMotionBootCache(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return (
      window.localStorage.getItem(REDUCE_MOTION_LOCALSTORAGE_KEY) === 'true'
    )
  } catch {
    return false
  }
}

function readOsPrefersReduce(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// React hook — subscribes to both sources and returns the resolved boolean.
// Side-effect free read: callers get the value, the DOM attribute write
// lives in `<ApplyReduceMotion />` so multiple call-sites don't double up
// on the attribute set.
//
// While the settings store is still hydrating (`status !== 'ready'`) the
// hook falls back to the boot cache. That's load-bearing for the ai-dialog
// window: it never calls `hydrate()`, so its store sits in 'loading'
// forever and the cache is the only on-disk source available.
export function useReduceMotion(): boolean {
  const status = useSettingsStore((s) => s.status)
  const settingValue = useSettingsStore((s) => s.values.reduceMotion)
  const [osPrefer, setOsPrefer] = useState<boolean>(readOsPrefersReduce)
  const [cachedSetting, setCachedSetting] = useState<boolean>(
    readReduceMotionBootCache
  )

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setOsPrefer(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (e: StorageEvent) => {
      if (e.key === REDUCE_MOTION_LOCALSTORAGE_KEY) {
        setCachedSetting(readReduceMotionBootCache())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Memo the choice between live and cached so a string of unrelated
  // re-renders doesn't churn the resolved boolean.
  const effectiveSetting = useMemo(
    () => (status === 'ready' ? settingValue : cachedSetting),
    [status, settingValue, cachedSetting]
  )
  return resolveReduceMotion(effectiveSetting, osPrefer)
}

// Sets `documentElement.dataset.reduceMotion` to the current resolved value.
// Mounted once at the root of each entry point (App.tsx for the main window,
// ai-dialog-main.tsx for the floating window). Uses `useLayoutEffect` so the
// attribute is written before the next paint — the inline boot script has
// already set it pre-paint, this just keeps it accurate after hydration.
export function ApplyReduceMotion(): null {
  const reduce = useReduceMotion()
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.dataset.reduceMotion = reduce ? 'true' : 'false'
  }, [reduce])
  return null
}
