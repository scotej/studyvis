import { inboxPassword, inboxTopic } from '@/lib/crypto/topics'
import { bytesToBase64, bytesToHex, hexToBytes } from '@/lib/encoding'
import { relaysUnreachable } from '@/lib/relayDiagnostics'
import { joinTopic } from '@/lib/trystero'
import { userRelayConfig } from '@/lib/trystero/relays'
import { useSessionStore } from '@/stores/sessionStore'

import {
  INVITE_ACTION,
  INVITE_ENVELOPE_VERSION,
  INVITE_TTL_MS,
  serializePayloadForSig,
  type InviteEnvelope,
  type InvitePayload,
  type InvitePayloadCore,
} from './envelope'
import { createInviteRetryManager } from './inviteRetry'

// F6 — process-wide retry manager. `inviteFriend` registers a pending retry on
// InviteTimeoutError (the friend was offline) and marks (recipient, session)
// delivered on success; InboxBoot drives `onPresenceOnline` when a friend's
// presence flips online, and `cancelAll` when the host's session ends.
export const inviteRetryManager = createInviteRetryManager({
  onRetryError: (err) => console.warn('invite retry failed:', err),
  // PR-9 — only ever retry-deliver an invite for the session the host is still
  // in. A retry queued for a session that has since ended must not pull the
  // friend into an empty room.
  isSessionLive: (sessionTopic) => {
    const s = useSessionStore.getState()
    return s.status === 'active' && s.sessionTopic === sessionTopic
  },
})

export type InviteRecipient = {
  edPubkeyHex: string
  xPubkeyHex: string
}

// Both sign and encrypt are async + injected so the production path can call
// keyring-backed Tauri commands (identity_sign, identity_box_encrypt) and tests
// can inject in-process closures with explicit private keys.
export type EncryptToFn = (
  theirXPub: Uint8Array,
  plaintext: Uint8Array
) => Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }>

export type InviteSender = {
  edPubkeyHex: string
  displayName: string
  sign: (message: Uint8Array) => Promise<Uint8Array>
  encryptTo: EncryptToFn
}

export type InviteOptions = {
  ttlMs?: number
  now?: () => number
  // Maximum time to wait for the recipient to be on their inbox topic before
  // giving up. Default 15s — long enough to absorb a slow Nostr handshake,
  // short enough that a click on a friend who just went offline gets fast
  // feedback instead of a stuck-forever toast. Caller may override via
  // AbortSignal in a later phase (V1-P8/P10).
  sendTimeoutMs?: number
}

// Message is developer-facing only; the user-facing copy lives in
// strings.friends.inviteTimeout and is mapped by type at the call site
// (Home.tsx) so no UI string leaks out of the feature layer.
export class InviteTimeoutError extends Error {
  constructor() {
    super('invite send timed out')
    this.name = 'InviteTimeoutError'
  }
}

// F1/F6 — distinct from InviteTimeoutError: no signaling relay was reachable,
// so the failure is the user's own network, not a friend who's merely offline.
// Reachability is read from trystero's live socket map at timeout (NOT from
// `onJoinError`, which never fires on blocked relays — see relaysUnreachable).
// Mapped to its own copy at the call site so we don't tell the user "they may
// be offline" when in fact the relays are blocked.
export class InviteRelayError extends Error {
  constructor() {
    super('invite send could not reach the relay')
    this.name = 'InviteRelayError'
  }
}

const DEFAULT_SEND_TIMEOUT_MS = 15_000

export type SessionInvite = {
  sessionTopic: string
  sessionPassword: string
}

export async function buildInvitePayload(
  sender: InviteSender,
  session: SessionInvite,
  opts: InviteOptions = {}
): Promise<InvitePayload> {
  const now = opts.now ? opts.now() : Date.now()
  const expires_at = now + (opts.ttlMs ?? INVITE_TTL_MS)
  const core: InvitePayloadCore = {
    session_topic: session.sessionTopic,
    session_password: session.sessionPassword,
    our_display_name: sender.displayName,
    expires_at,
  }
  const sig = await sender.sign(serializePayloadForSig(core))
  return { ...core, sig: bytesToHex(sig) }
}

