// The lab's verb table. One place, so the CLI, the daemon and a scenario file
// all drive a machine through exactly the same operations.

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
