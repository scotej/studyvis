// Typed wrappers over the Rust `friends_*` commands (local SQLite friends
// list). `Friend` mirrors serde's snake_case response verbatim (same
// convention as SessionRecord / AuditEventRecord); `ed_pubkey_hex` is the
// canonical identity and `addFriend` upserts on it Rust-side, so re-import
// of a known friend is idempotent.

import { invoke } from '@tauri-apps/api/core'

export type Friend = {
  ed_pubkey_hex: string
  x_pubkey_hex: string
  display_name: string | null
  paired_at: number | null
  last_studied_with: number | null
}

export async function listFriends(): Promise<Friend[]> {
  return invoke<Friend[]>('friends_list')
}

export async function addFriend(
  edPubkey: string,
  xPubkey: string,
  name: string,
  ts: number
): Promise<void> {
  await invoke('friends_add', { edPubkey, xPubkey, name, ts })
}

export async function removeFriend(edPubkey: string): Promise<void> {
  await invoke('friends_remove', { edPubkey })
}

export async function updateLastStudied(
  edPubkey: string,
  ts: number
): Promise<void> {
  await invoke('friends_update_last_studied', { edPubkey, ts })
}

export async function getFriendXPubkey(
  edPubkey: string
): Promise<string | null> {
  return invoke<string | null>('friends_get_x_pubkey', { edPubkey })
}
