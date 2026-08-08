import { LazyStore } from '@tauri-apps/plugin-store'
import { create } from 'zustand'

import { verifyMessage } from '@/lib/crypto/identity'
import { hexToBytes } from '@/lib/encoding'
import { logger } from '@/lib/log'

import {
  INVITE_CLOCK_SKEW_MS,
  INVITE_DISPLAY_NAME_MAX_LENGTH,
  INVITE_SESSION_PASSWORD_MAX_LENGTH,
  INVITE_SESSION_TOPIC_MAX_LENGTH,
  INVITE_TTL_MS,
  serializePayloadForSig,
} from './envelope'
import type { ValidInvite } from './inbox'

const log = logger.child('friends.pending-invites')
const STORE_FILE = 'pending-invites.json'
const STORE_VERSION = 2 as const
const MAX_PENDING_INVITES = 16
export const PENDING_INVITES_STORE_KEY = 'active'

export type PendingInviteEntry = {
  key: string
  invite: ValidInvite
  receivedAt: number
}

type PersistedPendingInvites = {
  v: typeof STORE_VERSION
  identityEdPubkeyHex: string
  entries: PendingInviteEntry[]
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
  cachedStore ??= new LazyStore(STORE_FILE, { autoSave: false })
  return cachedStore as unknown as PendingInviteStoreLike
}

const defaultDeps: PendingInviteStoreDeps = {
  storeFactory: isTauriRuntime() ? defaultStoreFactory : null,
}

let activeDeps = defaultDeps
let identityGeneration = 0
let reconcileGeneration = 0
let persistenceQueue: Promise<void> = Promise.resolve()
let persistenceReady: {
  identityEdPubkeyHex: string
  identityGeneration: number
} | null = null
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let mutationRevision = 0
let suppressRestoredRevision = 0
const tombstones = new Map<
  string,
  { inviteRevision: string; expiresAt: number; revision: number }
>()

export function __setPendingInviteStoreDeps(
  deps: PendingInviteStoreDeps
): void {
  activeDeps = deps
}

export function __resetPendingInviteStoreDeps(): void {
  activeDeps = defaultDeps
  cachedStore = null
  identityGeneration += 1
  reconcileGeneration += 1
  persistenceReady = null
  persistenceQueue = Promise.resolve()
  mutationRevision = 0
  suppressRestoredRevision = 0
  tombstones.clear()
  clearExpiryTimer()
}

export async function __flushPendingInvitePersistence(): Promise<void> {
  let observed: Promise<void>
  do {
    observed = persistenceQueue
    await observed
  } while (observed !== persistenceQueue)
}

export function pendingInviteKey(invite: ValidInvite): string {
  return `${invite.from_ed_pubkey}:${invite.payload.session_topic}`
}

function inviteRevision(invite: ValidInvite): string {
  return JSON.stringify([
    invite.from_ed_pubkey,
    invite.payload.session_topic,
    invite.payload.session_password,
    invite.payload.our_display_name,
    invite.payload.expires_at,
    invite.payload.sig,
  ])
}

function normalizeIdentity(identityEdPubkeyHex: string): string {
  return identityEdPubkeyHex.trim().toLowerCase()
}

