import { invoke } from '@tauri-apps/api/core'
import { LazyStore } from '@tauri-apps/plugin-store'

import {
  boxDecryptWithKeyring,
  boxEncryptWithKeyring,
} from '@/lib/db/identity'
import {
  base64ToBytes,
  bytesToBase64,
  hexToBytes,
} from '@/lib/encoding'
import { logger } from '@/lib/log'

const log = logger.child('session.recovery')
const STORE_FILE = 'session-recovery.json'
export const SESSION_RECOVERY_STORE_KEY = 'active'
export const SESSION_RECOVERY_PEER_ID_STORAGE_KEY =
  'studyvis:active-session-peer-id'
const STORE_VERSION = 1 as const
export const MAX_SESSION_RECOVERY_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const MAX_RECOVERY_ID_LENGTH = 128
const MAX_TRANSPORT_PEER_ID_LENGTH = 20
const MAX_SESSION_TOPIC_LENGTH = 512
const MAX_SESSION_PASSWORD_LENGTH = 512
const MAX_DECLARED_TOPIC_LENGTH = 2_000
const MAX_ENCRYPTED_RECOVERY_BYTES = 16 * 1_024
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000

export type SessionRecoveryRecord = {
  v: typeof STORE_VERSION
  recoveryId: string
  identityEdPubkeyHex: string
  transportPeerId: string
  sessionTopic: string
  sessionPassword: string
  isHost: boolean
  expectedAuthorityEdPubkeyHex: string | null
  initialDeclaredTopic: string
  declaredStudyTopic: string
  startedAt: number
  savedAt: number
}

export type SessionRecoveryRecordInput = Omit<
  SessionRecoveryRecord,
  'v' | 'savedAt'
> & {
  savedAt?: number
}

type PersistedSessionRecovery = {
  v: typeof STORE_VERSION
  recoveryId: string
  identityEdPubkeyHex: string
  nonceB64: string
  ciphertextB64: string
}

export type SessionRecoveryStoreLike = {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  save(): Promise<void>
}

export type SessionRecoveryDeps = {
  storeFactory: (() => SessionRecoveryStoreLike) | null
  encryptForIdentity: (
    identityXPubkeyHex: string,
    plaintext: Uint8Array
  ) => Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }>
  decryptForIdentity: (
    identityXPubkeyHex: string,
    nonce: Uint8Array,
    ciphertext: Uint8Array
  ) => Promise<Uint8Array>
  setNativeSessionActive: (active: boolean) => Promise<void>
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

let cachedStore: LazyStore | null = null
function defaultStoreFactory(): SessionRecoveryStoreLike {
  cachedStore ??= new LazyStore(STORE_FILE, { defaults: {}, autoSave: false })
  return cachedStore as unknown as SessionRecoveryStoreLike
}

const defaultDeps: SessionRecoveryDeps = {
  storeFactory: isTauriRuntime() ? defaultStoreFactory : null,
  encryptForIdentity: async (identityXPubkeyHex, plaintext) =>
    boxEncryptWithKeyring(hexToBytes(identityXPubkeyHex), plaintext),
  decryptForIdentity: async (identityXPubkeyHex, nonce, ciphertext) =>
    boxDecryptWithKeyring(
      hexToBytes(identityXPubkeyHex),
      nonce,
      ciphertext
    ),
  setNativeSessionActive: async (active) => {
    await invoke('session_set_active', { active })
  },
}

let activeDeps = defaultDeps
let persistenceQueue: Promise<void> = Promise.resolve()

export function __setSessionRecoveryDeps(deps: SessionRecoveryDeps): void {
  activeDeps = deps
}

export function __resetSessionRecoveryDeps(): void {
  activeDeps = defaultDeps
  cachedStore = null
  persistenceQueue = Promise.resolve()
}

export async function __flushSessionRecoveryPersistence(): Promise<void> {
  let observed: Promise<void>
  do {
    observed = persistenceQueue
    await observed
  } while (observed !== persistenceQueue)
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = persistenceQueue.then(operation, operation)
  persistenceQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(
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

function isEdPubkey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

function isTransportPeerId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === MAX_TRANSPORT_PEER_ID_LENGTH &&
    /^[0-9A-Za-z]+$/.test(value)
  )
}

function isSafeTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  )
}

