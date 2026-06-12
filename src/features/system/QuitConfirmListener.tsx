import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useSessionStore } from '@/stores/sessionStore'
import { strings } from '@/strings'

export const QUIT_REQUESTED_EVENT = 'quit-requested'

// N4 — app-wide guard for the Rust "quit-requested" event. The Rust side
// prevents the quit and emits this whenever the user tries to leave (window
// close with minimize-to-tray off, tray Quit, macOS Cmd+Q) WHILE its
// SessionActiveFlag is set. When a session is live we show a confirm whose
// confirm path invokes `app_quit()`; cancel just closes (the quit was already
// prevented, so cancel = do nothing).
//
// Stale-flag semantics: the JS store is the source of truth for "is a session
// actually live right now." If the event arrives but our store reports no
// active session — the Rust flag drifted (e.g. the frontend crashed
// mid-session and relaunched into a fresh `idle` store, or a teardown's
// session_set_active(false) lost the race) — there is nothing to protect, so
// we honor the quit immediately via app_quit() rather than trapping the user
// behind a phantom confirm.
export function QuitConfirmListener() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    let unlisten: UnlistenFn | null = null

    void (async () => {
      try {
        const off = await listen(QUIT_REQUESTED_EVENT, () => {
          if (useSessionStore.getState().status === 'active') {
            setOpen(true)
          } else {
            void invoke('app_quit').catch(() => {})
          }
        })
        if (cancelled) {
          off()
          return
        }
        unlisten = off
      } catch {
        // Outside a Tauri runtime (Vitest, Storybook, web preview) the event
        // bridge is absent; the quit-confirm simply never fires.
      }
    })()

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const confirmQuit = () => {
    setOpen(false)
    void invoke('app_quit').catch(() => {})
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{strings.session.quitConfirm.title}</DialogTitle>
          <DialogDescription>
            {strings.session.quitConfirm.body}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {strings.session.quitConfirm.cancelCta}
          </Button>
          <Button type="button" variant="destructive" onClick={confirmQuit}>
            {strings.session.quitConfirm.confirmCta}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
