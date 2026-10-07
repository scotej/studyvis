import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import path from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium, firefox, webkit } from 'playwright-core'
import sharp from 'sharp'

import { MirrorFixtureDriver } from '../../lab/src/backend/mirrorDriver.ts'
import {
  inviteAndAccept,
  declareTopicIfAsked,
  onboard,
  pairViaContactCard,
} from '../../lab/src/flows.ts'
import { Lab } from '../../lab/src/lab.ts'
import * as ui from '../../lab/src/ui.ts'
import { strings } from '../../src/strings.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const chromeExecutable =
  process.env.LAB_CHROME_EXECUTABLE ?? chromium.executablePath()
const fixtureExecutable =
  process.env.MIRROR_FIXTURE_BIN ??
  path.join(root, 'src-tauri/target/debug/examples/mirror_fixture')

before(
  async () => {
    if (process.env.MIRROR_FIXTURE_BIN) return
    await run(
      process.env.CARGO ?? 'cargo',
      ['build', '--locked', '--example', 'mirror_fixture'],
      path.join(root, 'src-tauri')
    )
  },
  { timeout: 600_000 }
)

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let errors = ''
    child.stderr.on('data', (chunk) => {
      errors = `${errors}${chunk}`.slice(-8000)
    })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited ${code}: ${errors}`))
    )
  })
}

function mediaFixtures(directory) {
  mkdirSync(directory, { recursive: true })
  const width = 640
  const height = 480
  const yuv = Buffer.concat([
    Buffer.alloc(width * height, 81),
    Buffer.alloc((width * height) / 4, 90),
    Buffer.alloc((width * height) / 4, 240),
  ])
  const camera = path.join(directory, 'red-camera.y4m')
  writeFileSync(
    camera,
    Buffer.concat([
      Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`),
      Buffer.from('FRAME\n'),
      yuv,
      Buffer.from('FRAME\n'),
      yuv,
    ])
  )
  const samples = 48_000
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(48_000, 24)
  wav.writeUInt32LE(96_000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++)
    wav.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 880 * i) / 48_000) * 24000),
      44 + i * 2
    )
  const microphone = path.join(directory, 'microphone.wav')
  writeFileSync(microphone, wav)
  return { camera, microphone }
}

function browserOptions(name, media, certificateDirectory) {
  const certificate = new X509Certificate(
    Buffer.from(
      JSON.parse(
        readFileSync(path.join(certificateDirectory, 'server.json'), 'utf8')
      ).certificate
    )
  )
  const certificateKey = createHash('sha256')
    .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64')
  if (name === 'chromium')
    return {
      executablePath: chromeExecutable,
      args: [
        // Chromium's service worker script fetch needs a process-level trust
        // exception; bind it to this test fixture's leaf public key only.
        `--ignore-certificate-errors-spki-list=${certificateKey}`,
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--auto-select-desktop-capture-source=Entire screen',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        `--use-file-for-fake-video-capture=${media.camera}`,
        `--use-file-for-fake-audio-capture=${media.microphone}`,
      ],
    }
  if (name === 'firefox')
    return {
      firefoxUserPrefs: {
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true,
        'media.autoplay.default': 0,
      },
    }
  return {}
}

async function assertTrustedFixture(url, certificateDirectory) {
  const ca = new X509Certificate(
    readFileSync(path.join(certificateDirectory, 'root.crt'))
  ).toString()
  const response = await new Promise((resolve, reject) => {
    const request = httpsGet(url, { ca }, (incoming) => {
      const authorized = incoming.socket.authorized
      const chunks = []
      incoming.on('data', (chunk) => chunks.push(chunk))
      incoming.on('error', reject)
      incoming.on('end', () =>
        resolve({
          status: incoming.statusCode,
          authorized,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      )
    })
    request.on('error', reject)
    request.setTimeout(5000, () =>
      request.destroy(new Error('Trusted fixture HTTPS request timed out'))
    )
  })
  assert.equal(response.status, 200)
  assert.equal(response.authorized, true)
  assert.match(response.body, /<title>StudyVis<\/title>/)
}

async function videoEvidence(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('video')].map((video) => {
      let pixel = null
      if (video.videoWidth > 0) {
        const canvas = document.createElement('canvas')
        canvas.width = 1
        canvas.height = 1
        const ctx = canvas.getContext('2d')
        ctx.drawImage(video, 0, 0, 1, 1)
        pixel = [...ctx.getImageData(0, 0, 1, 1).data]
      }
      return {
        muted: video.muted,
        width: video.videoWidth,
        playing: !video.paused,
        pixel,
        decoded:
          video.__mirrorDecodedFrames ??
          video.getVideoPlaybackQuality?.().totalVideoFrames ??
          0,
        tracks:
          video.srcObject
            ?.getTracks()
            .map((track) => `${track.kind}:${track.readyState}`) ?? [],
      }
    })
  )
}

