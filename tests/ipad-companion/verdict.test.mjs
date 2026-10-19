import assert from 'node:assert/strict'
import { test } from 'node:test'

import { evaluateProbe } from './verdict.mjs'

// Synthetic records test the decision boundary only; they are never runtime evidence.
function completeRecords() {
  const video = {
    kind: 'video',
    readyState: 'live',
    settings: { displaySurface: 'monitor' },
  }
  const audio = { kind: 'audio', readyState: 'live' }
  const ended = { kind: 'video', readyState: 'ended' }
  const activation = { trusted: true, active: true }
  const event = (kind, data, receivedAtMs = 100) => ({
    kind,
    data,
    receivedAtMs,
  })
  const frame = (label, frames = 5, time = 100) =>
    event(
      'video',
      {
        label,
        width: 320,
        height: 180,
        nonblack: true,
        decodedFrames: frames,
        distinctFrames: 3,
        tracks: [video],
      },
      time
    )
  return {
    platform: 'darwin',
    xcodeMajor: 27,
    sdkMajor: 27,
    simulator: {
      runtimeMajor: 27,
      deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro',
    },
    xcodeTestExit: 0,
    nativeScreenCaptureKitSymbolCompile: true,
    trustedHttps: true,
    errors: [],
    connectionEvents: [
      { connected: true },
      { connected: true },
      { connected: true },
    ],
    browserEvents: [
      event('runtime', {
        browser: 'Simulator Safari',
        userAgent: 'Version/27.0 Mobile/Apple Safari/600',
        maxTouchPoints: 5,
        secureContext: true,
      }),
      event('display-result', {
        id: 1,
        mode: 'deny',
        outcome: 'permission_denied',
        activation,
      }),
      event('display-result', {
        id: 2,
        mode: 'capture',
        outcome: 'live_track',
        activation,
        tracks: [video],
      }),
      frame('local-screen-2'),
      event(
        'display-result',
        {
          id: 3,
          mode: 'capture',
          outcome: 'live_track',
          activation,
          tracks: [video],
        },
        5000
      ),
      frame('local-screen-3'),
      frame('host-pattern'),
      event('camera-result', { outcome: 'live_track', tracks: [video, audio] }),
      event('screen-stopped', { camera: [video, audio], tracks: [ended] }),
      event('display-ended', { tracks: [ended] }),
      ...['initial', 'takeover', 'reconnect'].flatMap((reason, i) => [
        event(
          'socket-open',
          { reason, opens: i + 1, camera: [], screen: [] },
          reason === 'reconnect' ? 4500 : 100
        ),
        event('host-ack', { opens: i + 1 }),
        event('released', { reason, consentReset: true, stopped: [ended] }),
      ]),
      event('socket-close', { code: 4001 }),
      event('lifecycle', {
        event: 'orientationchange',
        orientation: { width: 1200, height: 800 },
      }),
      event(
        'lifecycle',
        { event: 'visibilitychange', visibility: 'hidden' },
        1000
      ),
      event(
        'lifecycle',
        { event: 'visibilitychange', visibility: 'visible' },
        4000
      ),
      event('complete', {}),
    ],
    desktopEvents: [
      frame('received-screen'),
      frame('received-camera'),
      event('audio', {
        label: 'received-microphone',
        peakRms: 0.1,
        tracks: [audio],
      }),
      ...['received-screen', 'received-camera'].flatMap((label) => [
        frame(label, 10, 1500),
        frame(label, 20, 2500),
      ]),
    ],
  }
}

test('complete synthetic evidence qualifies only the Simulator gate, never issue #365', () => {
  const result = evaluateProbe(completeRecords())
  assert.equal(result.diagnosticComplete, true)
  assert.equal(result.simulatorScreenSharingAccepted, true)
  assert.equal(result.issue365Accepted, false)
  assert.deepEqual(result.missingEvidence, [])
})

