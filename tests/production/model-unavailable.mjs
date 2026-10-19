import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { build } from 'vite'

// Exercise the real settings/picker and store hydration. Only native I/O is
// replaced; all files/records here are synthetic and owned by this fixture.
test('unavailable managed model preserves saved choice and files until explicit removal (#422)', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const fixture = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { Toaster } from 'sonner'
    import { AiCategory } from '@/features/settings/categories/AiCategory'
    import { __setDownloadRuntime } from '@/features/ai/download'
    import { __setHfTokenRuntime } from '@/features/ai/hfToken'
    import { __setEngineRuntime } from '@/features/ai/engine'
    import { __setScreenCaptureRuntime } from '@/features/ai/captureScreen'
    import { __setSidecarRuntime, useSidecarStore } from '@/features/ai/sidecar'
    import { __setModelStoreDeps, useModelStore } from '@/features/ai/modelStore'
    import { __setSettingsStoreDeps, useSettingsStore } from '@/stores/settingsStore'
    import { useSessionStore } from '@/stores/sessionStore'
    import { MODEL_UNAVAILABLE_ERROR } from '@/features/ai/models'
    import '@/design/index.css'
    const mode = new URL(location.href).searchParams.get('mode')
    const traces = []
    const oldRecord = { modelId: 'moondream2', installedAt: 123, benchmark: {
      p95Sec: 3.2, p50Sec: 2.7, sampleIntervalSec: 5, measuredAt: 100,
      engineFingerprint: 'historical-engine',
    }}
    const available = id => ({ modelId: id, installedAt: 456, benchmark: null })
    let disk = { records: {}, active_model_id: null }
    const files = new Map()
    if (mode !== 'fresh') {
      disk.active_model_id = mode === 'installed-other' ? 'qwen2_5-vl-3b' : mode.startsWith('partial') ? null : 'moondream2'
      if (mode !== 'selected-missing') disk.records.moondream2 = structuredClone(oldRecord)
      if (mode.startsWith('partial')) {
        disk.records.moondream2 = { modelId: 'moondream2', installedAt: null, benchmark: null,
          interruptedDownload: { bytesReceived: 777, at: 789 } }
        files.set('moondream2', { model: mode === 'partial-file', mmproj: false })
      } else if (mode !== 'selected-missing') {
        files.set('moondream2', { model: true, mmproj: true })
      }
    }
    if (mode === 'installed-other') {
      for (const id of ['qwen2_5-vl-3b', 'gemma3-4b']) {
        disk.records[id] = available(id)
        files.set(id, { model: true, mmproj: true })
      }
    }
    const initialDisk = structuredClone(disk)
    let pending = structuredClone(disk)
    let modelWrites = 0
    const store = {
      get: async key => structuredClone(disk[key]),
      set: async (key, value) => { modelWrites++; pending[key] = structuredClone(value) },
      delete: async key => { modelWrites++; return delete pending[key] },
      save: async () => { modelWrites++; disk = structuredClone(pending) },
    }
    __setModelStoreDeps({ storeFactory: () => store })
    useModelStore.setState({ status: 'loading', records: {}, activeModelId: null, error: null })
    await useModelStore.getState().hydrate()
    let settingsWrites = 0
    const settingsDisk = { theme: 'dark', ai_features_enabled: ['selected-on', 'selected-remove'].includes(mode) }
    __setSettingsStoreDeps({
      storeFactory: () => ({
        get: async key => settingsDisk[key],
        set: async (key, value) => { settingsWrites++; settingsDisk[key] = value },
        save: async () => { settingsWrites++ },
      }),
      migrator: { readLegacyTheme: () => null, clearLegacyTheme: () => {} },
      runtime: {
        pushAiFeaturesEnabled: async value => { traces.push('ai:' + value) },
        pushMinimizeToTray: async () => {}, setGlobalShortcut: async () => {}, relaunchApp: async () => {},
      },
    })
    useSettingsStore.setState({ status: 'loading' })
    await useSettingsStore.getState().hydrate()
    useSessionStore.setState({ status: ['selected-on', 'selected-remove'].includes(mode) ? 'active' : 'idle' })
    __setHfTokenRuntime({ present: async () => false, save: async () => {}, clear: async () => {} })
    __setEngineRuntime({
      info: async () => ({ supported: true, installed: true, source: 'bundled', version: 'b9095', installing: false,
        last_error: null, devices: [], device_error: null, hardware_identity: { selection: 'auto', topology: [] } }),
      install: async () => { traces.push('engine-install') }, subscribeProgress: async () => () => {},
    })
    __setScreenCaptureRuntime({ getDisplayMedia: async () => {
      traces.push('capture')
      return document.createElement('canvas').captureStream()
    }})
    __setSidecarRuntime({
      start: async () => { traces.push('sidecar-start'); throw new Error('Unexpected sidecar startup') },
      stop: async () => { traces.push('sidecar-stop') },
      status: async () => ({ running: false, port: null, errored: false, model: null }),
      fetchHealth: async () => { traces.push('health'); return true },
      setInterval: () => 0, clearInterval: () => {},
      getAiFeaturesEnabled: () => useSettingsStore.getState().values.aiFeaturesEnabled,
      getEngineAutoInstall: () => false,
    })
    useSidecarStore.setState({ status: 'errored', port: null, lastError: MODEL_UNAVAILABLE_ERROR })
    __setDownloadRuntime({
      paths: async id => { traces.push('paths:' + id); return { dir: '/' + id, model_path: '/' + id + '/model.gguf', mmproj_path: '/' + id + '/mmproj.gguf' } },
      installState: async id => ({ model: { exists: files.get(id)?.model ?? false, size: 123 }, mmproj: { exists: files.get(id)?.mmproj ?? false, size: 123 } }),
      subscribeProgress: async () => () => {},
      headCheck: async () => { traces.push('head'); return { status: 200, content_length: null } },
      startDownload: async () => { traces.push('download') },
      cancelDownload: async () => { traces.push('cancel') },
      remove: async id => { traces.push('remove:' + id); files.delete(id) },
    })
    traces.length = 0
    settingsWrites = 0
    Object.assign(window, { snapshot: () => ({ disk: structuredClone(disk), initialDisk, modelWrites, settingsWrites,
      ai: useSettingsStore.getState().values.aiFeaturesEnabled, savedAi: settingsDisk.ai_features_enabled,
      active: useModelStore.getState().activeModelId, traces: [...traces], files: [...files] }) })
    createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
      React.createElement(AiCategory), React.createElement(Toaster)))
  `
  const result = await build({
    root,
    logLevel: 'error',
    plugins: [
      {
        name: 'unavailable-model-check',
        resolveId: (id) =>
          id === 'unavailable-model-check'
            ? '\0unavailable-model-check'
            : undefined,
        load: (id) =>
          id === '\0unavailable-model-check' ? fixture : undefined,
      },
    ],
    build: {
      write: false,
      rollupOptions: {
        input: 'unavailable-model-check',
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
      'fresh',
      'selected-on',
      'selected-remove',
      'selected-missing',
      'installed-other',
      'partial-file',
      'partial-temp',
    ]) {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('http://studyvis.test/**', (route) => {
        const filename = new URL(route.request().url()).pathname.slice(1)
        if (!filename)
          return route.fulfill({
            contentType: 'text/html',
            body: `<div id="root"></div>${output
              .filter(
                (item) =>
                  item.type === 'asset' && item.fileName.endsWith('.css')
              )
              .map((item) => `<link rel="stylesheet" href="/${item.fileName}">`)
              .join('')}`,
          })
        const asset = output.find((item) => item.fileName === filename)
        return route.fulfill(
          asset
            ? {
                contentType:
                  asset.type === 'chunk'
                    ? 'text/javascript'
                    : filename.endsWith('.css')
                      ? 'text/css'
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
      await page.getByRole('heading', { name: 'Pick a vision model' }).waitFor()
      const legacy = page.getByRole('article', {
        name: 'Moondream 2',
        exact: true,
      })
      const initial = await page.evaluate(() => window.snapshot())
      assert.deepEqual(
        initial.disk,
        initial.initialDisk,
        `${mode}: hydration must retain all metadata`
      )
      assert.equal(initial.modelWrites, 0)
      assert.equal(initial.settingsWrites, 0)
      assert.deepEqual(initial.traces, [])
      if (mode === 'fresh') {
        assert.equal(await legacy.count(), 0)
        await page
          .getByText('What model should I pick?', { exact: true })
          .click()
        assert.equal(
          await page
            .getByRole('table')
            .getByText('Moondream 2', { exact: true })
            .count(),
          0
        )
        assert.equal(
          await page
            .getByRole('article', { name: 'Qwen 2.5-VL 3B', exact: true })
            .getByRole('button', { name: 'Download', exact: true })
            .isEnabled(),
          true
        )
      } else {
        await legacy.getByText('Unavailable', { exact: true }).waitFor()
        assert.equal(
          await legacy.getByText('Fastest', { exact: true }).count(),
          0
        )
        assert.equal(
          await legacy.getByText('In use', { exact: true }).count(),
          0
        )
        assert.equal(
          await legacy
            .getByRole('button', {
              name: /^(Download|Resume download|Re-download|Use model|Benchmark|Re-benchmark)$/,
            })
            .count(),
          0
        )
        assert.equal(
          await legacy
            .getByRole('button', { name: 'Remove Moondream 2', exact: true })
            .isEnabled(),
          true
        )
        if (mode === 'selected-on') {
          const toggle = page.getByRole('switch', {
            name: 'Enable AI features',
            exact: true,
          })
          assert.equal(await toggle.getAttribute('aria-checked'), 'true')
          assert.equal(initial.ai, true)
          assert.equal(initial.savedAi, true)
          assert.equal(
            await page
              .getByRole('button', { name: 'Restart', exact: true })
              .isDisabled(),
            true
          )
          await toggle.click()
          await page.waitForFunction(() => window.snapshot().ai === false)
          await toggle.click()
          await page
            .getByText(/Moondream 2 is unavailable for AI checks/)
            .first()
            .waitFor()
          const blocked = await page.evaluate(() => window.snapshot())
          assert.equal(blocked.ai, false)
          assert.equal(blocked.savedAi, false)
          assert.equal(blocked.active, 'moondream2')
          assert.deepEqual(blocked.disk, blocked.initialDisk)
          assert.deepEqual(blocked.traces, ['ai:false', 'sidecar-stop'])
        } else if (mode === 'installed-other') {
          const control = page.getByRole('article', {
            name: 'Gemma 3 4B',
            exact: true,
          })
          await control
            .getByRole('button', { name: 'Use model', exact: true })
            .click()
          await page.waitForFunction(
            () => window.snapshot().active === 'gemma3-4b'
          )
          assert.deepEqual(
            (await page.evaluate(() => window.snapshot())).disk.records
              .moondream2,
            initial.disk.records.moondream2
          )
        } else {
          await legacy
            .getByRole('button', { name: 'Remove Moondream 2', exact: true })
            .click()
          await page.waitForFunction(
            () =>
              !('moondream2' in window.snapshot().disk.records) &&
              window.snapshot().active === null
          )
          const removed = await page.evaluate(() => window.snapshot())
          assert.deepEqual(removed.traces, ['remove:moondream2'])
          assert.equal(
            removed.files.some(([id]) => id === 'moondream2'),
            false
          )
          if (mode === 'selected-remove') {
            assert.equal(removed.ai, true)
            assert.equal(removed.savedAi, true)
          }
        }
      }
      assert.deepEqual(errors, [], mode)
      console.log('verified retirement UI state:', mode)
      await page.close()
    }
  } finally {
    await browser.close()
  }
})

// Keep Home's actual handlers and topic gate; replace only discovery and room
// entry boundaries, with real notes controls after the synthetic session starts.
test('retained unavailable selection never captures on start or rejoin (#422)', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const fixture = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { Home } from '@/routes/Home'
    import { useIdentityStore } from '@/stores/identityStore'
    import { useFriendsStore } from '@/stores/friendsStore'
    import { useSettingsStore } from '@/stores/settingsStore'
    import { useSessionStore } from '@/stores/sessionStore'
    import { useModelStore } from '@/features/ai/modelStore'
    import { __setScreenCaptureRuntime, discardPendingScreenStream } from '@/features/ai/captureScreen'
    import '@/design/index.css'
    const query = new URL(location.href).searchParams
    const flow = query.get('flow'), model = query.get('model'), traces = [], streams = []
    const record = { modelId: 'moondream2', installedAt: 123, benchmark: { p95Sec: 3 } }
    await useIdentityStore.getState().actions.refresh()
    useIdentityStore.setState({ status: 'ready', identity: {
      ed_pubkey_hex: '11'.repeat(32), x_pubkey_hex: '22'.repeat(32), display_name: 'Local' } })
    useFriendsStore.setState({ status: 'ready', friends: [] })
    useSettingsStore.setState(state => ({ status: 'ready', values: { ...state.values, aiFeaturesEnabled: true } }))
    useModelStore.setState({ status: model === 'loading' ? 'loading' : 'ready', activeModelId: model === 'loading' ? null : model,
      records: { moondream2: record }, hydrate: async () => {} })
    const request = { sessionTopic: 'fixture-session', sessionPassword: 'fixture-password', isHost: true,
      expectedAuthorityEdPubkeyHex: null }
    useSessionStore.setState({ status: flow === 'rejoin' ? 'ended' : 'idle', sessionTopic: flow === 'rejoin' ? request.sessionTopic : null,
      endedBy: 'user', rejoinDeadline: Date.now() + 20_000, getRejoinRequest: () => request })
    __setScreenCaptureRuntime({ getDisplayMedia: async () => {
      traces.push('capture')
      const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16
      const stream = canvas.captureStream(); streams.push(stream); return stream
    } })
    window.sessionFixture = { flow, traces, request,
      snapshot: () => ({ traces: [...traces], model: useModelStore.getState().activeModelId,
        records: useModelStore.getState().records, ai: useSettingsStore.getState().values.aiFeaturesEnabled,
        tracks: streams.flatMap(stream => stream.getTracks().map(track => track.readyState)) }),
      entered: () => { traces.push('entered'); useSessionStore.setState({ status: 'active' }) },
      dispose: discardPendingScreenStream }
    createRoot(document.getElementById('root')).render(React.createElement(Home))
  `
  const stubs = {
    '@/features/friends': `
      import React from 'react'
      export class InviteRelayError extends Error {}
      export class InviteTimeoutError extends Error {}
      export const AddFriendDialog = () => null, ContactImportDialog = () => null,
        PairDeepLinkBoot = () => null, InboxBoot = () => null, PendingInvites = () => null
      export const pendingInviteKey = () => 'fixture-invite', presenceState = () => ({ state: 'offline' })
      const pendingState = { pending: [] }
      export const usePendingInvitesStore = select => select(pendingState)
      usePendingInvitesStore.getState = () => pendingState
      export const FriendsList = ({ onInvite }) => React.createElement('button', {
        onClick: () => onInvite({ ed_pubkey_hex: '33'.repeat(32), display_name: 'Friend' }),
      }, 'Start fixture session')`,
    '@/features/session': `
      import React from 'react'
      import { SessionNotesPanel } from '@/features/session/SessionNotesPanel'
      export { TopicGateModal } from '@/features/session/TopicGateModal'
      export class InviteWhileGuestError extends Error {}
      export const inviteToCurrentSession = async () => { window.sessionFixture.entered(); return { acked: true } }
      export const joinSession = () => window.sessionFixture.entered(), rejoinSession = joinSession
      export const Report = ({ onRejoin }) => React.createElement('button', { onClick: onRejoin }, 'Rejoin fixture session')
      export const SessionView = () => React.createElement(SessionNotesPanel, {
        notes: [], images: [], resolveName: () => 'Local', onSend: () => {}, onSendImage: () => {}, onOpenImage: () => {} })
      export const InterruptedSessionView = ({ onRejoin }) => React.createElement('button', { onClick: onRejoin }, 'Resume fixture session')
      export const useInterruptedSession = () => ({ state: window.sessionFixture.flow === 'interrupted' && !window.sessionFixture.traces.includes('entered')
        ? { status: 'prompt', record: { ...window.sessionFixture.request, startedAt: Date.now() - 60_000,
            declaredStudyTopic: 'Maths' }, loadedAt: Date.now() } : { status: 'absent' }, dismiss: () => {}, end: () => {} })`,
    '@/features/onboarding':
      'export const useOnboardingState = () => ({ status: "ready" }); export const Onboarding = () => null',
    '@/features/settings':
      'export const Settings = () => null; export const SettingsOverlay = () => null',
    '@/components/UpdateReadyBanner':
      'export const UpdateReadyBanner = () => null',
  }
  const result = await build({
    root,
    logLevel: 'error',
    plugins: [
      {
        name: 'unavailable-session-boundaries',
        enforce: 'pre',
        transform(code, id) {
          if (!id.endsWith('/src/routes/Home.tsx')) return
          for (const specifier of Object.keys(stubs))
            code = code.replaceAll(
              "'" + specifier + "'",
              "'session-boundary:" + specifier + "'"
            )
          return code
        },
        resolveId(id) {
          if (id === 'unavailable-session-check')
            return '\0unavailable-session-check'
          if (id.startsWith('session-boundary:')) return '\0' + id
        },
        load(id) {
          if (id === '\0unavailable-session-check') return fixture
          if (id.startsWith('\0session-boundary:'))
            return stubs[id.slice('\0session-boundary:'.length)]
        },
      },
    ],
    build: {
      write: false,
      rollupOptions: {
        input: 'unavailable-session-check',
        preserveEntrySignatures: 'strict',
      },
    },
  })
  const output = (Array.isArray(result) ? result[0] : result).output
  const entry = output.find((item) => item.type === 'chunk' && item.isEntry)
  assert.ok(entry)
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.LAB_CHROME_EXECUTABLE,
  })
  try {
    for (const flow of ['start', 'rejoin', 'interrupted']) {
      for (const model of ['moondream2', 'qwen2_5-vl-3b', 'loading']) {
        const page = await browser.newPage()
        page.setDefaultTimeout(10_000)
        const errors = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.route('http://studyvis.test/**', (route) => {
          const filename = new URL(route.request().url()).pathname.slice(1)
          const asset = output.find((item) => item.fileName === filename)
          return route.fulfill(
            asset
              ? {
                  contentType:
                    asset.type === 'chunk'
                      ? 'text/javascript'
                      : asset.fileName.endsWith('.css')
                        ? 'text/css'
                        : 'application/octet-stream',
                  body: asset.type === 'chunk' ? asset.code : asset.source,
                }
              : {
                  contentType: 'text/html',
                  body: `<div id="root"></div><script type="module" src="/${entry.fileName}"></script>`,
                }
          )
        })
        await page.goto(`http://studyvis.test/?flow=${flow}&model=${model}`)
        await page.waitForFunction(() => window.sessionFixture)
        if (flow === 'start') {
          await page
            .getByRole('button', { name: 'Start fixture session' })
            .click()
          await page.getByRole('textbox').fill('Maths')
          await page
            .getByRole('button', { name: 'Start studying', exact: true })
            .click()
        } else {
          await page
            .getByRole('button', {
              name:
                flow === 'rejoin'
                  ? 'Rejoin fixture session'
                  : 'Resume fixture session',
            })
            .click()
        }
        await page.waitForFunction(() =>
          window.sessionFixture.traces.includes('entered')
        )
        const snapshot = await page.evaluate(() =>
          window.sessionFixture.snapshot()
        )
        assert.equal(
          snapshot.traces.filter((value) => value === 'capture').length,
          model === 'moondream2' ? 0 : 1,
          `${flow} ${model}`
        )
        assert.equal(snapshot.ai, true)
        assert.equal(snapshot.model, model === 'loading' ? null : model)
        assert.deepEqual(snapshot.records.moondream2, {
          modelId: 'moondream2',
          installedAt: 123,
          benchmark: { p95Sec: 3 },
        })
        await page.getByRole('button', { name: 'Add conversation' }).click()
        await page
          .getByRole('menuitem')
          .filter({ hasText: 'StudyVis AI' })
          .click()
        assert.equal(
          await page
            .getByRole('textbox', { name: 'Message StudyVis AI', exact: true })
            .isDisabled(),
          model !== 'qwen2_5-vl-3b'
        )
        assert.deepEqual(errors, [], `${flow} ${model}`)
        await page.evaluate(() => window.sessionFixture.dispose())
        await page.waitForFunction(() =>
          window.sessionFixture
            .snapshot()
            .tracks.every((state) => state === 'ended')
        )
        console.log('verified session entry and chat:', flow, model)
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
})
