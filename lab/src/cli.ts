#!/usr/bin/env tsx
// `npm run lab -- <command>` — the whole harness from a shell.
//
// Output is always JSON on stdout so an agent (or jq) can consume it, and
// failures exit non-zero with the message on stderr.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { daemonMeta, isRunning, send } from './client'
import { probeMqttBroker, probeNostrRelay } from './net/roundtrip'
import { SOCKET_PATH } from './protocol'
import { WORK_ROOT } from './lab'
import { runScenarioProcess } from './scenarioProcess'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

const USAGE = `studyvis lab — run the real app as N virtual machines on this box

  up [--peers a,b] [--mode built|dev] [--headed] [--keep-data] [--run-id ID]
                              start the lab (local relay + broker + llama stub).
                              Defaults to the built bundle and rebuilds it when
                              src/ is newer. --mode dev serves Vite instead, where
                              StrictMode's double-invoked effects churn rooms and
                              nothing peer-to-peer works.
  down                        stop it and remove the machines' disks
  status                      what is running, plus every error counter
  doctor                      prove the transports round-trip and nothing left the box

  add-machine <name> [--ai true] [--clock-skew-ms N] [--video FILE] [--audio FILE]
                              --ai gives the machine an installed, selected model
                              and a sidecar pointed at the llama stub
  onboard <machine> [display-name]    walk the six onboarding screens
  mnemonic <machine>                  the 24 words currently on screen
  snapshot <machine> [--window W]     accessibility view of the screen
  text <machine>                      visible text
  click <machine> <name> [--role R] [--nth N]
  hover <machine> <name> [--role R]   reveal a hover-gated control
  fill <machine> <name> <value> [--role R]
  press <machine> <keys>
  wait-for <machine> <text> [--timeout-ms N]
  eval <machine> <expression>
  clipboard <machine>                 what the app last copied
  screenshot <machine> <file>
  open-window <machine> <label> [--url URL]
  emit <machine> <event> [--payload JSON]      push a Tauri event, as Rust would

  peers <machine>                     every RTCPeerConnection and its state
  db <machine> friends|sessions|audit [--session-id ID]
  identity <machine>
  settings <machine> [--set JSON]     read, or seed for the next load
  reload <machine>                    reload the window (settings take effect)
  logs <machine> [--limit N]
  calls <machine> [--limit N] [--cmd SUBSTRING]
  notifications <machine>     recorded notifications, dialogs, windows, shortcuts

  llama status|requests|push <content>
  frames [--topic T] [--limit N]      recent relay frames (REQ/EVENT/CLOSE)
  subs [--topic T]                    the relay's live subscription table
  fault relay|broker --faults JSON

  run <scenario.ts> [args...]  run a scenario file against a fresh lab
  verify [--suite smoke|fault|all] [--dev] [--timeout-ms N] [--evidence-dir DIR]
                              bounded scenarios with individual JSON evidence
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
    mode: (flags.mode as string) ?? 'built',
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

// One command that runs the whole suite, because "is the app still working"
// should not require knowing the scenario list.
async function verify(flags: Flags): Promise<void> {
  const dir = path.join(import.meta.dirname, '../scenarios')
  const { readdirSync } = await import('node:fs')
  const suite = flags.suite ?? 'all'
  if (!['smoke', 'fault', 'all'].includes(String(suite))) {
    fail('lab: --suite must be smoke, fault, or all')
  }
  const faultScenarios = new Set([
    'reconnect.ts',
    'invite-recovery.ts',
    'dark-relay.ts',
  ])
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.ts'))
    .filter((file) =>
      suite === 'all'
        ? true
        : suite === 'fault'
          ? faultScenarios.has(file)
          : !faultScenarios.has(file)
    )
    .sort()
  if (files.length === 0) fail('lab: the requested suite has no scenarios')
  const evidenceDir = path.resolve(
    typeof flags['evidence-dir'] === 'string'
      ? flags['evidence-dir']
      : path.join(WORK_ROOT, 'evidence', `${suite}-${Date.now()}`)
  )
  mkdirSync(evidenceDir, { recursive: true })
  const results: {
    scenario: string
    ok: boolean
    ms: number
    error?: string
  }[] = []
  for (const file of files) {
    process.stderr.write(`\n── ${file}\n`)
    const result = await executeScenario(
      path.join(dir, file),
      flags.dev === true ? ['--dev'] : [],
      flags,
      evidenceDir
    )
    results.push(result)
    if (result.interrupted) break
  }
  const ok =
    results.length === files.length && results.every((result) => result.ok)
  const summary = { ok, suite, evidenceDir, scenarios: results }
  writeFileSync(
    path.join(evidenceDir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`
  )
  json(summary)
  if (!ok) process.exit(1)
}