function decodeRecoveryRecord(
  value: unknown,
  identityEdPubkeyHex: string,
  now: number
):
  | { kind: 'valid'; record: SessionRecoveryRecord }
  | { kind: 'other-identity' | 'future' | 'invalid' | 'stale' } {
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
    !isBoundedString(value.recoveryId, 1, MAX_RECOVERY_ID_LENGTH) ||
    !isEdPubkey(value.identityEdPubkeyHex) ||
    !isTransportPeerId(value.transportPeerId) ||
    !isBoundedString(value.sessionTopic, 1, MAX_SESSION_TOPIC_LENGTH) ||
    !isBoundedString(
      value.sessionPassword,
      1,
      MAX_SESSION_PASSWORD_LENGTH
    ) ||
    typeof value.isHost !== 'boolean' ||
    !(
      value.expectedAuthorityEdPubkeyHex === null ||
      isEdPubkey(value.expectedAuthorityEdPubkeyHex)
    ) ||
    !isBoundedString(
      value.initialDeclaredTopic,
      1,
      MAX_DECLARED_TOPIC_LENGTH
    ) ||
    !isBoundedString(
      value.declaredStudyTopic,
      1,
      MAX_DECLARED_TOPIC_LENGTH
    ) ||
    !isSafeTimestamp(value.startedAt) ||
    !isSafeTimestamp(value.savedAt) ||
    value.startedAt > value.savedAt + FUTURE_CLOCK_SKEW_MS ||
    value.savedAt > now + FUTURE_CLOCK_SKEW_MS
  ) {
    return { kind: 'invalid' }
  }

  const record: SessionRecoveryRecord = {
    v: STORE_VERSION,
    recoveryId: value.recoveryId,
    identityEdPubkeyHex: value.identityEdPubkeyHex.toLowerCase(),
    transportPeerId: value.transportPeerId,
    sessionTopic: value.sessionTopic,
    sessionPassword: value.sessionPassword,
    isHost: value.isHost,
    expectedAuthorityEdPubkeyHex:
      value.expectedAuthorityEdPubkeyHex?.toLowerCase() ?? null,
    initialDeclaredTopic: value.initialDeclaredTopic,
    declaredStudyTopic: value.declaredStudyTopic,
    startedAt: value.startedAt,
    savedAt: value.savedAt,
  }

  if (
    record.identityEdPubkeyHex !== identityEdPubkeyHex.trim().toLowerCase()
  ) {
    return { kind: 'other-identity' }
  }
  if (now - record.savedAt > MAX_SESSION_RECOVERY_AGE_MS) {
    return { kind: 'stale' }
  }
  return { kind: 'valid', record }
}

function decodePersistedRecovery(
  value: unknown,
  identityEdPubkeyHex: string
):
  | { kind: 'valid'; persisted: PersistedSessionRecovery }
  | { kind: 'empty' | 'other-identity' | 'future' | 'invalid' } {
  if (value === undefined) return { kind: 'empty' }
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
    !isBoundedString(value.recoveryId, 1, MAX_RECOVERY_ID_LENGTH) ||
    !isEdPubkey(value.identityEdPubkeyHex) ||
    !isBoundedString(value.nonceB64, 1, MAX_ENCRYPTED_RECOVERY_BYTES) ||
    !isBoundedString(
      value.ciphertextB64,
      1,
      MAX_ENCRYPTED_RECOVERY_BYTES
    )
  ) {
    return { kind: 'invalid' }
  }
  const persisted: PersistedSessionRecovery = {
    v: STORE_VERSION,
    recoveryId: value.recoveryId,
    identityEdPubkeyHex: value.identityEdPubkeyHex.toLowerCase(),
    nonceB64: value.nonceB64,
    ciphertextB64: value.ciphertextB64,
  }
  if (
    persisted.identityEdPubkeyHex !==
    identityEdPubkeyHex.trim().toLowerCase()
  ) {
    return { kind: 'other-identity' }
  }
  return { kind: 'valid', persisted }
}

function persistSessionPeerId(peerId: string): void {
  try {
    globalThis.localStorage?.setItem(
      SESSION_RECOVERY_PEER_ID_STORAGE_KEY,
      peerId
    )
  } catch {
    // Storage can be unavailable in hardened webviews. The encrypted recovery
    // record still exists, but the transport will need a fresh peer ID.
  }
}

function clearPersistentSessionPeerId(): void {
  try {
    globalThis.localStorage?.removeItem(
      SESSION_RECOVERY_PEER_ID_STORAGE_KEY
    )
  } catch {
    // Storage can be unavailable in hardened webviews. Recovery persistence
    // still remains authoritative; Trystero will simply rotate next process.
  }
}

async function deleteStoredRecovery(
  store: SessionRecoveryStoreLike
): Promise<void> {
  await store.delete(SESSION_RECOVERY_STORE_KEY)
  await store.save()
  clearPersistentSessionPeerId()
}

export function createSessionRecoveryId(): string {
  const randomUuid = globalThis.crypto?.randomUUID
  if (!randomUuid) {
    throw new Error('secure random UUID generation is unavailable')
  }
  return randomUuid.call(globalThis.crypto)
}

export function createSessionRecoveryRecord(
  input: SessionRecoveryRecordInput
): SessionRecoveryRecord {
  const record: SessionRecoveryRecord = {
    ...input,
    v: STORE_VERSION,
    identityEdPubkeyHex: input.identityEdPubkeyHex.trim().toLowerCase(),
    expectedAuthorityEdPubkeyHex:
      input.expectedAuthorityEdPubkeyHex?.trim().toLowerCase() ?? null,
    savedAt: input.savedAt ?? Date.now(),
  }
  const decoded = decodeRecoveryRecord(
    record,
    record.identityEdPubkeyHex,
    record.savedAt
  )
  if (decoded.kind !== 'valid') {
    throw new Error('invalid active session recovery record')
  }
  return decoded.record
}

