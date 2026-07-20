// One truncation for every surface that identifies a friend by raw key
// (FriendsListView rows, Settings → Friends): the fingerprint's whole job
// is to be recognizable, so the same friend must show the same fragment
// everywhere. 8 hex chars is the original list-facing convention; the
// length guard skips the ellipsis when nothing would be hidden.
export function shortPubkey(hex: string): string {
  if (hex.length <= 10) return hex
  return `${hex.slice(0, 8)}…`
}
