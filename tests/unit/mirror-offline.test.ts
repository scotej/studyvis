import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import type { Rollup } from 'vite'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { mirrorOfflinePlugin } from '../../scripts/mirror-offline'
import { registerMirrorOffline } from '@/features/mirror/offline'

const directories: string[] = []
type WorkerEvent = {
  waitUntil: (promise: Promise<unknown>) => void
  respondWith: (promise: Promise<unknown>) => void
  request?: { url: string; method: string }
  data?: unknown
  source?: { id: string }
}
type Client = { id: string; postMessage: ReturnType<typeof vi.fn> }

function build(version: string) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mirror-offline-'))
  directories.push(directory)
  const bundle = {
    'mirror.html': {
      type: 'asset',
      fileName: 'mirror.html',
      source: `<html><head></head><body>${version}</body></html>`,
    },
    [`assets/mirror-${version}.js`]: {
      type: 'chunk',
      fileName: `assets/mirror-${version}.js`,
      name: 'mirror',
      isEntry: true,
      code: version,
      imports: [],
      dynamicImports: [`assets/lazy-${version}.js`],
    },
    [`assets/lazy-${version}.js`]: {
      type: 'chunk',
      fileName: `assets/lazy-${version}.js`,
      code: `lazy ${version}`,
      imports: [],
      dynamicImports: [],
    },
  } as unknown as Rollup.OutputBundle
  const write = mirrorOfflinePlugin().writeBundle as (
    options: { dir: string },
    bundle: Rollup.OutputBundle
  ) => void
  write({ dir: directory }, bundle)
  const source = readFileSync(path.join(directory, 'mirror-sw.js'), 'utf8')
  const html = readFileSync(path.join(directory, 'mirror.html'), 'utf8')
  const cache = html.match(/content="(studyvis-mirror-[a-f0-9]{16})"/)![1]
  return { source, html, cache }
}

function worker(
  generation: ReturnType<typeof build>,
  storage = new Map<string, Map<string, string>>(),
  windows: Client[] = []
) {
  const listeners = new Map<string, (event: WorkerEvent) => void>()
  const skipWaiting = vi.fn(async () => {})
  const claim = vi.fn(async () => {})
  const network = vi.fn(async () => 'network')
  const install = vi.fn(async (assets: string[]) => {
    for (const asset of assets)
      storage.get(generation.cache)!.set(asset, `${generation.cache}:${asset}`)
    storage.get(generation.cache)!.set('/', generation.html)
    storage.get(generation.cache)!.set('/mirror.html', generation.html)
  })
  runInNewContext(generation.source, {
    URL,
    fetch: network,
    self: {
      location: { origin: 'https://studyvis.local' },
      addEventListener: (type: string, handler: (event: WorkerEvent) => void) =>
        listeners.set(type, handler),
      skipWaiting,
      clients: { claim, matchAll: async () => windows },
    },
    caches: {
      keys: async () => [...storage.keys()],
      delete: async (key: string) => storage.delete(key),
      open: async (key: string) => {
        if (!storage.has(key)) storage.set(key, new Map())
        return {
          addAll: install,
          match: async (url: string) => storage.get(key)?.get(url),
        }
      },
    },
  })
  const dispatch = async (type: string, fields: Partial<WorkerEvent> = {}) => {
    const promises: Promise<unknown>[] = []
    let response: Promise<unknown> | undefined
    listeners.get(type)!({
      ...fields,
      waitUntil: (promise) => promises.push(promise),
      respondWith: (promise) => {
        response = promise
      },
    })
    await Promise.all(promises)
    return response
  }
  const report = (id: string, cache: string) =>
    dispatch('message', {
      source: { id },
      data: { type: 'studyvis-mirror-build', cache },
    })
  const fetch = (pathname: string, method = 'GET') =>
    dispatch('fetch', {
      request: { url: `https://studyvis.local${pathname}`, method },
    })
  return {
    dispatch,
    report,
    fetch,
    storage,
    windows,
    install,
    skipWaiting,
    claim,
    network,
  }
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true })
  vi.unstubAllGlobals()
})

