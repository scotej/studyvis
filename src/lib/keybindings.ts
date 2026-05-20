// V3-P3 — combo serialization, display, validation, and the per-platform
// reserved-combo denylist for the Settings → Shortcuts rebind flow.
//
// The Combo shape stays OS-agnostic and round-trips losslessly with the
// accelerator string we hand to tauri-plugin-global-shortcut. The `mod`
// modifier is the OS-primary one (Cmd on macOS, Ctrl elsewhere) — same
// mapping Tauri's `CmdOrCtrl` accelerator token uses. `ctrl` is only
// meaningful on macOS to distinguish explicit Ctrl from Cmd; on
// Windows/Linux `mod` already covers that, so a Windows capture never
// sets `ctrl`.
//
// `code` is the physical KeyboardEvent.code value (KeyA, BracketLeft, …)
// so combos stay layout-independent — a US user binding `[` still hits
// the same physical key for a friend on a UK keyboard.

export type Platform = 'mac' | 'other'

export type Combo = {
  mod: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  code: string
}

export type ShortcutAction = 'ptt-friends' | 'ptt-ai'

export const PTT_FRIENDS_DEFAULT_ACCELERATOR = 'CmdOrCtrl+['
export const PTT_AI_DEFAULT_ACCELERATOR = 'CmdOrCtrl+]'

export const DEFAULT_PTT_FRIENDS_COMBO: Combo = {
  mod: true,
  ctrl: false,
  alt: false,
  shift: false,
  code: 'BracketLeft',
}

export const DEFAULT_PTT_AI_COMBO: Combo = {
  mod: true,
  ctrl: false,
  alt: false,
  shift: false,
  code: 'BracketRight',
}

const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
])

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code)
}

// One direction of the event.code ↔ accelerator-token map. The accelerator
// tokens are the literal characters where Tauri's parse_key accepts them
// (`[`, `]`, `,`, `.`, etc.) so the default "CmdOrCtrl+[" stays the same
// shape on disk. Falling back to the event.code value itself works for the
// keyboard-types Code variants global-hotkey understands (case-insensitive
// match against the variant name).
const CODE_TO_ACCEL_TOKEN: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
}

const ACCEL_TOKEN_TO_CODE: Record<string, string> = {
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  UP: 'ArrowUp',
  DOWN: 'ArrowDown',
  LEFT: 'ArrowLeft',
  RIGHT: 'ArrowRight',
  ESC: 'Escape',
}

function codeToAcceleratorToken(code: string): string {
  if (CODE_TO_ACCEL_TOKEN[code]) return CODE_TO_ACCEL_TOKEN[code]
  // KeyA…KeyZ → A…Z; Digit0…Digit9 → 0…9
  if (code.startsWith('Key') && code.length === 4) return code.slice(3)
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5)
  // F1…F24, Space, Tab, Enter, Backspace, Delete, Home, End, PageUp,
  // PageDown, Insert, and the keyboard-types Code variants
  // (`Numpad0`…`Numpad9`, etc.) round-trip via their own variant name.
  return code
}

function acceleratorTokenToCode(token: string): string {
  const direct = ACCEL_TOKEN_TO_CODE[token]
  if (direct) return direct
  const upper = token.toUpperCase()
  if (ACCEL_TOKEN_TO_CODE[upper]) return ACCEL_TOKEN_TO_CODE[upper]
  if (token.length === 1) {
    const ch = token.toUpperCase()
    if (ch >= 'A' && ch <= 'Z') return `Key${ch}`
    if (ch >= '0' && ch <= '9') return `Digit${ch}`
  }
  return token
}

// Tauri / global-hotkey accelerator format: `Mod1+Mod2+Key`. Modifier order
// matches the convention in DESIGN-SYSTEM §17 (primary mod first, then
// Alt/Option, then Shift). `Control` is only emitted when `ctrl` is set
// explicitly (mac-only distinct-from-Cmd path).
export function comboToAccelerator(combo: Combo): string {
  const parts: string[] = []
  if (combo.mod) parts.push('CmdOrCtrl')
  if (combo.ctrl) parts.push('Control')
  if (combo.alt) parts.push('Alt')
  if (combo.shift) parts.push('Shift')
  parts.push(codeToAcceleratorToken(combo.code))
  return parts.join('+')
}

