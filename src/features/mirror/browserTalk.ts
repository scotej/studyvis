import {
  comboFromKeyboardEvent,
  combosEqual,
  isModifierCode,
  type Combo,
  type Platform,
} from '@/lib/keybindings'
import { MAX_HOLD_MS } from '@/stores/pttStore'

export type BrowserTalkState = {
  held: boolean
  microphoneOpen: boolean
  active: boolean
}

export type BrowserTalk = {
  getState: () => BrowserTalkState
  press: (source?: string) => void
  release: (source?: string) => void
  blur: () => void
  setMicrophoneOpen: (open: boolean) => void
  reset: () => void
}

export function createBrowserTalk(
  onChange: (state: BrowserTalkState) => void
): BrowserTalk {
  const sources = new Set<string>()
  let microphoneOpen = false
  let expired = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let state: BrowserTalkState = {
    held: false,
    microphoneOpen: false,
    active: false,
  }
  const publish = () => {
    const held = sources.size > 0 && !expired
    if (held === state.held && microphoneOpen === state.microphoneOpen) return
    state = { held, microphoneOpen, active: held || microphoneOpen }
    onChange(state)
  }
  const clearHold = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    sources.clear()
    expired = false
  }
  return {
    getState: () => state,
    press: (source = 'button') => {
      if (sources.has(source)) return
      if (sources.size === 0) {
        timer = setTimeout(() => {
          timer = null
          expired = true
          publish()
        }, MAX_HOLD_MS)
      }
      sources.add(source)
      publish()
    },
    release: (source = 'button') => {
      sources.delete(source)
      if (sources.size === 0) clearHold()
      publish()
    },
    blur: () => {
      clearHold()
      publish()
    },
    setMicrophoneOpen: (open) => {
      microphoneOpen = open
      publish()
    },
    reset: () => {
      clearHold()
      microphoneOpen = false
      publish()
    },
  }
}

const EDITABLE =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'
const OPEN_MODAL =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], dialog[open]'

export function installBrowserTalkShortcut({
  target,
  document,
  talk,
  combo,
  platform,
  enabled,
}: {
  target: Window
  document: Document
  talk: BrowserTalk
  combo: Combo
  platform: Platform
  enabled: () => boolean
}): () => void {
  const shortcutCombo =
    platform === 'other'
      ? { ...combo, mod: combo.mod || combo.ctrl, ctrl: false }
      : combo
  const keydown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      (platform === 'other' && event.metaKey) ||
      !enabled() ||
      document.visibilityState !== 'visible' ||
      !document.hasFocus() ||
      document.activeElement?.closest(EDITABLE) ||
      document.querySelector(OPEN_MODAL) ||
      !combosEqual(comboFromKeyboardEvent(event, platform), shortcutCombo)
    )
      return
    event.preventDefault()
    talk.press('shortcut')
  }
  const keyup = (event: KeyboardEvent) => {
    if (event.code === combo.code || isModifierCode(event.code))
      talk.release('shortcut')
  }
  const blur = () => talk.blur()
  const visibility = () => {
    if (document.visibilityState !== 'visible') talk.blur()
  }
  target.addEventListener('keydown', keydown)
  target.addEventListener('keyup', keyup)
  target.addEventListener('blur', blur)
  document.addEventListener('visibilitychange', visibility)
  return () => {
    target.removeEventListener('keydown', keydown)
    target.removeEventListener('keyup', keyup)
    target.removeEventListener('blur', blur)
    document.removeEventListener('visibilitychange', visibility)
    talk.release('shortcut')
  }
}
