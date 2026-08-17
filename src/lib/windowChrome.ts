// V3-P6 — Pure helpers for the opt-in custom window chrome.
//
// The titlebar component is the only consumer today. Splitting the logic
// out keeps it node-testable (`tests/unit/window-chrome.test.ts`) and lets
// the Rust setup code stay in sync with the JS-side rendering without
// duplicating constants: the platform detection is JS-only because the
// Rust side already knows the target via `cfg!(target_os = ...)`.

import { tokens } from '@/design/tokens'

// Linux uses the same right-side control order as Windows, but stays explicit
// in the type so platform-specific behavior cannot silently fall through when
// the supported desktop matrix changes again.
export type ChromePlatform = 'mac' | 'windows' | 'linux'

// Detects the host platform from `navigator.userAgent`. Mirror the regex
// used by `isMacLikePlatform` in `src/lib/utils.ts` so the two helpers
// stay aligned. Pure: takes the UA string as an explicit argument so unit
// tests can drive both branches without monkey-patching `navigator`.
export function detectChromePlatformFromUA(userAgent: string): ChromePlatform {
  if (/Mac|iPhone|iPad|iPod/.test(userAgent)) return 'mac'
  if (/Linux|X11/.test(userAgent)) return 'linux'
  return 'windows'
}

export function detectChromePlatform(): ChromePlatform {
  if (typeof navigator === 'undefined') return 'windows'
  return detectChromePlatformFromUA(navigator.userAgent)
}

// Windows and Linux host controls on the right. macOS keeps the native system
// traffic lights on the left, so the React cluster is empty there.
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
