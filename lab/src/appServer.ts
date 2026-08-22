// Serves the app under test.
//
// Two modes, and the difference is not cosmetic: `dev` runs the Vite server, so
// React StrictMode double-invokes effects and every `import.meta.env.DEV` gate
// is live; `built` serves `dist/`, which is the bytes that ship. Iterate in dev,
// confirm in built.

import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'

import { listen } from './net/nostrRelay'

export type AppServerMode = 'dev' | 'built'

export type AppServerHandle = {
  url: string
  mode: AppServerMode
  close: () => Promise<void>
}

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const DEV_URL = 'http://localhost:1420'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

export async function startAppServer(
  mode: AppServerMode
): Promise<AppServerHandle> {
  if (mode === 'built') return startStaticServer()
  return startViteServer()
}

async function startViteServer(): Promise<AppServerHandle> {
  if (await responds(DEV_URL)) {
    // Reuse a dev server the developer already has open rather than fighting
    // it for the strict port.
    return { url: `${DEV_URL}/`, mode: 'dev', close: async () => {} }
  }
  const child: ChildProcess = spawn('npm', ['run', 'dev'], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    detached: false,
  })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await responds(DEV_URL)) {
      return {
        url: `${DEV_URL}/`,
        mode: 'dev',
        close: async () => {
          child.kill('SIGTERM')
        },
      }
    }
    await sleep(250)
  }
  child.kill('SIGTERM')
  throw new Error('lab: the Vite dev server did not come up within 60s')
}

async function startStaticServer(): Promise<AppServerHandle> {
  const root = path.join(REPO_ROOT, 'dist')
  if (!existsSync(path.join(root, 'index.html'))) {
    throw new Error(
      'lab: dist/index.html is missing — run `npm run build` before `--built`'
    )
  }
  const server = createServer((req, res) => {
    const requested = decodeURIComponent((req.url ?? '/').split('?')[0])
    const relative = requested === '/' ? 'index.html' : requested.slice(1)
    const file = path.join(root, relative)
    // Directory traversal would let a page under test read the repo.
    if (
      !file.startsWith(root) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {
      'content-type':
        CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
    })
    createReadStream(file).pipe(res)
  })
  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}/`,
    mode: 'built',
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

async function responds(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
    return response.ok
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