export function persistSessionRecovery(
  record: SessionRecoveryRecord,
  identityXPubkeyHex: string
): Promise<boolean> {
  persistSessionPeerId(record.transportPeerId)
  const factory = activeDeps.storeFactory
  if (!factory) return Promise.resolve(true)

  return enqueue(async () => {
    try {
      const plaintext = new TextEncoder().encode(JSON.stringify(record))
      const sealed = await activeDeps.encryptForIdentity(
        identityXPubkeyHex,
        plaintext
      )
      const persisted: PersistedSessionRecovery = {
        v: STORE_VERSION,
        recoveryId: record.recoveryId,
        identityEdPubkeyHex: record.identityEdPubkeyHex,
        nonceB64: bytesToBase64(sealed.nonce),
        ciphertextB64: bytesToBase64(sealed.ciphertext),
      }
      const store = factory()
      await store.set(SESSION_RECOVERY_STORE_KEY, persisted)
      await store.save()
      log.debug('persist.succeeded', {
        recoveryId: record.recoveryId,
        role: record.isHost ? 'host' : 'guest',
      })
      return true
    } catch (err) {
      log.error('persist.failed', {
        recoveryId: record.recoveryId,
        role: record.isHost ? 'host' : 'guest',
        err,
      })
      return false
    }
  })
}

export function clearSessionRecovery(recoveryId: string): Promise<boolean> {
  const factory = activeDeps.storeFactory
  if (!factory) {
    clearPersistentSessionPeerId()
    return Promise.resolve(true)
  }

  return enqueue(async () => {
    try {
      const store = factory()
      const current = await store.get<unknown>(SESSION_RECOVERY_STORE_KEY)
      if (!isRecord(current)) {
        clearPersistentSessionPeerId()
        return true
      }
      if (current.recoveryId !== recoveryId) return true
      await deleteStoredRecovery(store)
      log.debug('clear.succeeded', { recoveryId })
      return true
    } catch (err) {
      log.error('clear.failed', { recoveryId, err })
      return false
    }
  })
}

export function loadSessionRecovery(
  identityEdPubkeyHex: string,
  identityXPubkeyHex: string,
  now = Date.now()
): Promise<SessionRecoveryRecord | null> {
  const factory = activeDeps.storeFactory
  if (!factory) {
    clearPersistentSessionPeerId()
    return Promise.resolve(null)
  }

  return enqueue(async () => {
    const store = factory()
    let raw: unknown
    try {
      raw = await store.get<unknown>(SESSION_RECOVERY_STORE_KEY)
    } catch (err) {
      log.error('load.read_failed', { err })
      throw err
    }

    const decodedEnvelope = decodePersistedRecovery(
      raw,
      identityEdPubkeyHex
    )
    if (decodedEnvelope.kind === 'empty') {
      clearPersistentSessionPeerId()
      return null
    }
    if (
      decodedEnvelope.kind === 'future' ||
      decodedEnvelope.kind === 'other-identity'
    ) {
      return null
    }
    if (decodedEnvelope.kind === 'invalid') {
      await deleteStoredRecovery(store)
      log.warn('load.discarded', { reason: 'invalid-envelope' })
      return null
    }

    const persisted = decodedEnvelope.persisted
    let plaintext: Uint8Array
    try {
      plaintext = await activeDeps.decryptForIdentity(
        identityXPubkeyHex,
        base64ToBytes(persisted.nonceB64),
        base64ToBytes(persisted.ciphertextB64)
      )
    } catch (err) {
      log.error('load.decrypt_failed', {
        recoveryId: persisted.recoveryId,
        err,
      })
      throw err
    }

    let decodedRecord: ReturnType<typeof decodeRecoveryRecord>
    try {
      const parsed = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
      ) as unknown
      decodedRecord = decodeRecoveryRecord(
        parsed,
        identityEdPubkeyHex,
        now
      )
    } catch {
      decodedRecord = { kind: 'invalid' }
    }

    if (
      decodedRecord.kind === 'valid' &&
      decodedRecord.record.recoveryId === persisted.recoveryId
    ) {
      return decodedRecord.record
    }
    if (decodedRecord.kind === 'future') return null
    await deleteStoredRecovery(store)
    log.warn('load.discarded', { reason: decodedRecord.kind })
    return null
  })
}

export async function abandonRecoveredSession(
  recoveryId: string
): Promise<boolean> {
  const cleared = await clearSessionRecovery(recoveryId)
  if (!cleared) return false
  try {
    await activeDeps.setNativeSessionActive(false)
  } catch (err) {
    log.warn('native_active_clear.failed', { err })
  }
  return true
}
