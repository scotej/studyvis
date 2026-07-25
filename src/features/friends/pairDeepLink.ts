import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import type { UnlistenFn } from '@tauri-apps/api/event'

import { routeDeepLinkUrl } from './pairLink'

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

// The launch URL (`getCurrent()`) is the SAME value every time it's read, so a
// re-mount of the boot would otherwise re-open the dialog with the launch link
// after the user already dismissed it. View switches no longer remount it (the
// keyed `tail` fragment in Home.tsx pins its slot), but the identity /
// onboarding gate still mounts it fresh once those resolve — and dev
// StrictMode mounts it twice — so this guard stays. Consume the launch URL once
// per process; runtime links via `onOpenUrl` are unaffected and always deliver.
let launchConsumed = false

// F10 — routes an OS-delivered `studyvis://` link into the add-friend flow.
// `getCurrent()` covers a launch triggered by the link (macOS Apple event,
// Windows argv); `onOpenUrl` covers links clicked while the app is already
// running (the single-instance plugin's `deep-link` feature forwards the second
// instance's argv into that stream). Two link shapes are handled from this ONE
// subscribe pass (a second getCurrent() would race the module-global
// launchConsumed and drop a launch link): a legacy `studyvis://pair?c=<code>`
// pairing code → onPairWords, and a self-contained `studyvis://add#<card>`
// ContactCard → onContactCard. Both are validated by routeDeepLinkUrl and drop
// silently on anything malformed, since any web page can fire the scheme without
// user intent. For the same reason neither callback may auto-add — they only
// PREFILL / open a confirm surface the user still acts on. No-op outside the
// Tauri runtime (`npm run dev`).
export function subscribePairDeepLink(
  onPairWords: (words: string[]) => void,
  onContactCard: (cardBytes: Uint8Array) => void
): () => void {
  if (!isTauriRuntime()) {
    return () => {}
  }
  let disposed = false
  let unlisten: UnlistenFn | null = null

  const deliver = (urls: string[] | null) => {
    if (disposed) return
    for (const url of urls ?? []) {
      const route = routeDeepLinkUrl(url)
      if (!route) continue
      if (route.kind === 'add') onContactCard(route.card)
      else onPairWords(route.words)
      return
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
