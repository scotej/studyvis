import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { build } from 'vite'

test(
  'abandoned idle channels close on both native peers and allow a fresh offer',
  { timeout: 85_000 },
  async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const result = await build({
      root,
      logLevel: 'error',
      plugins: [
        {
          name: 'idle-transport-fixture',
          resolveId(id) {
            if (id === 'idle-fixture') return '\0idle-fixture'
          },
          load(id) {
            if (id === '\0idle-fixture')
              return `
          export { default as createPeer } from ${JSON.stringify(`${root}node_modules/@trystero-p2p/core/dist/peer.mjs`)}
          export { SharedPeerManager, getConnectedPeerHealth } from ${JSON.stringify(`${root}node_modules/@trystero-p2p/core/dist/shared-peer.mjs`)}
          export { createSignalHandler, getState } from ${JSON.stringify(`${root}node_modules/@trystero-p2p/core/dist/signal-handler.mjs`)}
          export { createResilientPeerConnection, TRANSIENT_DISCONNECT_HOLD_MS } from ${JSON.stringify(`${root}src/lib/webrtc/resilientPeerConnection.ts`)}
        `
          },
        },
      ],
      build: {
        write: false,
        rollupOptions: {
          input: 'idle-fixture',
          preserveEntrySignatures: 'strict',
        },
      },
    })
    const output = (Array.isArray(result) ? result[0] : result).output
    const entry = output.find((item) => item.type === 'chunk' && item.isEntry)
    assert.ok(entry)
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.LAB_CHROME_EXECUTABLE
        ? { executablePath: process.env.LAB_CHROME_EXECUTABLE }
        : {}),
    })
    try {
      const page = await browser.newPage()
      const errors = []
      const egress = []
      const origin = 'http://127.0.0.1'
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url())
        if (url.origin !== origin) {
          egress.push(url.origin)
          return route.abort('blockedbyclient')
        }
        const asset = output.find(
          (item) => item.fileName === url.pathname.slice(1)
        )
        return route.fulfill({
          contentType:
            asset?.type === 'chunk' ? 'text/javascript' : 'text/html',
          body: asset?.type === 'chunk' ? asset.code : '<html></html>',
        })
      })
      await page.goto(origin)
      assert.equal(
        await page.evaluate(
          () => isSecureContext && typeof crypto.subtle?.digest === 'function'
        ),
        true
      )
      const verdicts = await page.evaluate(async (file) => {
        const {
          createPeer,
          SharedPeerManager,
          getConnectedPeerHealth,
          createSignalHandler,
          getState,
          createResilientPeerConnection,
          TRANSIENT_DISCONNECT_HOLD_MS,
        } = await import(`/${file}`)
        const forced = new WeakMap()
        class ControlledConnection extends RTCPeerConnection {
          get connectionState() {
            const state = super.connectionState
            return state === 'closed' ? state : (forced.get(this) ?? state)
          }
          get iceConnectionState() {
            const state = super.iceConnectionState
            return state === 'closed' ? state : (forced.get(this) ?? state)
          }
        }
        const config = {
          rtcConfig: { iceServers: [] },
          rtcPolyfill: createResilientPeerConnection(ControlledConnection),
        }
        const until = async (condition, timeout = 10_000) => {
          const deadline = Date.now() + timeout
          while (!condition()) {
            if (Date.now() > deadline)
              throw new Error('Transport condition deadline expired')
            await new Promise((done) => setTimeout(done, 25))
          }
        }
        const allPeers = []
        const managers = []
        const outcomes = []
        try {
          for (let iteration = 0; iteration < 2; iteration++) {
            const local = createPeer(true, config),
              remote = createPeer(false, config)
            allPeers.push(local, remote)
            local.setHandlers({
              signal: (signal) => void remote.signal(signal),
            })
            remote.setHandlers({
              signal: (signal) => void local.signal(signal),
            })
            const lm = new SharedPeerManager(),
              rm = new SharedPeerManager()
            managers.push(lm, rm)
            const ls = lm.register('studyvis', 'friend', local, 1000)
            const rs = rm.register('studyvis', 'friend', remote, 1000)
            const departures = { local: 0, remote: 0 }
            for (const room of ['presence', 'inbox']) {
              lm.bind(room, Promise.resolve(room), ls, {
                onDetach() {},
              }).proxy.setHandlers({ close: () => departures.local++ })
              rm.bind(room, Promise.resolve(room), rs, {
                onDetach() {},
              }).proxy.setHandlers({ close: () => departures.remote++ })
            }
            await until(
              () =>
                local.channel?.readyState === 'open' &&
                remote.channel?.readyState === 'open'
            )
            // A deliberate one-room leave must preserve the healthy shared PC.
            lm.bind('temporary', Promise.resolve('temporary'), ls, {
              onDetach() {},
            }).proxy.destroy()
            if (
              local.connection.connectionState !== 'connected' ||
              Object.keys(ls.bindings).length !== 2
            )
              throw new Error('Healthy shared peer was retired')
            forced.set(local.connection, 'disconnected')
            local.connection.dispatchEvent(new Event('connectionstatechange'))
            local.connection.dispatchEvent(
              new Event('iceconnectionstatechange')
            )
            if (
              local.connection.connectionState !== 'connected' ||
              local.channel.readyState !== 'open'
            )
              throw new Error('Transient hold was bypassed')
            await until(
              () => departures.local === 2,
              TRANSIENT_DISCONNECT_HOLD_MS + 10_000
            )
            // The native link never physically failed. Recovery cannot restore a
            // channel which its last owner has deliberately retired.
            forced.delete(local.connection)
            await until(
              () =>
                remote.channel.readyState === 'closed' &&
                departures.remote === 2
            )
            let decrypted = false
            const fresh = createPeer(true, { rtcConfig: { iceServers: [] } })
            allPeers.push(fresh)
            const ctx = {
              appId: 'studyvis',
              roomId: 'presence',
              config,
              peerStates: {},
              rootTopicPlaintext: 'fixture',
              rootTopicP: Promise.resolve('root'),
              selfTopicP: Promise.resolve('self'),
              isLeaving: () => false,
              isPassive: false,
              isActive: true,
              sharedPeers: rm,
              initPeer: (initiator, options) => {
                const peer = createPeer(initiator, options)
                allPeers.push(peer)
                return peer
              },
              toPlain: async (signal) => {
                decrypted = true
                return signal
              },
              toCipher: async (signal) => signal,
              connectPeer() {},
              disconnectPeer() {},
              checkDeactivate() {},
            }
            const state = getState(ctx.peerStates, 'friend')
            state.connectedPeer = remote
            const offer = await fresh.getOffer()
            await createSignalHandler(ctx)(0)(
              'root',
              { peerId: 'friend', offer: offer.sdp },
              () => {}
            )
            outcomes.push({
              departures,
              localClosed: local.connection.connectionState === 'closed',
              localChannelClosed: local.channel.readyState === 'closed',
              remoteClosed: remote.connection.connectionState === 'closed',
              remoteChannelClosed: remote.channel.readyState === 'closed',
              localOwned: Boolean(lm.get('studyvis', 'friend')),
              remoteOwned: Boolean(rm.get('studyvis', 'friend')),
              farHealth: getConnectedPeerHealth(remote),
              decrypted,
              newOfferApplied:
                state.answeringPeer?.connection.remoteDescription?.type ===
                'offer',
            })
            state.answeringPeer?.destroy()
            fresh.destroy()
          }
          return outcomes
        } finally {
          for (const manager of managers)
            manager.clear('studyvis', 'friend', { destroyPeer: true })
          for (const peer of allPeers) if (!peer.isDead) peer.destroy()
        }
      }, entry.fileName)
      assert.equal(verdicts.length, 2)
      for (const verdict of verdicts)
        assert.deepEqual(verdict, {
          departures: { local: 2, remote: 2 },
          localClosed: true,
          localChannelClosed: true,
          remoteClosed: true,
          remoteChannelClosed: true,
          localOwned: false,
          remoteOwned: false,
          farHealth: 'stale',
          decrypted: true,
          newOfferApplied: true,
        })
      assert.deepEqual(errors, [])
      assert.deepEqual(egress, [])
      console.log(JSON.stringify(verdicts))
    } finally {
      await browser.close()
    }
  }
)