function scenarioTimeout(flags: Flags): number {
  const timeoutMs = Number(flags['timeout-ms'] ?? 300_000)
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 3_600_000
  ) {
    fail('lab: --timeout-ms must be an integer from 1 to 3600000')
  }
  return timeoutMs
}

async function executeScenario(
  file: string,
  args: string[],
  flags: Flags,
  evidenceDir: string
): Promise<{
  scenario: string
  ok: boolean
  ms: number
  error?: string
  evidence: string
  interrupted: boolean
}> {
  const name = path.basename(file, path.extname(file))
  const started = Date.now()
  const outcome = await runScenarioProcess({
    args: ['--import', 'tsx', file, ...args],
    cwd: REPO_ROOT,
    timeoutMs: scenarioTimeout(flags),
    onStderr: (text) => process.stderr.write(text),
  })
  let report: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(outcome.stdout)
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('scenario' in parsed) ||
      typeof parsed.scenario !== 'string' ||
      parsed.scenario.length === 0 ||
      !('ok' in parsed) ||
      typeof parsed.ok !== 'boolean'
    )
      throw new Error('invalid scenario verdict')
    report = parsed as Record<string, unknown>
  } catch {
    report = {
      scenario: name,
      ok: false,
      error: 'no valid scenario JSON verdict',
    }
  }
  const ok =
    report.ok === true &&
    outcome.code === 0 &&
    !outcome.timedOut &&
    !outcome.interrupted
  const error = outcome.timedOut
    ? `scenario exceeded ${scenarioTimeout(flags)} ms`
    : outcome.interrupted
      ? 'scenario interrupted'
      : typeof report.error === 'string'
        ? report.error
        : outcome.code !== 0
          ? `scenario process exited with ${outcome.signal ?? outcome.code}`
          : undefined
  const evidence = path.join(evidenceDir, `${name}.json`)
  writeFileSync(
    evidence,
    `${JSON.stringify(
      {
        ...report,
        ok,
        error,
        process: {
          exitCode: outcome.code,
          signal: outcome.signal,
          timedOut: outcome.timedOut,
          interrupted: outcome.interrupted,
        },
      },
      null,
      2
    )}\n`
  )
  writeFileSync(path.join(evidenceDir, `${name}.stdout.log`), outcome.stdout)
  writeFileSync(path.join(evidenceDir, `${name}.stderr.log`), outcome.stderr)
  return {
    scenario: name,
    ok,
    ms: Date.now() - started,
    error,
    evidence,
    interrupted: outcome.interrupted,
  }
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
  const { flags } = parse(argv.slice(1))
  const evidenceDir = path.resolve(
    typeof flags['evidence-dir'] === 'string'
      ? flags['evidence-dir']
      : path.join(WORK_ROOT, 'evidence', `single-${Date.now()}`)
  )
  mkdirSync(evidenceDir, { recursive: true })
  const result = await executeScenario(
    resolved,
    argv.slice(1),
    flags,
    evidenceDir
  )
  json(result)
  if (!result.ok) process.exit(1)
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
  if (command === 'run') return run(rest)
  if (command === 'verify') return verify(flags)
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
    case 'peers':
    case 'clipboard':
    case 'reload':
    case 'settings':
    case 'logs':
    case 'calls':
    case 'notifications':
      args.machine = positional[0]
      break
    case 'click':
    case 'hover':
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
