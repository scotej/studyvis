// The lab itself: local transports, the app server, and N machines.
//
// Everything a StudyVis install would reach over the internet is replaced by a
// loopback equivalent that speaks the same protocol — the Nostr relays and MQTT
// brokers the app pins, and the llama-server sidecar. Nothing else is allowed
// out (see machine.ts), so a lab run is offline by construction rather than by
// convention.

import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

import { DEFAULT_MQTT_BROKER_URLS } from '@/lib/trystero/mqttRelayUrls'
import { DEFAULT_RELAY_URLS } from '@/lib/trystero/relayUrls'

import {
  startAppServer,
  type AppServerHandle,
  type AppServerMode,
} from './appServer'
import { LabMachine, type MachineMedia } from './machine'
import { startLlamaStub, type LlamaStubHandle } from './net/llamaStub'
import { startMqttBroker, type MqttBrokerHandle } from './net/mqttBroker'
import { startNostrRelay, type NostrRelayHandle } from './net/nostrRelay'

export const WORK_ROOT = path.resolve(import.meta.dirname, '../.work')

export type LabOptions = {
  mode?: AppServerMode
  headless?: boolean
  /** Reuse a previous run's workdir instead of starting from empty disks. */
  runId?: string
  keepData?: boolean
  chromeChannel?: string
  chromeExecutable?: string
}

export type AddMachineOptions = {
  name: string
  media?: MachineMedia
  clockSkewMs?: number
  settings?: Record<string, unknown>
  appState?: Record<string, unknown>
}

export class Lab {
  readonly runId: string
  readonly workdir: string
  readonly app: AppServerHandle
  readonly relay: NostrRelayHandle
  readonly broker: MqttBrokerHandle
  readonly llama: LlamaStubHandle
  readonly machines = new Map<string, LabMachine>()

  private readonly options: LabOptions

  private constructor(
    runId: string,
    workdir: string,
    app: AppServerHandle,
    relay: NostrRelayHandle,
    broker: MqttBrokerHandle,
    llama: LlamaStubHandle,
    options: LabOptions
  ) {
    this.runId = runId
    this.workdir = workdir
    this.app = app
    this.relay = relay
    this.broker = broker
    this.llama = llama
    this.options = options
  }

  static async up(options: LabOptions = {}): Promise<Lab> {
    const runId = options.runId ?? `run-${Date.now().toString(36)}`
    const workdir = path.join(WORK_ROOT, runId)
    if (!options.keepData) rmSync(workdir, { recursive: true, force: true })
    mkdirSync(workdir, { recursive: true })

    const [app, relay, broker, llama] = await Promise.all([
      startAppServer(options.mode ?? 'dev'),
      startNostrRelay(),
      startMqttBroker(),
      startLlamaStub(),
    ])
    return new Lab(runId, workdir, app, relay, broker, llama, options)
  }

  /** Maps every pinned public endpoint onto this run's loopback twin. */
  websocketRewrites(): Record<string, string> {
    const rewrites: Record<string, string> = {}
    for (const url of DEFAULT_RELAY_URLS) {
      rewrites[url] = this.relay.url
      rewrites[new URL(url).hostname] = this.relay.url
    }
    for (const url of DEFAULT_MQTT_BROKER_URLS) {
      rewrites[url] = this.broker.url
      rewrites[new URL(url).hostname] = this.broker.url
    }
    return rewrites
  }

  async addMachine(options: AddMachineOptions): Promise<LabMachine> {
    if (this.machines.has(options.name)) {
      throw new Error(`lab: machine '${options.name}' already exists`)
    }
    const machine = await LabMachine.start({
      name: options.name,
      workdir: path.join(this.workdir, options.name),
      appUrl: this.app.url,
      websocketRewrites: this.websocketRewrites(),
      allowedOrigins: [this.app.url, this.llama.url],
      headless: this.options.headless ?? true,
      media: options.media,
      clockSkewMs: options.clockSkewMs,
      settings: {
        // The app's own debug-log setting, on by default here: it is the
        // difference between `lab logs` showing five records and showing the
        // discovery/invite/session trace a failure is diagnosed from. A
        // scenario that wants shipped-default logging can override it.
        debug_log_enabled: true,
        ...options.settings,
      },
      appState: options.appState,
      chromeChannel: this.options.chromeChannel,
      chromeExecutable: this.options.chromeExecutable,
    })
    this.machines.set(options.name, machine)
    return machine
  }

  machine(name: string): LabMachine {
    const machine = this.machines.get(name)
    if (!machine) {
      throw new Error(
        `lab: no machine '${name}' (have: ${[...this.machines.keys()].join(', ') || 'none'})`
      )
    }
    return machine
  }

  /** Every non-loopback request any machine tried to make. Empty is the pass. */
  egressAttempts(): string[] {
    const attempts: string[] = []
    for (const machine of this.machines.values()) {
      attempts.push(...machine.blockedRequests)
    }
    return attempts
  }

  async down(): Promise<void> {
    await Promise.all([...this.machines.values()].map((m) => m.close()))
    this.machines.clear()
    await Promise.all([
      this.relay.close(),
      this.broker.close(),
      this.llama.close(),
      this.app.close(),
    ])
  }
}
