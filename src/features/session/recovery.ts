// #225 — durable "you were in a session when StudyVis closed" record.
//
// The live session lives entirely in the (unpersisted) Zustand store, so a
// quit or a crash used to take the room credentials with it: the friend who
// stayed kept studying while the person who closed the app had no way back in
// short of another invite. This module is the one thing that survives the
// process, and it holds a bearer capability — the session topic and password
// are all anyone needs to enter the room — so the payload is sealed to the
// local identity's own X25519 key rather than written as plaintext JSON.
//
// Only the envelope is readable at rest: a version, the owning identity, and
// the write time. That is enough to scope and expire a record without opening
// it, and no help at all to anyone who copies the file off the device.

import { LazyStore } from '@tauri-apps/plugin-store'

import { boxDecryptWithKeyring, boxEncryptWithKeyring } from '@/lib/db/identity'
import { base64ToBytes, bytesToBase64, hexToBytes } from '@/lib/encoding'
import { logger } from '@/lib/log'
import { DEFAULT_DECLARED_STUDY_TOPIC } from '@/stores/sessionStore'

const log = logger.child('session.recovery')

export const SESSION_RECOVERY_STORE_FILE = 'session-recovery.json'
export const SESSION_RECOVERY_KEY = 'interrupted'
const RECORD_VERSION = 1 as const

// Domain tag inside the sealed plaintext. The seal reuses the identity's own
// X25519 keypair, which is also the key an inbox invite envelope is opened
// with; the tag is what stops a record from being mistaken for one.
const RECORD_DOMAIN = 'studyvis:session-recovery:v1'

// Past this the room is almost certainly gone and offering to re-enter it
// would be a lie. Deliberately generous: an overnight laptop lid is a real
// way to interrupt a study session.
export const SESSION_RECOVERY_MAX_AGE_MS = 12 * 60 * 60 * 1_000

const TOPIC_MAX_LENGTH = 512
const PASSWORD_MAX_LENGTH = 512
const STUDY_TOPIC_MAX_LENGTH = 120

export type SessionRecoveryRecord = {
  sessionTopic: string
  sessionPassword: string
  isHost: boolean
  // The signed inviter this stint bound its admission authority to, so a
  // recovered guest re-enters with the same anchor instead of trusting
  // whoever answers first.
  expectedAuthorityEdPubkeyHex: string | null
  declaredStudyTopic: string | null
  startedAt: number
  savedAt: number
}

type SealedEnvelope = {
  v: typeof RECORD_VERSION
  identityEdPubkeyHex: string
  savedAt: number
  nonce: string
  ciphertext: string
}

export type SessionRecoveryOwner = {
  edPubkeyHex: string
  xPubkeyHex: string
}

// 'unavailable' keeps the record: a store read or a keychain call that failed
// this boot says nothing about whether the session is recoverable, and
// deleting on a transient error would silently strand the user.
export type SessionRecoveryLoad =
  | { kind: 'none' }
  | { kind: 'record'; record: SessionRecoveryRecord }
  | { kind: 'unavailable' }

export type SessionRecoveryStoreLike = {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  save(): Promise<void>
}

export type SessionRecoveryDeps = {
  storeFactory: (() => SessionRecoveryStoreLike) | null
  seal: (
    theirXPub: Uint8Array,
    plaintext: Uint8Array
  ) => Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }>
  open: (
    theirXPub: Uint8Array,
    nonce: Uint8Array,
    ciphertext: Uint8Array
  ) => Promise<Uint8Array>
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

let cachedStore: LazyStore | null = null
function defaultStoreFactory(): SessionRecoveryStoreLike {
  // Matches pendingInvitesStore: plugin-store 2.4 wants an explicit defaults
  // object, and auto-save off means each write below flushes exactly once.
  cachedStore ??= new LazyStore(SESSION_RECOVERY_STORE_FILE, {
    defaults: {},
    autoSave: false,
  })
  return cachedStore as unknown as SessionRecoveryStoreLike
}

const defaultDeps: SessionRecoveryDeps = {
  storeFactory: isTauriRuntime() ? defaultStoreFactory : null,
  seal: boxEncryptWithKeyring,
  open: boxDecryptWithKeyring,
}

let activeDeps = defaultDeps
// Writes and the clear-on-leave must not interleave, or a slow save can land
// after the teardown that was supposed to erase it.
let queue: Promise<void> = Promise.resolve()
let retainedForQuit = false

export function __setSessionRecoveryDeps(deps: SessionRecoveryDeps): void {
  activeDeps = deps
}

