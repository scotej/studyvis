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
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)))
})
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith('studyvis-mirror-') && key !== CACHE)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname.startsWith('/api/') || !ASSETS.includes(url.pathname)) return
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(url.pathname)
    return cached || fetch(event.request)
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
      writeFileSync(path.join(options.dir ?? 'dist', 'mirror-sw.js'), source)
    },
  }
}
