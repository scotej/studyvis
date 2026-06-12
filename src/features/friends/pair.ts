import { generateMnemonic } from '@scure/bip39'
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js'

import { bytesToHex, hexToBytes, verifyMessage } from '@/lib/crypto/identity'
import { pairPassword, pairTopic } from '@/lib/crypto/topics'
import { joinTopic } from '@/lib/trystero'
import { buildIceOptions } from '@/lib/trystero/ice'
import { userRelayConfig } from '@/lib/trystero/relays'
import type { TurnPreference } from '@/stores/settingsStore'

export const PAIR_WORD_COUNT = 12
const PAIR_ENTROPY_BITS = 128
const HELLO_ACTION = 'hello'

// F5 — after a peer is on the Nostr topic, trystero needs a WebRTC datachannel
// to form before the signed hello can cross. On strict/symmetric NAT with no
// TURN server the channel never establishes and the dialog sits on "Exchanging
// keys" forever. This is how long we wait post-arrival before surfacing the
// "couldn't establish a direct link" guidance. Longer than the typical ICE
// gathering + DTLS handshake, short enough not to feel hung.
export const POST_ARRIVAL_STALL_MS = 45_000

export type PairingContext = {
  edPubHex: string
  xPubHex: string
  displayName: string
  sign: (message: Uint8Array) => Promise<Uint8Array>
}

export type PairedFriend = {
  edPubkey: string
  xPubkey: string
  name: string
}

export type PairOptions = {
  signal?: AbortSignal
  // Fires once the room sees the other peer arrive but before the signed
  // hello has been verified. Lets the dialog flip its status text from
  // "waiting for friend" to "exchanging keys".
  onPeerJoinedTopic?: () => void
  // Reject with PairTimeoutError if the pair hasn't settled within this many
  // milliseconds. Call sites that don't pass this stay timeout-less and wait
  // until aborted — the friend-pairing dialog relies on that so a slow code
  // transfer between two devices doesn't race a deadline.
  timeoutMs?: number
  // User's TURN preference (Settings → Network), mapped to ICE config via
  // buildIceOptions. Defaults to 'auto'. Takes effect only once a TURN server
  // is configured in lib/trystero/ice (none ships by default — see that file).
  turnPreference?: TurnPreference
  // F1 — fires when trystero reports a room-level join error during pairing: a
  // peer reached the topic but its offer/answer failed to decrypt under the
  // room password, or its handshake errored out. This is a peer-present-but-
  // the-link-failed signal — NOT "the relays are unreachable" (trystero never
  // reports that here; the dialog reads relay reachability from the socket map
  // instead). Best-effort: the pairing keeps running, so the user can keep
  // waiting or cancel.
  onJoinError?: () => void
  // F5 — fires when a peer has been on the topic for `stallMs` without the
  // pairing settling (no datachannel formed → no signed hello exchanged).
  // Surfaces the "connected to the network but couldn't establish a direct
  // link" guidance. Best-effort and one-shot; pairing keeps running.
  onPostArrivalStall?: () => void
  // F5 — how long after a peer arrives to wait before firing onPostArrivalStall.
  // Defaults to POST_ARRIVAL_STALL_MS; injectable so the unit test drives it
  // with fake timers.
  stallMs?: number
}

export type HelloPayload = {
  type: 'hello'
  ed_pubkey: string
  x_pubkey: string
  display_name: string
  sig: string
}

export class PairAbortedError extends Error {
  constructor() {
    super('pairing aborted')
    this.name = 'PairAbortedError'
  }
}

export class PairTimeoutError extends Error {
  constructor() {
    super('pairing timed out')
    this.name = 'PairTimeoutError'
  }
}

export class PairVerificationError extends Error {
  constructor(reason: string) {
    super(`pairing verification failed: ${reason}`)
    this.name = 'PairVerificationError'
  }
}

export function generatePairingCode(): string[] {
  return generateMnemonic(englishWordlist, PAIR_ENTROPY_BITS).split(' ')
}

export function buildPairAuthMessage(
  words: string[],
  edPubkeyHex: string,
  xPubkeyHex: string
): Uint8Array {
  return new TextEncoder().encode(words.join('-') + edPubkeyHex + xPubkeyHex)
}

export async function buildHello(
  words: string[],
  ctx: PairingContext
): Promise<HelloPayload> {
  const msg = buildPairAuthMessage(words, ctx.edPubHex, ctx.xPubHex)
  const sig = await ctx.sign(msg)
  return {
    type: 'hello',
    ed_pubkey: ctx.edPubHex,
    x_pubkey: ctx.xPubHex,
    display_name: ctx.displayName,
    sig: bytesToHex(sig),
  }
}

