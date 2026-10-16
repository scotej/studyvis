import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { build } from 'vite'
import {
  getModel,
  modelDownloadUrls,
  type ModelFileSpec,
} from '../src/features/ai/models'

const repo = path.resolve(import.meta.dirname, '..')
const triple = 'x86_64-unknown-linux-gnu'
const model = getModel('qwen2_5-vl-3b')!

export async function verifyPinnedFile(
  file: string,
  pin: Pick<ModelFileSpec, 'sizeBytes' | 'sha256'>
): Promise<string> {
  assert.equal(
    statSync(file).size,
    pin.sizeBytes,
    `${file}: pinned size mismatch`
  )
  const digest = await fileDigest(file)
  assert.equal(digest, pin.sha256, `${file}: pinned SHA-256 mismatch`)
  return digest
}

async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function options(argv: string[]): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    assert.ok(
      [
        '--models-dir',
        '--fixture',
        '--output',
        '--prepare-models',
        '--print-model-manifest',
      ].includes(key),
      `unknown option ${key}`
    )
    values[key] =
      key === '--prepare-models' || key === '--print-model-manifest'
        ? true
        : argv[++i]
    assert.notEqual(values[key], undefined, `${key} needs a value`)
  }
  return values
}

async function prepareModels(dir: string, download: boolean): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const urls = modelDownloadUrls(model)
  for (const [kind, pin] of [
    ['model', model.modelFile],
    ['mmproj', model.mmprojFile],
  ] as const) {
    const file = path.join(dir, pin.localFilename)
    if (!existsSync(file)) {
      assert.ok(download, `${file} is missing; run --prepare-models first`)
      const response = await fetch(urls[kind], {
        signal: AbortSignal.timeout(15 * 60_000),
      })
      assert.ok(
        response.ok && response.body,
        `model download HTTP ${response.status}`
      )
      const { createWriteStream } = await import('node:fs')
      const { pipeline } = await import('node:stream/promises')
      const temporary = `${file}.part`
      const reader = response.body.getReader()
      async function* chunks() {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) return
            yield value
          }
        } finally {
          await reader.cancel()
          reader.releaseLock()
        }
      }
      try {
        await pipeline(chunks(), createWriteStream(temporary, { flags: 'wx' }))
        await verifyPinnedFile(temporary, pin)
        const { renameSync } = await import('node:fs')
        renameSync(temporary, file)
      } finally {
        rmSync(temporary, { force: true })
      }
    }
    await verifyPinnedFile(file, pin)
  }
}

class NativeFixture {
  readonly child: ChildProcessWithoutNullStreams
  readonly calls: string[] = []
  private sequence = 0
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  readonly ready: Promise<void>

