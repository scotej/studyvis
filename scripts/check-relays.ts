#!/usr/bin/env tsx
// #47 C4 — health check for the pinned signaling relays (DEFAULT_RELAY_URLS).
// The list was hand-verified once (see the comment in relays.ts), but relays
// die, and with no auto-update a dead pinned relay degrades default-config
// discovery for every install simultaneously — fixing the list means shipping
// a release, so its health AT RELEASE TIME is load-bearing.
//
// For each pinned URL this performs the exact primitive trystero rendezvous
// depends on: publish an ephemeral Nostr event on a fresh WebSocket and
// receive it back on a live subscription over the same socket. Dev-time
// tooling only — run manually (`npm run check-relays`) or via release-prep's
// non-blocking warning step. Exits 1 if any relay fails, so manual runs are
// strict; release-prep marks the step continue-on-error.

import { createHash, randomBytes } from 'node:crypto'

import { schnorr } from '@noble/curves/secp256k1.js'

import { DEFAULT_RELAY_URLS } from '../src/lib/trystero/relayUrls'

const TIMEOUT_MS = 10_000
// Ephemeral kind range (20000–29999): relays broadcast to live subscribers
// and never store — the same class trystero's Nostr strategy uses, so a pass
// here exercises the behavior rendezvous needs.
const EPHEMERAL_KIND = 20001
const CHECK_TAG = 'studyvis-relay-check'

type CheckResult =
  | { url: string; ok: true; ms: number }
  | { url: string; ok: false; reason: string }

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function buildSignedEvent(): { id: string; event: Record<string, unknown> } {
  const priv = randomBytes(32)
  const pubkey = Buffer.from(schnorr.getPublicKey(priv)).toString('hex')
  const createdAt = Math.floor(Date.now() / 1000)
  const tags = [['x', CHECK_TAG]]
  const content = ''
  const id = sha256Hex(
    JSON.stringify([0, pubkey, createdAt, EPHEMERAL_KIND, tags, content])
  )
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, 'hex'), priv)).toString(
    'hex'
  )
  return {
    id,
    event: {
      id,
      pubkey,
      created_at: createdAt,
      kind: EPHEMERAL_KIND,
      tags,
      content,
      sig,
    },
  }
}

function checkRelay(url: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const finish = (result: CheckResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        // already closed
      }
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ url, ok: false, reason: `timeout after ${TIMEOUT_MS}ms` }),
      TIMEOUT_MS
    )

    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (err) {
      clearTimeout(timer)
      resolve({ url, ok: false, reason: `connect: ${String(err)}` })
      return
    }

    const subId = `check-${randomBytes(4).toString('hex')}`
    const { id, event } = buildSignedEvent()

    ws.addEventListener('open', () => {
      // Subscribe first, then publish on the same socket: receiving our own
      // event back proves the full publish→broadcast→receive loop.
      ws.send(
        JSON.stringify([
          'REQ',
          subId,
          { kinds: [EPHEMERAL_KIND], '#x': [CHECK_TAG] },
        ])
      )
      ws.send(JSON.stringify(['EVENT', event]))
    })
    ws.addEventListener('message', (msg) => {
      try {
        const data = JSON.parse(String(msg.data)) as unknown[]
        if (
          data[0] === 'EVENT' &&
          data[1] === subId &&
          (data[2] as { id?: string })?.id === id
        ) {
          finish({ url, ok: true, ms: Date.now() - started })
        } else if (data[0] === 'OK' && data[1] === id && data[2] === false) {
          finish({ url, ok: false, reason: `relay rejected: ${data[3]}` })
        }
      } catch {
        // non-JSON frame; ignore
      }
    })
    ws.addEventListener('error', () => {
      finish({ url, ok: false, reason: 'socket error' })
    })
    ws.addEventListener('close', (evt) => {
      finish({ url, ok: false, reason: `closed (${evt.code})` })
    })
  })
}

const results = await Promise.all(DEFAULT_RELAY_URLS.map(checkRelay))

let failures = 0
for (const r of results) {
  if (r.ok) {
    console.log(`OK    ${r.url}  (round-trip ${r.ms}ms)`)
  } else {
    failures += 1
    console.log(`FAIL  ${r.url}  — ${r.reason}`)
  }
}
console.log(
  `\ncheck-relays: ${results.length - failures}/${results.length} pinned relays passed the publish/receive round-trip`
)
if (failures > 0) {
  console.log(
    'Dead relays degrade default-config discovery for every install; update DEFAULT_RELAY_URLS (src/lib/trystero/relays.ts) before the next release.'
  )
  process.exit(1)
}
