#!/usr/bin/env tsx
// `npm run lab -- <command>` — the whole harness from a shell.
//
// Output is always JSON on stdout so an agent (or jq) can consume it, and
// failures exit non-zero with the message on stderr.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

import { daemonMeta, isRunning, send } from './client'
import { probeMqttBroker, probeNostrRelay } from './net/roundtrip'
import { SOCKET_PATH } from './protocol'
import { WORK_ROOT } from './lab'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

const USAGE = `studyvis lab — run the real app as N virtual machines on this box

  up [--peers a,b] [--mode dev|built] [--headed] [--keep-data] [--run-id ID]
                              start the lab (local relay + broker + llama stub)
  down                        stop it and remove the machines' disks
  status                      what is running, plus every error counter
  doctor                      prove the transports round-trip and nothing left the box

  add-machine <name> [--clock-skew-ms N] [--video FILE] [--audio FILE]
  onboard <machine> [display-name]    walk the six onboarding screens
  mnemonic <machine>                  the 24 words currently on screen
  snapshot <machine> [--window W]     accessibility view of the screen
  text <machine>                      visible text
  click <machine> <name> [--role R] [--nth N]
  fill <machine> <name> <value> [--role R]
  press <machine> <keys>
  wait-for <machine> <text> [--timeout-ms N]
  eval <machine> <expression>
  clipboard <machine>                 what the app last copied
  screenshot <machine> <file>
  open-window <machine> <label> [--url URL]
  emit <machine> <event> [--payload JSON]      push a Tauri event, as Rust would

  db <machine> friends|sessions|audit [--session-id ID]
  identity <machine>
  settings <machine> [--set JSON]     read, or seed for the next load
  reload <machine>                    reload the window (settings take effect)
  logs <machine> [--limit N]
  calls <machine> [--limit N] [--cmd SUBSTRING]
  notifications <machine>     recorded notifications, dialogs, windows, shortcuts

  llama status|requests|push <content>
  fault relay|broker --faults JSON

  run <scenario.ts> [args...]  run a scenario file against a fresh lab
  scenarios                    list the scenarios in lab/scenarios/
`

type Flags = Record<string, string | boolean>

function parse(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = []
  const flags: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true
    } else {
      flags[key] = next
      i++
    }
  }
  return { positional, flags }
}

function camel(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function maybeJson(value: string | boolean | undefined): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

async function up(flags: Flags): Promise<void> {
  if (isRunning()) fail("lab: already up — run 'down' first, or use 'status'")
  mkdirSync(WORK_ROOT, { recursive: true })
  if (existsSync(SOCKET_PATH)) rmSync(SOCKET_PATH)

  const options = {
    mode: (flags.mode as string) ?? 'dev',
    headless: flags.headed !== true,
    keepData: flags['keep-data'] === true,
    runId: flags['run-id'] as string | undefined,
    chromeChannel: flags['chrome-channel'] as string | undefined,
    chromeExecutable: flags['chrome-executable'] as string | undefined,
  }
  const daemonPath = path.join(import.meta.dirname, 'daemon.ts')
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', daemonPath, JSON.stringify(options)],
    { cwd: REPO_ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 120_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('lab: ready')) {
        clearTimeout(timer)
        resolve(true)
      }
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
  if (!ready) fail(`lab: the daemon failed to start\n${stderr}`)
  // Detaching the child is not enough: the piped stdio handles stay referenced
  // by this event loop, so `up` would never exit even though the daemon is
  // ready and independent.
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.unref()

  const peers = typeof flags.peers === 'string' ? flags.peers.split(',') : []
  for (const name of peers.map((p) => p.trim()).filter(Boolean)) {
    try {
      await send('add-machine', { name })
    } catch (err) {
      fail(
        `lab: the lab is up but machine '${name}' failed to start — ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  json({ ...daemonMeta(), machines: peers })
}

async function doctor(): Promise<void> {
  const meta = daemonMeta()
  if (!meta || !isRunning()) fail("lab: not up — run 'npm run lab -- up' first")
  const [nostr, mqtt, status] = await Promise.all([
    probeNostrRelay(meta.relay),
    probeMqttBroker(`${meta.broker}/mqtt`),
    send('status') as Promise<{
      egressAttempts: string[]
      machines: unknown[]
    }>,
  ])
  const offline = status.egressAttempts.length === 0
  const ok = nostr.ok && mqtt.ok && offline
  json({
    ok,
    relayRoundTrip: nostr,
    brokerRoundTrip: mqtt,
    offline,
    egressAttempts: status.egressAttempts,
    machines: status.machines,
  })
  if (!ok) process.exit(1)
}

async function run(argv: string[]): Promise<void> {
  const file = argv[0]
  if (!file) fail('lab: run needs a scenario file')
  const resolved = path.resolve(
    existsSync(file)
      ? file
      : path.join(import.meta.dirname, '../scenarios', file)
  )
  if (!existsSync(resolved)) fail(`lab: no scenario at ${resolved}`)
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolved, ...argv.slice(1)],
    { cwd: REPO_ROOT, stdio: 'inherit' }
  )
  const code: number = await new Promise((resolve) =>
    child.on('exit', (c) => resolve(c ?? 1))
  )
  process.exit(code)
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE)
    return
  }
  const { positional, flags } = parse(rest)

  if (command === 'up') return up(flags)
  if (command === 'doctor') return doctor()
  if (command === 'run') return run(positional)
  if (command === 'scenarios') {
    const dir = path.join(import.meta.dirname, '../scenarios')
    const { readdirSync } = await import('node:fs')
    json({
      scenarios: existsSync(dir)
        ? readdirSync(dir).filter((f) => f.endsWith('.ts'))
        : [],
    })
    return
  }

  const args: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(flags)) {
    args[camel(key)] = maybeJson(value)
  }

  // Positional shorthands, so the common calls stay short at a shell.
  switch (command) {
    case 'add-machine':
      args.name = positional[0]
      break
    case 'onboard':
      args.machine = positional[0]
      if (positional[1]) args.name = positional[1]
      break
    case 'snapshot':
    case 'text':
    case 'mnemonic':
    case 'identity':
    case 'clipboard':
    case 'reload':
    case 'settings':
    case 'logs':
    case 'calls':
    case 'notifications':
      args.machine = positional[0]
      break
    case 'click':
    case 'wait-for':
    case 'press':
    case 'eval':
    case 'screenshot':
      args.machine = positional[0]
      args[
        command === 'press'
          ? 'keys'
          : command === 'wait-for'
            ? 'text'
            : command === 'eval'
              ? 'expression'
              : command === 'screenshot'
                ? 'file'
                : 'name'
      ] = positional[1]
      break
    case 'fill':
      args.machine = positional[0]
      args.name = positional[1]
      args.value = positional[2]
      break
    case 'open-window':
      args.machine = positional[0]
      args.label = positional[1]
      break
    case 'emit':
      args.machine = positional[0]
      args.event = positional[1]
      break
    case 'db':
      args.machine = positional[0]
      args.table = positional[1]
      break
    case 'llama':
      args.action = positional[0] ?? 'status'
      if (positional[0] === 'push') args.content = positional[1]
      break
    case 'fault':
      args.target = positional[0]
      break
    default:
      break
  }

  try {
    const result = await send(command, args)
    // These two answer with a document meant to be read, not parsed; escaping
    // it into a JSON string makes it unusable at a glance.
    if (command === 'snapshot' || command === 'text') {
      process.stdout.write(
        `${String((result as Record<string, string>)[command])}\n`
      )
      return
    }
    json(result)
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}

await main()
