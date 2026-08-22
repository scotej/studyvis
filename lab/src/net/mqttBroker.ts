// Local MQTT-over-WebSocket broker for the lab.
//
// Pairing, presence, the inbox and invite sends all race Nostr AND MQTT
// (src/lib/trystero/index.ts). Without a local broker those rooms would reach
// for the shipped public brokers, so the lab would be neither offline nor able
// to exercise the transport that exists precisely to survive a dark Nostr relay
// set. aedes speaks enough MQTT 3.1.1 for @trystero-p2p/mqtt, which only ever
// connects, subscribes, publishes and unsubscribes at QoS 0.

import { createServer } from 'node:http'
import { Duplex } from 'node:stream'

import { Aedes } from 'aedes'
import { WebSocketServer, type WebSocket } from 'ws'

import { listen } from './nostrRelay'

export type MqttBrokerFaults = {
  /** Close every connection as it opens — a broker that has gone dark. */
  refuseConnections?: boolean
  /** Accept publishes and never deliver them. */
  dropMessages?: boolean
}

export type MqttBrokerStats = {
  connections: number
  openConnections: number
  published: number
}

export type MqttBrokerHandle = {
  url: string
  port: number
  faults: MqttBrokerFaults
  stats: () => MqttBrokerStats
  close: () => Promise<void>
}

// mqtt.js writes a packet to its transport in several small writes, and its
// WebSocket transport turns each one into its own frame — a CONNECT arrives as
// nine frames of 1–15 bytes. Handed to aedes in that shape it never parses and
// the client dies on `connack timeout`; coalescing the frames that land in one
// tick into a single push fixes it. Concatenating is always sound: MQTT is a
// byte stream, so frame boundaries carry no meaning.
function websocketDuplex(socket: WebSocket): Duplex {
  let queue: Buffer[] = []
  let scheduled = false
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      socket.send(chunk, { binary: true }, () => done())
    },
    final(done) {
      try {
        socket.close()
      } catch {
        // already closed
      }
      done()
    },
  })
  const flush = () => {
    scheduled = false
    if (queue.length === 0) return
    const joined = Buffer.concat(queue)
    queue = []
    stream.push(joined)
  }
  socket.on('message', (data) => {
    queue.push(
      Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer)
    )
    if (scheduled) return
    scheduled = true
    setImmediate(flush)
  })
  socket.on('close', () => stream.push(null))
  socket.on('error', () => stream.destroy())
  return stream
}

export async function startMqttBroker(
  faults: MqttBrokerFaults = {}
): Promise<MqttBrokerHandle> {
  const broker = await Aedes.createBroker()
  const http = createServer()
  const wss = new WebSocketServer({ server: http })
  const stats: MqttBrokerStats = {
    connections: 0,
    openConnections: 0,
    published: 0,
  }

  broker.authorizePublish = (_client, _packet, done) => {
    stats.published += 1
    done(
      faults.dropMessages ? new Error('lab: broker dropping messages') : null
    )
  }

  wss.on('connection', (socket) => {
    stats.connections += 1
    stats.openConnections += 1
    socket.on('close', () => {
      stats.openConnections -= 1
    })
    if (faults.refuseConnections) {
      socket.close(1013, 'lab: broker marked offline')
      return
    }
    broker.handle(websocketDuplex(socket))
  })

  const port = await listen(http)
  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    faults,
    stats: () => ({ ...stats }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate()
        broker.close(() => wss.close(() => http.close(() => resolve())))
      }),
  }
}
