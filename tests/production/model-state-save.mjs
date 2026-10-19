import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { build } from 'vite'

const ACTIVE_MODEL_ID = 'qwen2_5-vl-3b'
const OTHER_MODEL_ID = 'gemma3-4b'

test('failed model selection/removal saves remain visible and recoverable (#424)', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const fixture = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { Toaster } from 'sonner'
    import { ModelPickerContainer } from '@/features/ai/ModelPickerContainer'
    import { summariseBenchmark } from '@/features/ai/benchmark'
    import { __setDownloadRuntime } from '@/features/ai/download'
    import { __setHfTokenRuntime } from '@/features/ai/hfToken'
    import { SUPPORTED_MODELS } from '@/features/ai/models'
    import { __setModelStoreDeps, useModelStore } from '@/features/ai/modelStore'
    import { useSettingsStore } from '@/stores/settingsStore'
    import { useSessionStore } from '@/stores/sessionStore'
    let fail = true
    let failInspection = false
    let saveAttempts = 0
    let disk = { records: Object.fromEntries(SUPPORTED_MODELS.map(spec => [spec.id, { modelId: spec.id, installedAt: 1, benchmark: null }])), active_model_id: ${JSON.stringify(ACTIVE_MODEL_ID)} }
    disk.records[${JSON.stringify(ACTIVE_MODEL_ID)}].benchmark = summariseBenchmark({ samplesSec: [2, 3, 4], completedAtSec: 99 })
    let pending = structuredClone(disk)
    const installed = new Set(SUPPORTED_MODELS.map(spec => spec.id))
    const store = {
      get: async key => structuredClone(disk[key]), set: async (key, value) => { pending[key] = structuredClone(value) }, delete: async () => false,
      save: async () => { saveAttempts++; if (fail) throw new Error('Synthetic models.json write denied'); disk = structuredClone(pending) },
    }
    __setModelStoreDeps({ storeFactory: () => store })
    useSessionStore.setState({ status: 'idle' })
    useSettingsStore.setState(s => ({ status: 'ready', values: { ...s.values, aiFeaturesEnabled: false } }))
    useModelStore.setState({ status: 'ready', activeModelId: disk.active_model_id, records: structuredClone(disk.records), error: null })
    __setHfTokenRuntime({ present: async () => false, save: async () => {}, clear: async () => {} })
    __setDownloadRuntime({
      paths: async id => ({ dir: '/' + id, model_path: '/' + id + '/model.gguf', mmproj_path: '/' + id + '/mmproj.gguf' }),
      installState: async id => { if (failInspection && id === ${JSON.stringify(ACTIVE_MODEL_ID)}) throw new Error('Synthetic model directory permission denied'); return { model: { exists: installed.has(id), size: 123 }, mmproj: { exists: installed.has(id), size: 123 } } },
      subscribeProgress: async () => () => {}, headCheck: async () => ({ status: 200, content_length: null }), startDownload: async () => {}, cancelDownload: async () => {},
      remove: async id => { installed.delete(id) },
    })
    let root
    function render() { root = createRoot(document.getElementById('root')); root.render(React.createElement(React.Fragment, null, React.createElement(Toaster), React.createElement(ModelPickerContainer))) }
    Object.assign(window, {
      snapshot: () => ({ status: useModelStore.getState().status, saveAttempts, active: useModelStore.getState().activeModelId, records: structuredClone(useModelStore.getState().records), error: useModelStore.getState().error, disk: structuredClone(disk), installed: [...installed] }),
      allowSave: () => { fail = false },
      denyInspection: () => { failInspection = true },
      allowInspection: () => { failInspection = false },
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
    for (const mode of ['select', 'remove', 'remove-active', 'inspection']) {
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
      if (mode === 'inspection') {
        const initial = await page.evaluate(() => window.snapshot())
        await page.evaluate(async () => {
          window.denyInspection()
          await window.restart()
        })
        await page
          .getByRole('alert')
          .filter({ hasText: "Couldn't check your saved model setup" })
          .waitFor()
        let denied = await page.evaluate(() => window.snapshot())
        assert.equal(denied.status, 'error')
        assert.equal(denied.active, initial.active)
        assert.deepEqual(denied.records, initial.records)
        assert.deepEqual(denied.disk, initial.disk)
        assert.equal(denied.saveAttempts, 0)
        assert.equal(await page.locator('[data-slot="model-card"]').count(), 0)
        await page.evaluate(() => window.allowInspection())
        await page.getByRole('button', { name: 'Retry', exact: true }).click()
        await page.waitForFunction(
          () =>
            window.snapshot().status === 'ready' &&
            window.snapshot().error === null
        )
        const recovered = await page.evaluate(() => window.snapshot())
        assert.equal(recovered.active, initial.active)
        assert.deepEqual(recovered.records, initial.records)
        assert.deepEqual(recovered.disk, initial.disk)
        assert.equal(recovered.saveAttempts, 0)
        await page
          .locator(
            `[data-slot="model-card"][aria-labelledby="model-${ACTIVE_MODEL_ID}-name"]`
          )
          .getByRole('button', { name: 'Re-benchmark', exact: true })
          .waitFor()
        assert.deepEqual(errors, [], mode)
        await page.close()
        continue
      }
      const targetModelId =
        mode === 'remove-active' ? ACTIVE_MODEL_ID : OTHER_MODEL_ID
      const card = page.locator(
        `[data-slot="model-card"][aria-labelledby="model-${targetModelId}-name"]`
      )
      if (mode === 'select')
        await card
          .getByRole('button', { name: 'Use model', exact: true })
          .click()
      else await card.getByRole('button', { name: /Remove/ }).click()
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
      assert.equal(snapshot.disk.active_model_id, ACTIVE_MODEL_ID)
      if (mode !== 'select') {
        const id = targetModelId
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
      assert.equal(
        snapshot.active,
        mode === 'select'
          ? OTHER_MODEL_ID
          : mode === 'remove-active'
            ? null
            : ACTIVE_MODEL_ID
      )
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
