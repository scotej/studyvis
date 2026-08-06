import { LazyStore } from '@tauri-apps/plugin-store'
import { create } from 'zustand'

import { verifyMessage } from '@/lib/crypto/identity'
import { hexToBytes } from '@/lib/encoding'
import { logger } from '@/lib/log'

import { INVITE_TTL_MS, serializePayloadForSig } from './envelope'
import type { ValidInvite } from './inbox'

const log = logger.child('friends.pending-invites')
const STORE_FILE = 'pending-invites.json'
const STORE_VERSION = 1 as const
const MAX_PENDING_INVITES = 16

export type PendingInviteEntry = {
  key: string
  invite: ValidInvite
  receivedAt: number
}

type PersistedPendingInvites = {
  v: typeof STORE_VERSION
  entries: unknown[]
}

export type PendingInviteStoreLike = {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  save(): Promise<void>
}

export type PendingInviteStoreDeps = {
  storeFactory: (() => PendingInviteStoreLike) | null
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

let cachedStore: LazyStore | null = null
function defaultStoreFactory(): PendingInviteStoreLike {
  cachedStore ??= new LazyStore(STORE_FILE)
  return cachedStore as unknown as PendingInviteStoreLike
}

const defaultDeps: PendingInviteStoreDeps = {
  storeFactory: isTauriRuntime() ? defaultStoreFactory : null,
}
let activeDeps = defaultDeps
let hydrationGeneration = 0
let persistenceQueue: Promise<void> = Promise.resolve()

export function __setPendingInviteStoreDeps(
  deps: PendingInviteStoreDeps
): void {
  activeDeps = deps
}

export function __resetPendingInviteStoreDeps(): void {
  activeDeps = defaultDeps
  cachedStore = null
  persistenceQueue = Promise.resolve()
}

export async function __flushPendingInvitePersistence(): Promise<void> {
  await persistenceQueue
}

export function pendingInviteKey(invite: ValidInvite): string {
  return `${invite.from_ed_pubkey}:${invite.payload.session_topic}`
}

function storageKey(identityEdPubkeyHex: string): string {
  return `identity:${identityEdPubkeyHex.toLowerCase()}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHex(value: unknown, bytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length === bytes * 2 &&
    /^[0-9a-f]+$/i.test(value)
  )
}

function isStringWithin(
  value: unknown,
  minLength: number,
  maxLength: number
): value is string {
  return (
    typeof value === 'string' &&
    value.length >= minLength &&
    value.length <= maxLength
  )
}

function restoreEntry(
  value: unknown,
  now: number,
  knownFriends: ReadonlySet<string>
): PendingInviteEntry | null {
  if (!isRecord(value) || !isRecord(value.invite)) return null
  const rawInvite = value.invite
  if (!isRecord(rawInvite.payload)) return null
  const rawPayload = rawInvite.payload

  const fromEdPubkey = rawInvite.from_ed_pubkey
  const sessionTopic = rawPayload.session_topic
  const sessionPassword = rawPayload.session_password
  const displayName = rawPayload.our_display_name
  const expiresAt = rawPayload.expires_at
  const sig = rawPayload.sig
  const receivedAt = value.receivedAt

  if (!isHex(fromEdPubkey, 32)) return null
  if (!knownFriends.has(fromEdPubkey.toLowerCase())) return null
  if (!isStringWithin(sessionTopic, 1, 256)) return null
  if (!isStringWithin(sessionPassword, 1, 256)) return null
  if (!isStringWithin(displayName, 0, 256)) return null
  if (!isHex(sig, 64)) return null
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null
  if (
    !Number.isSafeInteger(receivedAt) ||
    receivedAt <= 0 ||
    receivedAt > expiresAt ||
    expiresAt - receivedAt > INVITE_TTL_MS
  ) {
    return null
  }

  const invite: ValidInvite = {
    from_ed_pubkey: fromEdPubkey.toLowerCase(),
    payload: {
      session_topic: sessionTopic,
      session_password: sessionPassword,
      our_display_name: displayName,
      expires_at: expiresAt,
      sig: sig.toLowerCase(),
    },
  }

  const signed = serializePayloadForSig({
    session_topic: invite.payload.session_topic,
    session_password: invite.payload.session_password,
    our_display_name: invite.payload.our_display_name,
    expires_at: invite.payload.expires_at,
  })
  try {
    if (
      !verifyMessage(
        hexToBytes(invite.from_ed_pubkey),
        signed,
        hexToBytes(invite.payload.sig)
      )
    ) {
      return null
    }
  } catch {
    return null
  }

  const key = pendingInviteKey(invite)
  return value.key === key ? { key, invite, receivedAt } : null
}

function restoreEntries(
  value: unknown,
  now: number,
  knownFriends: ReadonlySet<string>
): PendingInviteEntry[] {
  if (!isRecord(value) || value.v !== STORE_VERSION) return []
  if (!Array.isArray(value.entries)) return []

  const entries = new Map<string, PendingInviteEntry>()
  for (const raw of value.entries.slice(-MAX_PENDING_INVITES)) {
    const entry = restoreEntry(raw, now, knownFriends)
    if (!entry) continue
    const previous = entries.get(entry.key)
    if (!previous || previous.receivedAt <= entry.receivedAt) {
      entries.set(entry.key, entry)
    }
  }
  return [...entries.values()].sort((a, b) => a.receivedAt - b.receivedAt)
}

function mergeEntries(
  restored: ReadonlyArray<PendingInviteEntry>,
  live: ReadonlyArray<PendingInviteEntry>,
  now: number
): PendingInviteEntry[] {
  const entries = new Map<string, PendingInviteEntry>()
  for (const entry of restored) {
    if (entry.invite.payload.expires_at > now) entries.set(entry.key, entry)
  }
  for (const entry of live) {
    if (entry.invite.payload.expires_at > now) entries.set(entry.key, entry)
  }
  return [...entries.values()]
    .sort((a, b) => a.receivedAt - b.receivedAt)
    .slice(-MAX_PENDING_INVITES)
}

type PendingInvitesState = {
  pending: PendingInviteEntry[]
  status: 'idle' | 'loading' | 'ready'
  identityEdPubkeyHex: string | null
  hydrate: (
    identityEdPubkeyHex: string,
    knownFriendEdPubkeys: ReadonlySet<string>,
    now?: number
  ) => Promise<void>
  deactivate: () => void
  add: (invite: ValidInvite, now?: number) => void
  remove: (key: string) => void
  prune: (now?: number) => void
  clear: () => void
}

export const usePendingInvitesStore = create<PendingInvitesState>((set, get) => ({
  pending: [],
  status: 'idle',
  identityEdPubkeyHex: null,

  hydrate: async (identityEdPubkeyHex, knownFriendEdPubkeys, now = Date.now()) => {
    const identity = identityEdPubkeyHex.toLowerCase()
    const current = get()
    if (current.identityEdPubkeyHex === identity && current.status === 'ready') {
      return
    }

    const generation = ++hydrationGeneration
    set({
      status: 'loading',
      identityEdPubkeyHex: identity,
      pending:
        current.identityEdPubkeyHex === identity ? current.pending : [],
    })

    const factory = activeDeps.storeFactory
    if (!factory) {
      if (generation === hydrationGeneration) {
        set((state) => ({
          status: 'ready',
          pending: mergeEntries([], state.pending, now),
        }))
      }
      return
    }

    try {
      const raw = await factory().get<unknown>(storageKey(identity))
      if (
        generation !== hydrationGeneration ||
        get().identityEdPubkeyHex !== identity
      ) {
        return
      }
      const knownFriends = new Set(
        [...knownFriendEdPubkeys].map((key) => key.toLowerCase())
      )
      const restored = restoreEntries(raw, now, knownFriends)
      set((state) => ({
        status: 'ready',
        pending: mergeEntries(restored, state.pending, now),
      }))
    } catch (err) {
      log.error('hydrate.failed', { err })
      if (
        generation === hydrationGeneration &&
        get().identityEdPubkeyHex === identity
      ) {
        set((state) => ({
          status: 'ready',
          pending: mergeEntries([], state.pending, now),
        }))
      }
    }
  },

  deactivate: () => {
    hydrationGeneration += 1
    set({ pending: [], status: 'idle', identityEdPubkeyHex: null })
  },

  add: (invite, now = Date.now()) =>
    set((state) => {
      const key = pendingInviteKey(invite)
      const kept = state.pending.filter(
        (entry) =>
          entry.key !== key && entry.invite.payload.expires_at > now
      )
      return {
        pending: [...kept, { key, invite, receivedAt: now }].slice(
          -MAX_PENDING_INVITES
        ),
      }
    }),

  remove: (key) =>
    set((state) =>
      state.pending.some((entry) => entry.key === key)
        ? { pending: state.pending.filter((entry) => entry.key !== key) }
        : state
    ),

  prune: (now = Date.now()) =>
    set((state) => {
      const kept = state.pending.filter(
        (entry) => entry.invite.payload.expires_at > now
      )
      return kept.length === state.pending.length
        ? state
        : { pending: kept }
    }),

  clear: () => set({ pending: [] }),
}))

function persist(state: PendingInvitesState): void {
  const factory = activeDeps.storeFactory
  if (!factory || state.status !== 'ready' || !state.identityEdPubkeyHex) {
    return
  }

  const key = storageKey(state.identityEdPubkeyHex)
  const entries = state.pending.slice(-MAX_PENDING_INVITES)
  persistenceQueue = persistenceQueue.then(async () => {
    try {
      const store = factory()
      if (entries.length === 0) {
        await store.delete(key)
      } else {
        const snapshot: PersistedPendingInvites = {
          v: STORE_VERSION,
          entries,
        }
        await store.set(key, snapshot)
      }
      await store.save()
    } catch (err) {
      log.error('persist.failed', { err })
    }
  })
}

usePendingInvitesStore.subscribe((state, previous) => {
  if (
    state.status === 'ready' &&
    state.identityEdPubkeyHex &&
    (state.pending !== previous.pending ||
      state.status !== previous.status ||
      state.identityEdPubkeyHex !== previous.identityEdPubkeyHex)
  ) {
    persist(state)
  }
})
