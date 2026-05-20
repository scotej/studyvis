// V3-P6 — Pure helpers for the opt-in custom window chrome.
//
// The titlebar component is the only consumer today. Splitting the logic
// out keeps it node-testable (`tests/unit/window-chrome.test.ts`) and lets
// the Rust setup code stay in sync with the JS-side rendering without
// duplicating constants: the platform detection is JS-only because the
// Rust side already knows the target via `cfg!(target_os = ...)`.

import { tokens } from '@/design/tokens'

// 'mac' and 'windows' are the two platforms StudyVis ships installers for
// (PLAN.md §5). Linux is not part of the V1+V2 release matrix; if the app
// somehow runs there, we fall through to 'windows' chrome shape — a
// functional rendering rather than a hard-coded "macOS only" fallback. The
// custom chrome setting itself stays opt-in everywhere.
export type ChromePlatform = 'mac' | 'windows'

// Detects the host platform from `navigator.userAgent`. Mirror the regex
// used by `isMacLikePlatform` in `src/lib/utils.ts` so the two helpers
// stay aligned. Pure: takes the UA string as an explicit argument so unit
// tests can drive both branches without monkey-patching `navigator`.
export function detectChromePlatformFromUA(userAgent: string): ChromePlatform {
  if (/Mac|iPhone|iPad|iPod/.test(userAgent)) return 'mac'
  return 'windows'
}

export function detectChromePlatform(): ChromePlatform {
  if (typeof navigator === 'undefined') return 'windows'
  return detectChromePlatformFromUA(navigator.userAgent)
}

// The order of Windows window controls, left-to-right inside the cluster
// on the right edge of the titlebar. macOS hosts the system traffic
// lights (rendered by AppKit via `TitleBarStyle::Overlay`) on the left,
// so the cluster is empty on that platform.
export type WindowControl = 'minimize' | 'maximize' | 'close'

export function windowControlOrder(
  platform: ChromePlatform
): readonly WindowControl[] {
  if (platform === 'mac') return []
  return ['minimize', 'maximize', 'close']
}

// Left padding for the wordmark / drag region. On macOS the OS-rendered
// traffic lights occupy the first ~78 px; on Windows the wordmark sits at
// a small calm padding (space.4 = 16 px) from the left edge.
export function titleBarLeftInsetPx(platform: ChromePlatform): number {
  if (platform === 'mac') return tokens.sizes.titleBarMacInset
  return tokens.space[4]
}

export function titleBarHeightPx(): number {
  return tokens.sizes.titleBarHeight
}
