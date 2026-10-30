import { createHmac } from 'node:crypto'
import { createSocket } from 'node:dgram'

// A loopback-only TURN boundary: browsers own ICE, DTLS and SCTP. Short
// allocation lifetimes make credential cutover and expiry observable in CI.
export async function startTurnRelay() {
  const cookie = 0x2112a442
  const realm = 'studyvis-local-turn-test'
  const nonce = 'studyvis-local-turn-nonce'
  // RFC 5389 long-term keys for the fixture's public old/next passwords.
  const authenticationKeys = new Map([
    ['old', Buffer.from('661b17c9e3d68a41ad7229defecde96c', 'hex')],
    ['next', Buffer.from('863d00a1766073aaaf94a82c8860e9ee', 'hex')],
  ])
  const socket = createSocket('udp4')
  const allocations = new Map()
  const expired = new Set()
  const requests = []
  const attr = (type, value) => {
    const header = Buffer.alloc(4)
    header.writeUInt16BE(type)
    header.writeUInt16BE(value.length, 2)
    return Buffer.concat([
      header,
      value,
      Buffer.alloc((4 - (value.length % 4)) % 4),
    ])
  }
  const address = (port, ip) => {
    const value = Buffer.alloc(8)
    value[1] = 1
    value.writeUInt16BE(port ^ (cookie >>> 16), 2)
    ip.split('.').forEach((byte, i) => {
      value[i + 4] = Number(byte) ^ [0x21, 0x12, 0xa4, 0x42][i]
    })
    return value
  }
  const decodeAddress = (value) => ({
    port: value.readUInt16BE(2) ^ (cookie >>> 16),
    ip: [...value.subarray(4, 8)]
      .map((byte, i) => byte ^ [0x21, 0x12, 0xa4, 0x42][i])
      .join('.'),
  })
  const attributes = (message) => {
    const result = new Map()
    for (let offset = 20; offset + 4 <= message.length;) {
      const length = message.readUInt16BE(offset + 2)
      result.set(
        message.readUInt16BE(offset),
        message.subarray(offset + 4, offset + 4 + length)
      )
      offset += 4 + ((length + 3) & ~3)
    }
    return result
  }
  const lifetime = Buffer.alloc(4)
  lifetime.writeUInt32BE(8)
  const reply = (request, remote, type, parts, username) => {
    const key = authenticationKeys.get(username)
    const content = Buffer.concat(parts)
    const header = Buffer.alloc(20)
    header.writeUInt16BE(type)
    header.writeUInt16BE(content.length + (key ? 24 : 0), 2)
    header.writeUInt32BE(cookie, 4)
    request.copy(header, 8, 8, 20)
    let response = Buffer.concat([header, content])
    if (key) {
      response = Buffer.concat([
        response,
        attr(8, createHmac('sha1', key).update(response).digest()),
      ])
    }
    socket.send(response, remote.port, remote.address)
    return response
  }
  socket.on('message', (message, remote) => {
    const id = `${remote.address}:${remote.port}`
    const allocation = allocations.get(id)
    if (message.length >= 4 && (message[0] & 0xc0) === 0x40) {
      const destination = allocation?.channels.get(message.readUInt16BE(0))
      if (destination && !expired.has(allocation.username)) {
        allocation.socket.send(
          message.subarray(4, 4 + message.readUInt16BE(2)),
          destination.port,
          destination.ip
        )
      }
      return
    }
    if (message.length < 20 || message.readUInt32BE(4) !== cookie) return
    const type = message.readUInt16BE(0)
    const values = attributes(message)
    const username = values.get(6)?.toString()
    if (type === 1) {
      reply(message, remote, 0x101, [
        attr(0x20, address(remote.port, remote.address)),
      ])
      return
    }
    if (type === 0x16) {
      if (
        allocation &&
        !expired.has(allocation.username) &&
        values.has(0x12) &&
        values.has(0x13)
      ) {
        const destination = decodeAddress(values.get(0x12))
        if (destination.ip === '127.0.0.1')
          allocation.socket.send(
            values.get(0x13),
            destination.port,
            destination.ip
          )
      }
      return
    }
    const transactionId = message.subarray(8, 20).toString('hex')
    const at = Date.now()
    const server = socket.address()
    const requestedLifetime = values.get(0xd)
    requests.push({
      type,
      username,
      transactionId,
      at,
      lifetime:
        requestedLifetime?.length === 4
          ? requestedLifetime.readUInt32BE(0)
          : null,
      fiveTuple: {
        protocol: 'udp',
        clientAddress: remote.address,
        clientPort: remote.port,
        serverAddress: server.address,
        serverPort: server.port,
      },
      allocationUsername: allocation?.username,
      allocationRelayPort: allocation?.relayAddress?.port,
    })
    if (allocation) {
      allocation.lastRequestAt = at
      if (type === 4) {
        allocation.lastRefreshAt = at
        allocation.lastRefreshUsername = username
        allocation.refreshCount++
      }
    }
    if (!authenticationKeys.has(username) || expired.has(username)) {
      reply(message, remote, type | 0x110, [
        attr(9, Buffer.from([0, 0, 4, 1, ...Buffer.from('Unauthorized')])),
        attr(0x14, Buffer.from(realm)),
        attr(0x15, Buffer.from(nonce)),
      ])
      return
    }
    if (type === 3) {
      // PR-499: UDP retries reuse one allocation and its exact response, even
      // when the duplicate arrives before the relay socket finishes binding.
      if (allocation) {
        if (allocation.transactionId === transactionId) {
          if (allocation.response)
            socket.send(allocation.response, remote.port, remote.address)
          else allocation.waiting.push(remote)
        } else {
          reply(
            message,
            remote,
            0x113,
            [
              attr(
                9,
                Buffer.from([
                  0,
                  0,
                  4,
                  37,
                  ...Buffer.from('Allocation Mismatch'),
                ])
              ),
            ],
            username
          )
        }
        return
      }
      const relay = createSocket('udp4')
      const record = {
        socket: relay,
        username,
        transactionId,
        response: null,
        waiting: [],
        channels: new Map(),
        createdAt: at,
        lastRequestAt: at,
        relayAddress: null,
        refreshCount: 0,
      }
      allocations.set(id, record)
      relay.on('message', (data, peer) => {
        if (expired.has(username)) return
        const channel = [...record.channels].find(
          ([, destination]) =>
            destination.port === peer.port && destination.ip === peer.address
        )?.[0]
        if (channel !== undefined) {
          const header = Buffer.alloc(4)
          header.writeUInt16BE(channel)
          header.writeUInt16BE(data.length, 2)
          socket.send(
            Buffer.concat([header, data]),
            remote.port,
            remote.address
          )
        } else {
          reply(Buffer.alloc(20), remote, 0x17, [
            attr(0x12, address(peer.port, peer.address)),
            attr(0x13, data),
          ])
        }
      })
      relay.bind(0, '127.0.0.1', () => {
        record.relayAddress = relay.address()
        record.boundAt = Date.now()
        record.response = reply(
          message,
          remote,
          0x103,
          [
            attr(0x16, address(relay.address().port, '127.0.0.1')),
            attr(0x20, address(remote.port, remote.address)),
            attr(0xd, lifetime),
          ],
          username
        )
        for (const waiting of record.waiting.splice(0))
          socket.send(record.response, waiting.port, waiting.address)
      })
    } else if (type === 4) {
      reply(message, remote, 0x104, [attr(0xd, lifetime)], username)
    } else if (type === 8 || type === 9) {
      if (type === 9 && allocation && values.has(0x12) && values.has(0xc)) {
        const destination = decodeAddress(values.get(0x12))
        if (destination.ip === '127.0.0.1')
          allocation.channels.set(values.get(0xc).readUInt16BE(0), destination)
      }
      reply(message, remote, type | 0x100, [], username)
    }
  })
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, '127.0.0.1', resolve)
  })
  return {
    url: `turn:127.0.0.1:${socket.address().port}?transport=udp`,
    requests,
    diagnostics: () => ({
      at: Date.now(),
      expired: [...expired],
      allocationCount: allocations.size,
      allocationsDropped: Math.max(0, allocations.size - 128),
      allocations: [...allocations.entries()]
        .slice(-128)
        .map(([client, record]) => ({
          client,
          fiveTuple: {
            protocol: 'udp',
            clientAddress: client.slice(0, client.lastIndexOf(':')),
            clientPort: Number(client.slice(client.lastIndexOf(':') + 1)),
            serverAddress: socket.address().address,
            serverPort: socket.address().port,
          },
          username: record.username,
          relayAddress: record.relayAddress?.address,
          relayPort: record.relayAddress?.port,
          transactionId: record.transactionId,
          createdAt: record.createdAt,
          boundAt: record.boundAt,
          lastRequestAt: record.lastRequestAt,
          lastRefreshAt: record.lastRefreshAt,
          lastRefreshUsername: record.lastRefreshUsername,
          refreshCount: record.refreshCount,
        })),
      requestCount: requests.length,
      allocateRequestCount: requests.filter((request) => request.type === 3)
        .length,
      allocateRequestsDropped: Math.max(
        0,
        requests.filter((request) => request.type === 3).length - 128
      ),
      requests: [
        ...requests.filter((request) => request.type === 3).slice(-128),
        ...requests.filter((request) => request.type !== 3).slice(-100),
      ].sort((a, b) => a.at - b.at),
    }),
    expire: (username) => expired.add(username),
    credentialAt: (port) =>
      [...allocations.values()].find(
        (record) => record.socket.address().port === port
      )?.username,
    close: async () => {
      await Promise.all(
        [
          socket,
          ...[...allocations.values()].map((record) => record.socket),
        ].map((item) => new Promise((resolve) => item.close(resolve)))
      )
    },
  }
}
