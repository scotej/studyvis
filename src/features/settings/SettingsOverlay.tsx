import { useEffect, useRef } from 'react'

import { tokens } from '@/design/tokens'
import { titleBarHeightPx } from '@/lib/windowChrome'
import { readWindowStyleBootCache } from '@/stores/settingsStore'
import { strings } from '@/strings'

import { Settings, type SettingsCategoryId } from './Settings'

// Frozen at module import — imports run at boot, before any Appearance
// toggle can rewrite the localStorage cache. Reading the cache per render
// would desync the inset from the chrome actually applied this process the
// moment the user flips Window style with the relaunch still pending
// (re-covering the custom titlebar's window controls — the exact defect
// the inset exists to fix). A useState initializer isn't enough here: the
// overlay remounts on every open.
const BOOTED_WINDOW_STYLE = readWindowStyleBootCache()

export type SettingsOverlayProps = {
  initialCategory?: SettingsCategoryId
  onClose: () => void
}

// #47 B2 — full-screen Settings hosted ABOVE a still-mounted SessionView.
// Home used to return SessionView before the settings branch was ever
// evaluated, so Settings was unreachable during a live session — while
// shipped error copy ("Pick a model in Settings → AI", "AI model crashed.
// Restart it in Settings → AI.") told users to go there; following it meant
// leaving, which in a 2-person session ends it for everyone. Home renders
// this over the session (and marks the session subtree inert) so media,
// peers, and the AI loop keep running underneath.
export function SettingsOverlay({
  initialCategory,
  onClose,
}: SettingsOverlayProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  // Esc closes the overlay — but only when no Radix modal is open: a
  // dialog inside Settings (confirm sheets, etc.) portals to <body> and owns
  // that Esc; closing the whole overlay underneath it would be jarring.
  // (This root is not aria-modal, so it never appears in the query.)
  // SessionView's Esc-to-leave independently ignores Esc while any
  // aria-modal element or this overlay is present.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('[aria-modal="true"]')) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Dialog-pattern focus contract (WCAG 2.4.3): Home marks the session
  // subtree inert while this overlay is up, which silently drops focus to
  // <body> — a keyboard/SR user got no announcement the dialog opened and
  // had to Tab from the document top; on close, focus landed back at the
  // top instead of on the gear button that opened it. Capture the opener,
  // move focus onto the dialog root, restore on unmount. Home removes the
  // overlay and the inert attribute in the same commit, so by the time this
  // cleanup runs the opener is un-inerted again; a disconnected opener (a
  // dismissed error toast's "Open settings" action) is skipped.
  useEffect(() => {
    // Capture-once via ref: StrictMode's dev double-invoke re-runs this
    // setup after the first run already moved focus onto the dialog, so a
    // per-run capture would record the dialog itself (or <body>) as the
    // opener and restore focus nowhere. The ref survives the remount; the
    // contains() guard skips any capture that already landed inside the
    // overlay.
    if (
      !openerRef.current &&
      document.activeElement instanceof HTMLElement &&
      !rootRef.current?.contains(document.activeElement)
    ) {
      openerRef.current = document.activeElement
    }
    rootRef.current?.focus()
    return () => {
      const opener = openerRef.current
      if (opener && opener.isConnected) opener.focus()
    }
  }, [])

  // Under the opt-in custom chrome the 38px TitleBar band must stay visible
  // and interactive above this overlay — covering it hides the min/restore/
  // close cluster and the drag region for as long as Settings is open.
  const chromeInsetTop =
    BOOTED_WINDOW_STYLE === 'custom' ? titleBarHeightPx() : 0

  return (
    <div
      ref={rootRef}
      role="dialog"
      // Deliberately NOT aria-modal: the session subtree is already inert
      // (Home sets it — that is the real modality fence), and under custom
      // chrome the TitleBar band above this overlay stays interactive;
      // aria-modal would tell AT to ignore window controls sighted users
      // can click. SessionView's Esc guard matches data-settings-overlay.
      data-settings-overlay=""
      aria-label={strings.settings.heading}
      tabIndex={-1}
      // overflow-y-auto: SettingsLayout is h-full and scrolls internally,
      // but the Report and Recover views that REPLACE the settings shell
      // (see Settings.tsx) size to content and need this ancestor scroll
      // container.
      className="fixed inset-x-0 bottom-0 overflow-y-auto bg-bg-base"
      style={{ top: chromeInsetTop, zIndex: tokens.zIndex.overlay }}
    >
      <Settings initialCategory={initialCategory} onClose={onClose} />
    </div>
  )
}