async function audioRms(page, capture = false) {
  return page.evaluate(async (capture) => {
    const videos = [...document.querySelectorAll('video')].filter(
      (element) => !element.muted && element.srcObject?.getAudioTracks().length
    )
    const streams = capture
      ? [window.__mirrorTestCapture.camera.at(-1)].filter(Boolean)
      : videos.map((video) => video.srcObject)
    if (!streams.length) return 0
    const context = new AudioContext()
    await context.resume()
    const analyser = context.createAnalyser()
    const sources = streams.map((stream) =>
      context.createMediaStreamSource(stream)
    )
    for (const source of sources) source.connect(analyser)
    const buffer = new Float32Array(analyser.fftSize)
    let peak = 0
    for (let i = 0; i < 20; i++) {
      analyser.getFloatTimeDomainData(buffer)
      peak = Math.max(
        peak,
        Math.sqrt(
          buffer.reduce((sum, value) => sum + value * value, 0) / buffer.length
        )
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    for (const source of sources) source.disconnect()
    await context.close()
    return peak
  }, capture)
}

function observeCapture() {
  const observed = { camera: [], screen: [], peers: [] }
  window.__mirrorTestCapture = observed
  const locks = []
  window.__mirrorTestWakeLocks = locks
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: async () => {
        const lock = new EventTarget()
        lock.released = false
        lock.release = async () => {
          lock.released = true
          lock.dispatchEvent(new Event('release'))
        }
        locks.push(lock)
        return lock
      },
    },
  })
  if (navigator.serviceWorker) {
    const register = navigator.serviceWorker.register
    navigator.serviceWorker.register = (...args) =>
      register.apply(navigator.serviceWorker, args).catch((error) => {
        window.__mirrorServiceWorkerError = error.message
        throw error
      })
  }
  const PeerConnection = window.RTCPeerConnection
  window.RTCPeerConnection = new Proxy(PeerConnection, {
    construct(target, args) {
      const peer = Reflect.construct(target, args)
      observed.peers.push(peer)
      return peer
    },
  })
  const videos = new WeakSet()
  const watchVideo = (video) => {
    if (videos.has(video) || !video.requestVideoFrameCallback) return
    videos.add(video)
    const frame = (_time, metadata) => {
      video.__mirrorDecodedFrames = metadata.presentedFrames
      video.requestVideoFrameCallback(frame)
    }
    video.requestVideoFrameCallback(frame)
  }
  new MutationObserver(() => {
    for (const video of document.querySelectorAll('video')) watchVideo(video)
  }).observe(document, { childList: true, subtree: true })
  for (const [kind, method] of [
    ['camera', 'getUserMedia'],
    ['screen', 'getDisplayMedia'],
  ]) {
    const original = navigator.mediaDevices?.[method]
    if (!original) continue
    navigator.mediaDevices[method] = async (...args) => {
      const stream = await original.apply(navigator.mediaDevices, args)
      observed[kind].push(stream)
      return stream
    }
  }
}

async function mediaState(page) {
  return page.evaluate(async () => {
    const track = (value) =>
      value && {
        id: value.id,
        kind: value.kind,
        readyState: value.readyState,
        enabled: value.enabled,
        muted: value.muted,
      }
    return {
      captures: Object.fromEntries(
        ['camera', 'screen'].map((kind) => [
          kind,
          window.__mirrorTestCapture[kind].map((stream) =>
            stream.getTracks().map(track)
          ),
        ])
      ),
      peers: await Promise.all(
        window.__mirrorTestCapture.peers.map(async (peer) => ({
          state: peer.connectionState,
          transceivers: peer.getTransceivers().map((slot) => ({
            mid: slot.mid,
            direction: slot.currentDirection,
            sending: track(slot.sender.track),
            receiving: track(slot.receiver.track),
          })),
          audio: [...(await peer.getStats()).values()].filter(
            (stat) =>
              stat.kind === 'audio' &&
              ['inbound-rtp', 'outbound-rtp', 'media-source'].includes(
                stat.type
              )
          ),
        }))
      ),
    }
  })
}

async function endActualCapture(page, kind) {
  await page.evaluate((captureKind) => {
    const stream = window.__mirrorTestCapture[captureKind].at(-1)
    if (!stream) throw new Error(`No actual ${captureKind} capture to end`)
    for (const track of stream.getTracks()) {
      track.stop()
      // Browser source revocation fires ended; script stop itself does not.
      // End real device tracks and then deliver that OS lifecycle event.
      track.dispatchEvent(new Event('ended'))
    }
  }, kind)
}