const MODIFIER_TOKENS = new Set([
  'CMDORCTRL',
  'COMMANDORCONTROL',
  'COMMANDORCTRL',
  'CMDORCONTROL',
  'CTRL',
  'CONTROL',
  'ALT',
  'OPTION',
  'SHIFT',
  'CMD',
  'COMMAND',
  'SUPER',
])

export function parseAccelerator(accelerator: string): Combo | null {
  const parts = accelerator
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length < 2) return null
  const combo: Combo = {
    mod: false,
    ctrl: false,
    alt: false,
    shift: false,
    code: '',
  }
  for (let i = 0; i < parts.length - 1; i += 1) {
    const token = parts[i].toUpperCase()
    if (
      token === 'CMDORCTRL' ||
      token === 'COMMANDORCONTROL' ||
      token === 'COMMANDORCTRL' ||
      token === 'CMDORCONTROL'
    ) {
      combo.mod = true
    } else if (token === 'CTRL' || token === 'CONTROL') {
      combo.ctrl = true
    } else if (token === 'ALT' || token === 'OPTION') {
      combo.alt = true
    } else if (token === 'SHIFT') {
      combo.shift = true
    } else if (token === 'CMD' || token === 'COMMAND' || token === 'SUPER') {
      // A persisted accelerator that used the OS-specific Cmd token
      // collapses into `mod` so display + capture stay consistent.
      combo.mod = true
    } else {
      return null
    }
  }
  const finalToken = parts[parts.length - 1]
  if (MODIFIER_TOKENS.has(finalToken.toUpperCase())) return null
  combo.code = acceleratorTokenToCode(finalToken)
  if (!combo.code) return null
  return combo
}

export function comboFromKeyboardEvent(
  event: KeyboardEvent,
  platform: Platform
): Combo {
  return {
    mod: platform === 'mac' ? event.metaKey : event.ctrlKey,
    ctrl: platform === 'mac' ? event.ctrlKey : false,
    alt: event.altKey,
    shift: event.shiftKey,
    code: event.code,
  }
}

export function combosEqual(a: Combo, b: Combo): boolean {
  return (
    a.mod === b.mod &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.code === b.code
  )
}

// Display tokens. Mac uses native glyphs (⌘ ⌥ ⇧ ⌃) per DESIGN-SYSTEM §17;
// everywhere else uses the literal words. Key-side glyphs match the OS
// convention too (↑ on mac, the same on Windows where the arrow keys are
// commonly drawn that way as well, so we keep them).
const MAC_MOD_GLYPHS = {
  mod: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
}

const OTHER_MOD_WORDS = {
  mod: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
}

const KEY_DISPLAY: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Backspace: '⌫',
  Delete: 'Del',
  Escape: 'Esc',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Insert: 'Ins',
}

export function keyDisplay(code: string): string {
  if (KEY_DISPLAY[code]) return KEY_DISPLAY[code]
  if (code.startsWith('Key') && code.length === 4) return code.slice(3)
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5)
  if (/^F\d{1,2}$/.test(code)) return code
  return code
}

// Returns the ordered list of Kbd labels that should render for this combo.
// Order on macOS: ctrl, option, shift, cmd, key (the Apple convention —
// modifier glyphs ascend in the order they sit on the keyboard, with the
// primary Cmd last next to the key). Order elsewhere: Ctrl, Alt, Shift,
// key. The trailing key is always included.
export function comboToKbdLabels(combo: Combo, platform: Platform): string[] {
  const labels: string[] = []
  if (platform === 'mac') {
    if (combo.ctrl) labels.push(MAC_MOD_GLYPHS.ctrl)
    if (combo.alt) labels.push(MAC_MOD_GLYPHS.alt)
    if (combo.shift) labels.push(MAC_MOD_GLYPHS.shift)
    if (combo.mod) labels.push(MAC_MOD_GLYPHS.mod)
  } else {
    if (combo.mod || combo.ctrl) labels.push(OTHER_MOD_WORDS.mod)
    if (combo.alt) labels.push(OTHER_MOD_WORDS.alt)
    if (combo.shift) labels.push(OTHER_MOD_WORDS.shift)
  }
  labels.push(keyDisplay(combo.code))
  return labels
}

