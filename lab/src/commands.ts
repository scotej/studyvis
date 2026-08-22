// The lab's verb table. One place, so the CLI, the daemon and a scenario file
// all drive a machine through exactly the same operations.

import { onboard, readMnemonic } from './flows'
import { Lab, type AddMachineOptions } from './lab'
import type { LabMachine } from './machine'
import * as ui from './ui'

export type CommandContext = { lab: Lab }
export type CommandArgs = Record<string, unknown>
export type CommandResult = unknown

function machineOf(lab: Lab, args: CommandArgs): LabMachine {
  const name = String(args.machine ?? '')
  if (!name) throw new Error('lab: this command needs a machine name')
  return lab.machine(name)
}

function pageOf(lab: Lab, args: CommandArgs) {
  return machineOf(lab, args).page(String(args.window ?? 'main'))
}

export const commands: Record<
  string,
  (ctx: CommandContext, args: CommandArgs) => Promise<CommandResult>
> = {
  async status({ lab }) {
    return {
      runId: lab.runId,
      workdir: lab.workdir,
      app: { url: lab.app.url, mode: lab.app.mode },
      relay: {
        url: lab.relay.url,
        ...lab.relay.stats(),
        faults: lab.relay.faults,
      },
      broker: {
        url: lab.broker.url,
        ...lab.broker.stats(),
        faults: lab.broker.faults,
      },
      llama: {
        url: lab.llama.url,
        queued: lab.llama.queue.length,
        requests: lab.llama.requests.length,
      },
      machines: [...lab.machines.values()].map((m) => ({
        name: m.name,
        windows: [...m.pages.keys()],
        pageErrors: m.pageErrors.length,
        consoleErrors: m.consoleErrors.length,
        blockedRequests: m.blockedRequests.length,
        unhandledCommands: [...m.backend.unhandled.keys()],
      })),
      egressAttempts: lab.egressAttempts(),
    }
  },

  async 'add-machine'({ lab }, args) {
    const machine = await lab.addMachine(args as unknown as AddMachineOptions)
    return { name: machine.name, windows: [...machine.pages.keys()] }
  },

  // Getting a machine to a usable home screen is six screens of clicking that
  // every interactive session needs before the interesting part starts.
  async onboard({ lab }, args) {
    const machine = machineOf(lab, args)
    await onboard(machine, {
      displayName: String(args.name ?? machine.name),
      addFriend: args.addFriend === true,
    })
    return {
      onboarded: machine.name,
      identity: machine.backend.identity.loadRecord(),
    }
  },

  async mnemonic({ lab }, args) {
    return { words: await readMnemonic(machineOf(lab, args)) }
  },

  async snapshot({ lab }, args) {
    return { snapshot: await ui.snapshot(pageOf(lab, args)) }
  },

  async text({ lab }, args) {
    return { text: await ui.text(pageOf(lab, args)) }
  },

  async click({ lab }, args) {
    await ui.click(pageOf(lab, args), String(args.name), {
      role: args.role as string | undefined,
      exact: args.exact as boolean | undefined,
      nth: args.nth as number | undefined,
      within: args.within as { role: string; name?: string } | undefined,
    })
    return { clicked: args.name }
  },

  async fill({ lab }, args) {
    await ui.fill(pageOf(lab, args), String(args.name), String(args.value), {
      role: args.role as string | undefined,
      nth: args.nth as number | undefined,
    })
    return { filled: args.name }
  },

  async press({ lab }, args) {
    await ui.press(pageOf(lab, args), String(args.keys))
    return { pressed: args.keys }
  },

  async 'wait-for'({ lab }, args) {
    await ui.waitForText(
      pageOf(lab, args),
      String(args.text),
      Number(args.timeoutMs ?? ui.DEFAULT_TIMEOUT_MS)
    )
    return { found: args.text }
  },

  async eval({ lab }, args) {
    return {
      value: await ui.evaluate(pageOf(lab, args), String(args.expression)),
    }
  },

  // Settings are read at boot, so a file seeded under a running app takes
  // effect on the next load. Reloading is also how a scenario tests the
  // restart-shaped paths (interrupted session recovery, boot caches).
  async reload({ lab }, args) {
    const page = pageOf(lab, args)
    await page.reload({ waitUntil: 'domcontentloaded' })
    return { reloaded: args.machine }
  },

  async clipboard({ lab }, args) {
    return { text: await ui.clipboard(pageOf(lab, args)) }
  },

  async screenshot({ lab }, args) {
    await ui.screenshot(pageOf(lab, args), String(args.file))
    return { file: args.file }
  },

  async 'open-window'({ lab }, args) {
    const machine = machineOf(lab, args)
    await machine.openPage(String(args.label), String(args.url ?? lab.app.url))
    return { windows: [...machine.pages.keys()] }
  },

  async emit({ lab }, args) {
    const machine = machineOf(lab, args)
    const delivered = await machine.emit(
      String(args.event),
      args.payload ?? null,
      args.window as string | undefined
    )
    return { event: args.event, delivered }
  },

  // Trystero keeps a pool of 20 pre-generated offers PER ROOM, so a machine
  // sitting alone already holds dozens of peer connections that are closed by
  // design. Reporting the raw list reads as catastrophic failure; what matters
  // is how many are live, and of those, how many actually connected.
  async peers({ lab }, args) {
    const page = pageOf(lab, args)
    const all = await ui.evaluate<
      { connectionState: string; dataChannels: string[] }[]
    >(page, 'window.__lab.peers()')
    const live = all.filter((peer) => peer.connectionState !== 'closed')
    const states: Record<string, number> = {}
    for (const peer of all) {
      states[peer.connectionState] = (states[peer.connectionState] ?? 0) + 1
    }
    return {
      connected: all.filter((peer) => peer.connectionState === 'connected')
        .length,
      openDataChannels: all.flatMap((peer) =>
        peer.dataChannels.filter((channel) => channel.endsWith(':open'))
      ).length,
      total: all.length,
      states,
      live: args.verbose === true ? live : live.slice(0, 8),
    }
  },

  async db({ lab }, args) {
    const { backend } = machineOf(lab, args)
    switch (String(args.table)) {
      case 'friends':
        return { rows: backend.db.friendsList() }
      case 'sessions':
        return { rows: backend.db.sessionsList() }
      case 'audit':
        return {
          rows: args.sessionId
            ? backend.db.auditListForSession(String(args.sessionId))
            : backend.db.auditListAll(),
        }
      default:
        throw new Error(`lab: unknown table '${String(args.table)}'`)
    }
  },

  async identity({ lab }, args) {
    const { backend } = machineOf(lab, args)
    return {
      exists: backend.identity.exists(),
      keysPresent: backend.identity.keysPresent(),
      record: backend.identity.loadRecord(),
    }
  },

  async settings({ lab }, args) {
    const { backend } = machineOf(lab, args)
    if (args.set) {
      backend.stores.seed('settings.json', args.set as Record<string, unknown>)
    }
    return { settings: backend.stores.read('settings.json') }
  },

  async logs({ lab }, args) {
    const machine = machineOf(lab, args)
    return {
      lines: machine.backend.logLines(Number(args.limit ?? 100)),
      pageErrors: machine.pageErrors.slice(-10),
      consoleErrors: machine.consoleErrors.slice(-10),
    }
  },

  async calls({ lab }, args) {
    const { backend } = machineOf(lab, args)
    const limit = Number(args.limit ?? 40)
    const filter = args.cmd ? String(args.cmd) : null
    const calls = filter
      ? backend.calls.filter((c) => c.cmd.includes(filter))
      : backend.calls
    return { calls: calls.slice(-limit) }
  },

  async notifications({ lab }, args) {
    const { backend } = machineOf(lab, args)
    return {
      notifications: backend.notifications,
      dialogs: backend.dialogs,
      windows: backend.windows,
      shortcuts: backend.registeredShortcuts,
    }
  },

  async llama({ lab }, args) {
    const action = String(args.action ?? 'status')
    if (action === 'push') {
      lab.llama.push({ content: String(args.content) })
      return { queued: lab.llama.queue.length }
    }
    if (action === 'requests') {
      return { requests: lab.llama.requests.slice(-Number(args.limit ?? 10)) }
    }
    return {
      url: lab.llama.url,
      queued: lab.llama.queue.length,
      requests: lab.llama.requests.length,
    }
  },

  async frames({ lab }, args) {
    const limit = Number(args.limit ?? 60)
    const filter = args.topic ? String(args.topic) : null
    const frames = lab.relay
      .frames()
      .filter((frame) => (filter ? frame.detail.includes(filter) : true))
    return { frames: frames.slice(-limit) }
  },

  async subs({ lab }, args) {
    const topic = args.topic ? String(args.topic) : null
    const subs = lab.relay
      .subscriptions()
      .filter((sub) => (topic ? sub.topics.includes(topic) : true))
    return { count: subs.length, subs: subs.slice(0, Number(args.limit ?? 20)) }
  },

  async fault({ lab }, args) {
    const which = String(args.target)
    const patch = (args.faults ?? {}) as Record<string, unknown>
    if (which === 'relay') {
      Object.assign(lab.relay.faults, patch)
      return { relay: lab.relay.faults }
    }
    if (which === 'broker') {
      Object.assign(lab.broker.faults, patch)
      return { broker: lab.broker.faults }
    }
    throw new Error(`lab: unknown fault target '${which}' (relay|broker)`)
  },
}
