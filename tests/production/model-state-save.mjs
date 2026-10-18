import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { build } from 'vite'

test('failed model selection/removal saves remain visible and recoverable (#424)', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const fixture = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { Toaster } from 'sonner'
    import { ModelPickerContainer } from '@/features/ai/ModelPickerContainer'
    import { __setDownloadRuntime } from '@/features/ai/download'
    import { __setHfTokenRuntime } from '@/features/ai/hfToken'
    import { SUPPORTED_MODELS } from '@/features/ai/models'
    import { __setModelStoreDeps, useModelStore } from '@/features/ai/modelStore'
    import { useSettingsStore } from '@/stores/settingsStore'
    import { useSessionStore } from '@/stores/sessionStore'
    let fail = true
    let disk = { records: Object.fromEntries(SUPPORTED_MODELS.map(spec => [spec.id, { modelId: spec.id, installedAt: 1, benchmark: null }])), active_model_id: SUPPORTED_MODELS[1].id }
    let pending = structuredClone(disk)
    const installed = new Set(SUPPORTED_MODELS.map(spec => spec.id))
    const store = {
      get: async key => structuredClone(disk[key]), set: async (key, value) => { pending[key] = structuredClone(value) }, delete: async () => false,
      save: async () => { if (fail) throw new Error('Synthetic models.json write denied'); disk = structuredClone(pending) },
    }
    __setModelStoreDeps({ storeFactory: () => store })
    useSessionStore.setState({ status: 'idle' })
    useSettingsStore.setState(s => ({ status: 'ready', values: { ...s.values, aiFeaturesEnabled: false } }))
    useModelStore.setState({ status: 'ready', activeModelId: disk.active_model_id, records: structuredClone(disk.records), error: null })
    __setHfTokenRuntime({ present: async () => false, save: async () => {}, clear: async () => {} })
    __setDownloadRuntime({
      paths: async id => ({ dir: '/' + id, model_path: '/' + id + '/model.gguf', mmproj_path: '/' + id + '/mmproj.gguf' }),
      installState: async id => ({ model: { exists: installed.has(id), size: 123 }, mmproj: { exists: installed.has(id), size: 123 } }),
      subscribeProgress: async () => () => {}, headCheck: async () => ({ status: 200, content_length: null }), startDownload: async () => {}, cancelDownload: async () => {},
      remove: async id => { installed.delete(id) },
    })
    let root
    function render() { root = createRoot(document.getElementById('root')); root.render(React.createElement(React.Fragment, null, React.createElement(Toaster), React.createElement(ModelPickerContainer))) }
    Object.assign(window, {
      snapshot: () => ({ active: useModelStore.getState().activeModelId, records: structuredClone(useModelStore.getState().records), error: useModelStore.getState().error, disk: structuredClone(disk), installed: [...installed] }),
      allowSave: () => { fail = false },
      restart: async () => { root.unmount(); pending = structuredClone(disk); useModelStore.setState({ status: 'loading', records: {}, activeModelId: null, error: null }); await useModelStore.getState().hydrate(); render() },
    })
    render()
  `
  const result = await build({
    root,
    logLevel: 'error',
    plugins: [
      {
        name: 'model-state-save-check',
        resolveId(id) {
          if (id === 'model-state-save-check') return '\0model-state-save-check'
        },
        load(id) {
          if (id === '\0model-state-save-check') return fixture
        },
      },
    ],
    build: {
      write: false,
      rollupOptions: {
        input: 'model-state-save-check',
        preserveEntrySignatures: 'strict',
      },
    },
  })
  const output = (Array.isArray(result) ? result[0] : result).output
  const entry = output.find((item) => item.type === 'chunk' && item.isEntry)
  assert.ok(entry)
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.LAB_CHROME_EXECUTABLE
      ? { executablePath: process.env.LAB_CHROME_EXECUTABLE }
      : {}),
  })
  try {
    for (const mode of ['select', 'remove', 'remove-active']) {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('http://studyvis.test/**', (route) => {
        const filename = new URL(route.request().url()).pathname.slice(1)
        if (!filename)
          return route.fulfill({
            contentType: 'text/html',
            body: '<div id="root"></div>',
          })
        const asset = output.find((item) => item.fileName === filename)
        return route.fulfill(
          asset
            ? {
                contentType:
                  asset.type === 'chunk'
                    ? 'text/javascript'
                    : 'application/octet-stream',
                body:
                  asset.type === 'chunk'
                    ? asset.code
                    : Buffer.from(asset.source),
              }
            : { status: 404 }
        )
      })
      await page.goto('http://studyvis.test/')
      await page.evaluate(
        (entryFile) => import('/' + entryFile),
        entry.fileName
      )
      const cards = page.locator('[data-slot="model-card"]')
      if (mode === 'select')
        await cards
          .first()
          .getByRole('button', { name: 'Use model', exact: true })
          .click()
      else
        await cards
          .nth(mode === 'remove-active' ? 1 : 0)
          .getByRole('button', { name: /Remove/ })
          .click()
      await page
        .getByRole('alert')
        .filter({ hasText: "Couldn't save model setup" })
        .waitFor()
      assert.equal(
        await page.locator('[data-sonner-toast][data-type="success"]').count(),
        0,
        mode
      )
      let snapshot = await page.evaluate(() => window.snapshot())
      assert.equal(snapshot.disk.active_model_id, 'qwen2_5-vl-3b')
      if (mode !== 'select') {
        const id = mode === 'remove-active' ? 'qwen2_5-vl-3b' : 'moondream2'
        assert.ok(!snapshot.installed.includes(id))
        await page.evaluate(() => window.restart())
        await page
          .getByRole('alert')
          .filter({ hasText: "Couldn't save model setup" })
          .waitFor()
        snapshot = await page.evaluate(() => window.snapshot())
        assert.equal(snapshot.records[id].installedAt, null)
        if (mode === 'remove-active') assert.equal(snapshot.active, null)
      }
      await page.evaluate(() => window.allowSave())
      await page
        .getByRole('button', { name: 'Retry saving', exact: true })
        .click()
      await page.waitForFunction(() => window.snapshot().error === null)
      snapshot = await page.evaluate(() => window.snapshot())
      assert.equal(snapshot.disk.active_model_id, snapshot.active)
      await page.evaluate(() => window.restart())
      assert.equal(
        (await page.evaluate(() => window.snapshot())).active,
        snapshot.active
      )
      assert.deepEqual(errors, [], mode)
      await page.close()
    }
  } finally {
    await browser.close()
  }
})
