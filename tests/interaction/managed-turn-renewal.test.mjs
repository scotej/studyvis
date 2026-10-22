import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { test } from 'node:test'
import { tsImport } from 'tsx/esm/api'

import { withComponentBrowser } from './component-browser.mjs'
import { startTurnRelay } from './turn-relay.mjs'

const { startNostrRelay } = await tsImport(
  '../../lab/src/net/nostrRelay.ts',
  import.meta.url
)

const source = `
import { joinRoom } from 'trystero'
import { createManagedTurnPeerConnection } from '@/lib/webrtc/managedTurnPeerConnection'
import { createResilientPeerConnection } from '@/lib/webrtc/resilientPeerConnection'

let room, roomConfig, servers = [], listeners = [], received = 0, joins = 0, leaves = 0, restarts = 0, releaseHandshake
const rooms = [], tickers = []
const nativeConnections = []
const failures = []
const strip = description => description && ({type: description.type, sdp: description.sdp.split('\\r\\n').filter(line => !line.startsWith('a=candidate:') || line.includes(' typ relay ')).join('\\r\\n')})
function wireRoom(channelRoom) {
  rooms.push(channelRoom)
  channelRoom.onPeerJoin = () => joins++
  channelRoom.onPeerLeave = () => leaves++
  const messages = channelRoom.makeAction('lease-proof')
  messages.onMessage = () => received++
  tickers.push(setInterval(() => {
    if (Object.keys(channelRoom.getPeers()).length) messages.send('ping').catch(error => failures.push(error.message))
  }, 75))
}
window.fixture = {
  join: ({relay, turn, relayOnly, early, shared}) => {
    const handshake = early || shared ? new Promise(resolve => { releaseHandshake = resolve }) : Promise.resolve()
    servers = [{urls: [turn], username: 'old', credential: 'old-password'}]
    const native = new Proxy(RTCPeerConnection, {construct(target, args) {
      const pc = Reflect.construct(target, args)
      nativeConnections.push(pc)
      const restart = pc.restartIce.bind(pc)
      pc.restartIce = () => { restarts++; restart() }
      if (relayOnly) {
        // Limit reachable paths at the native test boundary. Production ICE
        // configuration and Trystero signaling/negotiation remain unchanged.
        pc.addEventListener('icecandidate', event => {
          if (event.candidate && !event.candidate.candidate.includes(' typ relay ')) event.stopImmediatePropagation()
        })
        const read = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'localDescription').get
        Object.defineProperty(pc, 'localDescription', {get: () => strip(read.call(pc))})
      }
      return pc
    }})
    const Constructor = createManagedTurnPeerConnection(createResilientPeerConnection(native), {
      getIceServers: () => servers,
      subscribeIceServers: listener => { listeners.push(listener); return () => {} },
    })
    roomConfig = {appId: 'studyvis-turn-renewal', password: 'local-test-password',
      rtcPolyfill: Constructor, rtcConfig: {iceServers: []}, relayConfig: {urls: [relay]},
      _test_only_mdnsHostFallbackToLoopback: !relayOnly,
    }
    room = joinRoom(roomConfig, 'inbox', {onJoinError: error => failures.push(error.error), onPeerHandshake: () => handshake, handshakeTimeoutMs: 30_000})
    wireRoom(room)
  },
  addSharedRoom: () => {
    room = joinRoom(roomConfig, 'presence', {onJoinError: error => failures.push(error.error)})
    wireRoom(room)
  },
  rotate: () => {
    servers = servers.map(server => ({...server, username: 'next', credential: 'next-password'}))
    listeners.forEach(listener => listener())
  },
  snapshot: async () => {
    const peers = Object.values(room.getPeers())
    const connections = await Promise.all(peers.map(async pc => {
      const stats = await pc.getStats()
      const transport = [...stats.values()].find(entry => entry.type === 'transport' && entry.selectedCandidatePairId)
      const pair = transport && stats.get(transport.selectedCandidatePairId)
      const local = pair && stats.get(pair.localCandidateId)
      return {state: pc.connectionState, signaling: pc.signalingState, ice: pc.iceConnectionState, type: local?.candidateType, port: local?.port,
        currentUfrag: pc.currentLocalDescription?.sdp.match(/a=ice-ufrag:([^\\s]+)/)?.[1],
        currentRemoteUfrag: pc.currentRemoteDescription?.sdp.match(/a=ice-ufrag:([^\\s]+)/)?.[1],
        pendingUfrag: pc.pendingLocalDescription?.sdp.match(/a=ice-ufrag:([^\\s]+)/)?.[1],
        pendingRemoteUfrag: pc.pendingRemoteDescription?.sdp.match(/a=ice-ufrag:([^\\s]+)/)?.[1],
        ufrag: pc.localDescription?.sdp.match(/a=ice-ufrag:([^\\s]+)/)?.[1],
        remoteUfrag: pc.remoteDescription?.sdp.match(/a=ice-ufrag:([^\\s]+)/)?.[1],
        media: pc.localDescription?.sdp.includes('a=rtpmap'),
      }
    }))
    return {received, joins, leaves, restarts, failures: [...failures], connections, nativeConnected: nativeConnections.filter(pc => pc.connectionState === 'connected').length, firstActive: Object.keys(rooms[0].getPeers()).length}
  },
  releaseHandshake: () => releaseHandshake?.(),
  stop: async () => { tickers.forEach(clearInterval); await Promise.all(rooms.map(item => item.leave())) },
}
`

