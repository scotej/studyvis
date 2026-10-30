import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withComponentBrowser } from './component-browser.mjs'

const source = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { MicToggleButton } from '@/components/MicToggleButton'
import { subscribeMicrophone } from '@/features/session/microphone'
import { __setPttScheduler, MAX_HOLD_MS, usePttStore } from '@/stores/pttStore'
import '@/design/index.css'

const context = new AudioContext()
const oscillator = context.createOscillator()
const destination = context.createMediaStreamDestination()
oscillator.connect(destination)
oscillator.start()
const stream = destination.stream
const track = stream.getAudioTracks()[0]
const updates = []
let deadline
__setPttScheduler({
  setTimeout: (handler, delay) => {deadline = {handler, delay}; return 1},
  clearTimeout: () => {deadline = null},
})
const unsubscribe = subscribeMicrophone(() => stream, (update) => updates.push(update))

function snapshot() {
  const state = usePttStore.getState()
  return {enabled: track.enabled, hotMic: state.hotMic, active: state.active}
}

function App() {
  const hotMic = usePttStore((state) => state.hotMic)
  return <MicToggleButton enabled={hotMic} shortcutLabel="Ctrl+\\\\" onToggle={() => {
    usePttStore.getState().toggleHotMic()
    window.fixture.lastToggle = snapshot()
  }} />
}
flushSync(() => createRoot(document.getElementById('root')).render(<App />))
window.fixture = {
  updates,
  snapshot,
  press: () => {usePttStore.getState().press('native-shortcut'); return snapshot()},
  release: () => {usePttStore.getState().release('native-shortcut'); return snapshot()},
  expireHold: () => {
    if(deadline?.delay !== MAX_HOLD_MS) throw new Error('Missing 120-second PTT safety timer')
    deadline.handler()
    return snapshot()
  },
  reset: () => {usePttStore.getState().reset(); return snapshot()},
  close: async () => {
    unsubscribe()
    usePttStore.getState().reset()
    stream.getTracks().forEach((track) => track.stop())
    oscillator.stop()
    await context.close()
  },
}
`

test('background PTT gates real microphone tracks synchronously and always-on resets muted', async () => {
  await withComponentBrowser(source, async (page) => {
    assert.deepEqual(await page.evaluate(() => window.fixture.snapshot()), {
      enabled: false,
      hotMic: false,
      active: false,
    })
    const foreground = await page.context().browser().newPage()
    await foreground.goto('about:blank')
    await foreground.bringToFront()
    assert.equal(
      await page.evaluate(() => window.fixture.press().enabled),
      true
    )
    assert.equal(
      await page.evaluate(() => window.fixture.release().enabled),
      false
    )

    await page.bringToFront()
    await page.locator('button[aria-pressed="false"]').click()
    assert.equal(
      await page.evaluate(() => window.fixture.lastToggle.enabled),
      true
    )
    await foreground.bringToFront()
    await page.evaluate(() => window.fixture.press())
    assert.deepEqual(await page.evaluate(() => window.fixture.expireHold()), {
      enabled: true,
      hotMic: true,
      active: false,
    })
    assert.equal(
      await page.evaluate(() => window.fixture.release().enabled),
      true
    )

    await page.bringToFront()
    await page.locator('button[aria-pressed="true"]').click()
    assert.equal(
      await page.evaluate(() => window.fixture.lastToggle.enabled),
      false
    )
    await page.locator('button[aria-pressed="false"]').click()
    assert.deepEqual(await page.evaluate(() => window.fixture.reset()), {
      enabled: false,
      hotMic: false,
      active: false,
    })
    await page.evaluate(() => window.fixture.close())
    await foreground.close()
  })
})
