import { StrictMode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import '@/design/index.css'
import App from '@/App'
import { installLogSink, logger } from '@/lib/log'
import { canCreatePeerConnectionOffer } from '@/lib/webrtcRuntime'
import {
  resolveWindowStyleAtBoot,
  useSettingsStore,
} from '@/stores/settingsStore'

// #98 — before the first render, so a crash during boot is already recorded.
// The debug gate is passed as a closure rather than a value because it is read
// per record: flipping Settings → Advanced → Debug log takes effect on the next
// line rather than at the next launch.
installLogSink({
  window: 'main',
  appVersion: __APP_VERSION__,
  debugEnabled: () => useSettingsStore.getState().values.debugLogEnabled,
})

const isTauriRuntime =
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

// Linux WebKitGTK has independent compile-time and WebView-preference WebRTC
// gates. A process remaining alive is therefore not a startup proof: the first
// StudyVis document can render while every Trystero room fails with an absent
// or inert RTCPeerConnection. Record a machine-verifiable data-channel offer
// attestation before any app effect can join a room. Packaged Linux CI requires
// this exact record.
if (
  isTauriRuntime &&
  typeof navigator !== 'undefined' &&
  /\bLinux\b/i.test(navigator.userAgent)
) {
  const webRtcLog = logger.child('runtime.webrtc')
  let timeoutId: number | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timeoutId = window.setTimeout(() => resolve(false), 10_000)
  })
  void Promise.race([
    canCreatePeerConnectionOffer(globalThis.RTCPeerConnection),
    timeout,
  ]).then((ready) => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    if (ready) webRtcLog.info('ready')
    else webRtcLog.error('missing')
  })
}

async function renderApp(): Promise<void> {
  const bootedWindowStyle = await resolveWindowStyleAtBoot(
    isTauriRuntime
      ? () => invoke<boolean>('system_window_style_is_custom_applied')
      : null
  )
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App bootedWindowStyle={bootedWindowStyle} />
    </StrictMode>
  )
}

void renderApp()
