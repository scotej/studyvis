// Thin client over the daemon socket.

import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'

import { META_PATH, SOCKET_PATH, type Response } from './protocol'

export type DaemonMeta = {
  pid: number
  runId: string
  workdir: string
  app: string
  mode: string
  relay: string
  broker: string
  llama: string
  startedAt: number
}

export function daemonMeta(): DaemonMeta | null {
  if (!existsSync(META_PATH)) return null
  try {
    return JSON.parse(readFileSync(META_PATH, 'utf8')) as DaemonMeta
  } catch {
    return null
  }
}

export function isRunning(): boolean {
  const meta = daemonMeta()
  if (!meta || !existsSync(SOCKET_PATH)) return false
  try {
    process.kill(meta.pid, 0)
    return true
  } catch {
    return false
  }
}

export function send(
  command: string,
  args: Record<string, unknown> = {},
  timeoutMs = 120_000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(SOCKET_PATH)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`lab: '${command}' timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(
        new Error(
          `lab: cannot reach the daemon (${err.message}). Is it up? Run 'npm run lab -- up'.`
        )
      )
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: 1, command, args })}\n`)
    })
    let settled = false
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const index = buffer.indexOf('\n')
      if (index < 0) return
      clearTimeout(timer)
      settled = true
      let response: Response
      try {
        response = JSON.parse(buffer.slice(0, index)) as Response
      } catch {
        socket.end()
        reject(
          new Error(`lab: the daemon sent a reply this client cannot parse`)
        )
        return
      }
      socket.end()
      if (response.ok) resolve(response.result)
      else reject(new Error(response.error))
    })
    // A daemon that dies mid-command would otherwise leave the caller hanging
    // until the timeout with no clue what happened.
    socket.on('close', () => {
      if (settled) return
      clearTimeout(timer)
      reject(
        new Error(
          `lab: the daemon closed the connection before answering '${command}' — check that it is still up`
        )
      )
    })
  })
}
