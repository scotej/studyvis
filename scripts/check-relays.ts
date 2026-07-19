#!/usr/bin/env tsx
// #47 C4 — health check for BOTH halves of the dual-strategy rendezvous:
// the pinned Nostr relays (DEFAULT_RELAY_URLS) and the MQTT brokers baked
// into @trystero-p2p/mqtt. Relays and public test brokers die, and with no
// auto-update a dead pinned endpoint degrades default-config discovery for
// every install simultaneously — fixing either list means shipping a
// release, so their health AT RELEASE TIME is load-bearing. (MQTT is the
// redundancy that fixed the v1.2.2 clock-skew/Nostr-blocked failure; if its
// brokers rot silently, that failure quietly returns.)
//
// For each endpoint this performs the exact primitive rendezvous depends
// on: publish on a fresh connection and receive the message back on a live
// subscription over the same connection. Dev-time tooling only — run
// manually (`npm run check-relays`) or via release-prep's non-blocking
// warning step. Exits 1 if any endpoint fails, so manual runs are strict;
// release-prep marks the step continue-on-error.

import { createHash, randomBytes } from 'node:crypto'

import { schnorr } from '@noble/curves/secp256k1.js'
// The same broker list the shipped strategy resolves (no override is
// forwarded in src/lib/trystero/index.ts, so these are what installs use).
import { defaultRelayUrls as MQTT_BROKER_URLS } from '@trystero-p2p/mqtt'
import mqtt from 'mqtt'

import { DEFAULT_RELAY_URLS } from '../src/lib/trystero/relayUrls'

// Node 20 — the version CI and release-prep run — has no global WebSocket
// (it stabilized in Node 22), so the Nostr probe silently failed every run
// with 'WebSocket is not defined' behind release-prep's continue-on-error.
// Fall back to `ws` (already in the tree via mqtt), whose addEventListener
// surface matches the browser API this probe uses.
const WebSocketImpl: typeof WebSocket =
  (globalThis as { WebSocket?: typeof WebSocket }).WebSocket ??
  ((await import('ws')).default as unknown as typeof WebSocket)

// @trystero-p2p/mqtt's un-exported defaultRedundancy: getRelays takes the
// FIRST 4 entries, unshuffled, so every install talks to exactly these.
const MQTT_REDUNDANCY = 4

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
      ws = new WebSocketImpl(url)
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

// The subscribe→publish→echo round-trip over websockets, mirroring the
// browser transport (the exported URLs are already wss://; one embeds
// credentials, so they pass to mqtt.connect verbatim).
function checkMqttBroker(url: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const topic = `studyvis-broker-check/${randomBytes(8).toString('hex')}`
    const payload = randomBytes(8).toString('hex')
    const client = mqtt.connect(url, { connectTimeout: TIMEOUT_MS })
    const finish = (result: CheckResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.end(true)
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ url, ok: false, reason: `timeout after ${TIMEOUT_MS}ms` }),
      TIMEOUT_MS
    )
    client.on('connect', () => {
      client.subscribe(topic, (err) => {
        if (err) {
          finish({ url, ok: false, reason: `subscribe: ${err.message}` })
          return
        }
        client.publish(topic, payload)
      })
    })
    client.on('message', (onTopic, buffer) => {
      if (onTopic === topic && buffer.toString() === payload) {
        finish({ url, ok: true, ms: Date.now() - started })
      }
    })
    client.on('error', (err) => {
      finish({ url, ok: false, reason: `broker error: ${err.message}` })
    })
  })
}

const activeBrokers = MQTT_BROKER_URLS.slice(0, MQTT_REDUNDANCY)
const [nostrResults, mqttResults] = await Promise.all([
  Promise.all(DEFAULT_RELAY_URLS.map(checkRelay)),
  Promise.all(activeBrokers.map(checkMqttBroker)),
])

function report(label: string, results: CheckResult[]): number {
  let failures = 0
  console.log(`\n${label}`)
  for (const r of results) {
    if (r.ok) {
      console.log(`OK    ${r.url}  (round-trip ${r.ms}ms)`)
    } else {
      failures += 1
      console.log(`FAIL  ${r.url}  — ${r.reason}`)
    }
  }
  return failures
}

const nostrFailures = report('Nostr relays (DEFAULT_RELAY_URLS):', nostrResults)
const mqttFailures = report(
  `MQTT brokers (@trystero-p2p/mqtt defaults, first ${MQTT_REDUNDANCY}):`,
  mqttResults
)
const total = nostrResults.length + mqttResults.length
console.log(
  `\ncheck-relays: ${total - nostrFailures - mqttFailures}/${total} endpoints passed the publish/receive round-trip`
)
if (nostrFailures > 0) {
  console.log(
    'Dead relays degrade default-config discovery for every install; update DEFAULT_RELAY_URLS (src/lib/trystero/relayUrls.ts) before the next release.'
  )
}
if (mqttFailures > 0) {
  console.log(
    'Dead brokers silently degrade the dual-strategy rendezvous to Nostr-only. The broker list ships inside @trystero-p2p/mqtt; to override it, pin a curated list via relayConfig.urls in the joinRoomMqtt call (src/lib/trystero/index.ts).'
  )
}
if (nostrFailures + mqttFailures > 0) {
  process.exit(1)
}
process.exit(0)
