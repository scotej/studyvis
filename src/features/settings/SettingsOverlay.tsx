import { useEffect, useRef } from 'react'

import { tokens } from '@/design/tokens'
import { strings } from '@/strings'

import { Settings, type SettingsCategoryId } from './Settings'

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

  // Esc closes the overlay — but only when no OTHER modal is open: a Radix
  // dialog inside Settings (confirm sheets, etc.) portals to <body> and owns
  // that Esc; closing the whole overlay underneath it would be jarring.
  // SessionView's Esc-to-leave independently ignores Esc while any
  // aria-modal element is present.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const modals = document.querySelectorAll('[aria-modal="true"]')
      for (const modal of modals) {
        if (modal !== rootRef.current) return
      }
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
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    rootRef.current?.focus()
    return () => {
      if (opener && opener.isConnected) opener.focus()
    }
  }, [])

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={strings.settings.heading}
      tabIndex={-1}
      className="fixed inset-0 overflow-y-auto bg-bg-base"
      style={{ zIndex: tokens.zIndex.overlay }}
    >
      <Settings initialCategory={initialCategory} onClose={onClose} />
    </div>
  )
}
