import { create } from 'zustand'

import type { ValidInvite } from './inbox'

// #47 B1 — a persistent home for incoming invites. Envelopes are valid for
// INVITE_TTL_MS (5 min) but the only accept affordance was a ~4s sonner
// toast; a recipient who was tabbed away missed it and the invite was
// unrecoverable on their side while the host saw "Invite sent". Each valid
// invite is held here until it expires, is dismissed, or is accepted;
// PendingInvites renders the list as rows on the main view. Lives in
// features/friends (the alertsUiStore precedent), not src/stores — stores/
// modules must not import feature types.

export type PendingInviteEntry = {
  key: string
  invite: ValidInvite
  receivedAt: number
}

// One row per sender+session: a re-sent invite for the same session (the F6
// retry path) replaces the earlier entry instead of stacking duplicates.
export function pendingInviteKey(invite: ValidInvite): string {
  return `${invite.from_ed_pubkey}:${invite.payload.session_topic}`
}

type PendingInvitesState = {
  pending: PendingInviteEntry[]
  add: (invite: ValidInvite, now?: number) => void
  remove: (key: string) => void
  // Drop entries whose expires_at has passed. Called on a slow interval by
  // the banner while anything is pending.
  prune: (now?: number) => void
  clear: () => void
}

export const usePendingInvitesStore = create<PendingInvitesState>((set) => ({
  pending: [],
  add: (invite, now = Date.now()) =>
    set((s) => {
      const key = pendingInviteKey(invite)
      const kept = s.pending.filter(
        (e) => e.key !== key && e.invite.payload.expires_at > now
      )
      return { pending: [...kept, { key, invite, receivedAt: now }] }
    }),
  remove: (key) =>
    set((s) =>
      s.pending.some((e) => e.key === key)
        ? { pending: s.pending.filter((e) => e.key !== key) }
        : s
    ),
  prune: (now = Date.now()) =>
    set((s) => {
      const kept = s.pending.filter((e) => e.invite.payload.expires_at > now)
      return kept.length === s.pending.length ? s : { pending: kept }
    }),
  clear: () => set({ pending: [] }),
}))
