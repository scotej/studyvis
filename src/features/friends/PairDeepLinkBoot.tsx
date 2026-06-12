import { useEffect, useRef } from 'react'

import { subscribePairDeepLink } from './pairDeepLink'

export type PairDeepLinkBootProps = {
  // Fired with the decoded, validated 12 words when an OS-delivered
  // studyvis://pair?c=<code> link arrives (launch or while running). The
  // consumer opens the AddFriendDialog on the Enter-code tab with these words
  // prefilled — it must NEVER auto-connect (decodePairLink already validated
  // them; the user still presses Connect).
  onPairWords: (words: string[]) => void
}

// F10 — app-level mount point for the deep-link subscriber. Lives outside the
// view selector (like InboxBoot) so it survives settings/session toggles and
// catches a link delivered at any moment. No-op outside the Tauri runtime
// (subscribePairDeepLink short-circuits there).
export function PairDeepLinkBoot({ onPairWords }: PairDeepLinkBootProps) {
  // Keep the latest callback in a ref so the subscription effect runs once and
  // never re-subscribes just because the parent re-rendered with a new closure.
  const onPairWordsRef = useRef(onPairWords)
  useEffect(() => {
    onPairWordsRef.current = onPairWords
  }, [onPairWords])

  useEffect(() => {
    const unsubscribe = subscribePairDeepLink((words) => {
      onPairWordsRef.current(words)
    })
    return unsubscribe
  }, [])

  return null
}
