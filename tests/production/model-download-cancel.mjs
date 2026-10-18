import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { build } from 'vite'

const DOWNLOAD_MODEL_ID = 'qwen2_5-vl-3b'

test('Cancel owns model preflight and cannot cancel a later retry (#387)', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const fixture = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { ModelPickerContainer } from '@/features/ai/ModelPickerContainer'
    import { __setDownloadRuntime } from '@/features/ai/download'
    import { __setHfTokenRuntime } from '@/features/ai/hfToken'
    import { __setModelStoreDeps, useModelStore } from '@/features/ai/modelStore'
    import { useSettingsStore } from '@/stores/settingsStore'
    import { useSessionStore } from '@/stores/sessionStore'
    const mode = new URLSearchParams(location.search).get('mode')
    const downloadModelId = ${JSON.stringify(DOWNLOAD_MODEL_ID)}
    const traces = []
    const heads = []
    let finishDownload, finishCancel, emitProgress
    let root
    let starts = 0
    __setModelStoreDeps({ storeFactory: null })
    useSessionStore.setState({ status: 'idle' })
    useSettingsStore.setState(s => ({ status: 'ready', values: { ...s.values, aiFeaturesEnabled: false } }))
    useModelStore.setState({ status: 'ready', activeModelId: null, records: {}, error: null })
    __setHfTokenRuntime({ present: async () => false, save: async () => {}, clear: async () => {} })
    __setDownloadRuntime({
      paths: async id => ({ dir: '/' + id, model_path: '/' + id + '/model.gguf', mmproj_path: '/' + id + '/mmproj.gguf' }),
      installState: async () => ({ model: { exists: false, size: 0 }, mmproj: { exists: false, size: 0 } }),
      subscribeProgress: async handler => { emitProgress = handler; return () => {} },
      headCheck: () => {
        const index = heads.length
        traces.push('head-' + index)
        if (mode !== 'preflight' || index >= 2) { heads.push(null); return Promise.resolve({ status: 200, content_length: null }) }
        return new Promise(resolve => heads.push(() => { traces.push('head-resolved-' + index); resolve({ status: 200, content_length: null }) }))
      },
      startDownload: () => {
        traces.push('start-' + (++starts))
        if (mode !== 'preflight' && starts === 1) return new Promise(resolve => { finishDownload = resolve })
        return Promise.resolve()
      },
      cancelDownload: async () => { traces.push('cancel'); if (mode === 'cancel-failure') throw new Error('Cancellation IPC failed'); await new Promise(resolve => { finishCancel = resolve }) },
      remove: async () => {},
    })
    Object.assign(window, {
      snapshot: () => ({ traces: [...traces], starts, heads: heads.length }),
      replyHead: index => heads[index](),
      finishDownload: () => finishDownload(),
      finishCancel: () => finishCancel(),
      emitOldProgress: () => emitProgress({ model_id: downloadModelId, phase: 'downloading', file: 'model', file_index: 0, file_count: 2, bytes_received: 123, total_bytes: 456, error: null }),
      remount: () => { root.unmount(); root = createRoot(document.getElementById('root')); root.render(React.createElement(ModelPickerContainer)) },
    })
    root = createRoot(document.getElementById('root'))
    root.render(React.createElement(ModelPickerContainer))
  `
  const result = await build({
    root,
    logLevel: 'error',
    plugins: [
      {
        name: 'download-cancel-check',
        resolveId(id) {
          if (id === 'download-cancel-check') return '\0download-cancel-check'
        },
        load(id) {
          if (id === '\0download-cancel-check') return fixture
        },
      },
    ],
    build: {
      write: false,
      rollupOptions: {
        input: 'download-cancel-check',
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
    for (const mode of ['preflight', 'native', 'cancel-failure', 'unmount']) {
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
      await page.goto('http://studyvis.test/?mode=' + mode)
      await page.evaluate(
        (entryFile) => import('/' + entryFile),
        entry.fileName
      )
      const card = page.locator(
        `[data-slot="model-card"][aria-labelledby="model-${DOWNLOAD_MODEL_ID}-name"]`
      )
      await card.getByRole('button', { name: /Download/, exact: true }).click()
      await page.waitForFunction(() => window.snapshot().heads >= 1)
      if (mode !== 'preflight')
        await page.waitForFunction(() => window.snapshot().starts === 1)
      if (mode === 'unmount') await page.evaluate(() => window.remount())
      else
        await card.getByRole('button', { name: 'Cancel', exact: true }).click()
      if (mode === 'preflight') {
        await card
          .getByRole('button', { name: /Download/, exact: true })
          .click()
        await page.waitForFunction(() => window.snapshot().heads === 2)
        await page.evaluate(() => window.replyHead(0))
        await page.waitForFunction(() =>
          window.snapshot().traces.includes('head-resolved-0')
        )
        assert.equal((await page.evaluate(() => window.snapshot())).starts, 0)
        await page.evaluate(() => window.replyHead(1))
        await page.waitForFunction(() => window.snapshot().starts === 1)
        const snapshot = await page.evaluate(() => window.snapshot())
        assert.equal(snapshot.heads, 3)
        assert.ok(!snapshot.traces.includes('cancel'))
      } else if (mode === 'cancel-failure') {
        await card
          .getByRole('alert')
          .filter({ hasText: 'Cancellation IPC failed' })
          .waitFor()
        await page.waitForFunction(() =>
          window.snapshot().traces.includes('cancel')
        )
        assert.equal(
          await card
            .getByRole('button', { name: /Download/, exact: true })
            .count(),
          0
        )
        await page.evaluate(() => window.emitOldProgress())
        assert.equal((await page.evaluate(() => window.snapshot())).starts, 1)
        assert.equal(
          await card
            .getByRole('button', { name: /Download/, exact: true })
            .count(),
          0
        )
        await page.evaluate(() => window.finishDownload())
        await card
          .getByRole('button', { name: /Download/, exact: true })
          .click()
        await page.waitForFunction(() => window.snapshot().starts === 2)
      } else if (mode === 'unmount') {
        await page.waitForFunction(() =>
          window.snapshot().traces.includes('cancel')
        )
        await card
          .getByRole('button', { name: /Download/, exact: true })
          .click()
        assert.equal((await page.evaluate(() => window.snapshot())).starts, 1)
        await page.evaluate(() => window.finishCancel())
        await page.evaluate(() => window.finishDownload())
        await page.waitForFunction(() => window.snapshot().starts === 2)
      } else {
        await page.waitForFunction(() =>
          window.snapshot().traces.includes('cancel')
        )
        await page.evaluate(() => window.finishDownload())
        await page.evaluate(() => window.emitOldProgress())
        assert.equal(
          (await page.evaluate(() => window.snapshot())).traces.filter(
            (item) => item === 'cancel'
          ).length,
          1
        )
        assert.equal(
          await card
            .getByRole('button', { name: /Download/, exact: true })
            .count(),
          0
        )
        await page.evaluate(() => window.finishCancel())
        await card
          .getByRole('button', { name: /Download/, exact: true })
          .click()
        await page.waitForFunction(() => window.snapshot().starts === 2)
        assert.equal(
          (await page.evaluate(() => window.snapshot())).traces.filter(
            (item) => item === 'cancel'
          ).length,
          1
        )
      }
      assert.deepEqual(errors, [], mode)
      await page.close()
    }
  } finally {
    await browser.close()
  }
})