// Compact human-readable form (for inline error copy). Uses `+` as the join
// on non-mac for clarity ("Ctrl+C") and no separator on mac to match the
// Apple convention ("⌘C").
export function comboToInlineDisplay(combo: Combo, platform: Platform): string {
  const labels = comboToKbdLabels(combo, platform)
  return platform === 'mac' ? labels.join('') : labels.join('+')
}

// Per-platform reserved-combo set. Listed in canonical accelerator form
// (the same string `comboToAccelerator` emits) so the lookup is a single
// `Set.has(...)`. The list is deliberately small — only "obvious system
// combos" per the V3-P3 brief.
export const RESERVED_MAC: ReadonlySet<string> = new Set([
  'CmdOrCtrl+Q',
  'CmdOrCtrl+W',
  'CmdOrCtrl+M',
  'CmdOrCtrl+H',
  'CmdOrCtrl+Tab',
  'CmdOrCtrl+Space',
  'CmdOrCtrl+`',
  'CmdOrCtrl+,',
  'CmdOrCtrl+A',
  'CmdOrCtrl+C',
  'CmdOrCtrl+V',
  'CmdOrCtrl+X',
  'CmdOrCtrl+Z',
  'CmdOrCtrl+Shift+Z',
  'CmdOrCtrl+Shift+3',
  'CmdOrCtrl+Shift+4',
  'CmdOrCtrl+Shift+5',
  'CmdOrCtrl+Shift+Q',
])

export const RESERVED_OTHER: ReadonlySet<string> = new Set([
  'CmdOrCtrl+C',
  'CmdOrCtrl+V',
  'CmdOrCtrl+X',
  'CmdOrCtrl+A',
  'CmdOrCtrl+Z',
  'CmdOrCtrl+Y',
  'CmdOrCtrl+W',
  'CmdOrCtrl+Tab',
  'Alt+F4',
  'Alt+Tab',
  'CmdOrCtrl+Shift+Esc',
])

export function reservedCombos(platform: Platform): ReadonlySet<string> {
  return platform === 'mac' ? RESERVED_MAC : RESERVED_OTHER
}

export type ConflictReason =
  | { kind: 'modifier_only' }
  | { kind: 'no_modifier' }
  | { kind: 'self_conflict'; otherAction: ShortcutAction }
  | { kind: 'reserved' }

export type ValidationContext = {
  otherCombo: Combo
  otherAction: ShortcutAction
  platform: Platform
}

export function validateCombo(
  combo: Combo,
  ctx: ValidationContext
): ConflictReason | null {
  if (isModifierCode(combo.code)) return { kind: 'modifier_only' }
  // Shift alone isn't enough to make a global shortcut viable — every
  // capital-letter keystroke would fire it. Require Cmd/Ctrl or Alt.
  if (!combo.mod && !combo.ctrl && !combo.alt) {
    return { kind: 'no_modifier' }
  }
  if (combosEqual(combo, ctx.otherCombo)) {
    return { kind: 'self_conflict', otherAction: ctx.otherAction }
  }
  if (reservedCombos(ctx.platform).has(comboToAccelerator(combo))) {
    return { kind: 'reserved' }
  }
  return null
}

// `describeConflict` lives in `src/lib/keybindings-copy.ts`. It reads from
// the centralised strings module, so it can't live here without dragging
// that module into every importer of these pure utilities (notably the
// settings store). Callers that need the user-facing copy import the
// adapter directly.