function normalizeFriends(
  knownFriendEdPubkeys: ReadonlySet<string>
): ReadonlySet<string> {
  return new Set(
    [...knownFriendEdPubkeys].map((key) => key.trim().toLowerCase())
  )
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
  if (!isStringWithin(sessionTopic, 1, INVITE_SESSION_TOPIC_MAX_LENGTH)) {
    return null
  }
  if (!isStringWithin(sessionPassword, 1, INVITE_SESSION_PASSWORD_MAX_LENGTH)) {
    return null
  }
  if (!isStringWithin(displayName, 0, INVITE_DISPLAY_NAME_MAX_LENGTH)) {
    return null
  }
  if (!isHex(sig, 64)) return null
  if (
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now
  ) {
    return null
  }
  if (
    typeof receivedAt !== 'number' ||
    !Number.isSafeInteger(receivedAt) ||
    receivedAt <= 0 ||
    receivedAt > now ||
    receivedAt > expiresAt ||
    expiresAt - receivedAt > INVITE_TTL_MS + INVITE_CLOCK_SKEW_MS
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

function isTombstoned(entry: PendingInviteEntry): boolean {
  const tombstone = tombstones.get(entry.key)
  return tombstone?.inviteRevision === inviteRevision(entry.invite)
}

function restoreEntries(
  values: unknown[],
  now: number,
  knownFriends: ReadonlySet<string>
): PendingInviteEntry[] {
  if (suppressRestoredRevision > 0) return []
  const entries = new Map<string, PendingInviteEntry>()
  for (const raw of values.slice(-MAX_PENDING_INVITES)) {
    const entry = restoreEntry(raw, now, knownFriends)
    if (!entry || isTombstoned(entry)) continue
    const previous = entries.get(entry.key)
    if (!previous || previous.receivedAt <= entry.receivedAt) {
      entries.set(entry.key, entry)
    }
  }
  return [...entries.values()].sort((a, b) => a.receivedAt - b.receivedAt)
}

type DecodedSnapshot =
  { kind: 'supported'; entries: unknown[] } | { kind: 'future' }

function decodeSnapshot(
  value: unknown,
  identityEdPubkeyHex: string
): DecodedSnapshot {
  if (value === undefined) return { kind: 'supported', entries: [] }
  if (
    isRecord(value) &&
    typeof value.v === 'number' &&
    value.v > STORE_VERSION
  ) {
    return { kind: 'future' }
  }
  if (
    !isRecord(value) ||
    value.v !== STORE_VERSION ||
    typeof value.identityEdPubkeyHex !== 'string' ||
    normalizeIdentity(value.identityEdPubkeyHex) !== identityEdPubkeyHex ||
    !Array.isArray(value.entries)
  ) {
    return { kind: 'supported', entries: [] }
  }
  return { kind: 'supported', entries: value.entries }
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

function clearExpiryTimer(): void {
  if (expiryTimer !== null) clearTimeout(expiryTimer)
  expiryTimer = null
}

function scheduleExpiryTimer(referenceNow = Date.now()): void {
  clearExpiryTimer()
  const pending = usePendingInvitesStore.getState().pending
  const expiries = [
    ...pending.map((entry) => entry.invite.payload.expires_at),
    ...[...tombstones.values()].map((tombstone) => tombstone.expiresAt),
  ]
  if (expiries.length === 0) return
  const earliest = Math.min(...expiries)
  const delay = Math.min(Math.max(0, earliest - referenceNow), 2_147_483_647)
  expiryTimer = setTimeout(() => {
    expiryTimer = null
    usePendingInvitesStore.getState().prune()
  }, delay)
}

function recordTombstones(entries: ReadonlyArray<PendingInviteEntry>): number {
  if (entries.length === 0) return mutationRevision
  const revision = ++mutationRevision
  for (const entry of entries) {
    tombstones.set(entry.key, {
      inviteRevision: inviteRevision(entry.invite),
      expiresAt: entry.invite.payload.expires_at,
      revision,
    })
  }
  return revision
}

type PendingInvitesStatus = 'idle' | 'loading' | 'ready' | 'degraded'

type PendingInvitesState = {
  pending: PendingInviteEntry[]
  status: PendingInvitesStatus
  identityEdPubkeyHex: string | null
  activateIdentity: (identityEdPubkeyHex: string) => void
  reconcile: (
    identityEdPubkeyHex: string,
    knownFriendEdPubkeys: ReadonlySet<string>,
    now?: number
  ) => Promise<void>
  deactivateExpected: (identityEdPubkeyHex: string) => void
  add: (
    identityEdPubkeyHex: string,
    invite: ValidInvite,
    now?: number
  ) => boolean
  remove: (key: string) => void
  prune: (now?: number) => void
  clear: () => void
}

function canPersist(identityEdPubkeyHex: string): boolean {
  const ready = persistenceReady
  return (
    ready?.identityEdPubkeyHex === identityEdPubkeyHex &&
    ready.identityGeneration === identityGeneration
  )
}

function schedulePersistence(identityEdPubkeyHex: string): void {
  const factory = activeDeps.storeFactory
  if (!factory || !canPersist(identityEdPubkeyHex)) return

  persistenceQueue = persistenceQueue.then(async () => {
    const state = usePendingInvitesStore.getState()
    if (
      state.identityEdPubkeyHex !== identityEdPubkeyHex ||
      state.status !== 'ready' ||
      !canPersist(identityEdPubkeyHex)
    ) {
      return
    }

    const generation = identityGeneration
    const coveredRevision = mutationRevision
    const entries = state.pending.slice(-MAX_PENDING_INVITES)
    try {
      const store = factory()
      if (entries.length === 0) {
        await store.delete(PENDING_INVITES_STORE_KEY)
      } else {
        const snapshot: PersistedPendingInvites = {
          v: STORE_VERSION,
          identityEdPubkeyHex,
          entries,
        }
        await store.set(PENDING_INVITES_STORE_KEY, snapshot)
      }
      await store.save()
    } catch (err) {
      log.error('persist.failed', { err })
      return
    }

    const current = usePendingInvitesStore.getState()
    if (
      current.identityEdPubkeyHex !== identityEdPubkeyHex ||
      generation !== identityGeneration
    ) {
      return
    }
    if (
      suppressRestoredRevision > 0 &&
      suppressRestoredRevision <= coveredRevision
    ) {
      suppressRestoredRevision = 0
    }
  })
}

export const usePendingInvitesStore = create<PendingInvitesState>(
  (set, get) => ({
    pending: [],
    status: 'idle',
    identityEdPubkeyHex: null,

    activateIdentity: (identityEdPubkeyHex) => {
      const identity = normalizeIdentity(identityEdPubkeyHex)
      if (!identity || get().identityEdPubkeyHex === identity) return
      identityGeneration += 1
      reconcileGeneration += 1
      persistenceReady = null
      mutationRevision = 0
      suppressRestoredRevision = 0
      tombstones.clear()
      clearExpiryTimer()
      set({ pending: [], status: 'idle', identityEdPubkeyHex: identity })
    },

    reconcile: async (
      identityEdPubkeyHex,
      knownFriendEdPubkeys,
      explicitNow
    ) => {
      const identity = normalizeIdentity(identityEdPubkeyHex)
      if (!identity || get().identityEdPubkeyHex !== identity) return

      const friends = normalizeFriends(knownFriendEdPubkeys)
      const startNow = explicitNow ?? Date.now()
      const generation = ++reconcileGeneration
      const activeIdentityGeneration = identityGeneration
      persistenceReady = null

      const beforeRead = get().pending
      const revoked = beforeRead.filter(
        (entry) =>
          entry.invite.payload.expires_at <= startNow ||
          !friends.has(entry.invite.from_ed_pubkey.toLowerCase())
      )
      if (revoked.length > 0) recordTombstones(revoked)
      const kept = beforeRead.filter((entry) => !revoked.includes(entry))
      set({ status: 'loading', pending: kept })
      scheduleExpiryTimer(startNow)

      const factory = activeDeps.storeFactory
      if (!factory) {
        if (
          generation !== reconcileGeneration ||
          activeIdentityGeneration !== identityGeneration ||
          get().identityEdPubkeyHex !== identity
        ) {
          return
        }
        tombstones.clear()
        suppressRestoredRevision = 0
        set({ status: 'ready' })
        persistenceReady = {
          identityEdPubkeyHex: identity,
          identityGeneration: activeIdentityGeneration,
        }
        scheduleExpiryTimer(startNow)
        return
      }

      let raw: unknown
      try {
        raw = await factory().get<unknown>(PENDING_INVITES_STORE_KEY)
      } catch (err) {
        log.error('reconcile.failed', { phase: 'read', err })
        if (
          generation === reconcileGeneration &&
          activeIdentityGeneration === identityGeneration &&
          get().identityEdPubkeyHex === identity
        ) {
          set({ status: 'degraded' })
          scheduleExpiryTimer(startNow)
        }
        return
      }

      const now = explicitNow ?? Date.now()
      if (
        generation !== reconcileGeneration ||
        activeIdentityGeneration !== identityGeneration ||
        get().identityEdPubkeyHex !== identity
      ) {
        return
      }

      const decoded = decodeSnapshot(raw, identity)
      if (decoded.kind === 'future') {
        set({ status: 'degraded' })
        scheduleExpiryTimer(now)
        return
      }

      const restored = restoreEntries(decoded.entries, now, friends)
      const live = get().pending.filter(
        (entry) =>
          entry.invite.payload.expires_at > now &&
          friends.has(entry.invite.from_ed_pubkey.toLowerCase())
      )
      const newlyRevoked = get().pending.filter(
        (entry) => !live.includes(entry)
      )
      if (newlyRevoked.length > 0) recordTombstones(newlyRevoked)
      const pending = mergeEntries(restored, live, now)
      set({ status: 'ready', pending })
      persistenceReady = {
        identityEdPubkeyHex: identity,
        identityGeneration: activeIdentityGeneration,
      }
      scheduleExpiryTimer(now)
      schedulePersistence(identity)
    },

    deactivateExpected: (identityEdPubkeyHex) => {
      const identity = normalizeIdentity(identityEdPubkeyHex)
      if (get().identityEdPubkeyHex !== identity) return
      identityGeneration += 1
      reconcileGeneration += 1
      persistenceReady = null
      mutationRevision = 0
      suppressRestoredRevision = 0
      tombstones.clear()
      clearExpiryTimer()
      set({ pending: [], status: 'idle', identityEdPubkeyHex: null })
    },

    add: (identityEdPubkeyHex, invite, now = Date.now()) => {
      const identity = normalizeIdentity(identityEdPubkeyHex)
      const expiresAt = invite.payload.expires_at
      if (
        get().identityEdPubkeyHex !== identity ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= now ||
        expiresAt > now + INVITE_TTL_MS + INVITE_CLOCK_SKEW_MS
      ) {
        return false
      }

      const key = pendingInviteKey(invite)
      const revision = inviteRevision(invite)
      const current = get()
      const existing = current.pending.find((entry) => entry.key === key)
      if (existing && inviteRevision(existing.invite) === revision) return false
      if (tombstones.get(key)?.inviteRevision === revision) return false
      tombstones.delete(key)

      const expired = current.pending.filter(
        (entry) => entry.invite.payload.expires_at <= now
      )
      if (expired.length > 0) recordTombstones(expired)
      mutationRevision += 1
      const kept = current.pending.filter(
        (entry) => entry.key !== key && entry.invite.payload.expires_at > now
      )
      set({
        pending: [...kept, { key, invite, receivedAt: now }].slice(
          -MAX_PENDING_INVITES
        ),
      })
      scheduleExpiryTimer(now)
      if (current.status === 'ready') schedulePersistence(identity)
      return true
    },

    remove: (key) => {
      const current = get()
      const removed = current.pending.filter((entry) => entry.key === key)
      if (removed.length === 0 || !current.identityEdPubkeyHex) return
      recordTombstones(removed)
      set({
        pending: current.pending.filter((entry) => entry.key !== key),
      })
      scheduleExpiryTimer()
      if (current.status === 'ready') {
        schedulePersistence(current.identityEdPubkeyHex)
      }
    },

    prune: (now = Date.now()) => {
      const current = get()
      for (const [key, tombstone] of tombstones) {
        if (tombstone.expiresAt <= now) tombstones.delete(key)
      }
      const removed = current.pending.filter(
        (entry) => entry.invite.payload.expires_at <= now
      )
      if (removed.length === 0 || !current.identityEdPubkeyHex) {
        scheduleExpiryTimer(now)
        return
      }
      recordTombstones(removed)
      set({
        pending: current.pending.filter(
          (entry) => entry.invite.payload.expires_at > now
        ),
      })
      scheduleExpiryTimer(now)
      if (current.status === 'ready') {
        schedulePersistence(current.identityEdPubkeyHex)
      }
    },

    clear: () => {
      const current = get()
      if (!current.identityEdPubkeyHex) return
      const revision = recordTombstones(current.pending)
      if (current.pending.length === 0) mutationRevision += 1
      suppressRestoredRevision = Math.max(
        suppressRestoredRevision,
        current.pending.length === 0 ? mutationRevision : revision
      )
      set({ pending: [] })
      clearExpiryTimer()
      if (current.status === 'ready') {
        schedulePersistence(current.identityEdPubkeyHex)
      }
    },
  })
)
