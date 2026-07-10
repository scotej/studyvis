import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// Standard shadcn classname combiner: clsx for conditional joining, then
// tailwind-merge so a caller-supplied class beats a same-property default
// ("p-2" passed after "p-4" wins instead of both landing in the DOM).
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
