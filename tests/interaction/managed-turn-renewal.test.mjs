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
let lastMessageAt, observationStartedAt, observationLastMessageAt, observationReceived = 0, maxMessageGap = 0
const rooms = [], tickers = []
const nativeConnections = []
const nativeDetails = new WeakMap()
const failures = []
const ufrag = description => description?.sdp.match(/a=ice-ufrag:([^\\s]+)/)?.[1]
const strip = description => description && ({type: description.type, sdp: description.sdp.split('\\r\\n').filter(line => !line.startsWith('a=candidate:') || line.includes(' typ relay ')).join('\\r\\n')})
function wireRoom(channelRoom) {
  rooms.push(channelRoom)
  channelRoom.onPeerJoin = () => joins++
  channelRoom.onPeerLeave = () => leaves++
  const messages = channelRoom.makeAction('lease-proof')
  messages.onMessage = () => {
    const at = Date.now()
    received++
    lastMessageAt = at
    if (observationStartedAt) {
      observationReceived++
      maxMessageGap = Math.max(maxMessageGap, at - observationLastMessageAt)
      observationLastMessageAt = at
    }
  }
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
      const details = {id: nativeConnections.length, createdAt: Date.now(), timeline: []}
      nativeDetails.set(pc, details)
      nativeConnections.push(pc)
      const record = (kind, data = {}) => {
        const at = Date.now()
        if (pc.connectionState === 'connected' && !details.connectedAt) details.connectedAt = at
        if (kind === 'icegatheringstatechange' && pc.iceGatheringState === 'complete') {
          details.firstGatheringCompleteAt ??= at
          details.gatheringCompleteAt = at
        }
        details.timeline.push({at, kind, state: pc.connectionState, signaling: pc.signalingState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState, localUfrag: ufrag(pc.localDescription), remoteUfrag: ufrag(pc.remoteDescription), ...data})
        if (details.timeline.length > 64) details.timeline.shift()
      }
      for (const event of ['connectionstatechange', 'signalingstatechange', 'iceconnectionstatechange', 'icegatheringstatechange']) pc.addEventListener(event, () => record(event))
      pc.addEventListener('icecandidate', event => record('icecandidate', {candidate: event.candidate?.toJSON()}))
      pc.addEventListener('icecandidateerror', event => record('icecandidateerror', {errorCode: event.errorCode}))
      const configure = pc.setConfiguration.bind(pc)
      pc.setConfiguration = config => {
        const result = configure(config)
        record('configuration', {servers: config.iceServers?.map(server => ({urls: server.urls, username: server.username}))})
        return result
      }
      const restart = pc.restartIce.bind(pc)
      pc.restartIce = () => { record('restart'); restarts++; restart() }
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
  beginExpiryObservation: () => {
    observationStartedAt = observationLastMessageAt = Date.now()
    observationReceived = maxMessageGap = 0
  },
  snapshot: async () => {
    const at = Date.now()
    const peers = Object.values(room.getPeers())
    const connections = await Promise.all(peers.map(async pc => {
      const details = nativeDetails.get(pc)
      details.seenAsPeer = true
      const stats = await pc.getStats()
      const transport = [...stats.values()].find(entry => entry.type === 'transport' && entry.selectedCandidatePairId)
      const pair = transport && stats.get(transport.selectedCandidatePairId)
      const local = pair && stats.get(pair.localCandidateId)
      const candidateStats = [...stats.values()].filter(entry => ['transport', 'candidate-pair', 'local-candidate', 'remote-candidate'].includes(entry.type))
      return {id: details.id, state: pc.connectionState, signaling: pc.signalingState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState, type: local?.candidateType, port: local?.port,
        connectedAt: details.connectedAt, connectedAge: details.connectedAt && at - details.connectedAt,
        firstGatheringCompleteAt: details.firstGatheringCompleteAt, gatheringCompleteAt: details.gatheringCompleteAt,
        gatheringCompleteAge: details.gatheringCompleteAt && at - details.gatheringCompleteAt,
        selectedPair: pair, localCandidate: local, remoteCandidate: pair && stats.get(pair.remoteCandidateId),
        candidateStats: candidateStats.slice(-256), candidateStatsCount: candidateStats.length, candidateStatsDropped: Math.max(0, candidateStats.length - 256),
        currentUfrag: pc.currentLocalDescription?.sdp.match(/a=ice-ufrag:([^\\s]+)/)?.[1],
        currentRemoteUfrag: pc.currentRemoteDescription?.sdp.match(/a=ice-ufrag:([^\\s]+)/)?.[1],
        pendingUfrag: pc.pendingLocalDescription?.sdp.match(/a=ice-ufrag:([^\\s]+)/)?.[1],
        pendingRemoteUfrag: pc.pendingRemoteDescription?.sdp.match(/a=ice-ufrag:([^\\s]+)/)?.[1],
        ufrag: pc.localDescription?.sdp.match(/a=ice-ufrag:([^\\s]+)/)?.[1],
        remoteUfrag: pc.remoteDescription?.sdp.match(/a=ice-ufrag:([^\\s]+)/)?.[1],
        media: pc.localDescription?.sdp.includes('a=rtpmap'),
      }
    }))
    return {at, received, joins, leaves, restarts, failures: [...failures], connections, messages: {lastMessageAt, timeSinceLastMessage: lastMessageAt && at - lastMessageAt, observationStartedAt, observationReceived, maxInterMessageGap: observationStartedAt ? Math.max(maxMessageGap, at - observationLastMessageAt) : null}, nativeTimeline: nativeConnections.map(pc => nativeDetails.get(pc)).filter(details => details.seenAsPeer).slice(-4).map(details => ({...details, timeline: [...details.timeline]})), nativeConnected: nativeConnections.filter(pc => pc.connectionState === 'connected').length, firstActive: Object.keys(rooms[0].getPeers()).length}
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
              const errors = []
              const check = (verify) => {
                try {
                  verify()
                } catch (error) {
                  errors.push(error)
                }
              }
              let rotationSnapshot
              if (relayOnly) {
                try {
                  await assertEventually(async () => {
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
                  })
                } catch (error) {
                  // Retain the cutover failure while observing its actual expiry impact.
                  errors.push(error)
                }
                check(() =>
                  assert.ok(
                    turn.requests.some(
                      (request) =>
                        request.type === 3 && request.username === 'next'
                    ),
                    'rotation must allocate with the next credential'
                  )
                )
              }
              const cutover = await snapshot()
              await Promise.all(
                pages.map((item) =>
                  item.evaluate(() => window.fixture.beginExpiryObservation())
                )
              )
              turn.expire('old')
              const expiredAt = Date.now()
              await new Promise((resolve) => setTimeout(resolve, 9_000))
              const after = await snapshot()
              if (shared)
                check(() =>
                  assert.ok(
                    after.every(
                      (state) =>
                        state.firstActive === 0 && state.nativeConnected === 1
                    ),
                    'the shared transport must remain connected'
                  )
                )
              for (let index = 0; index < after.length; index++) {
                check(() =>
                  assert.equal(
                    after[index].joins,
                    1,
                    `peer ${index} join count`
                  )
                )
                check(() =>
                  assert.equal(
                    after[index].leaves,
                    0,
                    `peer ${index} leave count`
                  )
                )
                check(() =>
                  assert.deepEqual(
                    after[index].failures,
                    [],
                    `peer ${index} failures`
                  )
                )
                check(() =>
                  assert.equal(
                    after[index].connections[0]?.state,
                    'connected',
                    `peer ${index} must remain connected after expiry`
                  )
                )
                check(() =>
                  assert.ok(
                    after[index].received > cutover[index].received + 20,
                    `peer ${index} must receive more than 20 payloads after expiry`
                  )
                )
                if (!relayOnly)
                  check(() =>
                    assert.equal(
                      after[index].restarts,
                      0,
                      `peer ${index} direct restart count`
                    )
                  )
              }
              if (relayOnly)
                check(() =>
                  assert.ok(
                    turn.requests.some(
                      (request) =>
                        request.type === 4 && request.username === 'next'
                    ),
                    'the next credential must refresh its allocation'
                  )
                )
              const turnDiagnostics = turn.diagnostics()
              const scenario = { relayOnly, early: !!early, shared: !!shared }
              const summarize = (states) =>
                states.map((state, index) => ({
                  received: state.received,
                  payloadsAfterExpiry:
                    state.at >= expiredAt
                      ? state.received - cutover[index].received
                      : undefined,
                  restarts: state.restarts,
                  messages: state.messages,
                  connections: state.connections.map((connection) => ({
                    port: connection.port,
                    type: connection.type,
                    gathering: connection.gathering,
                    localPriority: connection.localCandidate?.priority,
                    remotePriority: connection.remoteCandidate?.priority,
                  })),
                }))
              if (errors.length)
                throw new AggregateError(
                  errors,
                  `TURN renewal diagnostics: ${JSON.stringify({ scenario, expiredAt, before, current: rotationSnapshot, cutover, after, turn: turnDiagnostics })}`
                )
              await Promise.all(
                pages.map((item) => item.evaluate(() => window.fixture.stop()))
              )
              console.log(
                `TURN renewal passed: ${JSON.stringify({ scenario, before: summarize(before), cutover: summarize(cutover), after: summarize(after), nextAllocations: turnDiagnostics.allocations.filter((allocation) => allocation.username === 'next').length })}`
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
