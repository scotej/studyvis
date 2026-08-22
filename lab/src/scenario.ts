// Scenario harness: a script that owns its own lab, start to finish.
//
// Scenarios are the durable half of the harness. The CLI is for looking around;
// a scenario is the thing you re-run after a change and the thing a reviewer
// reads to learn what is actually covered. So the runner keeps the narration
// (`step`) in the output and, on failure, dumps the screen of every machine —
// the questions you always want answered are "how far did it get" and "what was
// on screen when it stopped".

import { Lab, type LabOptions } from './lab'
import * as ui from './ui'

export type ScenarioContext = {
  lab: Lab
  step: (title: string) => void
  check: (label: string, condition: boolean) => void
  ui: typeof ui
}

export type ScenarioBody = (ctx: ScenarioContext) => Promise<void>

export function scenario(name: string, body: ScenarioBody): void {
  void main(name, body)
}

async function main(name: string, body: ScenarioBody): Promise<void> {
  const headed = process.argv.includes('--headed')
  const mode = process.argv.includes('--built') ? 'built' : 'dev'
  const options: LabOptions = { headless: !headed, mode }

  const started = Date.now()
  const steps: string[] = []
  const checks: { label: string; ok: boolean }[] = []
  let failure: unknown = null

  const lab = await Lab.up(options)
  const ctx: ScenarioContext = {
    lab,
    step(title) {
      steps.push(title)
      process.stderr.write(`  → ${title}\n`)
    },
    check(label, condition) {
      checks.push({ label, ok: condition })
      process.stderr.write(`  ${condition ? '✓' : '✗'} ${label}\n`)
      if (!condition) throw new Error(`lab: check failed — ${label}`)
    },
    ui,
  }

  process.stderr.write(`lab scenario '${name}' (${mode})\n`)
  try {
    await body(ctx)
  } catch (err) {
    failure = err
  }

  const machines: Record<string, unknown> = {}
  for (const machine of lab.machines.values()) {
    machines[machine.name] = {
      windows: [...machine.pages.keys()],
      pageErrors: machine.pageErrors,
      consoleErrors: machine.consoleErrors.slice(-5),
      unhandledCommands: [...machine.backend.unhandled.keys()],
      screen: failure
        ? await ui.snapshot(machine.page()).catch(() => '<unavailable>')
        : undefined,
    }
  }
  const egress = lab.egressAttempts()
  await lab.down()

  const ok = failure === null && egress.length === 0
  process.stdout.write(
    `${JSON.stringify(
      {
        scenario: name,
        ok,
        ms: Date.now() - started,
        steps,
        checks,
        egressAttempts: egress,
        error: failure
          ? failure instanceof Error
            ? failure.message
            : String(failure)
          : undefined,
        machines,
      },
      null,
      2
    )}\n`
  )
  process.exit(ok ? 0 : 1)
}
