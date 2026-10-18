import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withComponentBrowser } from './component-browser.mjs'

const source = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Toaster } from 'sonner'
import { AiCategory } from '@/features/settings/categories/AiCategory'
import { __setScreenCaptureRuntime } from '@/features/ai/captureScreen'
import { __setEngineRuntime } from '@/features/ai/engine'
import { __setHfTokenRuntime } from '@/features/ai/hfToken'
import { __setDownloadRuntime } from '@/features/ai/download'
import { useModelStore } from '@/features/ai/modelStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSessionStore } from '@/stores/sessionStore'
import '@/design/index.css'
const pending = [], activation = [], tracks = []
__setScreenCaptureRuntime({ getDisplayMedia: () => {
  activation.push(navigator.userActivation.isActive)
  return new Promise((resolve,reject) => pending.push({resolve,reject}))
} })
__setEngineRuntime({ info: async () => ({ supported:false,installed:false,installing:false,last_error:null,devices:[] }),subscribeProgress: async () => () => {} })
__setHfTokenRuntime({ present: async () => false })
__setDownloadRuntime({ installState: async () => ({model:{exists:true,size:1},mmproj:{exists:true,size:1}}),subscribeProgress:async()=>()=>{} })
useModelStore.setState({ status:'ready',activeModelId:'moondream2',records:{moondream2:{modelId:'moondream2',benchmark:null,installedAt:1}} })
useSettingsStore.setState({setAiFeaturesEnabled: async enabled => useSettingsStore.setState(s=>({values:{...s.values,aiFeaturesEnabled:enabled}}))})
const root = createRoot(document.getElementById('root'))
flushSync(() => root.render(<><AiCategory /><Toaster /></>))
window.fixture = {
  settle: (index, outcome) => {
    if (outcome !== 'success') { pending[index].reject(new DOMException('fixture capture failure',outcome === 'denied' ? 'NotAllowedError' : 'NotReadableError')); return }
    const canvas = document.createElement('canvas');canvas.width=canvas.height=16
    const stream=canvas.captureStream(1);tracks.push(...stream.getTracks());pending[index].resolve(stream)
  },
  count: () => pending.length,
  session: active => flushSync(() => useSessionStore.setState({status:active?'active':'idle'})),
  unmount: () => flushSync(() => root.unmount()),
  activation,
  tracks: () => tracks.map(t=>t.readyState),
}
`

async function denyInitial(page) {
  await page
    .getByRole('switch', { name: 'Enable AI features', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Turn on anyway', exact: true })
    .click()
  await page.waitForFunction(() => window.fixture.count() === 1)
  await page.evaluate(() => window.fixture.settle(0, 'denied'))
  await page
    .getByRole('dialog', { name: 'Allow screen recording', exact: true })
    .waitFor()
}

for (const outcome of ['denied', 'error', 'success']) {
  test(`permission retry handles ${outcome} with actionable feedback`, async () => {
    await withComponentBrowser(source, async (page) => {
      await denyInitial(page)
      await page.getByRole('button', { name: 'Try again', exact: true }).click()
      await page.waitForFunction(() => window.fixture.count() === 2)
      assert.equal(
        await page.evaluate(() => window.fixture.activation[1]),
        true
      )
      await page.evaluate((result) => window.fixture.settle(1, result), outcome)
      if (outcome === 'denied') {
        await page
          .getByRole('dialog', { name: 'Allow screen recording', exact: true })
          .waitFor()
        assert.equal(
          await page
            .getByRole('button', { name: 'Try again', exact: true })
            .isEnabled(),
          true
        )
      } else {
        await page.locator('[data-sonner-toast]').waitFor()
        await page.getByRole('dialog').waitFor({ state: 'hidden' })
        if (outcome === 'success') {
          await page
            .getByText('Screen recording granted.', { exact: true })
            .waitFor()
          assert.deepEqual(await page.evaluate(() => window.fixture.tracks()), [
            'ended',
          ])
        }
      }
    })
  })
}

for (const change of ['session', 'unmount']) {
  test(`a delayed retry after ${change} cannot reopen recovery or toast`, async () => {
    await withComponentBrowser(source, async (page) => {
      await denyInitial(page)
      if (change === 'session')
        await page.evaluate(() => window.fixture.session(true))
      await page.getByRole('button', { name: 'Try again', exact: true }).click()
      await page.waitForFunction(() => window.fixture.count() === 2)
      // The retry deliberately closes guidance before capture. Wait for the
      // actual Radix exit so a closing portal is not mistaken for a reopen.
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      if (change === 'session')
        await page.evaluate(() => window.fixture.session(false))
      else await page.evaluate(() => window.fixture.unmount())
      await page.evaluate(() => window.fixture.settle(1, 'denied'))
      await page.waitForTimeout(100)
      assert.equal(await page.getByRole('dialog').count(), 0)
      assert.equal(await page.locator('[data-sonner-toast]').count(), 0)
    })
  })
}
