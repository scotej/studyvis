import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { MirrorFixtureDriver } from '../../lab/src/backend/mirrorDriver.ts'
import {
  inviteAndAccept,
  onboard,
  pairViaContactCard,
} from '../../lab/src/flows.ts'
import { Lab } from '../../lab/src/lab.ts'
import * as ui from '../../lab/src/ui.ts'
import { strings } from '../../src/strings.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const chromeExecutable =
  process.env.LAB_CHROME_EXECUTABLE ?? chromium.executablePath()
function observeCapture() {
  window.__appCapture = { camera: [], screen: [] }
  window.__appSocketCloses = []
  const close = WebSocket.prototype.close
  WebSocket.prototype.close = function (...args) {
    const observation = { socket: this, at: performance.now(), closedAt: null }
    window.__appSocketCloses.push(observation)
    this.addEventListener(
      'close',
      () => {
        observation.closedAt = performance.now()
      },
      { once: true }
    )
    return close.apply(this, args)
  }
  for (const [method, kind] of [
    ['getUserMedia', 'camera'],
    ['getDisplayMedia', 'screen'],
  ]) {
    const original = navigator.mediaDevices[method].bind(navigator.mediaDevices)
    navigator.mediaDevices[method] = async (...args) => {
      const stream = await original(...args)
      window.__appCapture[kind].push(stream)
      return stream
    }
  }
}
const captureState = (page) =>
  page.evaluate(() => ({
    camera: window.__appCapture.camera.length,
    screen: window.__appCapture.screen.length,
    live: [...window.__appCapture.camera, ...window.__appCapture.screen]
      .flatMap((stream) => stream.getTracks())
      .filter((track) => track.readyState === 'live').length,
  }))
