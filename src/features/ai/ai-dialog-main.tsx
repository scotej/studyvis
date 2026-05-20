import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import '@/design/index.css'

import { ApplyReduceMotion } from '@/design/reduce-motion'
import {
  AiDialogWindow,
  type AiDialogRuntime,
} from '@/features/ai/AiDialogWindow'

// V2-P7 — Standalone React root for the floating Ctrl+] window. The Rust
// `toggle_ai_dialog` command points the new window at `/ai-dialog.html`
// which loads this module. Lives in `features/ai/` so the dialog-only
// imports never get pulled into the main bundle.
//
// Production runtime wires the Tauri JS APIs directly. Tests + Storybook
// inject their own runtime into `<AiDialogWindow runtime={...} />`.
//
// Listening: webview-targeted events (the `emitTo('ai-dialog', ...)`
// payloads the main window sends back, and the `tauri://blur` window
// event) are NOT received by the global `listen()` API by default — per
// Tauri 2 docs, global listeners only see catch-all events. We use
// `getCurrentWindow().listen()` so the dialog window receives every
// event addressed to its webview, including built-in window events.
const dialogWindow = getCurrentWindow()
const liveRuntime: AiDialogRuntime = {
  listen: (event, handler) =>
    dialogWindow.listen(event, (e) => handler(e.payload as never)),
  emit: async (event, payload) => {
    await emit(event, payload)
  },
  close: async () => {
    try {
      await dialogWindow.close()
    } catch (err) {
      console.warn('[ai-dialog] close failed:', err)
    }
  },
  now: () => Date.now(),
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApplyReduceMotion />
    <AiDialogWindow runtime={liveRuntime} />
  </StrictMode>
)
