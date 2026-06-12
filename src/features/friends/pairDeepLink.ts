import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import type { UnlistenFn } from '@tauri-apps/api/event'

import { decodePairLink } from './pairLink'

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

// The launch URL (`getCurrent()`) is the SAME value every time it's read, so a
// component that re-mounts (view switches re-mount the boot, like InboxBoot)
// would otherwise re-open the dialog with the launch link after the user
// already dismissed it. Consume it once per process; runtime links via
// `onOpenUrl` are unaffected and always deliver.
let launchConsumed = false

// F10 — routes an OS-delivered `studyvis://pair?c=<code>` into the add-friend
// accept flow. `getCurrent()` covers a launch triggered by the link (macOS
// Apple event, Windows argv); `onOpenUrl` covers links clicked while the app
// is already running (the single-instance plugin's `deep-link` feature
// forwards the second instance's argv into that stream). `decodePairLink` is
// the validator — anything that isn't a well-formed pair link is dropped
// silently, since any web page can fire the scheme without user intent. For
// the same reason the callback should only PREFILL the join form, never
// auto-connect. No-op outside the Tauri runtime (`npm run dev`).
export function subscribePairDeepLink(
  onPairWords: (words: string[]) => void
): () => void {
  if (!isTauriRuntime()) {
    return () => {}
  }
  let disposed = false
  let unlisten: UnlistenFn | null = null

  const deliver = (urls: string[] | null) => {
    if (disposed) return
    for (const url of urls ?? []) {
      const words = decodePairLink(url)
      if (words) {
        onPairWords(words)
        return
      }
    }
  }

  if (!launchConsumed) {
    launchConsumed = true
    getCurrent()
      .then(deliver)
      .catch(() => {})
  }
  onOpenUrl(deliver)
    .then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    .catch(() => {})

  return () => {
    disposed = true
    unlisten?.()
    unlisten = null
  }
}