async function closeControls(page) {
  await page
    .getByRole('dialog', { name: strings.mirror.controls })
    .getByRole('button', { name: strings.common.actions.close, exact: true })
    .click()
}

async function assertAiStopped(lab, page, kind) {
  await endActualCapture(page, kind)
  await page.waitForTimeout(1000)
  const count = lab.llama.requests.length
  // Longer than the real production fallback sampling interval (5 seconds).
  await page.waitForTimeout(6500)
  assert.equal(
    lab.llama.requests.length,
    count,
    `AI pauses after ${kind} source loss`
  )
}

async function assertHostCaptureReleased(host) {
  await ui.until(
    () =>
      host
        .page()
        .evaluate(
          () =>
            window.__mirrorTestCapture.camera.length > 0 &&
            ['camera', 'screen'].every((kind) =>
              window.__mirrorTestCapture[kind].every((stream) =>
                stream
                  .getTracks()
                  .every((track) => track.readyState === 'ended')
              )
            )
        ),
    {
      label:
        'enabling the companion releases all desktop capture before pairing',
    }
  )
}

async function assertNoNativeCaptureOverlay(host) {
  assert.equal(
    await host
      .page()
      .getByRole('dialog', {
        name: strings.permissions.screenCapture.title,
        exact: true,
      })
      .count(),
    0,
    'browser capture recovery never opens the desktop screen-permission overlay'
  )
  await assertHostCaptureReleased(host)
}

async function assertImagesAndDirectMessages(page, friend, workdir) {
  await page.locator('input[type="file"]').setInputFiles({
    name: 'invalid.png',
    mimeType: 'image/png',
    buffer: Buffer.from('invalid image data'),
  })
  await page
    .getByRole('alert')
    .getByText(strings.mirror.imageSendFailed, { exact: true })
    .waitFor()
  await ui.click(page, strings.mirror.dismissError, { exact: true })
  await ui.waitForGone(page, strings.mirror.imageSendFailed)
  const image = await sharp({
    create: {
      width: 32,
      height: 24,
      channels: 3,
      background: { r: 10, g: 80, b: 220 },
    },
  })
    .png()
    .toBuffer()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'mirror-reading.png',
    mimeType: 'image/png',
    buffer: image,
  })
  await ui.waitForText(friend.page(), 'mirror-reading.png')
  await page
    .getByRole('button', {
      name: strings.session.images.openImage('Alice'),
      exact: true,
    })
    .click()
  const imageDownload = page.waitForEvent('download')
  await ui.click(page, strings.session.images.download, { exact: true })
  const downloaded = await imageDownload
  assert.equal(downloaded.suggestedFilename(), 'mirror-reading.png')
  const savedImage = path.join(workdir, 'downloaded-reading.png')
  await downloaded.saveAs(savedImage)
  assert.deepEqual(readFileSync(savedImage), image)
  await page
    .getByRole('dialog', { name: strings.session.images.viewerTitle('Alice') })
    .getByRole('button', { name: strings.common.actions.close, exact: true })
    .click()

  await page.mouse.move(20, 20)
  await ui.waitForGone(page, strings.session.images.downloaded)
  await ui.click(page, strings.session.chat.addConversation, { exact: true })
  await page.getByRole('menuitem', { name: 'Bob', exact: true }).click()
  await ui.fill(
    page,
    strings.session.chat.dmInputAriaLabel('Bob'),
    'Private browser question'
  )
  await ui.click(page, strings.session.chat.sendDirectAriaLabel('Bob'), {
    exact: true,
  })
  await ui.click(friend.page(), strings.session.chat.addConversation, {
    exact: true,
  })
  await friend
    .page()
    .getByRole('menuitem', { name: 'Alice', exact: true })
    .click()
  await ui.waitForText(friend.page(), 'Private browser question')
  await ui.fill(
    friend.page(),
    strings.session.chat.dmInputAriaLabel('Alice'),
    'Private peer answer'
  )
  await ui.click(
    friend.page(),
    strings.session.chat.sendDirectAriaLabel('Alice'),
    { exact: true }
  )
  await ui.waitForText(page, 'Private peer answer')
  await page
    .getByRole('tab', { name: strings.session.chat.group, exact: true })
    .click()
  await friend
    .page()
    .getByRole('tab', { name: strings.session.chat.group, exact: true })
    .click()
  assert.equal(
    await page.getByText('Private peer answer', { exact: true }).count(),
    0
  )
}

