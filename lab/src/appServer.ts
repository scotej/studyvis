// Serves the app under test.
//
// Two modes, and the difference is not cosmetic. `built` serves `dist/` — the
// bytes that ship — and is the DEFAULT. `dev` runs the Vite server, where
// StrictMode double-invokes every effect: rooms are joined and left in a loop,
// so trystero never holds a subscription long enough to meet a peer and no
// two machines ever connect. That makes dev mode useful for looking at screens
// and useless for anything peer-to-peer. Use it knowingly.

import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
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
  await buildIfStale(root)
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

// Running a scenario against yesterday's bundle and believing the result is the
// one mistake this mode invites, so the bundle is rebuilt whenever anything it
// is made of is newer than it.
async function buildIfStale(root: string): Promise<void> {
  const index = path.join(root, 'index.html')
  const builtAt = existsSync(index) ? statSync(index).mtimeMs : 0
  if (builtAt > 0 && newestSourceMs() <= builtAt) return
  process.stderr.write('lab: building the app bundle…\n')
  const build = spawn('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  })
  const code: number = await new Promise((resolve) =>
    build.on('exit', (value) => resolve(value ?? 1))
  )
  if (code !== 0 || !existsSync(index)) {
    throw new Error('lab: `npm run build` failed — fix the build, then retry')
  }
}

function newestSourceMs(): number {
  let newest = 0
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      newest = Math.max(newest, statSync(full).mtimeMs)
    }
  }
  walk(path.join(REPO_ROOT, 'src'))
  for (const file of ['index.html', 'vite.config.ts', 'package.json']) {
    const full = path.join(REPO_ROOT, file)
    if (existsSync(full)) newest = Math.max(newest, statSync(full).mtimeMs)
  }
  return newest
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
