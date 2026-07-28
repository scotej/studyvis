import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import '@/design/index.css'
import App from '@/App'
import { installLogSink } from '@/lib/log'
import { useSettingsStore } from '@/stores/settingsStore'

// #98 — before the first render, so a crash during boot is already recorded.
// The debug gate is passed as a closure rather than a value because it is read
// per record: flipping Settings → Advanced → Debug log takes effect on the next
// line rather than at the next launch.
installLogSink({
  window: 'main',
  appVersion: __APP_VERSION__,
  debugEnabled: () => useSettingsStore.getState().values.debugLogEnabled,
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