test(
  'local TURN Allocate retransmissions preserve the relayed address',
  { timeout: 5_000 },
  async () => {
    const turn = await startTurnRelay()
    const client = createSocket('udp4')
    try {
      const header = Buffer.alloc(20)
      header.writeUInt16BE(3)
      header.writeUInt16BE(8, 2)
      header.writeUInt32BE(0x2112a442, 4)
      header.fill(7, 8)
      const request = Buffer.concat([
        header,
        Buffer.from([0, 6, 0, 4, ...Buffer.from('next')]),
      ])
      const port = Number(turn.url.match(/:(\d+)\?/)[1])
      const responses = []
      client.on('message', (message) => responses.push(message))
      client.send(request, port, '127.0.0.1')
      client.send(request, port, '127.0.0.1')
      await assertEventually(async () => responses.length === 2)
      assert.deepEqual(responses[0], responses[1])
      let relayedPort
      for (let offset = 20; offset < responses[0].length;) {
        const type = responses[0].readUInt16BE(offset)
        const length = responses[0].readUInt16BE(offset + 2)
        if (type === 0x16)
          relayedPort = responses[0].readUInt16BE(offset + 6) ^ 0x2112
        offset += 4 + ((length + 3) & ~3)
      }
      assert.equal(turn.credentialAt(relayedPort), 'next')
      client.send(request, port, '127.0.0.1')
      await assertEventually(async () => responses.length === 3)
      assert.deepEqual(responses[2], responses[0])
      assert.equal(turn.credentialAt(relayedPort), 'next')
      const conflicting = Buffer.from(request)
      conflicting[8] ^= 1
      client.send(conflicting, port, '127.0.0.1')
      await assertEventually(async () => responses.length === 4)
      assert.equal(responses[3].readUInt16BE(0), 0x113)
      let errorCode
      for (let offset = 20; offset < responses[3].length;) {
        const type = responses[3].readUInt16BE(offset)
        const length = responses[3].readUInt16BE(offset + 2)
        if (type === 9)
          errorCode = responses[3][offset + 6] * 100 + responses[3][offset + 7]
        offset += 4 + ((length + 3) & ~3)
      }
      assert.equal(errorCode, 437)
      assert.equal(turn.credentialAt(relayedPort), 'next')
    } finally {
      client.close()
      await turn.close()
    }
  }
)