async function trusted(url, certificateDir) {
  const ca = new X509Certificate(
    readFileSync(path.join(certificateDir, 'root.crt'))
  ).toString()
  await new Promise((resolve, reject) => {
    const request = httpsGet(url, { ca }, (response) => {
      const authorized = response.socket.authorized
      response.resume()
      response.on('end', () => {
        try {
          assert.equal(response.statusCode, 200)
          assert.equal(authorized, true)
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
    request.setTimeout(5000, () =>
      request.destroy(new Error('trusted app listener timeout'))
    )
  })
}

test(
  'app companion uses real desktop Home guards across Leave, report, Home, rejoin and a later activation',
  { timeout: 180_000 },
  async () => {
    const lab = await Lab.up({ chromeExecutable })
    let driver
    let browser
    let companion
    let step = 'desktop setup'
    const errors = []
    try {
      const host = await lab.addMachine({ name: 'app-owner' })
      const friend = await lab.addMachine({ name: 'app-friend' })
      const desktop = host.page()
      await desktop.evaluate(observeCapture)
      const certificateDir = path.join(lab.workdir, 'app-certificate')
      driver = new MirrorFixtureDriver({
        certificateDir,
        assetsDir: path.join(root, 'dist'),
        executable: process.env.MIRROR_FIXTURE_BIN,
        emit: (event, payload) => {
          void host.emit(event, payload)
        },
      })
      host.backend.attachMirrorDriver(driver)
      await Promise.all([
        onboard(host, { displayName: 'Alice' }),
        onboard(friend, { displayName: 'Bob' }),
      ])
      await pairViaContactCard(host, friend)
      await ui.click(desktop, strings.mirror.app.open)
      await desktop
        .getByRole('switch', { name: strings.mirror.app.consent })
        .check()
      await ui.click(desktop, strings.mirror.start)
      const password = await desktop
        .getByLabel(strings.mirror.password)
        .inputValue()
      const url = await desktop
        .getByLabel(strings.mirror.link, { exact: true })
        .first()
        .inputValue()
      await trusted(url, certificateDir)
      await desktop.keyboard.press('Escape')
      const certificate = new X509Certificate(
        Buffer.from(
          JSON.parse(
            readFileSync(path.join(certificateDir, 'server.json'), 'utf8')
          ).certificate
        )
      )
      const key = createHash('sha256')
        .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
        .digest('base64')
      browser = await chromium.launch({
        executablePath: chromeExecutable,
        headless: true,
        args: [
          `--ignore-certificate-errors-spki-list=${key}`,
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--autoplay-policy=no-user-gesture-required',
          '--disable-features=WebRtcHideLocalIpsWithMdns',
        ],
      })
      const context = await browser.newContext({
        permissions: ['camera', 'microphone'],
        viewport: { width: 1280, height: 800 },
      })
      await context.addInitScript({
        content: `(${observeCapture.toString()})();`,
      })
      const page = (companion = await context.newPage())
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(url)
      await page.getByLabel(strings.mirror.password).fill(password)
      await ui.click(page, strings.mirror.pair)
      await page
        .getByRole('heading', { name: strings.mirror.app.home, exact: true })
        .waitFor()
      await page.getByText('Bob', { exact: true }).waitFor()
      assert.deepEqual(await captureState(page), {
        camera: 0,
        screen: 0,
        live: 0,
      })
      assert.deepEqual(await captureState(desktop), {
        camera: 0,
        screen: 0,
        live: 0,
      })
      const starts = () =>
        host.backend.calls.filter((call) => call.cmd === 'mirror_start')
      assert.equal(starts().length, 1)
      assert.equal(starts()[0].args.scope, 'app')
      const invite = async () => {
        await ui.click(page, strings.mirror.app.invite)
        await ui.waitForText(page, 'Study session', 20_000)
        await ui.waitForText(friend.page(), 'invites you to study', 20_000)
        await ui.click(friend.page(), 'Accept the invite from Alice')
        await ui.waitForText(friend.page(), 'Study session', 20_000)
      }
      step = 'first remote invitation'
      await invite()
      const activation = () =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem('studyvis.mirror.snapshot.v1'))
              .sessionId
        )
      const firstActivation = await activation()
      assert.deepEqual(await captureState(desktop), {
        camera: 0,
        screen: 0,
        live: 0,
      })
      assert.equal(
        (await captureState(page)).live,
        0,
        'session mount does not acquire browser media without a fresh gesture'
      )
      await ui.click(page, strings.mirror.enableMedia)
      await page.waitForFunction(() =>
        window.__appCapture.camera.some((stream) =>
          stream.getTracks().some((track) => track.readyState === 'live')
        )
      )
      driver.suspend()
      step = 'transport outage'
      await page
        .getByText(strings.mirror.disconnected, { exact: true })
        .waitFor({ timeout: 35_000 })
      await page.waitForFunction(() =>
        window.__appCapture.camera.every((stream) =>
          stream.getTracks().every((track) => track.readyState === 'ended')
        )
      )
      assert.deepEqual(
        await captureState(desktop),
        { camera: 0, screen: 0, live: 0 },
        'transport outage cannot restore desktop capture'
      )
      driver.resume()
      await page
        .getByRole('button', { name: strings.session.leaveCta, exact: true })
        .waitFor({ state: 'visible', timeout: 20_000 })
      await page
        .getByText(strings.mirror.disconnected, { exact: true })
        .waitFor({ state: 'hidden', timeout: 20_000 })
      await ui.click(page, strings.session.leaveCta)
      await page
        .getByRole('main', { name: strings.report.ariaLabel })
        .waitFor({ timeout: 20_000 })
      await page.waitForFunction(() =>
        [...window.__appCapture.camera, ...window.__appCapture.screen].every(
          (stream) =>
            stream.getTracks().every((track) => track.readyState === 'ended')
        )
      )
      step = 'same-topic rejoin'
      await page
        .getByRole('main', { name: strings.report.ariaLabel })
        .getByRole('button', { name: strings.mirror.app.home, exact: true })
        .click()
      await page
        .getByRole('heading', { name: strings.mirror.app.home, exact: true })
        .waitFor()
      await ui.click(page, strings.mirror.app.rejoin)
      await ui.waitForText(page, 'Study session', 20_000)
      const secondActivation = await activation()
      assert.notEqual(secondActivation, firstActivation)
      assert.equal(
        (await captureState(page)).live,
        0,
        'same-topic rejoin retires all earlier media consent'
      )
      await ui.click(page, strings.session.leaveCta)
      await page
        .getByRole('main', { name: strings.report.ariaLabel })
        .waitFor({ timeout: 20_000 })
      step = 'saved report transport outage'
      const savedReport = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('studyvis.mirror.report.v1'))
      )
      assert.ok(savedReport?.session.id)
      driver.suspend()
      await page
        .getByText(strings.mirror.savedReport, { exact: true })
        .waitFor({ timeout: 35_000 })
      await page.getByRole('main', { name: strings.report.ariaLabel }).waitFor()
      driver.resume()
      await page
        .getByText(strings.mirror.savedReport, { exact: true })
        .waitFor({ state: 'hidden', timeout: 20_000 })
      await page.getByRole('main', { name: strings.report.ariaLabel }).waitFor()
      assert.equal(
        await page.evaluate(
          () =>
            JSON.parse(localStorage.getItem('studyvis.mirror.report.v1'))
              ?.session.id
        ),
        savedReport.session.id,
        'automatic app reconnect preserves the completed report'
      )
      await page
        .getByRole('main', { name: strings.report.ariaLabel })
        .getByRole('button', { name: strings.mirror.app.home, exact: true })
        .click()
      await ui.click(friend.page(), strings.session.leaveCta)
      await friend
        .page()
        .getByRole('main', { name: strings.report.ariaLabel })
        .waitFor({ timeout: 20_000 })
      await page
        .getByRole('heading', { name: strings.mirror.app.home, exact: true })
        .waitFor()
      step = 'later remote invitation'
      await invite()
      assert.notEqual(await activation(), secondActivation)
      assert.equal(
        starts().length,
        1,
        'Home, rejoin and later session retain the original app listener'
      )
      assert.deepEqual(
        await captureState(desktop),
        { camera: 0, screen: 0, live: 0 },
        'app ownership never falls back to desktop capture'
      )
      assert.equal(
        (await captureState(page)).live,
        0,
        'later activation requires its own capture gesture'
      )
      await trusted(url, certificateDir)
      step = 'remote accept from Home'
      await ui.click(page, strings.session.leaveCta)
      await page
        .getByRole('main', { name: strings.report.ariaLabel })
        .waitFor({ timeout: 20_000 })
      await page
        .getByRole('main', { name: strings.report.ariaLabel })
        .getByRole('button', { name: strings.mirror.app.home, exact: true })
        .click()
      await ui.click(friend.page(), strings.session.leaveCta)
      const friendReport = friend
        .page()
        .getByRole('main', { name: strings.report.ariaLabel })
      await friendReport.waitFor({ timeout: 20_000 })
      await friendReport
        .getByRole('button', {
          name: strings.common.actions.close,
          exact: true,
        })
        .click()
      await ui.click(friend.page(), 'Invite Alice')
      await page
        .getByRole('button', { name: strings.mirror.app.accept, exact: true })
        .waitFor({ timeout: 20_000 })
      await ui.click(page, strings.mirror.app.accept)
      await ui.waitForText(page, 'Study session', 20_000)
      assert.equal(starts().length, 1)
      assert.equal((await captureState(page)).live, 0)
      assert.deepEqual(await captureState(desktop), {
        camera: 0,
        screen: 0,
        live: 0,
      })
      step = 'explicit stop'
      await ui.click(desktop, strings.mirror.app.open)
      await ui.click(desktop, strings.mirror.stop)
      await page
        .getByText(strings.mirror.app.disconnected, { exact: true })
        .waitFor({ timeout: 10_000 })
        .catch(async () => {
          await page
            .getByText(strings.mirror.disconnected, { exact: true })
            .waitFor({ timeout: 10_000 })
        })
      assert.deepEqual(errors, [])
      assert.equal(host.backend.unhandled.size, 0)
      assert.equal(friend.backend.unhandled.size, 0)
      console.log(
        JSON.stringify({
          appHomeLifecycle: 'passed',
          realRustTLS: true,
          hostFallbackCaptures: 0,
          retainedListenerStarts: starts().length,
          limitations: [
            'Native end-session fixture callbacks and physical device/certificate installation remain separate acceptance.',
          ],
        })
      )
    } catch (error) {
      console.error(
        JSON.stringify({
          failedStep: step,
          labWorkdir: lab.workdir,
          browserErrors: errors,
          error: error.stack ?? String(error),
          socketCloses: companion
            ? await companion
                .evaluate(() =>
                  window.__appSocketCloses.map((row) => ({
                    ageMs: performance.now() - row.at,
                    readyState: row.socket.readyState,
                    closedAt: row.closedAt,
                  }))
                )
                .catch(() => [])
            : [],
        })
      )
      if (companion)
        await companion
          .screenshot({
            path: path.join(lab.workdir, 'mirror-app-failure.png'),
            fullPage: true,
          })
          .catch(() => {})
      throw error
    } finally {
      await browser?.close()
      await driver?.close()
      await lab.down()
    }
  }
)

test(
  'released session mirroring can yield to explicit app access and Stop restores desktop capture',
  { timeout: 90_000 },
  async () => {
    const lab = await Lab.up({ chromeExecutable })
    let driver
    try {
      const host = await lab.addMachine({ name: 'legacy-to-app-host' })
      const friend = await lab.addMachine({ name: 'legacy-to-app-friend' })
      const desktop = host.page()
      await desktop.evaluate(observeCapture)
      const certificateDir = path.join(lab.workdir, 'legacy-to-app-certificate')
      driver = new MirrorFixtureDriver({
        certificateDir,
        assetsDir: path.join(root, 'dist'),
        executable: process.env.MIRROR_FIXTURE_BIN,
        emit: (event, payload) => {
          void host.emit(event, payload)
        },
      })
      host.backend.attachMirrorDriver(driver)
      await Promise.all([
        onboard(host, { displayName: 'Alice' }),
        onboard(friend, { displayName: 'Bob' }),
      ])
      await pairViaContactCard(host, friend)
      await inviteAndAccept(host, friend, 'Bob', 'Alice')
      await desktop.waitForFunction(() =>
        window.__appCapture.camera.some((stream) =>
          stream.getTracks().some((track) => track.readyState === 'live')
        )
      )
      await ui.click(desktop, strings.mirror.open)
      await ui.click(desktop, strings.mirror.start)
      await desktop.waitForFunction(() =>
        window.__appCapture.camera.every((stream) =>
          stream.getTracks().every((track) => track.readyState === 'ended')
        )
      )
      await desktop.keyboard.press('Escape')
      await ui.click(desktop, strings.mirror.app.open)
      await desktop
        .getByRole('switch', { name: strings.mirror.app.consent })
        .check()
      await ui.click(desktop, strings.mirror.start)
      const url = await desktop
        .getByLabel(strings.mirror.link, { exact: true })
        .first()
        .inputValue()
      await trusted(url, certificateDir)
      const starts = host.backend.calls.filter(
        (call) => call.cmd === 'mirror_start'
      )
      assert.equal(starts.length, 2)
      assert.equal(starts[0].args.scope, undefined)
      assert.equal(starts[1].args.scope, 'app')
      await ui.click(desktop, strings.mirror.stop)
      await desktop.keyboard.press('Escape')
      await desktop.waitForFunction(
        () =>
          window.__appCapture.camera.some((stream) =>
            stream.getTracks().some((track) => track.readyState === 'live')
          ),
        undefined,
        { timeout: 10_000 }
      )
      assert.equal(host.backend.unhandled.size, 0)
      console.log(
        JSON.stringify({
          legacyToAppOwnership: 'passed',
          releasedDefaultScope: 'session',
          explicitStopRestoresDesktop: true,
        })
      )
    } catch (error) {
      console.error(error.stack ?? String(error))
      throw error
    } finally {
      await driver?.close()
      await lab.down()
    }
  }
)
