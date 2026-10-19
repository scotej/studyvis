import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { build } from 'vite'

test('AI Restart reserves success feedback for a started engine (#391)', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const fixture = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { Toaster } from 'sonner'
    import { AiCategory } from '@/features/settings/categories/AiCategory'
    import { __setDownloadRuntime } from '@/features/ai/download'
    import { __setHfTokenRuntime } from '@/features/ai/hfToken'
    import { __setEngineRuntime } from '@/features/ai/engine'
    import { __setSidecarRuntime, useSidecarStore } from '@/features/ai/sidecar'
    import { SUPPORTED_MODELS } from '@/features/ai/models'
    import { useModelStore } from '@/features/ai/modelStore'
    import { useSettingsStore } from '@/stores/settingsStore'
    import { useSessionStore } from '@/stores/sessionStore'
    const mode = new URLSearchParams(location.search).get('mode')
    const hardwareIdentity = { selection: 'cpu', topology: [] }
    const enabled = mode !== 'disabled'
    useSessionStore.setState({ status: 'idle' })
    useSettingsStore.setState(s => ({ status: 'ready', values: { ...s.values, aiFeaturesEnabled: true } }))
    useModelStore.setState({ status: 'ready', activeModelId: 'qwen2_5-vl-3b',
      records: Object.fromEntries(SUPPORTED_MODELS.map(spec => [spec.id, { modelId: spec.id, installedAt: 1, benchmark: null }])) })
    useSidecarStore.setState({ status: 'errored', lastError: 'Initial engine failure' })
    __setHfTokenRuntime({ present: async () => false, save: async () => {}, clear: async () => {} })
    __setDownloadRuntime({
      paths: async id => ({ dir: '/' + id, model_path: '/' + id + '/model.gguf', mmproj_path: '/' + id + '/mmproj.gguf' }),
      installState: async () => ({ model: { exists: true, size: 123 }, mmproj: { exists: true, size: 123 } }),
      subscribeProgress: async () => () => {}, headCheck: async () => ({ status: 200, content_length: null }),
      startDownload: async () => {}, cancelDownload: async () => {}, remove: async () => {},
    })
    __setEngineRuntime({ info: async () => ({ supported: true, installed: true, source: 'bundled', version: 'b9095', installing: false, last_error: null, devices: [], device_error: null, hardware_identity: hardwareIdentity }), install: async () => {}, subscribeProgress: async () => () => {} })
    __setSidecarRuntime({
      start: async () => {
        if (mode === 'rejected') throw new Error('Selected accelerator is unavailable')
        if (mode === 'missing-engine') throw 'engine_not_installed'
        if (mode === 'missing-model') throw new Error('The selected model files are unavailable. Download the model again.')
        return { port: 8000, hardwareIdentity }
      }, stop: async () => {}, status: async () => ({}), fetchHealth: async () => true,
      setInterval: () => 99, clearInterval: () => {}, getAiFeaturesEnabled: () => enabled, getEngineAutoInstall: () => true,
    })
    window.sidecarState = () => ({ status: useSidecarStore.getState().status, lastError: useSidecarStore.getState().lastError })
    createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null, React.createElement(Toaster), React.createElement(AiCategory)))
  `
  const result = await build({
    root,
    logLevel: 'error',
    plugins: [
      {
        name: 'ai-restart-feedback-check',
        resolveId(id) {
          if (id === 'ai-restart-feedback-check')
            return '\0ai-restart-feedback-check'
        },
        load(id) {
          if (id === '\0ai-restart-feedback-check') return fixture
        },
      },
    ],
    build: {
      write: false,
      rollupOptions: {
        input: 'ai-restart-feedback-check',
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
    for (const [mode, message, status] of [
      ['rejected', 'Selected accelerator is unavailable', 'errored'],
      [
        'missing-engine',
        'Install the AI engine first (see the AI engine row).',
        'errored',
      ],
      ['disabled', 'Enable AI features before restarting the model.', 'idle'],
      [
        'missing-model',
        'The selected model files are unavailable. Download the model again.',
        'errored',
      ],
      ['success', 'AI model restarting.', 'running'],
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
      await page.getByRole('button', { name: 'Restart', exact: true }).click()
      await page
        .locator('[data-sonner-toast]')
        .filter({ hasText: message })
        .waitFor()
      const toasts = await page
        .locator('[data-sonner-toast]')
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            text: node.textContent,
            type: node.getAttribute('data-type'),
          }))
        )
      assert.equal(
        toasts.at(-1).type,
        mode === 'success' ? 'success' : 'error',
        mode
      )
      assert.equal(
        (await page.evaluate(() => window.sidecarState())).status,
        status,
        mode
      )
      if (mode !== 'success')
        assert.equal(
          await page
            .getByRole('button', { name: 'Restart', exact: true })
            .count(),
          1,
          mode
        )
      assert.deepEqual(errors, [], mode)
      await page.close()
    }
  } finally {
    await browser.close()
  }
})
