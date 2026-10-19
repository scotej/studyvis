function live(tracks, kind) {
  return (
    tracks?.some(
      (track) => track.kind === kind && track.readyState === 'live'
    ) === true
  )
}

export function evaluateProbe(report) {
  const browser = report.browserEvents ?? []
  const desktop = report.desktopEvents ?? []
  const rows = (kind) => browser.filter((event) => event.kind === kind)
  const runtime = rows('runtime').at(-1)?.data
  const video = (events, label) =>
    events.some(
      (event) =>
        event.kind === 'video' &&
        event.data.label === label &&
        event.data.nonblack === true &&
        event.data.decodedFrames >= 2 &&
        event.data.distinctFrames >= 2 &&
        event.data.width > 0 &&
        event.data.height > 0 &&
        live(event.data.tracks, 'video')
    )
  const display = rows('display-result').filter(
    (event) => event.data.mode === 'capture'
  )
  const captured = display.filter(
    (event) =>
      event.data.outcome === 'live_track' &&
      event.data.activation?.trusted === true &&
      event.data.activation?.active === true &&
      live(event.data.tracks, 'video') &&
      video(browser, `local-screen-${event.data.id}`)
  )
  const reconnect = rows('socket-open').find(
    (event) => event.data.reason === 'reconnect'
  )
  const hidden = rows('lifecycle').find(
    (event) =>
      event.data.event === 'visibilitychange' &&
      event.data.visibility === 'hidden'
  )
  const shown =
    hidden &&
    rows('lifecycle').find(
      (event) =>
        event.receivedAtMs > hidden.receivedAtMs &&
        event.data.event === 'visibilitychange' &&
        event.data.visibility === 'visible'
    )
  const progressedHidden = (label) => {
    if (!hidden || !shown || shown.receivedAtMs - hidden.receivedAtMs < 1500)
      return false
    const frames = desktop.filter(
      (event) =>
        event.kind === 'video' &&
        event.data.label === label &&
        event.receivedAtMs > hidden.receivedAtMs &&
        event.receivedAtMs < shown.receivedAtMs &&
        live(event.data.tracks, 'video') &&
        event.data.nonblack === true
    )
    return (
      frames.length >= 2 &&
      frames.at(-1).data.decodedFrames > frames[0].data.decodedFrames
    )
  }
  const checks = {
    xcode27AndIpadSimulator:
      report.platform === 'darwin' &&
      report.xcodeMajor === 27 &&
      report.sdkMajor === 27 &&
      report.simulator?.runtimeMajor === 27 &&
      report.simulator?.deviceType?.includes('iPad') === true,
    uiTestSucceeded: report.xcodeTestExit === 0,
    nativeSdkSymbolCompiled:
      report.nativeScreenCaptureKitSymbolCompile === true,
    trustedHttps:
      report.trustedHttps === true && runtime?.secureContext === true,
    actualSimulatorSafari:
      runtime?.browser === 'Simulator Safari' &&
      /Version\/27(?:\.|\s)/.test(runtime?.userAgent ?? '') &&
      /Safari\//.test(runtime?.userAgent ?? '') &&
      runtime?.maxTouchPoints > 0,
    gesturePermissionDenial: rows('display-result').some(
      (event) =>
        event.data.mode === 'deny' &&
        event.data.outcome === 'permission_denied' &&
        event.data.activation?.trusted === true &&
        event.data.activation?.active === true
    ),
    displayFramesBeforeAndAfterReconnect:
      captured.length >= 2 &&
      captured.at(-1).data.id > captured[0].data.id &&
      captured[0].receivedAtMs < reconnect?.receivedAtMs &&
      captured.at(-1).receivedAtMs > reconnect?.receivedAtMs,
    wholeDisplaySurface:
      captured.length >= 2 &&
      captured.every((event) =>
        event.data.tracks.some(
          (track) =>
            track.kind === 'video' &&
            track.settings?.displaySurface === 'monitor'
        )
      ),
    productionPeerDesktopDecode: video(desktop, 'received-screen'),
    productionPeerSafariDecode: video(browser, 'host-pattern'),
    cameraAndMicrophone:
      rows('camera-result').some(
        (event) =>
          event.data.outcome === 'live_track' &&
          live(event.data.tracks, 'video') &&
          live(event.data.tracks, 'audio')
      ) &&
      video(desktop, 'received-camera') &&
      desktop.some(
        (event) =>
          event.kind === 'audio' &&
          event.data.label === 'received-microphone' &&
          event.data.peakRms > 0.001 &&
          live(event.data.tracks, 'audio')
      ),
    cameraRetainedWhenScreenStops: rows('screen-stopped').some(
      (event) =>
        live(event.data.camera, 'video') && live(event.data.camera, 'audio')
    ),
    systemCaptureEnded: rows('display-ended').some((event) =>
      event.data.tracks?.some(
        (track) => track.kind === 'video' && track.readyState === 'ended'
      )
    ),
    realWssTakeoverAndReconnect:
      rows('socket-open').length >= 3 &&
      rows('host-ack').length >= 3 &&
      (report.connectionEvents ?? []).filter((event) => event.connected)
        .length >= 3 &&
      rows('socket-close').some((event) => event.data.code === 4001),
    reconnectRequiresNewCapture:
      ['takeover', 'reconnect'].every((reason) =>
        rows('socket-open').some(
          (event) =>
            event.data.reason === reason &&
            event.data.camera?.length === 0 &&
            event.data.screen?.length === 0
        )
      ) &&
      ['takeover', 'reconnect'].every((reason) =>
        rows('released').some(
          (event) =>
            event.data.reason === reason &&
            event.data.consentReset === true &&
            event.data.stopped?.every((track) => track.readyState === 'ended')
        )
      ),
    orientationObserved: rows('lifecycle').some(
      (event) => event.data.orientation?.width > event.data.orientation?.height
    ),
    backgroundDisplayAndCameraFrames:
      progressedHidden('received-screen') &&
      progressedHidden('received-camera'),
    noRuntimeErrors:
      ![...browser, ...desktop].some((event) =>
        [
          'page-error',
          'transport-error',
          'frame-error',
          'peer-failure',
          'socket-error',
          'play-error',
        ].includes(event.kind)
      ) && (report.errors ?? []).length === 0,
    completedDiagnostic: rows('complete').length === 1,
  }
  return {
    diagnosticComplete: checks.completedDiagnostic && checks.uiTestSucceeded,
    simulatorScreenSharingAccepted: Object.values(checks).every(
      (value) => value === true
    ),
    issue365Accepted: false,
    checks,
    missingEvidence: Object.keys(checks).filter((key) => !checks[key]),
    physicalAcceptance:
      'not_run: no physical iPad or Mac is available; Simulator evidence does not prove device capture, installation, LAN trust, multitasking or notifications',
    evidenceScope: {
      browser:
        'Actual MobileSafari in an owned iPad Simulator; not WKWebView or desktop WebKit emulation',
      transport:
        'Production Rust mirror TLS/auth/WSS and production MirrorCodec/createMirrorPeer; test-only capture controls and event collector',
      desktopPattern:
        'Generated test canvas sent only from the desktop receiver; never substituted for Safari getDisplayMedia',
      productUi:
        'not exercised: this capability fixture does not establish full companion app parity',
    },
  }
}
