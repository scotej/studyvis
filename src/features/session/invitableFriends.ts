import type { Friend } from '@/lib/db/friends'

// #47 A2 — which friends the mid-session invite picker offers: online and
// not already in the session (by their signed-hello ed_pubkey binding).
// Pure + separate from SessionInviteDialog.tsx so it's unit-testable and the
// component file stays exports-components-only (react-refresh rule).
export function invitableFriends(
  friends: ReadonlyArray<Friend>,
  isOnline: (edPubkeyHex: string) => boolean,
  inSessionEdPubkeys: ReadonlySet<string>
): Friend[] {
  return friends.filter(
    (f) => isOnline(f.ed_pubkey_hex) && !inSessionEdPubkeys.has(f.ed_pubkey_hex)
  )
}
