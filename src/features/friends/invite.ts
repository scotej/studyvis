import { bytesToHex, hexToBytes } from '@/lib/crypto/identity'
import { inboxPassword, inboxTopic } from '@/lib/crypto/topics'
import { joinTopic } from '@/lib/trystero'

import {
  bytesToBase64,
  INVITE_ACTION,
  INVITE_ENVELOPE_VERSION,
  INVITE_TTL_MS,
  serializePayloadForSig,
  type InviteEnvelope,
  type InvitePayload,
  type InvitePayloadCore,
} from './envelope'

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
}

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
// the room is fully closed when the promise settles.
export async function sendInviteEnvelope(
  recipient: InviteRecipient,
  envelope: InviteEnvelope
): Promise<void> {
  const recipientEdPub = hexToBytes(recipient.edPubkeyHex)
  if (recipientEdPub.length !== 32) {
    throw new Error('recipient ed_pubkey must decode to 32 bytes')
  }
  const room = joinTopic({
    topic: inboxTopic(recipientEdPub),
    password: inboxPassword(recipientEdPub),
  })
  const action = room.makeAction<InviteEnvelope>(INVITE_ACTION)

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }
      // Once at least one peer is on the topic, fire the envelope to all
      // listeners and resolve. If no peer ever joins, the caller's outer
      // timeout (or AbortSignal in a future phase) decides when to give up.
      room.onPeerJoin(() => {
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
  await sendInviteEnvelope(recipient, envelope)
}