async function assertCaptureFreeAi(lab, page) {
  const before = lab.llama.requests.length
  lab.llama.queue.splice(0)
  lab.llama.push({
    content: JSON.stringify({
      reply_text: 'Read one section, then explain it in your own words.',
    }),
  })
  await ui.click(page, strings.session.chat.addConversation, { exact: true })
  await page.getByRole('menuitem', { name: strings.session.chat.ai }).click()
  await ui.fill(
    page,
    strings.session.chat.aiInputAriaLabel,
    'How should I study this chapter?'
  )
  await ui.click(page, strings.session.chat.sendAiAriaLabel, { exact: true })
  await ui.waitForText(
    page,
    'Read one section, then explain it in your own words.',
    30_000
  )
  await page
    .getByRole('tab', { name: strings.session.chat.group, exact: true })
    .click()
  lab.llama.push({
    content: JSON.stringify({
      intent: 'question',
      payload: {},
      reply_text: 'Explain one idea before moving on.',
    }),
  })
  await ui.click(page, strings.mirror.aiAction, { exact: true })
  await ui.fill(page, strings.ai.dialog.ariaLabel, 'What should I do next?')
  await page
    .getByRole('textbox', { name: strings.ai.dialog.ariaLabel })
    .press('Enter')
  await ui.waitForText(page, 'Explain one idea before moving on.', 30_000)
  await page
    .getByRole('dialog', { name: strings.mirror.aiAction })
    .getByRole('button', { name: strings.common.actions.close, exact: true })
    .click()
  const requests = lab.llama.requests.slice(before)
  assert.equal(
    requests.length,
    2,
    'capture-free AI runs chat and semantic dialogue only'
  )
  assert.ok(
    requests.every(({ body }) =>
      body.messages.every((message) => typeof message.content === 'string')
    ),
    'capture-free AI never sends image samples'
  )
  lab.llama.push({
    content: JSON.stringify({
      severity: 'on_task',
      reasoning: 'Reading the declared chapter.',
      on_topic_confidence: 0.95,
    }),
  })
}

