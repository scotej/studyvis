import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline'

import type { LabMirrorDriver } from './index'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type FixtureMessage = {
  id?: number
  result?: unknown
  error?: string
  event?: string
  payload?: unknown
}

export class MirrorFixtureDriver implements LabMirrorDriver {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 0
  private stopped = false
  private stderr = ''

  constructor(options: {
    certificateDir: string
    assetsDir: string
    emit: (event: string, payload: unknown) => void
    executable?: string
  }) {
    const root = path.resolve(import.meta.dirname, '../../..')
    this.child = spawn(
      options.executable ??
        path.join(root, 'src-tauri/target/debug/examples/mirror_fixture'),
      [options.certificateDir, options.assetsDir],
      { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-4000)
    })
    this.child.on('error', (error) => this.fail(error))
    this.child.on('exit', (code) => {
      this.fail(
        new Error(`mirror fixture exited (${code ?? 'signal'}): ${this.stderr}`)
      )
    })
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', (line) => {
      let message: FixtureMessage
      try {
        message = JSON.parse(line) as FixtureMessage
      } catch {
        this.fail(new Error('mirror fixture returned invalid JSON'))
        return
      }
      if (message.event) {
        options.emit(message.event, message.payload)
        return
      }
      if (typeof message.id !== 'number') return
      const request = this.pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer)
      this.pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error))
      else request.resolve(message.result)
    })
  }

  invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error('mirror fixture stopped'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`mirror fixture timed out on ${cmd}`))
      }, 20_000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`)
    })
  }

  suspend(): void {
    if (!this.stopped) this.child.kill('SIGSTOP')
  }

  resume(): void {
    if (!this.stopped) this.child.kill('SIGCONT')
  }

  async close(): Promise<void> {
    if (this.stopped) return
    this.resume()
    await this.invoke('mirror_stop', {}).catch(() => {})
    this.stopped = true
    this.child.stdin.end()
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL')
      }, 5000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private fail(error: Error): void {
    this.stopped = true
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
}
