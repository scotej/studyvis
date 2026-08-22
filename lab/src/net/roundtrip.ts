// Publish -> broadcast -> receive probes for the lab's own servers, mirroring
// scripts/check-relays.ts. The lab is only as trustworthy as its transports:
// if the local relay silently stops fanning out, every P2P scenario fails in a
// way that looks like an app bug. `lab doctor` runs these first.

import { createHash, randomBytes } from 'node:crypto'

import { schnorr } from '@noble/curves/secp256k1.js'
import mqtt from 'mqtt'

const EPHEMERAL_KIND = 20001
const CHECK_TAG = 'studyvis-lab-check'

export type ProbeResult = { ok: boolean; ms: number; reason?: string }

function signedEvent(): { id: string; event: Record<string, unknown> } {
  const priv = randomBytes(32)
  const pubkey = Buffer.from(schnorr.getPublicKey(priv)).toString('hex')
  const createdAt = Math.floor(Date.now() / 1000)
  const tags = [['x', CHECK_TAG]]
  const id = createHash('sha256')
    .update(
      JSON.stringify([0, pubkey, createdAt, EPHEMERAL_KIND, tags, '']),
      'utf8'
    )
    .digest('hex')
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
      content: '',
      sig,
    },
  }
}

export function probeNostrRelay(
  url: string,
  timeoutMs = 5000
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const socket = new WebSocket(url)
    const subId = `lab-${randomBytes(4).toString('hex')}`
    const { id, event } = signedEvent()
    const finish = (result: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // already closed
      }
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ ok: false, ms: Date.now() - started, reason: 'timeout' }),
      timeoutMs
    )
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify([
          'REQ',
          subId,
          { kinds: [EPHEMERAL_KIND], '#x': [CHECK_TAG] },
        ])
      )
      socket.send(JSON.stringify(['EVENT', event]))
    })
    socket.addEventListener('message', (message) => {
      let frame: unknown
      try {
        frame = JSON.parse(String(message.data))
      } catch {
        return
      }
      if (!Array.isArray(frame)) return
      const [type, a, b] = frame as [string, string, { id?: string }]
      if (type === 'EVENT' && a === subId && b?.id === id) {
        finish({ ok: true, ms: Date.now() - started })
      } else if (type === 'OK' && a === id && frame[2] === false) {
        finish({
          ok: false,
          ms: Date.now() - started,
          reason: `rejected: ${String(frame[3])}`,
        })
      }
    })
    socket.addEventListener('error', () =>
      finish({ ok: false, ms: Date.now() - started, reason: 'socket error' })
    )
    socket.addEventListener('close', () =>
      finish({ ok: false, ms: Date.now() - started, reason: 'closed' })
    )
  })
}

export function probeMqttBroker(
  url: string,
  timeoutMs = 5000
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const topic = `studyvis-lab-check/${randomBytes(8).toString('hex')}`
    const payload = randomBytes(8).toString('hex')
    const client = mqtt.connect(url, { connectTimeout: timeoutMs })
    const finish = (result: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.end(true)
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ ok: false, ms: Date.now() - started, reason: 'timeout' }),
      timeoutMs
    )
    client.on('connect', () => {
      client.subscribe(topic, (err) => {
        if (err) {
          finish({
            ok: false,
            ms: Date.now() - started,
            reason: `subscribe: ${err.message}`,
          })
          return
        }
        client.publish(topic, payload)
      })
    })
    client.on('message', (onTopic, buffer) => {
      if (onTopic === topic && buffer.toString() === payload) {
        finish({ ok: true, ms: Date.now() - started })
      }
    })
    client.on('error', (err) =>
      finish({
        ok: false,
        ms: Date.now() - started,
        reason: `broker error: ${err.message}`,
      })
    )
  })
}