const only = process.env.MIRROR_BROWSER
for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  test(
    `${name}: production companion, real Rust LAN host, peer media, and offline recovery`,
    { timeout: 240_000, skip: !!only && only !== name },
    async (t) => {
      const lab = await Lab.up({ chromeExecutable })
      let driver
      let browser
      let context
      let page
      const errors = []
      const browserEgress = []
      try {
        lab.llama.push({
          content: JSON.stringify({
            severity: 'on_task',
            reasoning: 'Reading the declared chapter.',
            on_topic_confidence: 0.95,
          }),
        })
        const host = await lab.addMachine({
          name: `mirror-host-${name}`,
          ai: name === 'chromium',
        })
        const friend = await lab.addMachine({ name: `mirror-friend-${name}` })
        const invited =
          name === 'chromium'
            ? await lab.addMachine({ name: 'mirror-invited-chromium' })
            : null
        await host.page().evaluate(observeCapture)
        driver = new MirrorFixtureDriver({
          certificateDir: path.join(lab.workdir, 'mirror-certificate'),
          assetsDir: path.join(root, 'dist'),
          executable: fixtureExecutable,
          emit: (event, payload) => {
            void host.emit(event, payload)
          },
        })
        host.backend.attachMirrorDriver(driver)
        await Promise.all([
          onboard(host, { displayName: 'Alice' }),
          onboard(friend, { displayName: 'Bob' }),
          ...(invited ? [onboard(invited, { displayName: 'Charlie' })] : []),
        ])
        await pairViaContactCard(host, friend)
        if (invited) {
          await pairViaContactCard(host, invited)
          await pairViaContactCard(friend, invited)
        }
        await inviteAndAccept(host, friend, 'Bob', 'Alice', 'Mirrored reading')
        await ui.click(host.page(), strings.mirror.open)
        await ui.click(host.page(), strings.mirror.start)
        await assertHostCaptureReleased(host)
        const password = await host
          .page()
          .getByLabel(strings.mirror.password)
          .inputValue()
        const url = await host
          .page()
          .getByLabel(strings.mirror.link, { exact: true })
          .first()
          .inputValue()
        const endpoint = new URL(url)
        assert.equal(endpoint.protocol, 'https:')
        assert.equal(endpoint.hostname, '127.0.0.1')
        assert.equal(endpoint.pathname, '/')
        assert.ok(password.length >= 8)
        await assertTrustedFixture(
          url,
          path.join(lab.workdir, 'mirror-certificate')
        )
        const media = mediaFixtures(path.join(lab.workdir, 'media'))
        browser = await engine.launch({
          headless: true,
          ...browserOptions(
            name,
            media,
            path.join(lab.workdir, 'mirror-certificate')
          ),
        })
        context = await browser.newContext({
          // TLS/router/cookie behavior is real. User certificate installation
          // remains a separate physical-device check.
          ignoreHTTPSErrors: true,
          permissions: name === 'firefox' ? [] : ['camera', 'microphone'],
          viewport: { width: 1280, height: 800 },
        })
        context.on('request', (request) => {
          const address = new URL(request.url())
          if (
            address.protocol !== 'data:' &&
            address.protocol !== 'blob:' &&
            address.hostname !== '127.0.0.1'
          )
            browserEgress.push(request.url())
        })
        await context.addInitScript(observeCapture)
        page = await context.newPage()
        page.on('pageerror', (error) => errors.push(error.message))
        await page.goto(url)
        assert.equal(await page.evaluate(() => window.isSecureContext), true)
        await page.getByLabel(strings.mirror.password).fill('WRONGPASSWORD')
        await page
          .getByRole('button', { name: strings.mirror.pair, exact: true })
          .click()
        await ui.waitForText(page, strings.mirror.pairFailed)
        await page.getByLabel(strings.mirror.password).fill(password)
        await page
          .getByRole('button', { name: strings.mirror.pair, exact: true })
          .click()
        await ui.waitForText(page, 'Study session')
        await ui.waitForText(page, 'Bob')
        const cookies = await context.cookies(url)
        assert.ok(
          cookies.some(
            (cookie) =>
              cookie.name.startsWith('__Host-') &&
              cookie.httpOnly &&
              cookie.secure &&
              cookie.sameSite === 'Strict'
          )
        )
        assert.equal(
          await page.evaluate(() => '__TAURI_INTERNALS__' in window),
          false
        )
        assert.equal(await page.evaluate(() => document.cookie), '')
        await assertHostCaptureReleased(host)
        if (invited) {
          await ui.click(page, strings.session.invite.cta, { exact: true })
          await ui.click(
            page,
            strings.session.invite.rowInviteAriaLabel('Charlie'),
            { exact: true }
          )
          await ui.waitForText(invited.page(), 'invites you to study', 30_000)
          await ui.click(invited.page(), 'Accept the invite from Alice', {
            exact: true,
          })
          await declareTopicIfAsked(invited, 'Mirrored reading')
          await ui.waitForText(invited.page(), 'Study session', 20_000)
          await ui.waitForText(page, 'Charlie')
          await page
            .getByRole('dialog', { name: strings.session.invite.dialogTitle })
            .getByRole('button', {
              name: strings.common.actions.close,
              exact: true,
            })
            .click()
        }
        if (name === 'chromium') await assertCaptureFreeAi(lab, page)

        await page
          .getByRole('button', {
            name: strings.mirror.enableMedia,
            exact: true,
          })
          .click()
        await ui.until(
          async () =>
            (await videoEvidence(friend.page())).some(
              (video) =>
                !video.muted &&
                video.width > 0 &&
                video.decoded > 5 &&
                (name !== 'chromium' ||
                  (video.pixel[0] > 180 && video.pixel[1] < 80))
            ),
          {
            label: 'browser camera decoded after relaying through desktop',
            timeoutMs: 45_000,
          }
        )
        await ui.until(
          async () =>
            (await videoEvidence(page)).some(
              (video) => !video.muted && video.width > 0 && video.decoded > 5
            ),
          {
            label: 'friend camera decoded after relaying through desktop',
            timeoutMs: 45_000,
          }
        )

        await ui.fill(page, 'Note to your session', `From ${name} browser`)
        await ui.click(page, 'Send the note')
        await ui.waitForText(friend.page(), `From ${name} browser`)
        await ui.fill(friend.page(), 'Note to your session', `Reply to ${name}`)
        await ui.click(friend.page(), 'Send the note')
        await ui.waitForText(page, `Reply to ${name}`)
        if (name === 'chromium') {
          await assertImagesAndDirectMessages(page, friend, lab.workdir)
          await page.emulateMedia({
            colorScheme: 'dark',
            reducedMotion: 'no-preference',
          })
          await ui.until(
            () =>
              page.evaluate(
                () => document.documentElement.dataset.theme === 'dark'
              ),
            { label: 'desktop companion uses the dark theme' }
          )
          await page.screenshot({
            path: path.join(lab.workdir, 'companion-desktop.png'),
            fullPage: true,
          })
          await page.setViewportSize({ width: 820, height: 1180 })
          await page.emulateMedia({
            colorScheme: 'light',
            reducedMotion: 'reduce',
          })
          await ui.until(
            () =>
              page.evaluate(
                () =>
                  document.documentElement.dataset.theme === 'light' &&
                  document.documentElement.dataset.reduceMotion === 'true'
              ),
            {
              label:
                'tablet companion follows light and reduced-motion preferences',
            }
          )
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth
            ),
            true,
            'the connected companion has no horizontal overflow at tablet size'
          )
          for (const label of [
            strings.session.holdToTalkAriaLabel,
            strings.settings.openAriaLabel,
            strings.session.leaveCta,
          ]) {
            const bounds = await page
              .getByRole('button', { name: label, exact: true })
              .boundingBox()
            assert.ok(
              bounds &&
                bounds.x >= 0 &&
                bounds.y >= 0 &&
                bounds.x + bounds.width <= 820 &&
                bounds.y + bounds.height <= 1180,
              `${label} remains visible in the tablet viewport`
            )
          }
          await page.screenshot({
            path: path.join(lab.workdir, 'companion-tablet.png'),
            fullPage: true,
          })
          await page.setViewportSize({ width: 1280, height: 800 })
          await page.emulateMedia({
            colorScheme: 'dark',
            reducedMotion: 'no-preference',
          })
          await ui.click(page, strings.settings.openAriaLabel, { exact: true })
          await page
            .getByLabel(strings.mirror.topic, { exact: true })
            .fill('Browser topic update')
          await ui.click(page, strings.mirror.updateTopic, { exact: true })
          await ui.waitForText(friend.page(), 'Browser topic update')
          await closeControls(page)
        }

        await ui.click(page, 'Open Pomodoro menu')
        await ui.click(page, 'Start')
        await ui.waitForText(friend.page(), 'Focus')
        await ui.waitForText(page, 'Focus')

        await ui.click(friend.page(), 'Share screen')
        await ui.waitForText(page, "Bob's screen", 30_000)
        if (name === 'chromium') {
          const talk = page.getByRole('button', {
            name: strings.session.holdToTalkAriaLabel,
            exact: true,
          })
          await talk.hover()
          await page.mouse.down()
          try {
            assert.ok(
              (await audioRms(page, true)) > 0.02,
              'the actual browser microphone capture contains fixture PCM while Talk is held'
            )
            await ui.until(async () => (await audioRms(friend.page())) > 0.02, {
              label:
                'browser microphone PCM decoded by friend while Talk is held',
              timeoutMs: 20_000,
            })
          } catch (error) {
            t.diagnostic(
              JSON.stringify({
                browserMedia: await mediaState(page),
                hostMedia: await mediaState(host.page()),
                friendVideo: await videoEvidence(friend.page()),
                friendPeers: await friend
                  .page()
                  .evaluate(() => window.__lab.peers()),
              })
            )
            throw error
          } finally {
            await page.mouse.up()
          }
          const requestStart = lab.llama.requests.length
          await ui.click(page, strings.settings.openAriaLabel)
          await ui.click(page, strings.mirror.screenCapture)
          await closeControls(page)
          await ui.until(() => lab.llama.requests.length > requestStart, {
            label: 'host AI inference on companion captures',
            timeoutMs: 45_000,
          })
          const requests = lab.llama.requests.slice(requestStart)
          let browserFrameFound = false
          for (const request of requests) {
            const images =
              request.body?.messages?.flatMap((message) =>
                Array.isArray(message.content)
                  ? message.content
                      .filter((part) => part.type === 'image_url')
                      .map((part) => part.image_url.url)
                  : []
              ) ?? []
            if (images.length !== 2) continue
            const pixel = await sharp(
              Buffer.from(images[0].split(',')[1], 'base64')
            )
              .resize(1, 1)
              .raw()
              .toBuffer()
            if (pixel[0] > 180 && pixel[1] < 80) browserFrameFound = true
          }
          assert.ok(
            browserFrameFound,
            'AI receives the distinct red companion camera rather than the desktop camera'
          )
          await assertAiStopped(lab, page, 'camera')
          await assertNoNativeCaptureOverlay(host)
          await ui.click(page, strings.mirror.enableMedia, { exact: true })
          const resumed = lab.llama.requests.length
          await ui.until(() => lab.llama.requests.length > resumed, {
            label: 'host AI resumes only after a fresh browser camera gesture',
            timeoutMs: 30_000,
          })
          await assertAiStopped(lab, page, 'screen')
          await assertNoNativeCaptureOverlay(host)
          await ui.click(page, strings.settings.openAriaLabel)
          await ui.click(page, strings.mirror.screenCapture)
          await closeControls(page)
          await ui.click(page, 'Share screen')
          await ui.waitForText(friend.page(), "Alice's screen", 30_000)
          await ui.click(page, 'Share screen')
          await ui.until(
            async () =>
              (await friend.page().getByText("Alice's screen").count()) === 0,
            {
              label: 'stopping browser sharing removes the relayed screen',
            }
          )
          await ui.click(page, 'Share screen')
          await ui.waitForText(friend.page(), "Alice's screen", 30_000)
        }

        if (name === 'chromium') {
          const replaced = page
          const replacement = await context.newPage()
          replacement.on('pageerror', (error) => errors.push(error.message))
          await replacement.goto(url)
          await ui.until(
            () =>
              replacement
                .getByRole('textbox', {
                  name: strings.session.notes.inputAriaLabel,
                  exact: true,
                })
                .isEnabled(),
            { label: 'new same-cookie tab takes control' }
          )
          await ui.waitForText(replaced, strings.mirror.sessionMoved)
          await replaced.waitForTimeout(6500)
          assert.equal(
            await replaced
              .getByRole('textbox', {
                name: strings.session.notes.inputAriaLabel,
                exact: true,
              })
              .isEnabled(),
            false
          )
          assert.equal(
            await replacement
              .getByRole('textbox', {
                name: strings.session.notes.inputAriaLabel,
                exact: true,
              })
              .isEnabled(),
            true
          )
          assert.equal(
            await replaced.evaluate(() =>
              window.__mirrorTestCapture.camera.every((stream) =>
                stream
                  .getTracks()
                  .every((track) => track.readyState === 'ended')
              )
            ),
            true
          )
          await replaced.close()
          page = replacement
          await assertNoNativeCaptureOverlay(host)
        }
        await ui.until(
          () =>
            page.evaluate(async () => {
              if (window.__mirrorServiceWorkerError)
                throw new Error(window.__mirrorServiceWorkerError)
              return !!(await navigator.serviceWorker.getRegistration())?.active
            }),
          {
            label: 'production offline service worker installs',
            timeoutMs: 30_000,
          }
        )
        await page.reload()
        await ui.waitForText(page, `Reply to ${name}`)
        // Suspend the actual LAN host process. Playwright's WebKit network
        // emulation bypasses service-worker navigation and cannot test this.
        driver.suspend()
        await page.reload({ waitUntil: 'domcontentloaded' })
        await ui.waitForText(page, strings.mirror.disconnected, 30_000)
        await ui.waitForText(page, `Reply to ${name}`)
        assert.equal(
          await page
            .getByRole('textbox', {
              name: strings.session.notes.inputAriaLabel,
              exact: true,
            })
            .isEnabled(),
          false
        )
        assert.equal(
          await page.evaluate(() =>
            [...document.querySelectorAll('video')]
              .flatMap((video) => video.srcObject?.getTracks() ?? [])
              .some((track) => track.readyState === 'live')
          ),
          false
        )
        driver.resume()
        await ui.until(
          async () =>
            await page
              .getByRole('textbox', {
                name: strings.session.notes.inputAriaLabel,
                exact: true,
              })
              .isEnabled(),
          {
            label: 'authenticated reconnect restores controls',
            timeoutMs: 40_000,
          }
        )
        await ui.fill(page, 'Note to your session', `${name} reconnected`)
        await ui.click(page, 'Send the note')
        await ui.waitForText(friend.page(), `${name} reconnected`)
        await assertNoNativeCaptureOverlay(host)
        if (
          !(await host
            .page()
            .getByRole('dialog', { name: strings.mirror.title, exact: true })
            .isVisible())
        )
          await ui.click(host.page(), strings.mirror.open, { exact: true })
        await ui.click(host.page(), strings.mirror.stop, { exact: true })
        await page.reload({ waitUntil: 'domcontentloaded' })
        await ui.waitForText(page, strings.mirror.disconnected, 30_000)
        await ui.waitForText(page, `${name} reconnected`)
        await ui.click(host.page(), strings.mirror.start, { exact: true })
        const freshPassword = await host
          .page()
          .getByLabel(strings.mirror.password)
          .inputValue()
        const freshUrl = await host
          .page()
          .getByLabel(strings.mirror.link, { exact: true })
          .first()
          .inputValue()
        assert.notEqual(freshPassword, password)
        assert.equal(
          freshUrl,
          url,
          'a cached companion origin survives host restart'
        )
        await page.getByLabel(strings.mirror.password).fill(freshPassword)
        await ui.click(page, strings.mirror.pair, { exact: true })
        await ui.until(
          async () =>
            page
              .getByRole('textbox', {
                name: strings.session.notes.inputAriaLabel,
                exact: true,
              })
              .isEnabled(),
          {
            label: 'fresh pairing restores the cached companion',
            timeoutMs: 30_000,
          }
        )
        await assertNoNativeCaptureOverlay(host)
        if (name === 'chromium') {
          await ui.click(page, strings.settings.openAriaLabel, { exact: true })
          const keepAwake = page.getByRole('switch', {
            name: strings.mirror.keepAwake,
            exact: true,
          })
          await keepAwake.click()
          assert.equal(await keepAwake.getAttribute('aria-checked'), 'true')
          await closeControls(page)
          assert.equal(
            await page.evaluate(
              () => window.__mirrorTestWakeLocks.at(-1)?.released
            ),
            false
          )
        }
        await ui.click(page, strings.session.leaveCta, { exact: true })
        await page
          .getByRole('main', { name: strings.report.ariaLabel })
          .waitFor({ timeout: 30_000 })
        if (name === 'chromium')
          assert.equal(
            await page.evaluate(
              () => window.__mirrorTestWakeLocks.at(-1)?.released
            ),
            true,
            'a browser wake lock is released when the actual report replaces the live session'
          )
        const saved = await page.evaluate(() =>
          JSON.parse(localStorage.getItem('studyvis.mirror.report.v1'))
        )
        const persisted = host.backend.db
          .sessionsList()
          .find((session) => session.started_at === saved.session.started_at)
        assert.ok(
          persisted?.ended_at,
          'browser Leave persists the actual host report'
        )
        assert.equal(saved.session.declared_topic, persisted.declared_topic)
        assert.equal(saved.session.started_at, persisted.started_at)
        assert.equal(saved.session.ended_at, persisted.ended_at)
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page
          .getByRole('main', { name: strings.report.ariaLabel })
          .waitFor({ timeout: 30_000 })
        await ui.waitForText(page, persisted.declared_topic)
        const reportDownload = page.waitForEvent('download')
        await ui.click(page, strings.report.export.saveAriaLabel, {
          exact: true,
        })
        const downloadedReport = await reportDownload
        const savedReport = path.join(lab.workdir, `${name}-report.md`)
        await downloadedReport.saveAs(savedReport)
        assert.ok(
          readFileSync(savedReport, 'utf8').includes(persisted.declared_topic),
          'offline report export contains the actual session topic'
        )
        const auditDownload = page.waitForEvent('download')
        await ui.click(page, strings.report.export.auditAriaLabel, {
          exact: true,
        })
        const downloadedAudit = await auditDownload
        const savedAudit = path.join(lab.workdir, `${name}-audit.json`)
        await downloadedAudit.saveAs(savedAudit)
        assert.deepEqual(
          JSON.parse(readFileSync(savedAudit, 'utf8')),
          saved.auditEvents,
          'offline raw audit export preserves the exact signed host journal rows'
        )
        assert.deepEqual(errors, [])
        assert.deepEqual(browserEgress, [])
        assert.deepEqual(lab.egressAttempts(), [])
        assert.equal(host.backend.unhandled.size, 0)
        assert.equal(friend.backend.unhandled.size, 0)
        t.diagnostic(
          `Covers production browser UI, actual Rust TLS/auth/websocket/static serving, real encoded camera relay both ways, desktop device release, notes/timer, cached host-loss reload and note delivery after reconnect, stable-origin host restart and fresh password, and durable Leave report handoff with offline downloads.${name === 'chromium' ? ' Also verifies outgoing image/view/download, private messages, invitation/topic actions, capture-free text AI, actual microphone PCM, host AI on browser pixels with camera/screen loss and restart, outgoing screen stop/restart, same-cookie tab takeover, and wake-lock API release.' : ''} OS media devices, certificate installation, OS notification delivery and physical iPad remain separate checks.`
        )
      } catch (error) {
        t.diagnostic(error.stack ?? String(error))
        if (page && !page.isClosed()) {
          t.diagnostic(
            JSON.stringify({
              video: await videoEvidence(page),
              media: await mediaState(page),
              workerError: await page.evaluate(
                () => window.__mirrorServiceWorkerError ?? null
              ),
            })
          )
          t.diagnostic(
            (
              await page
                .locator('body')
                .innerText()
                .catch(() => '')
            ).slice(0, 8000)
          )
          await page
            .screenshot({
              path: path.join(lab.workdir, `${name}-failure.png`),
              fullPage: true,
            })
            .catch(() => {})
        }
        const nativeUi = await Promise.allSettled(
          [...lab.machines.values()].map(async (machine) => {
            const nativePage = machine.page()
            const text = await nativePage
              .locator('body')
              .innerText()
              .catch(() => '')
            await nativePage
              .screenshot({
                path: path.join(lab.workdir, `${machine.name}-failure.png`),
                fullPage: true,
              })
              .catch(() => {})
            return { name: machine.name, text: text.slice(0, 8000) }
          })
        )
        t.diagnostic(JSON.stringify({ nativeUi }))
        t.diagnostic(
          JSON.stringify({
            browserErrors: errors,
            calls: [...lab.machines.values()].map((machine) => ({
              name: machine.name,
              unhandled: [...machine.backend.unhandled],
              lastCalls: machine.backend.calls.slice(-8).map((call) => ({
                ...call,
                args: JSON.stringify(call.args).slice(0, 500),
              })),
              logs: machine.backend.logLines(12),
            })),
          })
        )
        throw error
      } finally {
        driver?.resume()
        await context?.close()
        await browser?.close()
        await driver?.close()
        await lab.down()
      }
    }
  )
}
