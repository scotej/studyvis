import assert from 'node:assert/strict'
import { test } from 'node:test'

import { withComponentBrowser } from './component-browser.mjs'

const source = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { MemoryRouter } from 'react-router'
import { Toaster } from 'sonner'
import { ThemeProvider } from '@/design/theme'
import { SessionView } from '@/features/session/SessionView'
import { generateIdentity, signMessage } from '@/lib/crypto/identity'
import { bytesToHex } from '@/lib/encoding'
import { useIdentityStore } from '@/stores/identityStore'
import { useSessionStore } from '@/stores/sessionStore'
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'
import '@/design/index.css'

const now = Date.now()
Date.now = () => now
const person = generateIdentity()
const callbacks = new Map(), listeners = new Map()
let next = 1, leaves = 0
Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: {unregisterListener: (_event, id) => listeners.delete(id)},
  __TAURI_INTERNALS__: {
    metadata: {currentWindow: {label: 'main'}, currentWebview: {label: 'main'}},
    transformCallback: fn => {const id = next++; callbacks.set(id, fn); return id},
    unregisterCallback: id => callbacks.delete(id),
    invoke: async (command, args = {}) => {
      if(command === 'plugin:event|listen') {const id = next++; listeners.set(id, args); return id}
      if(command === 'plugin:event|unlisten') {listeners.delete(args.eventId); return}
      if(command === 'friends_list' || command === 'plugin:window|available_monitors') return []
      if(command === 'plugin:window|is_focused' || command === 'plugin:window|is_visible') return true
      if(command === 'identity_sign') return Array.from(signMessage(person.edPriv, new Uint8Array(args.message)))
      if(command === 'plugin:store|load') return 1
      if(command === 'mirror_start') return {
        urls: [], password: 'synthetic', fingerprint: 'synthetic fingerprint',
        certificateUrl: 'https://127.0.0.1/certificate', expiresAt: Date.now() + 600000,
        generation: 'synthetic',
      }
      return null
    },
  },
})
await new Promise(resolve => setTimeout(resolve, 0))
useIdentityStore.setState({status: 'ready', identity: {
  version: 1, ed_pubkey_hex: bytesToHex(person.edPub), x_pubkey_hex: bytesToHex(person.xPub),
  display_name: 'Synthetic Escape participant', created_at: 1, mnemonic_fingerprint: 'synthetic',
}})
useSettingsStore.setState({status: 'ready', error: null, values: {
  ...DEFAULT_SETTINGS, autoUpdateEnabled: false, aiFeaturesEnabled: false, sessionTimelineEnabled: false,
}})
const canvas = document.createElement('canvas')
canvas.width = canvas.height = 32
canvas.getContext('2d').fillRect(0, 0, 32, 32)
Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
  value: async () => canvas.captureStream(1), configurable: true,
})
const room = {
  selfId: 'escape-self', getPeers: () => ({}),
  onPeerJoin: () => () => {}, onPeerLeave: () => () => {}, onPeerStream: () => () => {},
  addStream: () => {}, removeStream: () => {}, leave: async () => {},
  makeAction: () => ({receive: () => {}, send: async () => {}}),
}
useSessionStore.getState().reset()
useSessionStore.getState().begin({room, sessionTopic: 'e'.repeat(64), sessionPassword: 'synthetic',
  isHost: true, startedAt: Date.now(), startedAtMono: performance.now(),
  leave: async () => {leaves++; useSessionStore.getState().markEnded()},
})
function App() {
  const active = useSessionStore(state => state.status === 'active')
  return <MemoryRouter><ThemeProvider><Toaster />{active ? <SessionView /> : <div>Ended</div>}</ThemeProvider></MemoryRouter>
}
const root = createRoot(document.getElementById('root'))
flushSync(() => root.render(<App />))
window.fixture = {
  copy: {open: strings.mirror.open, title: strings.mirror.title, hint: strings.session.escLeaveHint, start: strings.mirror.start, fingerprint: strings.mirror.fingerprint},
  snapshot: () => ({status: useSessionStore.getState().status, leaves}),
  stop: () => flushSync(() => root.unmount()),
}
`

async function openMirror(page, copy) {
  const trigger = page.getByRole('button', { name: copy.open, exact: true })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('dialog', { name: copy.title, exact: true }).waitFor()
}

async function closeMirror(page, copy) {
  await page.keyboard.press('Escape')
  await page
    .getByRole('dialog', { name: copy.title, exact: true })
    .waitFor({ state: 'hidden' })
}

test('closing session dialogs with Escape twice does not arm or leave the session', async () => {
  await withComponentBrowser(source, async (page) => {
    const copy = await page.evaluate(() => window.fixture.copy)
    for (let iteration = 0; iteration < 2; iteration++) {
      await openMirror(page, copy)
      await closeMirror(page, copy)
      assert.deepEqual(await page.evaluate(() => window.fixture.snapshot()), {
        status: 'active',
        leaves: 0,
      })
      assert.equal(await page.getByText(copy.hint, { exact: true }).count(), 0)
    }
    await page.evaluate(() => window.fixture.stop())
  })
})

test('dialog Escape clears an earlier leave warning and deliberate double Escape still leaves', async () => {
  await withComponentBrowser(source, async (page) => {
    const copy = await page.evaluate(() => window.fixture.copy)
    await page.keyboard.press('Escape')
    await page.getByText(copy.hint, { exact: true }).waitFor()
    await openMirror(page, copy)
    await closeMirror(page, copy)
    await page
      .getByText(copy.hint, { exact: true })
      .waitFor({ state: 'hidden' })
    await page.keyboard.press('Escape')
    assert.deepEqual(await page.evaluate(() => window.fixture.snapshot()), {
      status: 'active',
      leaves: 0,
    })
    await page.getByText(copy.hint, { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => window.fixture.snapshot().status === 'ended'
    )
    assert.equal(await page.evaluate(() => window.fixture.snapshot().leaves), 1)
    await page.evaluate(() => window.fixture.stop())
  })
})

test('input-focused dialog Escape clears an earlier leave warning', async () => {
  await withComponentBrowser(source, async (page) => {
    const copy = await page.evaluate(() => window.fixture.copy)
    await page.keyboard.press('Escape')
    await page.getByText(copy.hint, { exact: true }).waitFor()
    await openMirror(page, copy)
    const start = page.getByRole('button', { name: copy.start, exact: true })
    await start.focus()
    await page.keyboard.press('Enter')
    const fingerprint = page.getByLabel(copy.fingerprint, { exact: true })
    await fingerprint.waitFor()
    await fingerprint.focus()
    assert.equal(
      await fingerprint.evaluate(
        (element) => element === document.activeElement
      ),
      true
    )
    await closeMirror(page, copy)
    await page
      .getByText(copy.hint, { exact: true })
      .waitFor({ state: 'hidden' })
    await page.keyboard.press('Escape')
    assert.deepEqual(await page.evaluate(() => window.fixture.snapshot()), {
      status: 'active',
      leaves: 0,
    })
    await page.getByText(copy.hint, { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => window.fixture.snapshot().status === 'ended'
    )
    assert.equal(await page.evaluate(() => window.fixture.snapshot().leaves), 1)
    await page.evaluate(() => window.fixture.stop())
  })
})
