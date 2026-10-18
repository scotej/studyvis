import assert from 'node:assert/strict'
import { test } from 'node:test'

import { withComponentBrowser } from './component-browser.mjs'

const source = `
  import React from 'react'
  import { createRoot } from 'react-dom/client'
  import { AiCategory } from '@/features/settings/categories/AiCategory'
  import { __setEngineRuntime, readEngineInfo, getAiPlatformSupported } from '@/features/ai/engine'
  import { __setHfTokenRuntime } from '@/features/ai/hfToken'
  import { __setDownloadRuntime } from '@/features/ai/download'
  import { __setScreenCaptureRuntime, discardPendingScreenStream } from '@/features/ai/captureScreen'
  import { __setSidecarRuntime, useSidecarStore } from '@/features/ai/sidecar'
  import { useModelStore } from '@/features/ai/modelStore'
  import { __setSettingsStoreDeps, useSettingsStore } from '@/stores/settingsStore'
  import { useSessionStore } from '@/stores/sessionStore'
  import '@/design/index.css'

  const traces = []
  let settleInfo
  const engineInfo = supported => ({ supported, support_error: supported ? null : 'macos_ai_requires_14',
    installed: true, source: 'bundled', version: 'fixture', installing: false, last_error: null,
    devices: [], device_error: null, hardware_identity: { selection: 'auto', topology: [] } })
  const pendingRuntime = () => __setEngineRuntime({
    info: () => new Promise(resolve => { settleInfo = resolve }),
    install: async () => {}, subscribeProgress: async () => () => {},
  })
  pendingRuntime()
  const disk = { ai_features_enabled: false }
  __setSettingsStoreDeps({ storeFactory: () => ({
    get: async key => disk[key], set: async (key, value) => { traces.push(['write', key, value]); disk[key] = value },
    save: async () => {},
  }), runtime: {
    pushAiFeaturesEnabled: async value => traces.push(['native-flag', value]),
    pushMinimizeToTray: async () => {}, setGlobalShortcut: async () => {}, relaunchApp: async () => {},
  } })
  useSettingsStore.setState(state => ({ status: 'ready', values: { ...state.values, aiFeaturesEnabled: false } }))
  useSessionStore.setState({ status: 'active' })
  const id = 'qwen2_5-vl-3b'
  useModelStore.setState({ status: 'ready', activeModelId: id,
    records: { [id]: { modelId: id, installedAt: 123, benchmark: null } }, hydrate: async () => {} })
  __setHfTokenRuntime({ present: async () => false, save: async () => {}, clear: async () => {} })
  __setDownloadRuntime({
    paths: async id => ({ dir: '/' + id, model_path: '/' + id + '/model.gguf', mmproj_path: '/' + id + '/projector.gguf' }),
    installState: async () => ({ model: { exists: true, size: 1 }, mmproj: { exists: true, size: 1 } }),
    subscribeProgress: async () => () => {}, headCheck: async () => ({ status: 200, content_length: 1 }),
    startDownload: async () => {}, cancelDownload: async () => {}, remove: async () => {},
  })
  __setSidecarRuntime({
    start: async () => { traces.push(['engine-start']); throw new Error('unexpected engine start') },
    stop: async () => traces.push(['stop']), status: async () => ({ running: false, port: null, errored: false }),
    fetchHealth: async () => true, setInterval: () => 0, clearInterval: () => {},
    getAiFeaturesEnabled: () => useSettingsStore.getState().values.aiFeaturesEnabled,
    getEngineAutoInstall: () => false,
  })
  useSidecarStore.setState({ status: 'idle', port: null, lastError: null })
  __setScreenCaptureRuntime({ getDisplayMedia: async () => {
    traces.push(['capture', navigator.userActivation.isActive])
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16
    return canvas.captureStream()
  } })
  window.fixture = {
    waiting: () => Boolean(settleInfo),
    resolve: supported => settleInfo(engineInfo(supported)),
    replace: supported => {
      __setEngineRuntime({ info: async () => engineInfo(supported), install: async () => {}, subscribeProgress: async () => () => {} })
      return readEngineInfo()
    },
    storedOn: () => { disk.ai_features_enabled = true; useSettingsStore.setState(state => ({ values: { ...state.values, aiFeaturesEnabled: true } })) },
    snapshot: () => ({ traces: [...traces], supported: getAiPlatformSupported(),
      saved: disk.ai_features_enabled, enabled: useSettingsStore.getState().values.aiFeaturesEnabled }),
    dispose: discardPendingScreenStream,
  }
  createRoot(document.getElementById('root')).render(React.createElement(AiCategory))
`

