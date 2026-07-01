import { useEffect, useRef } from 'react'

import { subscribePairDeepLink } from './pairDeepLink'

export type PairDeepLinkBootProps = {
  // Fired with the decoded, validated 12 words when an OS-delivered
  // studyvis://pair?c=<code> link arrives (launch or while running). The
  // consumer opens the AddFriendDialog on the legacy pairing-code flow with
  // these words prefilled — it must NEVER auto-connect.
  onPairWords: (words: string[]) => void
  // Fired with raw ContactCard bytes when an OS-delivered studyvis://add#<card>
  // link arrives. The consumer opens the import confirm sheet (safety-number
  // check) — it must NEVER auto-add. The bytes are only structurally located
  // here; parse/verify/self-guard happen in the confirm surface.
  onContactCard: (cardBytes: Uint8Array) => void
}

// F10 — app-level mount point for the deep-link subscriber. Lives outside the
// view selector (like InboxBoot) so it survives settings/session toggles and
// catches a link delivered at any moment. No-op outside the Tauri runtime
// (subscribePairDeepLink short-circuits there).
export function PairDeepLinkBoot({
  onPairWords,
  onContactCard,
}: PairDeepLinkBootProps) {
  // Keep the latest callbacks in refs so the subscription effect runs once and
  // never re-subscribes just because the parent re-rendered with new closures.
  const onPairWordsRef = useRef(onPairWords)
  const onContactCardRef = useRef(onContactCard)
  useEffect(() => {
    onPairWordsRef.current = onPairWords
    onContactCardRef.current = onContactCard
  }, [onPairWords, onContactCard])

  useEffect(() => {
    const unsubscribe = subscribePairDeepLink(
      (words) => onPairWordsRef.current(words),
      (card) => onContactCardRef.current(card)
    )
    return unsubscribe
  }, [])

  return null
}