describe('generated companion offline worker', () => {
  test('activates only after the complete shell is cached; a failed install cannot replace it', async () => {
    const generation = build('one')
    const host = worker(generation)
    await host.dispatch('install')
    expect(host.skipWaiting).toHaveBeenCalledOnce()
    expect(host.install.mock.calls[0][0]).toContain('/assets/lazy-one.js')
    expect(
      host.install.mock.calls[0][0].some((asset) => asset.startsWith('/api/'))
    ).toBe(false)
    const failed = worker(build('failed'))
    failed.install.mockRejectedValueOnce(new Error('offline'))
    await expect(failed.dispatch('install')).rejects.toThrow('offline')
    expect(failed.skipWaiting).not.toHaveBeenCalled()
  })

  test('takes control without reloading clients and retains unknown older frontend assets', async () => {
    const old = build('old')
    const next = build('next')
    const clients = [{ id: 'legacy', postMessage: vi.fn() }]
    const storage = new Map([
      [
        old.cache,
        new Map([
          ['/mirror.html', old.html],
          ['/assets/lazy-old.js', 'old lazy module'],
        ]),
      ],
      ['unrelated-cache', new Map<string, string>()],
    ])
    const host = worker(next, storage, clients)
    await host.dispatch('install')
    await host.dispatch('activate')
    expect(host.claim).toHaveBeenCalledOnce()
    expect(clients[0].postMessage).toHaveBeenCalledWith({
      type: 'studyvis-mirror-build-request',
    })
    expect(storage.has(old.cache)).toBe(true)
    expect(await host.fetch('/mirror.html')).toBe(next.html)
    expect(await host.fetch('/')).toBe(next.html)
    host.network.mockRejectedValue(new Error('offline'))
    expect(await host.fetch('/assets/lazy-old.js')).toBe('old lazy module')
    expect(host.network).not.toHaveBeenCalled()
  })

  test('keeps both live tab builds, prunes closed tabs, and recovers ownership after a worker restart', async () => {
    const old = build('old')
    const next = build('next')
    const unused = build('unused')
    const clients = [
      { id: 'old-tab', postMessage: vi.fn() },
      { id: 'next-tab', postMessage: vi.fn() },
    ]
    const storage = new Map([
      [old.cache, new Map<string, string>()],
      [unused.cache, new Map<string, string>()],
      ['unrelated-cache', new Map<string, string>()],
    ])
    const host = worker(next, storage, clients)
    await host.dispatch('install')
    const installing = build('installing')
    storage.set(installing.cache, new Map())
    await host.report('old-tab', old.cache)
    expect(storage.has(unused.cache)).toBe(true)
    await host.report('next-tab', next.cache)
    expect(storage.has(unused.cache)).toBe(false)
    expect(storage.has(installing.cache)).toBe(true)
    expect(storage.has(old.cache)).toBe(true)
    expect(storage.has('unrelated-cache')).toBe(true)
    const restarted = worker(next, storage, clients)
    await restarted.dispatch('activate')
    expect(storage.has(old.cache)).toBe(true)
    await restarted.report('next-tab', next.cache)
    expect(storage.has(old.cache)).toBe(true)
    clients.splice(0, 1)
    await restarted.report('next-tab', next.cache)
    expect(storage.has(old.cache)).toBe(false)
    expect(await restarted.fetch('/mirror.html')).toBe(next.html)
  })

  test('does not intercept API, cross-origin, non-GET, or arbitrary static URLs', async () => {
    const host = worker(build('one'))
    await host.dispatch('install')
    expect(await host.fetch('/api/socket')).toBeUndefined()
    expect(await host.fetch('/api/pair')).toBeUndefined()
    expect(await host.fetch('/mirror.html', 'POST')).toBeUndefined()
    expect(await host.fetch('/private-file')).toBeUndefined()
    expect(
      await host.dispatch('fetch', {
        request: {
          url: 'https://elsewhere.local/assets/one.js',
          method: 'GET',
        },
      })
    ).toBeUndefined()
  })

  test('reserves a complete predecessor for an in-flight old navigation, skipping failed installs', async () => {
    const old = build('old')
    const failed = build('failed')
    const next = build('next')
    const storage = new Map([
      [
        old.cache,
        new Map([
          ['/mirror.html', old.html],
          ['/assets/lazy-old.js', 'old lazy module'],
        ]),
      ],
      [failed.cache, new Map<string, string>()],
    ])
    const host = worker(next, storage)
    await host.dispatch('install')
    // No execution-ready client exists yet for HTML already returned by the
    // old worker. The failed cache is newer than the last complete old shell.
    await host.dispatch('activate')
    expect(storage.has(old.cache)).toBe(true)
    expect(storage.has(failed.cache)).toBe(false)
    host.network.mockRejectedValue(new Error('offline'))
    expect(await host.fetch('/assets/lazy-old.js')).toBe('old lazy module')
    expect(await host.fetch('/mirror.html')).toBe(next.html)
  })
})

test('frontend reports its loaded build across controller changes without reloading', async () => {
  const events = new Map<string, (event?: MessageEvent) => void>()
  const controller = { postMessage: vi.fn() }
  const requester = { postMessage: vi.fn() }
  const register = vi.fn(async () => ({}))
  const reload = vi.fn()
  vi.stubGlobal('window', { isSecureContext: true, location: { reload } })
  vi.stubGlobal('document', {
    querySelector: () => ({ content: 'studyvis-mirror-1234567890abcdef' }),
  })
  vi.stubGlobal('navigator', {
    serviceWorker: {
      controller,
      register,
      addEventListener: (
        name: string,
        handler: (event?: MessageEvent) => void
      ) => events.set(name, handler),
    },
  })
  registerMirrorOffline()
  await Promise.resolve()
  expect(register).toHaveBeenCalledWith('/mirror-sw.js', {
    updateViaCache: 'none',
  })
  events.get('controllerchange')!()
  events.get('message')!({
    data: { type: 'studyvis-mirror-build-request' },
    source: requester,
  } as unknown as MessageEvent)
  expect(controller.postMessage).toHaveBeenCalledWith({
    type: 'studyvis-mirror-build',
    cache: 'studyvis-mirror-1234567890abcdef',
  })
  expect(requester.postMessage).toHaveBeenCalledWith({
    type: 'studyvis-mirror-build',
    cache: 'studyvis-mirror-1234567890abcdef',
  })
  expect(reload).not.toHaveBeenCalled()
})
