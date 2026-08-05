import { StrictMode, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { emit, type Event } from '@tauri-apps/api/event'
import { getCurrentWindow, Window } from '@tauri-apps/api/window'
import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import '@/design/index.css'

import { ApplyReduceMotion } from '@/design/reduce-motion'

import {
  SessionOverlayWindow,
  type SessionOverlayRuntime,
} from './SessionOverlayWindow'

const overlayWindow = getCurrentWindow()
const runtime: SessionOverlayRuntime = {
  listen: (event, handler) =>
    overlayWindow.listen(event, (message: Event<unknown>) =>
      handler(message.payload as never)
    ),
  emit: async (event, payload) => {
    await emit(event, payload)
  },
  close: async () => {
    await overlayWindow.close().catch(() => {})
  },
}

void Window.getByLabel('main')
  .then((mainWindow) =>
    mainWindow?.once('tauri://destroyed', () => {
      void runtime.close()
    })
  )
  .catch(() => {})

createRoot(document.getElementById('root')!).render(
  createElement(
    StrictMode,
    null,
    createElement(ApplyReduceMotion),
    createElement(SessionOverlayWindow, { runtime })
  )
)