for (const { relayOnly, early, shared } of [
  { relayOnly: true, early: false },
  { relayOnly: false, early: false },
  { relayOnly: true, early: true },
  { relayOnly: true, early: false, shared: true },
]) {
  test(
    `managed credentials renew ${shared ? 'a shared relay while its first room still authenticates' : early ? 'a relay connected before authentication completes' : relayOnly ? 'an active relay' : 'without restarting a direct path'} through real Trystero signaling`,
    { timeout: 60_000 },
    async () => {
      const relay = await startNostrRelay()
      const turn = await startTurnRelay()
      try {
        await withComponentBrowser(
          source,
          async (page) => {
            const friend = await page.context().browser().newPage()
            try {
              await friend.goto(page.url())
              await friend.waitForFunction(() => window.fixture)
              const pages = [page, friend]
              const snapshot = () =>
                Promise.all(
                  pages.map((item) =>
                    item.evaluate(() => window.fixture.snapshot())
                  )
                )
              for (const item of pages)
                await item.evaluate((options) => window.fixture.join(options), {
                  relay: relay.url,
                  turn: turn.url,
                  relayOnly,
                  early,
                  shared,
                })
              if (shared) {
                await assertEventually(async () =>
                  (await snapshot()).every((state) => state.nativeConnected > 0)
                )
                await Promise.all(
                  pages.map((item) =>
                    item.evaluate(() => window.fixture.addSharedRoom())
                  )
                )
              }
              if (early) {
                await Promise.all(
                  pages.map((item) =>
                    item.evaluate(() => window.fixture.rotate())
                  )
                )
                await assertEventually(async () =>
                  (await snapshot()).every((state) => state.nativeConnected > 0)
                )
                await Promise.all(
                  pages.map((item) =>
                    item.evaluate(() => window.fixture.releaseHandshake())
                  )
                )
              }
              await assertEventually(async () =>
                (await snapshot()).every(
                  (state) => state.joins === 1 && state.received >= 3
                )
              )
              const before = await snapshot()
              if (shared)
                assert.ok(
                  before.every(
                    (state) =>
                      state.firstActive === 0 && state.nativeConnected === 1
                  ),
                  JSON.stringify(before)
                )
              assert.ok(
                before.every(
                  (state) =>
                    state.connections.length === 1 &&
                    !state.connections[0].media
                ),
                JSON.stringify(before)
              )
              assert.ok(
                before.every(
                  (state) => state.leaves === 0 && state.failures.length === 0
                ),
                JSON.stringify(before)
              )
              if (relayOnly)
                assert.ok(
                  before.some((state) => state.connections[0].type === 'relay'),
                  JSON.stringify(before)
                )
              else
                assert.ok(
                  before.every(
                    (state) => state.connections[0].type !== 'relay'
                  ),
                  JSON.stringify(before)
                )
              await Promise.all(
                pages.map((item) =>
                  item.evaluate(() => window.fixture.rotate())
                )
              )
              if (relayOnly) {
                let rotationSnapshot
                await assertEventually(
                  async () => {
                    const states = (rotationSnapshot = await snapshot())
                    return (
                      states.some((state) => state.restarts > 0) &&
                      states.every(
                        (state, index) =>
                          state.connections[0]?.state === 'connected' &&
                          (early ||
                            state.connections[0]?.ufrag !==
                              before[index].connections[0].ufrag) &&
                          (early ||
                            state.connections[0]?.remoteUfrag !==
                              before[index].connections[0].remoteUfrag) &&
                          (state.connections[0]?.type !== 'relay' ||
                            turn.credentialAt(state.connections[0].port) ===
                              'next')
                      )
                    )
                  },
                  () => ({
                    before,
                    current: rotationSnapshot,
                    turnRequests: turn.requests.slice(-100),
                  })
                )
                assert.ok(
                  turn.requests.some(
                    (request) =>
                      request.type === 3 && request.username === 'next'
                  )
                )
              }
              const cutover = await snapshot()
              turn.expire('old')
              await new Promise((resolve) => setTimeout(resolve, 9_000))
              const after = await snapshot()
              if (shared)
                assert.ok(
                  after.every(
                    (state) =>
                      state.firstActive === 0 && state.nativeConnected === 1
                  ),
                  JSON.stringify(after)
                )
              for (let index = 0; index < after.length; index++) {
                assert.equal(after[index].joins, 1, JSON.stringify(after))
                assert.equal(after[index].leaves, 0, JSON.stringify(after))
                assert.deepEqual(
                  after[index].failures,
                  [],
                  JSON.stringify(after)
                )
                assert.equal(
                  after[index].connections[0]?.state,
                  'connected',
                  JSON.stringify(after)
                )
                assert.ok(
                  after[index].received > cutover[index].received + 20,
                  JSON.stringify(after)
                )
                if (!relayOnly)
                  assert.equal(after[index].restarts, 0, JSON.stringify(after))
              }
              if (relayOnly)
                assert.ok(
                  turn.requests.some(
                    (request) =>
                      request.type === 4 && request.username === 'next'
                  )
                )
              await Promise.all(
                pages.map((item) => item.evaluate(() => window.fixture.stop()))
              )
            } finally {
              await friend.close()
            }
          },
          { freshDependencies: true }
        )
      } finally {
        await Promise.all([turn.close(), relay.close()])
      }
    }
  )
}

async function assertEventually(check, details = () => undefined) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(
    `TURN renewal did not satisfy the expected live connection state within 20 seconds: ${JSON.stringify(details())}`
  )
}
