import { useState, type ReactNode } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router'

import { TitleBar } from '@/components/TitleBar'
import { Toaster } from '@/components/ui/sonner'
import { ApplyReduceMotion } from '@/design/reduce-motion'
import { ThemeProvider } from '@/design/theme'
import {
  PomodoroNotifyListener,
  PttListener,
  QuitConfirmListener,
} from '@/features/system'
import { Home } from '@/routes/Home'
import { StyleGuide } from '@/routes/StyleGuide'
import { readWindowStyleBootCache } from '@/stores/settingsStore'

const isDev = import.meta.env.DEV

// V3-P6 — The custom titlebar is mounted only when the user opted in
// AND Rust has actually applied the decoration / title-bar-style change
// (which happens during `setup()` at process boot). We freeze the value
// at first render: a mid-process toggle writes to disk but doesn't flip
// the TitleBar visibility, because Rust has not had the chance to change
// the OS chrome yet — rendering the TitleBar over the still-native
// decoration would create a double titlebar. The setting row triggers a
// process relaunch instead, and the next process reads the cache here.
function ChromeAwareShell({ children }: { children: ReactNode }) {
  const [bootedStyle] = useState(readWindowStyleBootCache)
  if (bootedStyle !== 'custom') {
    // Native chrome — keep the original mount unchanged so any route
    // component that relies on `min-h-screen` etc. behaves identically
    // to the v1.0.3 shipped layout.
    return <>{children}</>
  }
  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  )
}

function App() {
  return (
    <ThemeProvider>
      <ApplyReduceMotion />
      <PttListener />
      <QuitConfirmListener />
      <PomodoroNotifyListener />
      <BrowserRouter>
        <ChromeAwareShell>
          <Routes>
            <Route path="/" element={<Home />} />
            {isDev ? <Route path="/style" element={<StyleGuide />} /> : null}
          </Routes>
        </ChromeAwareShell>
        <Toaster position="bottom-right" />
      </BrowserRouter>
    </ThemeProvider>
  )
}

export default App