test('Settings waits for support and preserves an unsupported stored ON preference until explicit off', async () => {
  await withComponentBrowser(source, async (page) => {
    const toggle = page.getByRole('switch', {
      name: 'Enable AI features',
      exact: true,
    })
    await toggle.waitFor()
    await page.waitForFunction(() => window.fixture.waiting())
    assert.equal(await toggle.isDisabled(), true)
    assert.deepEqual(
      (await page.evaluate(() => window.fixture.snapshot())).traces,
      []
    )
    await page.evaluate(() => {
      window.fixture.storedOn()
      window.fixture.resolve(false)
    })
    await page
      .getByText(
        'Local AI requires macOS 14 or later. You can still study with friends without AI.',
        { exact: true }
      )
      .waitFor()
    await page
      .getByText(
        'AI is off on this computer. Your saved preference is kept; you can still turn it off.',
        { exact: true }
      )
      .waitFor()
    assert.equal(await toggle.isEnabled(), true)
    const before = await page.evaluate(() => window.fixture.snapshot())
    assert.equal(before.enabled, true)
    assert.equal(before.saved, true)
    assert.deepEqual(before.traces, [])
    await toggle.click()
    await page.waitForFunction(() => window.fixture.snapshot().saved === false)
    const after = await page.evaluate(() => window.fixture.snapshot())
    assert.equal(after.enabled, false)
    assert.equal(
      after.traces.some(
        ([kind]) => kind === 'capture' || kind === 'engine-start'
      ),
      false
    )
  })
})

test('an open benchmark warning cannot enable AI after support becomes unavailable', async () => {
  await withComponentBrowser(source, async (page) => {
    const toggle = page.getByRole('switch', {
      name: 'Enable AI features',
      exact: true,
    })
    await toggle.waitFor()
    await page.waitForFunction(() => window.fixture.waiting())
    await page.evaluate(() => window.fixture.resolve(true))
    await page.waitForFunction(() => window.fixture.snapshot().supported)
    await toggle.click()
    const confirmation = page.getByRole('button', {
      name: 'Turn on anyway',
      exact: true,
    })
    await confirmation.waitFor()
    await page.evaluate(() => window.fixture.replace(false))
    await page.waitForFunction(() => !window.fixture.snapshot().supported)
    assert.equal(await confirmation.isDisabled(), true)
    const state = await page.evaluate(() => window.fixture.snapshot())
    assert.equal(state.saved, false)
    assert.equal(state.enabled, false)
    assert.deepEqual(state.traces, [])
  })
})

test('supported confirmation acquires capture during the click before saving the preference', async () => {
  await withComponentBrowser(source, async (page) => {
    const toggle = page.getByRole('switch', {
      name: 'Enable AI features',
      exact: true,
    })
    await toggle.waitFor()
    await page.waitForFunction(() => window.fixture.waiting())
    await page.evaluate(() => window.fixture.resolve(true))
    await page.waitForFunction(() => window.fixture.snapshot().supported)
    await toggle.click()
    await page
      .getByRole('button', { name: 'Turn on anyway', exact: true })
      .click()
    await page.waitForFunction(() => window.fixture.snapshot().saved)
    const state = await page.evaluate(() => window.fixture.snapshot())
    assert.deepEqual(state.traces[0], ['capture', true])
    assert.equal(state.traces.findIndex(([kind]) => kind === 'write') > 0, true)
    await page.evaluate(() => window.fixture.dispose())
  })
})
