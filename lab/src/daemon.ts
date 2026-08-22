// The lab as a long-lived process.
//
// Browsers take seconds to launch and a machine's whole point is accumulated
// state — an identity, a friend, a session in progress. Re-running a one-shot
// script per command would throw that away every time, so the lab stays up and
// the CLI is a thin client over a unix socket. That is also what makes the lab
// usable interactively: drive a few steps, look, drive a few more.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'

import { commands } from './commands'
import { Lab, WORK_ROOT, type LabOptions } from './lab'
import { META_PATH, SOCKET_PATH, type Request, type Response } from './protocol'

async function main(): Promise<void> {
  const options: LabOptions = JSON.parse(process.argv[2] ?? '{}')
  mkdirSync(WORK_ROOT, { recursive: true })
  if (existsSync(SOCKET_PATH)) rmSync(SOCKET_PATH)

  const lab = await Lab.up(options)

  const server = createServer((socket: Socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        void handle(line, socket)
        index = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => socket.destroy())
  })

  async function handle(line: string, socket: Socket): Promise<void> {
    let request: Request
    try {
      request = JSON.parse(line) as Request
    } catch {
      return
    }
    if (request.command === 'down') {
      reply(socket, { id: request.id, ok: true, result: { down: true } })
      await shutdown()
      return
    }
    const handler = commands[request.command]
    if (!handler) {
      reply(socket, {
        id: request.id,
        ok: false,
        error: `lab: unknown command '${request.command}' (try: ${Object.keys(commands).sort().join(', ')})`,
      })
      return
    }
    try {
      const result = await handler({ lab }, request.args ?? {})
      reply(socket, { id: request.id, ok: true, result })
    } catch (err) {
      reply(socket, {
        id: request.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function reply(socket: Socket, response: Response): void {
    if (socket.destroyed) return
    socket.write(`${JSON.stringify(response)}\n`)
  }

  async function shutdown(): Promise<void> {
    server.close()
    await lab.down().catch(() => {})
    for (const file of [SOCKET_PATH, META_PATH]) {
      if (existsSync(file)) rmSync(file)
    }
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())

  await new Promise<void>((resolve) => server.listen(SOCKET_PATH, resolve))
  writeFileSync(
    META_PATH,
    JSON.stringify(
      {
        pid: process.pid,
        runId: lab.runId,
        workdir: lab.workdir,
        app: lab.app.url,
        mode: lab.app.mode,
        relay: lab.relay.url,
        broker: lab.broker.url,
        llama: lab.llama.url,
        startedAt: Date.now(),
      },
      null,
      2
    )
  )
  // Read by `lab up` to know the daemon is ready to take commands.
  process.stdout.write(`lab: ready on ${SOCKET_PATH}\n`)
}

await main()
