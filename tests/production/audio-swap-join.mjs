import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { build } from 'vite'

test(
  'an incumbent and a peer joining mid-swap both decode the new microphone',
  { timeout: 45_000 },
  async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const result = await build({
      root,
      logLevel: 'error',
      build: {
        write: false,
        rollupOptions: {
          input: `${root}src/features/session/audioDevices.ts`,
          preserveEntrySignatures: 'strict',
        },
      },
    })
    const output = (Array.isArray(result) ? result[0] : result).output
    const entry = output.find((item) => item.type === 'chunk' && item.isEntry)
    assert.ok(entry)
    const browser = await chromium.launch({
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
      ...(process.env.LAB_CHROME_EXECUTABLE
        ? { executablePath: process.env.LAB_CHROME_EXECUTABLE }
        : {}),
    })
    try {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('**/*', (route) => {
        const asset = output.find(
          (item) =>
            item.fileName === new URL(route.request().url()).pathname.slice(1)
        )
        return route.fulfill({
          contentType:
            asset?.type === 'chunk' ? 'text/javascript' : 'text/html',
          body: asset?.type === 'chunk' ? asset.code : '<html></html>',
        })
      })
      await page.goto('http://studyvis.test/')
      const result = await page.evaluate(async (file) => {
        const { swapAudioInput } = await import(`/${file}`)
        const audio = new AudioContext()
        const pcs = []
        const sources = []
        const until = async (condition) => {
          const deadline = Date.now() + 10_000
          while (!condition()) {
            if (Date.now() > deadline)
              throw new Error('Audio/connection deadline expired')
            await new Promise((done) => setTimeout(done, 25))
          }
        }
        try {
          await audio.resume()
          const source = (frequency) => {
            const osc = audio.createOscillator()
            osc.frequency.value = frequency
            const dest = audio.createMediaStreamDestination()
            osc.connect(dest)
            osc.start()
            const value = { osc, track: dest.stream.getAudioTracks()[0] }
            sources.push(value)
            return value
          }
          const first = source(440)
          const replacement = source(880)
          const localStream = new MediaStream([first.track])
          const connect = async () => {
            const local = new RTCPeerConnection({ iceServers: [] })
            const remote = new RTCPeerConnection({ iceServers: [] })
            pcs.push(local, remote)
            const candidatesA = [],
              candidatesB = []
            local.onicecandidate = (e) => {
              if (e.candidate) {
                if (remote.remoteDescription)
                  void remote.addIceCandidate(e.candidate)
                else candidatesA.push(e.candidate)
              }
            }
            remote.onicecandidate = (e) => {
              if (e.candidate) {
                if (local.remoteDescription)
                  void local.addIceCandidate(e.candidate)
                else candidatesB.push(e.candidate)
              }
            }
            const received = new Promise((done) => {
              remote.ontrack = (e) => done(e.streams[0])
            })
            const sender = local.addTrack(
              localStream.getAudioTracks()[0],
              localStream
            )
            await local.setLocalDescription(await local.createOffer())
            await remote.setRemoteDescription(local.localDescription)
            for (const c of candidatesA.splice(0))
              await remote.addIceCandidate(c)
            await remote.setLocalDescription(await remote.createAnswer())
            await local.setRemoteDescription(remote.localDescription)
            for (const c of candidatesB.splice(0))
              await local.addIceCandidate(c)
            const incoming = await received
            const element = document.createElement('audio')
            element.autoplay = true
            element.srcObject = incoming
            document.body.append(element)
            await element.play()
            await until(() => local.connectionState === 'connected')
            const analyser = audio.createAnalyser()
            analyser.fftSize = 4096
            analyser.smoothingTimeConstant = 0
            audio.createMediaStreamSource(incoming).connect(analyser)
            const sample = () => {
              const bins = new Uint8Array(analyser.frequencyBinCount)
              analyser.getByteFrequencyData(bins)
              let top = 0
              for (let i = 1; i < bins.length; i++)
                if (bins[i] > bins[top]) top = i
              return {
                peakHz: Math.round((top * audio.sampleRate) / analyser.fftSize),
                amplitude: bins[top],
              }
            }
            return { local, sender, sample }
          }
          const incumbent = await connect()
          await until(() => incumbent.sample().amplitude > 60)
          const before = incumbent.sample()
          let release, markStarted
          const started = new Promise((done) => {
            markStarted = done
          })
          const nativeReplace = incumbent.sender.replaceTrack.bind(
            incumbent.sender
          )
          incumbent.sender.replaceTrack = async (track) => {
            markStarted()
            await new Promise((done) => {
              release = done
            })
            return nativeReplace(track)
          }
          const peers = { incumbent: incumbent.local }
          const swapping = swapAudioInput(
            'replacement',
            {
              getUserMedia: async () => new MediaStream([replacement.track]),
              room: { getPeers: () => peers },
              localStream,
            },
            () => true
          )
          await started
          const arriving = await connect()
          peers.arriving = arriving.local
          await until(() => arriving.sample().amplitude > 60)
          const arrivingBefore = arriving.sample()
          release()
          await swapping
          const newTone = (peer) => {
            const s = peer.sample()
            return s.amplitude > 60 && s.peakHz > 800 && s.peakHz < 950
          }
          await until(() => newTone(incumbent) && newTone(arriving))
          return {
            before,
            arrivingBefore,
            incumbent: incumbent.sample(),
            arriving: arriving.sample(),
            connected: Object.values(peers).every(
              (pc) => pc.connectionState === 'connected'
            ),
            currentSenders: [incumbent, arriving].every(
              (peer) => peer.sender.track === replacement.track
            ),
            oldTrack: first.track.readyState,
            newTrack: replacement.track.readyState,
          }
        } finally {
          for (const pc of pcs) pc.close()
          for (const { track, osc } of sources) {
            track.stop()
            osc.stop()
          }
          await audio.close()
        }
      }, entry.fileName)
      for (const sample of [result.before, result.arrivingBefore]) {
        assert.ok(
          sample.peakHz > 400 && sample.peakHz < 480 && sample.amplitude > 60,
          JSON.stringify(result)
        )
      }
      assert.equal(result.connected, true)
      assert.equal(result.currentSenders, true)
      assert.equal(result.oldTrack, 'ended')
      assert.equal(result.newTrack, 'live')
      assert.deepEqual(errors, [])
      console.log(JSON.stringify(result))
    } finally {
      await browser.close()
    }
  }
)
