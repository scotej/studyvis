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
    import { flushSync } from 'react-dom'
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
    const attemptIds = []
    const persisted = {}
    let saved = {}
    let busy = false
    let nativeCompleted = false
    let installProbePending = false
    let replyInstallProbe
    let finishDownload, failDownload, finishCancel, emitProgress
    let root
    let starts = 0
    __setModelStoreDeps({ storeFactory: () => ({
      get: async key => persisted[key],
      set: async (key, value) => { persisted[key] = structuredClone(value) },
      delete: async key => delete persisted[key],
      save: async () => { saved = structuredClone(persisted) },
    }) })
    useSessionStore.setState({ status: 'idle' })
    useSettingsStore.setState(s => ({ status: 'ready', values: { ...s.values, aiFeaturesEnabled: false } }))
    useModelStore.setState({ status: 'ready', activeModelId: null, records: {}, error: null })
    __setHfTokenRuntime({ present: async () => false, save: async () => {}, clear: async () => {} })
    __setDownloadRuntime({
      paths: async id => ({ dir: '/' + id, model_path: '/' + id + '/model.gguf', mmproj_path: '/' + id + '/mmproj.gguf' }),
      installState: async id => {
        if (mode === 'complete-unmount' && nativeCompleted && id === downloadModelId && !installProbePending) {
          installProbePending = true
          return new Promise(resolve => { replyInstallProbe = () => resolve({ model: { exists: true, size: 1 }, mmproj: { exists: true, size: 1 } }) })
        }
        return { model: { exists: nativeCompleted, size: 0 }, mmproj: { exists: nativeCompleted, size: 0 } }
      },
      subscribeProgress: async handler => { emitProgress = handler; return () => {} },
      headCheck: () => {
        const index = heads.length
        traces.push('head-' + index)
        if (mode !== 'preflight' || index >= 2) { heads.push(null); return Promise.resolve({ status: 200, content_length: null }) }
        return new Promise(resolve => heads.push(() => { traces.push('head-resolved-' + index); resolve({ status: 200, content_length: null }) }))
      },
      startDownload: (id, files, useToken, downloadId) => {
        attemptIds.push(downloadId)
        traces.push('start-' + (++starts))
        if (mode !== 'preflight' && (starts === 1 || mode === 'stale-terminal')) return new Promise((resolve, reject) => { finishDownload = resolve; failDownload = reject })
        return Promise.resolve()
      },
      cancelDownload: async (id, downloadId) => { traces.push('cancel'); traces.push('cancel-id-' + downloadId); if (mode === 'cancel-failure') throw new Error('Cancellation IPC failed'); await new Promise(resolve => { finishCancel = resolve }) },
      remove: async () => {},
    })
    Object.assign(window, {
      snapshot: () => ({ traces: [...traces], starts, heads: heads.length, attemptIds: [...attemptIds], busy, installProbePending, saved }),
      replyHead: index => heads[index](),
      finishDownload: (success = false) => { if (success) { nativeCompleted = true; finishDownload() } else failDownload(new Error('cancelled')) },
      replyInstallProbe: () => replyInstallProbe(),
      finishCancel: () => finishCancel(),
      emitOldProgress: () => emitProgress({ download_id: attemptIds[0], model_id: downloadModelId, phase: 'downloading', file: 'model', file_index: 0, file_count: 2, bytes_received: 123, total_bytes: 456, error: null }),
      emitOldTerminal: phase => flushSync(() => emitProgress({ download_id: attemptIds[0], model_id: downloadModelId, phase, file: 'all', file_index: 0, file_count: 2, bytes_received: 0, total_bytes: 0, error: null })),
      emitCurrentProgress: () => emitProgress({ download_id: attemptIds.at(-1), model_id: downloadModelId, phase: 'downloading', file: 'mmproj', file_index: 1, file_count: 2, bytes_received: 123, total_bytes: 456, error: null }),
      remount: () => { root.unmount(); root = createRoot(document.getElementById('root')); root.render(React.createElement(ModelPickerContainer, { onBusyChange: value => { busy = value } })) },
    })
    root = createRoot(document.getElementById('root'))
    root.render(React.createElement(ModelPickerContainer, { onBusyChange: value => { busy = value } }))
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
    for (const mode of [
      'preflight',
      'native',
      'cancel-failure',
      'unmount',
      'stale-terminal',
      'complete-unmount',
    ]) {
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
      if (mode === 'complete-unmount') {
        await page.evaluate(() => window.finishDownload(true))
        await page.waitForFunction(() => window.snapshot().installProbePending)
        await page.evaluate(() => window.remount())
        await page.evaluate(() => window.replyInstallProbe())
        await page.waitForFunction(
          (modelId) =>
            window.snapshot().saved.records?.[modelId]?.installedAt != null,
          DOWNLOAD_MODEL_ID,
          { timeout: 5000 }
        )
        const completed = await page.evaluate(() => window.snapshot())
        assert.equal(completed.saved.active_model_id, DOWNLOAD_MODEL_ID)
        assert.equal(completed.traces.includes('cancel'), false)
        assert.deepEqual(errors, [], mode)
        await page.close()
        continue
      }
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
        if (mode === 'stale-terminal') {
          const retry = await page.evaluate(() => window.snapshot())
          assert.equal(typeof retry.attemptIds[1], 'string')
          assert.notEqual(retry.attemptIds[0], retry.attemptIds[1])
          for (const phase of ['cancelled', 'failed', 'done']) {
            await page.evaluate((phase) => window.emitOldTerminal(phase), phase)
            assert.equal(
              await card
                .getByRole('button', { name: /Download/, exact: true })
                .count(),
              0,
              phase
            )
            assert.equal(
              (await page.evaluate(() => window.snapshot())).busy,
              true,
              phase
            )
          }
          await page.evaluate(() => window.emitOldProgress())
          await page.evaluate(() => window.emitCurrentProgress())
          await card
            .getByRole('button', { name: 'Cancel', exact: true })
            .waitFor()
          await card
            .getByRole('button', { name: 'Cancel', exact: true })
            .click()
          await page.waitForFunction(
            () =>
              window.snapshot().traces.filter((item) => item === 'cancel')
                .length === 2
          )
          const cancelling = await page.evaluate(() => window.snapshot())
          assert.ok(
            cancelling.traces.includes('cancel-id-' + retry.attemptIds[1])
          )
          await page.evaluate(() => window.finishCancel())
          await page.evaluate(() => window.finishDownload())
          const resume = card.getByRole('button', {
            name: 'Resume download',
            exact: true,
          })
          await resume.waitFor()
          assert.equal(await resume.isEnabled(), true)
          await page.waitForFunction(
            (modelId) =>
              window.snapshot().saved.records?.[modelId]?.interruptedDownload
                ?.bytesReceived === 123,
            DOWNLOAD_MODEL_ID
          )
          assert.equal(
            (await page.evaluate(() => window.snapshot())).busy,
            false
          )
        }
        assert.equal(
          (await page.evaluate(() => window.snapshot())).traces.filter(
            (item) => item === 'cancel'
          ).length,
          mode === 'stale-terminal' ? 2 : 1
        )
      }
      assert.deepEqual(errors, [], mode)
      await page.close()
    }
  } finally {
    await browser.close()
  }
})
