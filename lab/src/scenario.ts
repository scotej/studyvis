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

// The app writes one JSON record per line; a failure dump wants the shape, not
// the volume — warnings and errors always, plus the tail of everything else.
function tailLog(lines: string[]): string[] {
  const records = lines
    .map((line) => {
      try {
        return JSON.parse(line) as {
          lvl: string
          scope: string
          msg: string
          data?: unknown
        }
      } catch {
        return null
      }
    })
    .filter((record): record is NonNullable<typeof record> => record !== null)
  const notable = records.filter((r) => r.lvl === 'warn' || r.lvl === 'error')
  const tail = records.slice(-30)
  const chosen = [...new Set([...notable, ...tail])]
  return chosen.map(
    (r) =>
      `${r.lvl} ${r.scope} ${r.msg} ${JSON.stringify(r.data ?? {}).slice(0, 300)}`
  )
}

async function main(name: string, body: ScenarioBody): Promise<void> {
  const headed = process.argv.includes('--headed')
  const mode = process.argv.includes('--dev') ? 'dev' : 'built'
  const options: LabOptions = { headless: !headed, mode }

  const started = Date.now()
  const steps: string[] = []
  const checks: { label: string; ok: boolean }[] = []
  let failure: unknown = null

  let lab: Lab
  try {
    lab = await Lab.up(options)
  } catch (err) {
    // Nothing to tear down and nothing to snapshot, but the run still has to
    // answer in the shape a caller parses.
    process.stdout.write(
      `${JSON.stringify(
        {
          scenario: name,
          ok: false,
          ms: Date.now() - started,
          steps,
          checks,
          error: `lab failed to start: ${err instanceof Error ? err.message : String(err)}`,
        },
        null,
        2
      )}\n`
    )
    process.exit(1)
  }

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

  // Collecting diagnostics must never be the reason browsers are left running,
  // so the teardown is in a finally and a failure to gather is reported rather
  // than thrown.
  const machines: Record<string, unknown> = {}
  let egress: string[] = []
  try {
    for (const machine of lab.machines.values()) {
      machines[machine.name] = {
        windows: [...machine.pages.keys()],
        pageErrors: machine.pageErrors,
        consoleErrors: machine.consoleErrors.slice(-5),
        unhandledCommands: [...machine.backend.unhandled.keys()],
        screen: failure
          ? await ui.snapshot(machine.page()).catch(() => '<unavailable>')
          : undefined,
        // On failure the app's own structured log is the difference between
        // "bob never got the invite" and knowing which leg dropped it.
        log: failure ? tailLog(machine.backend.logLines(400)) : undefined,
      }
    }
    egress = lab.egressAttempts()
  } catch (err) {
    failure ??= err
  } finally {
    await lab.down().catch(() => {})
  }

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