  constructor(executable: string, root: string, log: string) {
    this.child = spawn(executable, [], {
      detached: true,
      env: {
        ...process.env,
        STUDYVIS_CI_AI_ROOT: root,
        XDG_DATA_HOME: path.join(root, 'data'),
        XDG_CONFIG_HOME: path.join(root, 'config'),
        XDG_CACHE_HOME: path.join(root, 'cache'),
        XDG_RUNTIME_DIR: path.join(root, 'runtime'),
      },
    })
    this.child.stderr.on('data', (chunk: Buffer) => {
      appendFileSync(log, chunk)
    })
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('native canary startup deadline')),
        30_000
      )
      const lines = createInterface({ input: this.child.stdout })
      lines.on('line', (line) => {
        let message: {
          ready?: boolean
          id?: number
          result?: unknown
          error?: string
        }
        try {
          message = JSON.parse(line)
        } catch {
          reject(new Error(`invalid native fixture JSON: ${line}`))
          return
        }
        if (message.ready) {
          clearTimeout(timer)
          resolve()
          return
        }
        if (message.id === undefined) return
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) pending?.reject(new Error(message.error))
        else pending?.resolve(message.result)
      })
      const exited = (error: Error) => {
        clearTimeout(timer)
        reject(error)
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
      }
      this.child.once('error', exited)
      this.child.once('exit', (code, signal) =>
        exited(new Error(`native fixture exited ${signal ?? code}`))
      )
    })
  }

  async invoke(
    command: string,
    args: unknown = {},
    timeoutMs = 120_000
  ): Promise<unknown> {
    await this.ready
    const id = ++this.sequence
    this.calls.push(command)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${command}: native deadline`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.child.stdin.write(`${JSON.stringify({ id, cmd: command, args })}\n`)
    })
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    await this.invoke('sidecar_stop', {}, 5000).catch(() => {})
    this.child.stdin.end()
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        if (this.child.pid) {
          try {
            process.kill(-this.child.pid, 'SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        }
        resolve()
      }, 5000)
      this.child.once('exit', () => {
        clearTimeout(kill)
        resolve()
      })
    })
  }
}

function enginePids(executable: string): number[] {
  return readdirSync('/proc').flatMap((entry) => {
    if (!/^\d+$/.test(entry)) return []
    try {
      return readlinkSync(`/proc/${entry}/exe`) === executable
        ? [Number(entry)]
        : []
    } catch {
      return []
    }
  })
}

const browserRuntime = `export { run } from ${JSON.stringify(path.join(repo, 'lab/src/aiInference.ts'))};`

async function main(argv = process.argv.slice(2)): Promise<void> {
  const opts = options(argv)
  if (opts['--print-model-manifest']) {
    console.log(
      JSON.stringify(
        {
          id: model.id,
          revision: model.hfRevision,
          urls: modelDownloadUrls(model),
          files: [model.modelFile, model.mmprojFile],
        },
        null,
        2
      )
    )
    return
  }
  assert.equal(
    process.platform,
    'linux',
    'native CPU canary currently runs on Linux'
  )
  assert.equal(process.arch, 'x64')
  assert.equal(
    typeof opts['--models-dir'],
    'string',
    '--models-dir is required'
  )
  const modelsDir = path.resolve(String(opts['--models-dir']))
  await prepareModels(modelsDir, opts['--prepare-models'] === true)
  if (opts['--prepare-models']) return
  const fixturePath = path.resolve(
    String(
      opts['--fixture'] ??
        path.join(repo, 'src-tauri/target/debug/examples/ai_inference_fixture')
    )
  )
  const evidence = path.resolve(
    String(
      opts['--output'] ??
        path.join(repo, 'lab/.work/evidence/ai-inference.json')
    )
  )
  mkdirSync(path.dirname(evidence), { recursive: true })
  writeFileSync(
    evidence,
    `${JSON.stringify({ ok: false, status: 'running' })}\n`
  )
  writeFileSync(`${evidence}.native.log`, '')
  const scratch = path.join(repo, 'node_modules/.cache')
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(path.join(scratch, 'studyvis-ci-ai-'))
  const native = path.join(root, 'native')
  for (const dir of ['data', 'config', 'cache', 'runtime', 'native'])
    mkdirSync(path.join(root, dir), { mode: 0o700 })
  const managedModels = path.join(root, 'data/studyvis/models', model.id)
  mkdirSync(managedModels, { recursive: true })
  for (const pin of [model.modelFile, model.mmprojFile]) {
    const source = path.join(modelsDir, pin.localFilename),
      target = path.join(managedModels, pin.localFilename)
    try {
      linkSync(source, target)
    } catch {
      copyFileSync(source, target)
    }
  }
  cpSync(
    path.join(repo, 'src-tauri/binaries', `llama-runtime-${triple}`),
    native,
    { recursive: true, dereference: true }
  )
  const engine = path.join(native, 'llama-server')
  copyFileSync(
    path.join(repo, 'src-tauri/binaries', `llama-server-${triple}`),
    engine
  )
  const executable = path.join(native, 'ai_inference_fixture')
  copyFileSync(fixturePath, executable)
  chmodSync(engine, 0o755)
  chmodSync(executable, 0o755)
  const engineSha256 = await fileDigest(engine)
  const fixture = new NativeFixture(executable, root, `${evidence}.native.log`)
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let server: ReturnType<typeof createServer> | undefined
  let result: Record<string, unknown> = { ok: false }
  const startedPids: number[] = []
  try {
    await fixture.ready
    const built = await build({
      root: repo,
      logLevel: 'error',
      plugins: [
        {
          name: 'ci-ai-inference',
          resolveId: (id) =>
            id === 'ci-ai-inference' ? '\0ci-ai-inference' : undefined,
          load: (id) =>
            id === '\0ci-ai-inference' ? browserRuntime : undefined,
        },
      ],
      build: {
        write: false,
        rollupOptions: {
          input: 'ci-ai-inference',
          preserveEntrySignatures: 'strict',
        },
      },
    })
    const bundle = Array.isArray(built) ? built[0] : built
    assert.ok(
      'output' in bundle,
      'canary build unexpectedly returned a watcher'
    )
    const output = bundle.output
    const entry = output.find((item) => item.type === 'chunk' && item.isEntry)
    assert.ok(entry)
    server = createServer((request, response) => {
      const name = new URL(request.url ?? '/', 'http://local').pathname.slice(1)
      if (!name) {
        response
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end('<!doctype html><html><body></body></html>')
        return
      }
      const asset = output.find((item) => item.fileName === name)
      if (!asset) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, {
        'Content-Type':
          asset.type === 'chunk'
            ? 'text/javascript'
            : name.endsWith('.png')
              ? 'image/png'
              : 'application/octet-stream',
      })
      response.end(asset.type === 'chunk' ? asset.code : asset.source)
    })
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve)
    )
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    browser = await chromium.launch({
      headless: true,
      ...(process.env.LAB_CHROME_EXECUTABLE
        ? { executablePath: process.env.LAB_CHROME_EXECUTABLE }
        : {}),
    })
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.exposeBinding(
      '__ciNative',
      async (_source, command: string, args: unknown) => {
        const value = await fixture.invoke(command, args)
        if (command === 'sidecar_start') {
          const pids = enginePids(engine)
          assert.equal(
            pids.length,
            1,
            'native start did not own exactly one staged engine process'
          )
          startedPids.push(pids[0])
        }
        return value
      }
    )
    await page.exposeBinding(
      '__ciAssertStopped',
      async (_source, port?: number) => {
        const deadline = Date.now() + 5000
        while (enginePids(engine).length > 0 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 100))
        assert.deepEqual(
          enginePids(engine),
          [],
          'owned engine processes survived Stop'
        )
        if (port !== undefined)
          await assert.rejects(
            fetch(`http://127.0.0.1:${port}/health`, {
              signal: AbortSignal.timeout(1000),
            })
          )
      }
    )
    await page.addInitScript({
      content:
        'window.__TAURI_INTERNALS__={invoke:(command,args)=>window.__ciNative(command,args)};',
    })
    await page.goto(`http://127.0.0.1:${address.port}/`)
    const evaluation = page.evaluate(
      async (file) => (await import(/* @vite-ignore */ `/${file}`)).run(),
      entry.fileName
    )
    const deadline = setTimeout(() => {
      void browser?.close()
    }, 10 * 60_000)
    let generated: unknown
    try {
      generated = await evaluation
    } finally {
      clearTimeout(deadline)
    }
    assert.deepEqual(errors, [])
    assert.ok(
      generated &&
        typeof generated === 'object' &&
        'focusImageCount' in generated,
      'focus inference did not report its image assertion'
    )
    assert.equal(generated.focusImageCount, 2)
    assert.equal(
      fixture.calls.filter((command) => command === 'sidecar_start').length,
      2
    )
    assert.equal(
      fixture.calls.filter((command) => command === 'sidecar_stop').length,
      2
    )
    assert.equal(
      new Set(startedPids).size,
      2,
      'write-up did not start a fresh owned engine process'
    )
    result = {
      ok: true,
      model: model.id,
      revision: model.hfRevision,
      modelSha256: model.modelFile.sha256,
      projectorSha256: model.mmprojFile.sha256,
      engineExecutableSha256: engineSha256,
      ownedEnginePids: startedPids,
      generated,
      nativeCalls: fixture.calls,
    }
  } catch (error) {
    result = {
      ...result,
      error: error instanceof Error ? error.message : String(error),
      nativeCalls: fixture.calls,
    }
    throw error
  } finally {
    await browser?.close().catch(() => {})
    await fixture.close()
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()))
    const remaining = enginePids(engine)
    for (const pid of remaining) process.kill(pid, 'SIGKILL')
    result.cleanup = { leakedEngineProcesses: remaining }
    writeFileSync(evidence, `${JSON.stringify(result, null, 2)}\n`)
    rmSync(root, { recursive: true, force: true })
    assert.deepEqual(
      remaining,
      [],
      'native fixture leaked an owned engine process'
    )
  }
  console.log(JSON.stringify({ ok: true, evidence }))
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  void main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
