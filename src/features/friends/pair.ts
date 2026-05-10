import { generateMnemonic } from '@scure/bip39'
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js'

import { bytesToHex, hexToBytes, verifyMessage } from '@/lib/crypto/identity'
import { pairPassword, pairTopic } from '@/lib/crypto/topics'
import { joinTopic } from '@/lib/trystero'

export const PAIR_WORD_COUNT = 12
const PAIR_ENTROPY_BITS = 128
const HELLO_ACTION = 'hello'

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
  // milliseconds. Existing call sites that don't pass this stay timeout-less,
  // matching pre-V1-P12-polish behavior.
  timeoutMs?: number
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
  hello: HelloPayload
): PairedFriend {
  if (hello?.type !== 'hello') {
    throw new PairVerificationError('not a hello payload')
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
  })
  const action = room.makeAction<HelloPayload>(HELLO_ACTION)

  let onAbort: (() => void) | null = null
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  try {
    return await new Promise<PairedFriend>((resolve, reject) => {
      let settled = false
      let peerSeen = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
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
          const friend = verifyHello(words, payload)
          settle(() => resolve(friend))
        } catch (err) {
          settle(() => reject(err))
        }
      })

      room.onPeerJoin(async () => {
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
    if (opts.signal && onAbort) {
      opts.signal.removeEventListener('abort', onAbort)
    }
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
