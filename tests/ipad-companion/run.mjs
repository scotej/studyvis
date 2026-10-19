import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { get } from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright-core'
import { build } from 'vite'

import { MirrorFixtureDriver } from '../../lab/src/backend/mirrorDriver.ts'
import { evaluateProbe } from './verdict.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const here = path.join(root, 'tests/ipad-companion')
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--output')) {
  process.stderr.write(
    'usage: bash scripts/check-ipad-companion.sh [--output NEW_DIRECTORY]\n'
  )
  process.exit(2)
}
const output = path.resolve(
  args[1] ?? path.join(root, 'lab/.work', `ipad-companion-${randomUUID()}`)
)
await mkdir(path.dirname(output), { recursive: true })
await mkdir(output)
const report = {
  schema: 1,
  startedAt: new Date().toISOString(),
  platform: process.platform,
  nodeVersion: process.version,
  runner: {
    imageOS: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
  },
  browserEvents: [],
  desktopEvents: [],
  connectionEvents: [],
  commands: [],
  errors: [],
  sourceSha256: {},
}
const secrets = new Set()
const scrub = (value) => {
  let text = String(value)
  for (const secret of secrets) text = text.replaceAll(secret, '<redacted>')
  return text
}
let privateDirectory
let fixture
let browser
let simulatorId
let sequence = 0
let currentClient = null
let peerEpoch = 0
let chain = Promise.resolve()
const abort = new AbortController()
const onSignal = () => abort.abort(new Error('Probe interrupted'))
process.once('SIGTERM', onSignal)
process.once('SIGINT', onSignal)
const deadline = setTimeout(
  () => abort.abort(new Error('Probe exceeded 30 minute deadline')),
  30 * 60_000
)

async function command(
  executable,
  argv,
  {
    timeout = 120_000,
    required = true,
    cleanup = false,
    sensitive = false,
  } = {}
) {
  const number = ++sequence
  const name = `${String(number).padStart(2, '0')}-${path.basename(executable)}.log`
  const log = createWriteStream(path.join(output, name))
  const record = {
    executable,
    args: argv.map(scrub),
    log: name,
    exitCode: null,
  }
  report.commands.push(record)
  let stdout = ''
  let stderr = ''
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(executable, argv, {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
      let killed = false
      let forceTimer
      const kill = () => {
        killed = true
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          /* Owned process already exited. */
        }
        forceTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            /* Owned process already exited. */
          }
        }, 5000)
      }
      const timer = setTimeout(kill, timeout)
      if (!cleanup) {
        abort.signal.addEventListener('abort', kill, { once: true })
        if (abort.signal.aborted) kill()
      }
      child.stdout.on('data', (chunk) => {
        const text = sensitive
          ? '[sensitive command output omitted]\n'
          : scrub(chunk.toString())
        stdout = (stdout + text).slice(-4 * 1024 * 1024)
        log.write(text)
      })
      child.stderr.on('data', (chunk) => {
        const text = sensitive
          ? '[sensitive command output omitted]\n'
          : scrub(chunk.toString())
        stderr = (stderr + text).slice(-8000)
        log.write(text)
      })
      const finish = () => {
        clearTimeout(timer)
        clearTimeout(forceTimer)
        abort.signal.removeEventListener('abort', kill)
      }
      child.once('error', (error) => {
        finish()
        reject(error)
      })
      child.once('close', (code) => {
        finish()
        if (killed)
          reject(new Error(`${executable} timed out or was interrupted`))
        else resolve(code)
      })
    })
    record.exitCode = code
    if (required && code !== 0)
      throw new Error(`${executable} failed (${code}); see ${name}: ${stderr}`)
    return { code, stdout, stderr }
  } finally {
    await new Promise((resolve) => log.end(resolve))
  }
}

function collect(target, event) {
  if (target.length >= 10_000) throw new Error('Probe evidence budget exceeded')
  target.push({ ...event, receivedAtMs: Date.now() })
}

async function trustedGet(url, ca) {
  return new Promise((resolve, reject) => {
    const request = get(url, { ca }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        text = (text + chunk).slice(-100_000)
      })
      response.on('error', reject)
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          authorized: response.socket.authorized,
          text,
        })
      )
    })
    request.on('error', reject)
    request.setTimeout(10_000, () =>
      request.destroy(new Error('Trusted HTTPS timed out'))
    )
  })
}