export async function buildInviteEnvelope(
  sender: InviteSender,
  recipient: InviteRecipient,
  session: SessionInvite,
  opts: InviteOptions = {}
): Promise<InviteEnvelope> {
  const recipientXPub = hexToBytes(recipient.xPubkeyHex)
  if (recipientXPub.length !== 32) {
    throw new Error('recipient x_pubkey must decode to 32 bytes')
  }
  const payload = await buildInvitePayload(sender, session, opts)
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const { nonce, ciphertext } = await sender.encryptTo(recipientXPub, plaintext)
  return {
    v: INVITE_ENVELOPE_VERSION,
    from_ed_pubkey: sender.edPubkeyHex,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
  }
}

// Joins the recipient's inbox topic, sends one invite envelope as
// makeAction(INVITE_ACTION), then leaves. Caller awaits the full lifecycle —
// the room is fully closed when the promise settles, including on timeout.
export async function sendInviteEnvelope(
  recipient: InviteRecipient,
  envelope: InviteEnvelope,
  opts: {
    sendTimeoutMs?: number
    // F1/F6 test seam — overrides the live relay-reachability read at timeout.
    isRelayUnreachable?: () => boolean
  } = {}
): Promise<void> {
  const recipientEdPub = hexToBytes(recipient.edPubkeyHex)
  if (recipientEdPub.length !== 32) {
    throw new Error('recipient ed_pubkey must decode to 32 bytes')
  }
  const timeoutMs = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS
  const isRelayUnreachable = opts.isRelayUnreachable ?? relaysUnreachable
  const room = joinTopic({
    topic: inboxTopic(recipientEdPub),
    password: inboxPassword(recipientEdPub),
    relayConfig: userRelayConfig(),
  })
  const action = room.makeAction<InviteEnvelope>(INVITE_ACTION)

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let unsubscribePeerJoin: (() => void) | null = null
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        unsubscribePeerJoin?.()
        clearTimeout(timer)
        fn()
      }
      const timer = setTimeout(() => {
        // F1/F6 — no peer arrived in time. Distinguish "the friend is offline"
        // from "the relays are blocked" by reading the live socket map: if no
        // relay is reachable, it's the user's own network (InviteRelayError, no
        // retry queued); otherwise the friend is simply offline.
        settle(() =>
          reject(
            isRelayUnreachable()
              ? new InviteRelayError()
              : new InviteTimeoutError()
          )
        )
      }, timeoutMs)
      // Once at least one peer is on the topic, fire the envelope to all
      // listeners and resolve. The timeout above guarantees the promise
      // settles even if no peer ever joins.
      unsubscribePeerJoin = room.onPeerJoin(() => {
        if (settled) return
        action
          .send(envelope)
          .then(() => settle(resolve))
          .catch((err) => settle(() => reject(err)))
      })
    })
  } finally {
    try {
      await room.leave()
    } catch {
      // best-effort: a failed leave shouldn't mask the actual outcome
    }
  }
}

export async function inviteFriend(
  sender: InviteSender,
  recipient: InviteRecipient,
  session: SessionInvite,
  opts: InviteOptions = {}
): Promise<void> {
  const envelope = await buildInviteEnvelope(sender, recipient, session, opts)
  const sessionTopic = session.sessionTopic
  const deliver = () =>
    sendInviteEnvelope(recipient, envelope, {
      sendTimeoutMs: opts.sendTimeoutMs,
    })
  try {
    await deliver()
    // F6 — first send landed; dedupe future retries for this (friend, session).
    inviteRetryManager.markDelivered(recipient.edPubkeyHex, sessionTopic)
  } catch (err) {
    // F6 — the friend was offline (no peer ever joined their inbox topic).
    // Hold the invite and re-attempt when their presence flips online within
    // the retry window. A relay-unreachable failure (InviteRelayError) is the
    // user's own network, not an offline friend, so we don't queue a retry —
    // the same relay would be just as unreachable.
    if (err instanceof InviteTimeoutError) {
      inviteRetryManager.register(recipient.edPubkeyHex, sessionTopic, deliver)
    }
    throw err
  }
}
