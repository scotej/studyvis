import { spawn } from 'node:child_process'

export type ScenarioProcessResult = {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  interrupted: boolean
  stdout: string
  stderr: string
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
  }
}

export async function runScenarioProcess({
  args,
  cwd,
  timeoutMs,
  graceMs = 5_000,
  env = process.env,
  onStderr,
}: {
  args: string[]
  cwd: string
  timeoutMs: number
  graceMs?: number
  env?: NodeJS.ProcessEnv
  onStderr?: (text: string) => void
}): Promise<ScenarioProcessResult> {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const browsers = new Set<number>()
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let interrupted = false
  let killing: ReturnType<typeof setTimeout> | undefined
  const stop = (force: boolean) => {
    for (const pid of [child.pid, ...browsers]) {
      if (pid === undefined) continue
      if (process.platform === 'win32') {
        spawn(
          'taskkill',
          ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])],
          {
            stdio: 'ignore',
          }
        ).on('error', () => {})
      } else {
        signalGroup(pid, 'SIGCONT')
        signalGroup(pid, force ? 'SIGKILL' : 'SIGTERM')
      }
    }
  }
  const terminate = () => {
    if (killing) return
    stop(false)
    killing = setTimeout(() => stop(true), graceMs)
  }
  const onInterrupt = () => {
    interrupted = true
    terminate()
  }
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onInterrupt)
  child.on('message', (message: unknown) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'lab:browser' &&
      'pid' in message &&
      typeof message.pid === 'number' &&
      Number.isSafeInteger(message.pid) &&
      message.pid > 1
    ) {
      browsers.add(message.pid)
    }
  })
  child.stdout!.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    stderr += text
    onStderr?.(text)
  })
  const timeout = setTimeout(() => {
    timedOut = true
    terminate()
  }, timeoutMs)
  try {
    const outcome = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    return { ...outcome, stdout, stderr, timedOut, interrupted }
  } finally {
    clearTimeout(timeout)
    if (killing) clearTimeout(killing)
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onInterrupt)
    // Chromium owns a separate process group, so the scenario's group alone
    // cannot clean it up after a hung or abruptly terminated scenario.
    stop(true)
  }
}