async function runProbe() {
  assert.equal(
    process.platform,
    'darwin',
    'Xcode and Simulator require a macOS runner; Linux execution is not iPad evidence'
  )
  assert.equal(
    Number(process.versions.node.split('.')[0]),
    24,
    'Use the repository Node 24 toolchain'
  )
  const xcode = await command('xcodebuild', ['-version'])
  report.xcodeVersion = xcode.stdout.trim()
  report.xcodeMajor = Number(/Xcode (\d+)/.exec(xcode.stdout)?.[1])
  assert.equal(report.xcodeMajor, 27, 'The selected Xcode must be version 27')
  await command('sw_vers', [])
  await command('xcodebuild', ['-showsdks'])
  const sdk = await command('xcrun', [
    '--sdk',
    'iphonesimulator',
    '--show-sdk-version',
  ])
  report.sdkVersion = sdk.stdout.trim()
  report.sdkMajor = Number(sdk.stdout.split('.')[0])
  assert.equal(
    report.sdkMajor,
    27,
    'An installed iOS Simulator 27 SDK is required'
  )
  for (const subcommand of ['create', 'bootstatus', 'keychain', 'openurl'])
    await command('xcrun', ['simctl', 'help', subcommand])
  const runtimeList = await command('xcrun', [
    'simctl',
    'list',
    'runtimes',
    '--json',
  ])
  const deviceList = await command('xcrun', [
    'simctl',
    'list',
    'devices',
    '--json',
  ])
  const typeList = await command('xcrun', [
    'simctl',
    'list',
    'devicetypes',
    '--json',
  ])
  const runtimes = JSON.parse(runtimeList.stdout)
    .runtimes.filter(
      (item) =>
        item.isAvailable === true &&
        item.identifier.startsWith('com.apple.CoreSimulator.SimRuntime.iOS-27-')
    )
    .sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }))
  assert.ok(runtimes.length, 'No available iOS 27 Simulator runtime')
  const runtime = runtimes[0]
  const types = JSON.parse(typeList.stdout).devicetypes
  const installed =
    JSON.parse(deviceList.stdout).devices[runtime.identifier] ?? []
  const existing = installed.find(
    (item) => item.isAvailable && item.name.startsWith('iPad')
  )
  const deviceType =
    types.find((item) => item.identifier === existing?.deviceTypeIdentifier) ??
    types.find(
      (item) =>
        item.name.startsWith('iPad Pro') && item.productFamily === 'iPad'
    )
  assert.ok(
    deviceType?.identifier.includes('iPad'),
    'No installed iPad Simulator device type'
  )
  report.simulator = {
    runtime: runtime.identifier,
    runtimeVersion: runtime.version,
    runtimeBuild: runtime.buildversion,
    runtimeMajor: 27,
    deviceType: deviceType.identifier,
  }
  const created = await command('xcrun', [
    'simctl',
    'create',
    `StudyVis probe ${randomUUID()}`,
    deviceType.identifier,
    runtime.identifier,
  ])
  simulatorId = created.stdout.trim()
  assert.match(simulatorId, /^[A-F0-9-]{36}$/i)
  report.simulator.udid = simulatorId
  await command('xcrun', ['simctl', 'boot', simulatorId])
  await command('xcrun', ['simctl', 'bootstatus', simulatorId, '-b'], {
    timeout: 240_000,
  })
  privateDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'studyvis-ipad-probe-')
  )
  const assets = path.join(privateDirectory, 'assets')
  const modules = path.join(assets, 'assets')
  const certificates = path.join(privateDirectory, 'certificates')
  await mkdir(modules, { recursive: true })
  await copyFile(
    path.join(here, 'probe.html'),
    path.join(assets, 'mirror.html')
  )
  await copyFile(path.join(here, 'probe.mjs'), path.join(modules, 'probe.js'))
  await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      emptyOutDir: false,
      outDir: modules,
      lib: {
        entry: path.join(here, 'transport.mjs'),
        formats: ['es'],
        fileName: () => 'transport.js',
      },
    },
  })
  await command(
    'cargo',
    [
      'build',
      '--locked',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--example',
      'mirror_fixture',
    ],
    { timeout: 20 * 60_000 }
  )
  const executable = path.join(
    process.env.CARGO_TARGET_DIR ?? path.join(root, 'src-tauri/target'),
    'debug/examples/mirror_fixture'
  )
  let page
  fixture = new MirrorFixtureDriver({
    certificateDir: certificates,
    assetsDir: assets,
    executable,
    emit(event, payload) {
      chain = chain
        .then(async () => {
          if (event === 'mirror:client') {
            collect(report.connectionEvents, {
              connected: payload.connected,
              connection: createHash('sha256')
                .update(payload.clientId)
                .digest('hex')
                .slice(0, 12),
            })
            return
          }
          if (event !== 'mirror:message') return
          const data = JSON.parse(payload.data)
          if (data.type === 'ipad-probe') {
            collect(report.browserEvents, data)
          } else if (data.type === 'ready') {
            currentClient = payload.clientId
            const epoch = ++peerEpoch
            await fixture.invoke('mirror_send', {
              clientId: currentClient,
              data: 'ipad-probe:ack',
            })
            await page.evaluate(
              (epoch) =>
                window.ipadProbeHost.start((data) =>
                  window.ipadHostSend({ epoch, data })
                ),
              epoch
            )
          } else {
            await page.evaluate(
              (data) => window.ipadProbeHost.receive(data),
              payload.data
            )
          }
        })
        .catch((error) => {
          report.errors.push(scrub(error.stack ?? error))
        })
    },
  })
  const config = await fixture.invoke('mirror_start', {
    requestId: 'ipad-probe-owned',
  })
  secrets.add(config.password)
  const url = config.urls.find(
    (value) => new URL(value).hostname === '127.0.0.1'
  )
  assert.ok(url, 'The owned mirror fixture must advertise loopback')
  const rootDer = await readFile(path.join(certificates, 'root.crt'))
  assert.equal(
    createHash('sha256').update(rootDer).digest('hex'),
    config.fingerprint.replaceAll(':', '')
  )
  const ca = new X509Certificate(rootDer)
  const trusted = await trustedGet(url, ca.toString())
  assert.equal(trusted.status, 200)
  assert.equal(trusted.authorized, true)
  assert.match(trusted.text, /StudyVis iPad Safari probe/)
  report.trustedHttps = true
  report.certificateFingerprint = config.fingerprint
  await copyFile(
    path.join(certificates, 'root.crt'),
    path.join(output, 'fixture-public-root.cer')
  )
  await command('xcrun', [
    'simctl',
    'keychain',
    simulatorId,
    'add-root-cert',
    path.join(certificates, 'root.crt'),
  ])
  const leaf = new X509Certificate(
    Buffer.from(
      JSON.parse(await readFile(path.join(certificates, 'server.json'), 'utf8'))
        .certificate
    )
  )
  const spki = createHash('sha256')
    .update(leaf.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64')
  browser = await chromium.launch({
    args: [
      `--ignore-certificate-errors-spki-list=${spki}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
  report.desktopBrowser = {
    name: 'locked Playwright Chromium',
    version: browser.version(),
    fixtureLeafSpkiException: true,
    fakeSafariDisplayTrack: false,
  }
  page = await browser.newPage()
  page.on('pageerror', (error) =>
    report.errors.push(scrub(`Desktop receiver: ${error.message}`))
  )
  await page.exposeFunction('ipadHostSend', async ({ epoch, data }) => {
    if (epoch !== peerEpoch || !currentClient) return
    await fixture.invoke('mirror_send', { clientId: currentClient, data })
  })
  await page.exposeFunction('ipadHostEvidence', (event) =>
    collect(report.desktopEvents, event)
  )
  await page.goto(`${url}/mirror.html?role=host`)
  await page.waitForFunction(() => window.ipadProbeHost)
  const project = path.join(here, 'Probe.xcodeproj')
  const common = [
    '-project',
    project,
    '-scheme',
    'Probe',
    '-destination',
    `platform=iOS Simulator,id=${simulatorId}`,
    '-derivedDataPath',
    path.join(privateDirectory, 'DerivedData'),
    '-parallel-testing-enabled',
    'NO',
    'CODE_SIGNING_ALLOWED=NO',
  ]
  await command('xcodebuild', ['build-for-testing', ...common], {
    timeout: 10 * 60_000,
  })
  report.nativeScreenCaptureKitSymbolCompile = true
  await command(
    'xcrun',
    [
      'simctl',
      'openurl',
      simulatorId,
      `${url}/mirror.html#password=${encodeURIComponent(config.password)}`,
    ],
    { sensitive: true }
  )
  const test = await command(
    'xcodebuild',
    [
      'test-without-building',
      ...common,
      '-resultBundlePath',
      path.join(output, 'SafariProbe.xcresult'),
    ],
    { timeout: 10 * 60_000, required: false }
  )
  report.xcodeTestExit = test.code
  await chain
  await page.screenshot({
    path: path.join(output, 'desktop-receiver.png'),
    fullPage: true,
  })
  await command(
    'xcrun',
    [
      'simctl',
      'io',
      simulatorId,
      'screenshot',
      path.join(output, 'simulator-final.png'),
    ],
    { required: false }
  )
}

try {
  for (const file of [
    'scripts/check-ipad-companion.sh',
    'tests/ipad-companion/run.mjs',
    'tests/ipad-companion/probe.mjs',
    'tests/ipad-companion/probe.html',
    'tests/ipad-companion/transport.mjs',
    'tests/ipad-companion/verdict.mjs',
    'tests/ipad-companion/ProbeHarness/ProbeHarness.swift',
    'tests/ipad-companion/SafariProbeTests/SafariProbeTests.swift',
    'tests/ipad-companion/Probe.xcodeproj/project.pbxproj',
    'tests/ipad-companion/Probe.xcodeproj/xcshareddata/xcschemes/Probe.xcscheme',
    'src/features/mirror/peer.ts',
    'src/features/mirror/wire.ts',
    'src-tauri/src/mirror.rs',
    'src-tauri/examples/mirror_fixture.rs',
    'src-tauri/Cargo.lock',
    'package-lock.json',
  ])
    report.sourceSha256[file] = createHash('sha256')
      .update(await readFile(path.join(root, file)))
      .digest('hex')
  await runProbe()
} catch (error) {
  report.errors.push(scrub(error.stack ?? error))
} finally {
  clearTimeout(deadline)
  await browser?.close().catch((error) => report.errors.push(scrub(error)))
  await fixture?.close().catch((error) => report.errors.push(scrub(error)))
  if (simulatorId) {
    for (const operation of ['shutdown', 'delete']) {
      try {
        const result = await command(
          'xcrun',
          ['simctl', operation, simulatorId],
          { timeout: 60_000, required: false, cleanup: true }
        )
        if (result.code !== 0)
          report.errors.push(`Owned Simulator ${operation} failed`)
      } catch (error) {
        report.errors.push(scrub(error))
      }
    }
  }
  if (privateDirectory)
    await rm(privateDirectory, { recursive: true, force: true }).catch(
      (error) => report.errors.push(scrub(error))
    )
  for (const [file, expected] of Object.entries(report.sourceSha256)) {
    try {
      const actual = createHash('sha256')
        .update(await readFile(path.join(root, file)))
        .digest('hex')
      if (actual !== expected)
        report.errors.push(`Source changed during probe: ${file}`)
    } catch (error) {
      report.errors.push(scrub(error))
    }
  }
  report.finishedAt = new Date().toISOString()
  report.verdict = evaluateProbe(report)
  await writeFile(
    path.join(output, 'result.json'),
    `${JSON.stringify(report, null, 2)}\n`
  )
  process.stdout.write(`iPad Safari evidence: ${output}\n`)
  process.stdout.write(
    `Diagnostic complete: ${report.verdict.diagnosticComplete}; Simulator screen-sharing accepted: ${report.verdict.simulatorScreenSharingAccepted}\n`
  )
  if (report.verdict.missingEvidence.length)
    process.stdout.write(
      `Missing evidence: ${report.verdict.missingEvidence.join(', ')}\n`
    )
  process.exitCode = report.verdict.simulatorScreenSharingAccepted ? 0 : 1
}