export function verifyHello(
  words: string[],
  hello: HelloPayload,
  localEdPubHex?: string
): PairedFriend {
  if (hello?.type !== 'hello') {
    throw new PairVerificationError('not a hello payload')
  }
  if (
    localEdPubHex !== undefined &&
    typeof hello.ed_pubkey === 'string' &&
    hello.ed_pubkey.toLowerCase() === localEdPubHex.toLowerCase()
  ) {
    // Pairing with your own pubkey (own code echoed back) would create a
    // self friend row. The signature would still verify, so reject here. (I18)
    throw new PairVerificationError('cannot pair with your own identity')
  }
  if (
    typeof hello.ed_pubkey !== 'string' ||
    typeof hello.x_pubkey !== 'string' ||
    typeof hello.sig !== 'string' ||
    typeof hello.display_name !== 'string'
  ) {
    throw new PairVerificationError('hello has missing or wrong-type fields')
  }
  let edPub: Uint8Array
  let xPub: Uint8Array
  let sig: Uint8Array
  try {
    edPub = hexToBytes(hello.ed_pubkey)
    xPub = hexToBytes(hello.x_pubkey)
    sig = hexToBytes(hello.sig)
  } catch (e) {
    throw new PairVerificationError(
      `hex decode failed: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  if (edPub.length !== 32) {
    throw new PairVerificationError('ed_pubkey must be 32 bytes')
  }
  if (xPub.length !== 32) {
    throw new PairVerificationError('x_pubkey must be 32 bytes')
  }
  const msg = buildPairAuthMessage(words, hello.ed_pubkey, hello.x_pubkey)
  if (!verifyMessage(edPub, msg, sig)) {
    throw new PairVerificationError('signature does not verify')
  }
  return {
    edPubkey: hello.ed_pubkey,
    xPubkey: hello.x_pubkey,
    name: hello.display_name,
  }
}

async function runPair(
  words: string[],
  ctx: PairingContext,
  opts: PairOptions
): Promise<PairedFriend> {
  if (opts.signal?.aborted) throw new PairAbortedError()

  const room = joinTopic({
    topic: pairTopic(words),
    password: pairPassword(words),
    relayConfig: userRelayConfig(),
    ...buildIceOptions(opts.turnPreference ?? 'auto'),
    onJoinError: () => {
      // Best-effort signal; never let a throwing handler bubble into trystero.
      try {
        opts.onJoinError?.()
      } catch {
        // Swallow — surfacing the hint must not crash the room.
      }
    },
  })
  const action = room.makeAction<HelloPayload>(HELLO_ACTION)

  const stallMs = opts.stallMs ?? POST_ARRIVAL_STALL_MS
  let onAbort: (() => void) | null = null
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let stallHandle: ReturnType<typeof setTimeout> | null = null
  let unsubscribePeerJoin: () => void = () => {}
  try {
    return await new Promise<PairedFriend>((resolve, reject) => {
      let settled = false
      let peerSeen = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        if (stallHandle !== null) {
          clearTimeout(stallHandle)
          stallHandle = null
        }
        fn()
      }
      onAbort = () => settle(() => reject(new PairAbortedError()))

      if (opts.signal) opts.signal.addEventListener('abort', onAbort)

      if (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          settle(() => reject(new PairTimeoutError()))
        }, opts.timeoutMs)
      }

      action.receive((payload) => {
        if (settled) return
        try {
          const friend = verifyHello(words, payload, ctx.edPubHex)
          settle(() => resolve(friend))
        } catch (err) {
          settle(() => reject(err))
        }
      })

      unsubscribePeerJoin = room.onPeerJoin(async () => {
        if (settled) return
        // Trystero may fire onPeerJoin twice when both peers race the
        // microtask in the in-process test bus; only notify once.
        if (!peerSeen) {
          peerSeen = true
          try {
            opts.onPeerJoinedTopic?.()
          } catch {
            // Swallow notification errors — they shouldn't fail the pair.
          }
          // F5 — arm the post-arrival stall timer. The peer is on the topic;
          // if no hello crosses within stallMs the WebRTC channel never formed
          // (strict NAT without TURN), so nudge the user toward a relay/TURN.
          // One-shot — never re-armed on a duplicate onPeerJoin.
          if (stallHandle === null && stallMs > 0) {
            stallHandle = setTimeout(() => {
              stallHandle = null
              if (settled) return
              try {
                opts.onPostArrivalStall?.()
              } catch {
                // Swallow — the hint must not fail the pair.
              }
            }, stallMs)
          }
        }
        try {
          const hello = await buildHello(words, ctx)
          await action.send(hello)
        } catch (err) {
          settle(() => reject(err))
        }
      })
    })
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle)
    if (stallHandle !== null) clearTimeout(stallHandle)
    if (opts.signal && onAbort) {
      opts.signal.removeEventListener('abort', onAbort)
    }
    unsubscribePeerJoin()
    try {
      await room.leave()
    } catch {
      // best-effort: a failed leave shouldn't mask the actual outcome
    }
  }
}

export function hostPairing(
  words: string[],
  ctx: PairingContext,
  opts: PairOptions = {}
): Promise<PairedFriend> {
  return runPair(words, ctx, opts)
}

export function joinPairing(
  words: string[],
  ctx: PairingContext,
  opts: PairOptions = {}
): Promise<PairedFriend> {
  return runPair(words, ctx, opts)
}