export function __resetSessionRecoveryDeps(): void {
  activeDeps = defaultDeps
  cachedStore = null
  queue = Promise.resolve()
  retainedForQuit = false
}

export async function __flushSessionRecovery(): Promise<void> {
  let observed: Promise<void>
  do {
    observed = queue
    await observed
  } while (observed !== queue)
}

function enqueue(work: () => Promise<void>): Promise<void> {
  queue = queue.then(work, work)
  return queue
}

// A confirmed quit is not the end of the study session — it is the user
// stepping away from a room their friends may still be sitting in. The leave
// handler still runs (the report and the sessions row depend on it), so this
// flag is what tells it to leave the recovery record behind.
export function retainSessionRecoveryForQuit(): void {
  retainedForQuit = true
}

export function isSessionRecoveryRetainedForQuit(): boolean {
  return retainedForQuit
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringWithin(
  value: unknown,
  min: number,
  max: number
): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

function normalizeIdentity(edPubkeyHex: string): string {
  return edPubkeyHex.trim().toLowerCase()
}

function decodeSealedPlaintext(
  bytes: Uint8Array,
  savedAt: number
): SessionRecoveryRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.d !== RECORD_DOMAIN) return null

  const {
    sessionTopic,
    sessionPassword,
    isHost,
    expectedAuthorityEdPubkeyHex,
    declaredStudyTopic,
    startedAt,
  } = parsed

  if (!isStringWithin(sessionTopic, 1, TOPIC_MAX_LENGTH)) return null
  if (!isStringWithin(sessionPassword, 1, PASSWORD_MAX_LENGTH)) return null
  if (typeof isHost !== 'boolean') return null
  if (
    expectedAuthorityEdPubkeyHex !== null &&
    !isStringWithin(expectedAuthorityEdPubkeyHex, 64, 64)
  ) {
    return null
  }
  if (
    declaredStudyTopic !== null &&
    !isStringWithin(declaredStudyTopic, 1, STUDY_TOPIC_MAX_LENGTH)
  ) {
    return null
  }
  if (typeof startedAt !== 'number' || !Number.isSafeInteger(startedAt)) {
    return null
  }

  return {
    sessionTopic,
    sessionPassword,
    isHost,
    expectedAuthorityEdPubkeyHex:
      expectedAuthorityEdPubkeyHex === null
        ? null
        : expectedAuthorityEdPubkeyHex.toLowerCase(),
    declaredStudyTopic,
    startedAt,
    savedAt,
  }
}

function decodeEnvelope(value: unknown, owner: string): SealedEnvelope | null {
  if (!isRecord(value)) return null
  if (value.v !== RECORD_VERSION) return null
  if (typeof value.identityEdPubkeyHex !== 'string') return null
  if (normalizeIdentity(value.identityEdPubkeyHex) !== owner) return null
  if (
    typeof value.savedAt !== 'number' ||
    !Number.isSafeInteger(value.savedAt)
  ) {
    return null
  }
  if (typeof value.nonce !== 'string' || typeof value.ciphertext !== 'string') {
    return null
  }
  return {
    v: RECORD_VERSION,
    identityEdPubkeyHex: owner,
    savedAt: value.savedAt,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
  }
}

// Called when a session goes live. Failure is logged, never thrown: a session
// that cannot be made recoverable is still a session worth having.
export function saveSessionRecovery(
  owner: SessionRecoveryOwner,
  record: Omit<SessionRecoveryRecord, 'savedAt'>,
  now: number = Date.now()
): Promise<void> {
  return enqueue(async () => {
    const factory = activeDeps.storeFactory
    if (!factory) return
    retainedForQuit = false
    try {
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          d: RECORD_DOMAIN,
          sessionTopic: record.sessionTopic,
          sessionPassword: record.sessionPassword,
          isHost: record.isHost,
          expectedAuthorityEdPubkeyHex: record.expectedAuthorityEdPubkeyHex,
          declaredStudyTopic: record.declaredStudyTopic,
          startedAt: record.startedAt,
        })
      )
      const { nonce, ciphertext } = await activeDeps.seal(
        hexToBytes(owner.xPubkeyHex),
        plaintext
      )
      const envelope: SealedEnvelope = {
        v: RECORD_VERSION,
        identityEdPubkeyHex: normalizeIdentity(owner.edPubkeyHex),
        savedAt: now,
        nonce: bytesToBase64(nonce),
        ciphertext: bytesToBase64(ciphertext),
      }
      const store = factory()
      await store.set(SESSION_RECOVERY_KEY, envelope)
      await store.save()
    } catch (err) {
      log.error('save.failed', { err })
    }
  })
}

