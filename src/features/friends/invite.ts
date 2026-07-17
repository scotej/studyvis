import { verifyMessage } from '@/lib/crypto/identity'
import { inboxPassword, inboxTopic } from '@/lib/crypto/topics'
import { bytesToBase64, bytesToHex, hexToBytes } from '@/lib/encoding'
import { pairingRelaysUnreachable } from '@/lib/relayDiagnostics'
import { joinTopic } from '@/lib/trystero'
import { buildIceOptions } from '@/lib/trystero/ice'
import { userRelayConfig } from '@/lib/trystero/relays'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'

import {
  INVITE_ACK_ACTION,
  INVITE_ACK_VERSION,
  INVITE_ACTION,
  INVITE_ENVELOPE_VERSION,
  INVITE_TTL_MS,
  serializeAckForSig,
  serializePayloadForSig,
  type InviteAck,
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
  // #47 C2 — how long to linger for the signed delivery ACK after a
  // successful send (default 5s).
  ackTimeoutMs?: number
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
// #47 C2 — how long the sender lingers on the recipient's inbox topic after a
// successful send, waiting for the signed delivery ACK. Recipients answer
// automatically (no user action), so a healthy round-trip is fast; older
// builds never answer, and the caller falls back to unconfirmed copy.
const DEFAULT_ACK_TIMEOUT_MS = 5_000

// #47 C2 — the send outcome: `acked` is true only when the recipient's build
// confirmed delivery with a signature that verifies against their known ed
// pubkey. False means "sent, unconfirmed": an older build, a slow answer, or
// — the case this exists to surface — a friend who never added you back, so
// their inbox silently dropped the envelope.
export type InviteSendResult = { acked: boolean }

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

type SendEnvelopeOpts = {
  sendTimeoutMs?: number
  // #47 C2 — session topic the delivery ACK must name; when provided the
  // sender lingers ackTimeoutMs for a verified ACK and reports it.
  ackSessionTopic?: string
  ackTimeoutMs?: number
  // F1/F6 test seam — overrides the live relay-reachability read at timeout.
  isRelayUnreachable?: () => boolean
}

// Two concurrent sends to the same friend collide inside trystero: its core
// dedupes rooms per (appId, topic), so the second joinTopic gets the SAME
// raw room whose last-wins listener registration disconnects the first
// send's onPeerJoin/ACK handlers, and whichever send finishes first calls
// room.leave() — destroying the shared room under the other mid-flight. The
// realistic trigger is the F6 offline-retry auto-firing on a presence flip
// at the moment the host clicks Invite manually. Serialize per inbox topic:
// each send awaits the previous one's FULL lifecycle (its finally closes
// the room before the promise settles).
const sendChains = new Map<string, Promise<unknown>>()

// Joins the recipient's inbox topic, sends one invite envelope as
// makeAction(INVITE_ACTION), then leaves. Caller awaits the full lifecycle —
// the room is fully closed when the promise settles, including on timeout.
export async function sendInviteEnvelope(
  recipient: InviteRecipient,
  envelope: InviteEnvelope,
  opts: SendEnvelopeOpts = {}
): Promise<InviteSendResult> {
  const recipientEdPub = hexToBytes(recipient.edPubkeyHex)
  if (recipientEdPub.length !== 32) {
    throw new Error('recipient ed_pubkey must decode to 32 bytes')
  }
  const chainKey = inboxTopic(recipientEdPub)
  const prev = sendChains.get(chainKey) ?? Promise.resolve()
  const run = prev.then(() =>
    sendInviteEnvelopeNow(recipientEdPub, recipient, envelope, opts)
  )
  // The chain tail swallows this send's outcome so a failed send never
  // poisons the next one; the map entry is dropped once the topic is idle.
  const tail = run.catch(() => {})
  sendChains.set(chainKey, tail)
  void tail.then(() => {
    if (sendChains.get(chainKey) === tail) sendChains.delete(chainKey)
  })
  return run
}

async function sendInviteEnvelopeNow(
  recipientEdPub: Uint8Array,
  recipient: InviteRecipient,
  envelope: InviteEnvelope,
  opts: SendEnvelopeOpts
): Promise<InviteSendResult> {
  const timeoutMs = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS
  // #47 C1 — the send path now races both transports, so the network-down
  // verdict at timeout must consider both socket maps (the same PR-21
  // rationale as pairing).
  const isRelayUnreachable = opts.isRelayUnreachable ?? pairingRelaysUnreachable
  const room = joinTopic({
    topic: inboxTopic(recipientEdPub),
    password: inboxPassword(recipientEdPub),
    relayConfig: userRelayConfig(),
    // #47 C1 — a recipient behind a Nostr-blocking firewall is reachable over
    // MQTT; the merged room's onPeerJoin fires on whichever transport sees
    // them first, and the ACK listener latches a boolean so duplicate
    // delivery is harmless.
    strategies: ['nostr', 'mqtt'],
    // onPeerJoin fires only after the WebRTC handshake, so a strict-NAT send
    // without the user's TURN server times out and misreports "friend may be
    // offline" — the exact case the TURN setting exists to fix. This room is
    // per-send, so a TURN change applies on the next invite, no restart.
    ...buildIceOptions(useSettingsStore.getState().values.turnPreference),
  })
  const action = room.makeAction<InviteEnvelope>(INVITE_ACTION)

  // #47 C2 — register the ACK listener BEFORE sending so a fast answer can't
  // slip past. Resolves true on the first ack that (a) names our session,
  // (b) is addressed to us, (c) comes from the recipient we invited, and
  // (d) verifies against their known ed pubkey.
  let ackReceived: () => boolean = () => false
  if (opts.ackSessionTopic !== undefined) {
    let acked = false
    ackReceived = () => acked
    const expectedTopic = opts.ackSessionTopic
    const ackAction = room.makeAction<InviteAck>(INVITE_ACK_ACTION)
    ackAction.receive((data) => {
      if (acked || !data || typeof data !== 'object') return
      if (data.v !== INVITE_ACK_VERSION) return
      if (data.session_topic !== expectedTopic) return
      if (data.to_ed_pubkey !== envelope.from_ed_pubkey) return
      if (data.from_ed_pubkey !== recipient.edPubkeyHex) return
      if (typeof data.sig !== 'string' || typeof data.ts !== 'number') return
      let sig: Uint8Array
      try {
        sig = hexToBytes(data.sig)
      } catch {
        return
      }
      if (sig.length !== 64) return
      const signed = serializeAckForSig({
        session_topic: data.session_topic,
        to_ed_pubkey: data.to_ed_pubkey,
        ts: data.ts,
      })
      if (!verifyMessage(recipientEdPub, signed, sig)) return
      acked = true
    })
  }

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
    // #47 C2 — linger for the delivery ACK. Poll the flag on a short tick
    // rather than restructuring the receive callback into a promise: the
    // window is bounded and small.
    if (opts.ackSessionTopic !== undefined && !ackReceived()) {
      const ackDeadline =
        Date.now() + (opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS)
      while (!ackReceived() && Date.now() < ackDeadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    return { acked: ackReceived() }
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
): Promise<InviteSendResult> {
  const envelope = await buildInviteEnvelope(sender, recipient, session, opts)
  const sessionTopic = session.sessionTopic
  const deliver = () =>
    sendInviteEnvelope(recipient, envelope, {
      sendTimeoutMs: opts.sendTimeoutMs,
      ackSessionTopic: sessionTopic,
      ackTimeoutMs: opts.ackTimeoutMs,
    })
  try {
    const result = await deliver()
    // F6 — first send landed; dedupe future retries for this (friend, session).
    inviteRetryManager.markDelivered(recipient.edPubkeyHex, sessionTopic)
    return result
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
