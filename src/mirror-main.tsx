import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import '@/design/index.css'

import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Toaster } from '@/components/ui/sonner'
import { ApplyReduceMotion } from '@/design/reduce-motion'
import { ThemeProvider } from '@/design/theme'
import { createBrowserConnection } from '@/features/mirror/browserConnection'
import { MirrorSession } from '@/features/mirror/MirrorSession'
import { useSettingsStore } from '@/stores/settingsStore'

// The browser has no native settings store; follow this device's appearance.
useSettingsStore.setState((state) => ({
  status: 'ready',
  values: { ...state.values, theme: 'auto' },
}))
const connection = createBrowserConnection()

createRoot(document.getElementById('root')!).render(
  <ThemeProvider defaultMode="auto">
    <ApplyReduceMotion />
    <ErrorBoundary surface="mirror">
      <MirrorSession connection={connection} />
    </ErrorBoundary>
    <Toaster position="bottom-right" />
  </ThemeProvider>
)

if (
  import.meta.env.PROD &&
  window.isSecureContext &&
  'serviceWorker' in navigator
) {
  void navigator.serviceWorker.register('/mirror-sw.js').catch(() => {
    // Trusted HTTPS is required for offline caching; the live UI still works.
  })
}