// Called once a session is live, from both the host and the join paths. Fire
// and forget: recoverability is a convenience, and a store that will not write
// must not stop the session it describes.
//
// Host stints are deliberately NOT recorded. When the original host goes, the
// survivors freeze admissions against that host's TRANSPORT peer id
// (lifecycle.ts `lostAdmissionAuthority`, #219), and a relaunched process has
// a new one — so a returning host would be shown a rejoin button that leads to
// the empty room this issue is about. Covering it means rebinding authority by
// signed identity, which is a peer wire-contract change rather than a UI one.
// A guest whose host stayed is readmitted normally; that is the reported case.
export function rememberActiveSession(args: {
  identity: { ed_pubkey_hex: string; x_pubkey_hex: string } | null
  sessionTopic: string
  sessionPassword: string
  isHost: boolean
  expectedAuthorityEdPubkeyHex: string | null
  declaredStudyTopic: string
  startedAt: number
}): void {
  if (!args.identity || args.isHost) return
  void saveSessionRecovery(
    {
      edPubkeyHex: args.identity.ed_pubkey_hex,
      xPubkeyHex: args.identity.x_pubkey_hex,
    },
    {
      sessionTopic: args.sessionTopic,
      sessionPassword: args.sessionPassword,
      isHost: args.isHost,
      expectedAuthorityEdPubkeyHex: args.expectedAuthorityEdPubkeyHex,
      // The placeholder label says nothing worth putting on the prompt.
      declaredStudyTopic:
        args.declaredStudyTopic === DEFAULT_DECLARED_STUDY_TOPIC
          ? null
          : args.declaredStudyTopic,
      startedAt: args.startedAt,
    }
  )
}

export function clearSessionRecovery(): Promise<void> {
  return enqueue(async () => {
    retainedForQuit = false
    const factory = activeDeps.storeFactory
    if (!factory) return
    try {
      const store = factory()
      await store.delete(SESSION_RECOVERY_KEY)
      await store.save()
    } catch (err) {
      log.error('clear.failed', { err })
    }
  })
}

// The leave handler runs on the confirmed-quit path too. Quitting is the one
// ending that is meant to be resumable, so it keeps the record.
export function clearSessionRecoveryOnLeave(): Promise<void> {
  if (retainedForQuit) return Promise.resolve()
  return clearSessionRecovery()
}

export async function loadSessionRecovery(
  owner: SessionRecoveryOwner,
  now: number = Date.now()
): Promise<SessionRecoveryLoad> {
  const factory = activeDeps.storeFactory
  if (!factory) return { kind: 'none' }

  let raw: unknown
  try {
    raw = await factory().get<unknown>(SESSION_RECOVERY_KEY)
  } catch (err) {
    log.error('load.failed', { phase: 'read', err })
    return { kind: 'unavailable' }
  }
  if (raw === undefined) return { kind: 'none' }

  const envelope = decodeEnvelope(raw, normalizeIdentity(owner.edPubkeyHex))
  // Unreadable, from a future build, or written by another identity on this
  // device. None of those is ours to act on, and none is ours to delete.
  if (!envelope) return { kind: 'none' }
  if (
    envelope.savedAt > now ||
    now - envelope.savedAt > SESSION_RECOVERY_MAX_AGE_MS
  ) {
    await clearSessionRecovery()
    return { kind: 'none' }
  }

  let plaintext: Uint8Array
  try {
    plaintext = await activeDeps.open(
      hexToBytes(owner.xPubkeyHex),
      base64ToBytes(envelope.nonce),
      base64ToBytes(envelope.ciphertext)
    )
  } catch (err) {
    // The keychain answered for the identity load but not for this; the
    // sealed record is still valid, so it stays on disk for the next boot.
    log.error('load.failed', { phase: 'open', err })
    return { kind: 'unavailable' }
  }

  const record = decodeSealedPlaintext(plaintext, envelope.savedAt)
  if (!record) {
    await clearSessionRecovery()
    return { kind: 'none' }
  }
  // Belt and braces against the invariant rememberActiveSession enforces on
  // the way in: this build never offers a host stint for recovery, so a host
  // record could only be stale state it should not be sitting on.
  if (record.isHost || record.startedAt > now) {
    await clearSessionRecovery()
    return { kind: 'none' }
  }
  return { kind: 'record', record }
}
