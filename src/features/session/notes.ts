// #47 B6 — quiet in-session text notes. The only in-session communication
// was voice PTT, which breaks the silence for everyone; typing "brb 5" or
// dropping a link meant switching to the messenger the app exists to avoid.
// Rides the established makeAction wire pattern: signed like audit events
// (receivers authenticate against the signed-hello peerId→ed_pubkey binding,
// never the wire's own claim), length-capped, and NEVER persisted — notes
// live in a session-scoped store and die with the session, staying clear of
// the recording non-goal (PLAN §6). Older builds simply don't register the
// action, so nothing strands a peer.

import { verifyMessage } from '@/lib/crypto/identity'
import { bytesToHex, hexToBytes } from '@/lib/encoding'

export const NOTE_ACTION = 'session-note'
export const NOTE_VERSION = 1 as const
export const NOTE_MAX_LENGTH = 500

export type NoteCore = {
  v: typeof NOTE_VERSION
  session_topic: string
  // Sender's ed_pubkey hex. Receivers MUST match this against the signed-
  // hello binding for the delivering peerId (see verifyIncomingNote).
  from_ed_pubkey: string
  text: string
  ts: number
}

export type NotePayload = NoteCore & { sig: string }

// Canonical bytes-being-signed AND bytes the receiver re-serializes for
// verification — fixed key order, same convention as serializeAuditForSig.
export function serializeNoteForSig(core: NoteCore): Uint8Array {
  const canonical = JSON.stringify({
    v: core.v,
    session_topic: core.session_topic,
    from_ed_pubkey: core.from_ed_pubkey,
    text: core.text,
    ts: core.ts,
  })
  return new TextEncoder().encode(canonical)
}

export async function buildNotePayload(args: {
  sessionTopic: string
  myEdPubkeyHex: string
  text: string
  sign: (message: Uint8Array) => Promise<Uint8Array>
  now?: () => number
}): Promise<NotePayload> {
  const text = args.text.trim().slice(0, NOTE_MAX_LENGTH)
  const core: NoteCore = {
    v: NOTE_VERSION,
    session_topic: args.sessionTopic,
    from_ed_pubkey: args.myEdPubkeyHex,
    text,
    ts: args.now ? args.now() : Date.now(),
  }
  const sig = await args.sign(serializeNoteForSig(core))
  return { ...core, sig: bytesToHex(sig) }
}

// Drop-don't-throw validation, mirroring verifyIncomingAuditEvent:
//   - well-shaped, right version, non-empty text within the cap
//   - from_ed_pubkey matches the hello-bound key for the delivering peer
//     (null binding → drop; hello hasn't landed, we can't authenticate)
//   - addressed to THIS session (replay guard, I8 convention)
//   - signature verifies over the canonical bytes
export function verifyIncomingNote(
  data: unknown,
  expectedEdPubkeyHex: string | null,
  sessionTopic: string
): NotePayload | null {
  if (!data || typeof data !== 'object') return null
  const v = data as Partial<NotePayload>
  if (v.v !== NOTE_VERSION) return null
  if (
    typeof v.session_topic !== 'string' ||
    typeof v.from_ed_pubkey !== 'string' ||
    typeof v.text !== 'string' ||
    typeof v.ts !== 'number' ||
    typeof v.sig !== 'string'
  ) {
    return null
  }
  if (v.text.trim().length === 0 || v.text.length > NOTE_MAX_LENGTH) return null
  if (!expectedEdPubkeyHex || v.from_ed_pubkey !== expectedEdPubkeyHex)
    return null
  if (v.session_topic !== sessionTopic) return null
  let edPub: Uint8Array
  let sig: Uint8Array
  try {
    edPub = hexToBytes(v.from_ed_pubkey)
    sig = hexToBytes(v.sig)
  } catch {
    return null
  }
  if (edPub.length !== 32 || sig.length !== 64) return null
  const signed = serializeNoteForSig({
    v: v.v,
    session_topic: v.session_topic,
    from_ed_pubkey: v.from_ed_pubkey,
    text: v.text,
    ts: v.ts,
  })
  if (!verifyMessage(edPub, signed, sig)) return null
  return v as NotePayload
}