test('unsupported API is a completed diagnostic and a failing capture qualification', () => {
  const report = completeRecords()
  report.browserEvents = report.browserEvents.filter(
    (event) => event.kind !== 'display-result'
  )
  report.browserEvents.push({
    kind: 'display-result',
    data: { mode: 'capture', outcome: 'not_exposed' },
  })
  const result = evaluateProbe(report)
  assert.equal(result.diagnosticComplete, true)
  assert.equal(result.simulatorScreenSharingAccepted, false)
  assert.ok(
    result.missingEvidence.includes('displayFramesBeforeAndAfterReconnect')
  )
})

for (const [label, mutate, missing] of [
  [
    'desktop WebKit emulation',
    (r) => {
      r.browserEvents[0].data.browser = 'desktop Playwright WebKit'
    },
    'actualSimulatorSafari',
  ],
  [
    'a WKWebView',
    (r) => {
      r.browserEvents[0].data.userAgent = 'Mobile AppleWebKit/600'
    },
    'actualSimulatorSafari',
  ],
  [
    'a missing iPad runtime',
    (r) => {
      r.simulator.runtimeMajor = 26
    },
    'xcode27AndIpadSimulator',
  ],
  [
    'an incomplete UI run',
    (r) => {
      r.xcodeTestExit = 65
    },
    'uiTestSucceeded',
  ],
  [
    'untrusted TLS',
    (r) => {
      r.trustedHttps = false
    },
    'trustedHttps',
  ],
  [
    'synthetic click without transient activation',
    (r) => {
      r.browserEvents
        .filter((e) => e.kind === 'display-result')
        .forEach((e) => {
          e.data.activation.active = false
        })
    },
    'displayFramesBeforeAndAfterReconnect',
  ],
  [
    'live track without decoded frames',
    (r) => {
      r.desktopEvents
        .filter((e) => e.kind === 'video')
        .forEach((e) => {
          e.data.decodedFrames = 0
        })
    },
    'productionPeerDesktopDecode',
  ],
  [
    'constant black video',
    (r) => {
      r.browserEvents
        .filter((e) => e.kind === 'video')
        .forEach((e) => {
          e.data.nonblack = false
        })
    },
    'displayFramesBeforeAndAfterReconnect',
  ],
  [
    'unchanging stale frames',
    (r) => {
      r.desktopEvents
        .filter((e) => e.kind === 'video')
        .forEach((e) => {
          e.data.distinctFrames = 1
        })
    },
    'productionPeerDesktopDecode',
  ],
  [
    'silent received microphone',
    (r) => {
      r.desktopEvents.find((e) => e.kind === 'audio').data.peakRms = 0
    },
    'cameraAndMicrophone',
  ],
  [
    'missing system stop',
    (r) => {
      r.browserEvents = r.browserEvents.filter(
        (e) => e.kind !== 'display-ended'
      )
    },
    'systemCaptureEnded',
  ],
  [
    'capture restored without fresh consent',
    (r) => {
      r.browserEvents.find(
        (e) => e.kind === 'socket-open' && e.data.reason === 'reconnect'
      ).data.screen = [{ kind: 'video', readyState: 'live' }]
    },
    'reconnectRequiresNewCapture',
  ],
  [
    'background suspension',
    (r) => {
      r.desktopEvents = r.desktopEvents.filter((e) => e.receivedAtMs < 1000)
    },
    'backgroundDisplayAndCameraFrames',
  ],
  [
    'queued visibility events on foreground',
    (r) => {
      r.browserEvents.find(
        (e) => e.data.visibility === 'visible'
      ).receivedAtMs = 1001
    },
    'backgroundDisplayAndCameraFrames',
  ],
  [
    'unhandled page error',
    (r) => {
      r.browserEvents.push({ kind: 'page-error', data: { message: 'failure' } })
    },
    'noRuntimeErrors',
  ],
]) {
  test(`qualification fails closed for ${label}`, () => {
    const report = completeRecords()
    mutate(report)
    const result = evaluateProbe(report)
    assert.equal(result.simulatorScreenSharingAccepted, false)
    assert.ok(result.missingEvidence.includes(missing))
    assert.equal(result.issue365Accepted, false)
  })
}

test('no data or a harness crash cannot qualify', () => {
  const result = evaluateProbe({})
  assert.equal(result.diagnosticComplete, false)
  assert.equal(result.simulatorScreenSharingAccepted, false)
  assert.equal(result.issue365Accepted, false)
})
