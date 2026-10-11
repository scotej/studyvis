import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Plugin, Rollup } from 'vite'

export function mirrorOfflinePlugin(): Plugin {
  return {
    name: 'studyvis-mirror-offline',
    apply: 'build',
    writeBundle(options, bundle) {
      const entry = Object.values(bundle).find(
        (item): item is Rollup.OutputChunk =>
          item.type === 'chunk' && item.isEntry && item.name === 'mirror'
      )
      // Storybook shares this Vite config but has its own HTML entry.
      if (!entry) return
      const files = new Set<string>([
        '/',
        '/mirror.html',
        '/manifest.webmanifest',
        '/mirror-icon.png',
      ])
      const visit = (file: string) => {
        if (files.has(`/${file}`)) return
        files.add(`/${file}`)
        const item = bundle[file]
        if (item?.type === 'chunk')
          for (const imported of [...item.imports, ...item.dynamicImports])
            visit(imported)
      }
      visit(entry.fileName)
      for (const item of Object.values(bundle)) {
        if (item.type === 'asset' && item.fileName.startsWith('assets/'))
          files.add(`/${item.fileName}`)
      }
      const digest = createHash('sha256')
      for (const item of Object.values(bundle)) {
        if (files.has(`/${item.fileName}`) || item.fileName === 'mirror.html') {
          digest.update(item.type === 'chunk' ? item.code : item.source)
        }
      }
      const cacheName = `studyvis-mirror-${digest.digest('hex').slice(0, 16)}`
      const source = `const CACHE = ${JSON.stringify(cacheName)}
const ASSETS = ${JSON.stringify([...files])}
const builds = new Map()
async function pruneCaches() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const liveIds = new Set(windows.map(client => client.id))
  for (const id of builds.keys()) if (!liveIds.has(id)) builds.delete(id)
  let unknown = false
  for (const client of windows) {
    if (builds.has(client.id)) continue
    unknown = true
    client.postMessage({ type: 'studyvis-mirror-build-request' })
  }
  // Older frontends do not answer. Keep their assets until those tabs close;
  // querying again also recovers the map after the worker process restarts.
  if (unknown) return
  const retained = new Set([CACHE, ...builds.values()])
  const keys = await caches.keys()
  const preceding = keys.slice(0, keys.indexOf(CACHE))
  // A navigation can have received the previous HTML before its new client is
  // visible to matchAll(). Keep one complete predecessor as a bounded reserve.
  // A cache opened by a failed install must not displace that predecessor.
  for (const key of [...preceding].reverse()) {
    if (!key.startsWith('studyvis-mirror-')) continue
    if (await (await caches.open(key)).match('/mirror.html')) {
      retained.add(key)
      break
    }
  }
  // CacheStorage.keys() is creation-ordered. A later cache can belong to an
  // update that is still installing; the active worker must never delete it.
  await Promise.all(preceding.filter(key => key.startsWith('studyvis-mirror-') &&
    !retained.has(key)).map(key => caches.delete(key)))
}
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))
    .then(() => self.skipWaiting()))
})
self.addEventListener('activate', event => {
  // Changing the controller does not reload a page or interrupt its media.
  event.waitUntil(self.clients.claim().then(pruneCaches))
})
self.addEventListener('message', event => {
  if (event.data?.type !== 'studyvis-mirror-build' || !event.source?.id ||
      typeof event.data.cache !== 'string' ||
      !/^studyvis-mirror-[a-f0-9]{16}$/.test(event.data.cache)) return
  builds.set(event.source.id, event.data.cache)
  event.waitUntil(pruneCaches())
})
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname.startsWith('/api/') ||
      (!ASSETS.includes(url.pathname) && !url.pathname.startsWith('/assets/'))) return
  const navigation = url.pathname === '/' || url.pathname === '/mirror.html'
  if (navigation) event.waitUntil(pruneCaches())
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(url.pathname)
    if (cached) return cached
    // Only immutable assets may come from an older build. Never serve an old
    // HTML shell (or API response) to a new navigation.
    if (!navigation && url.pathname.startsWith('/assets/')) {
      for (const key of await caches.keys()) {
        if (!key.startsWith('studyvis-mirror-') || key === CACHE) continue
        const previous = await (await caches.open(key)).match(url.pathname)
        if (previous) return previous
      }
    }
    return fetch(event.request)
  }))
})
self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then(windows => {
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin)
    return existing ? existing.focus() : self.clients.openWindow('/')
  }))
})
`
      const directory = options.dir ?? 'dist'
      const html = bundle['mirror.html']
      if (html?.type === 'asset') {
        const original =
          typeof html.source === 'string'
            ? html.source
            : Buffer.from(html.source).toString('utf8')
        writeFileSync(
          path.join(directory, 'mirror.html'),
          original.replace(
            '<head>',
            `<head>\n    <meta name="studyvis-mirror-build" content="${cacheName}">`
          )
        )
      }
      writeFileSync(path.join(directory, 'mirror-sw.js'), source)
    },
  }
}
