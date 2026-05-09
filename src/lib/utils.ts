import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// DESIGN-SYSTEM.md §17 wants the OS-native modifier glyph in shortcut
// hints (`⌘` on macOS, literal `Ctrl` on others). `userAgent` regex is the
// portable check inside the WebView; the `navigator` guard keeps this safe
// to import in node-env tests.
export function isMacLikePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
}
