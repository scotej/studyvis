export type ExpectedFailure = {
  machine: string
  kind: 'page-error' | 'unhandled-command'
  pattern: RegExp
  count: number
}

export type MachineFailures = {
  name: string
  pageErrors: readonly { message: string }[]
  unhandled: ReadonlyMap<string, number>
}

export function unexpectedScenarioFailures(
  machines: readonly MachineFailures[],
  expected: readonly ExpectedFailure[]
): string[] {
  const remaining = expected.map((entry) => ({ ...entry, seen: 0 }))
  const problems: string[] = []
  for (const machine of machines) {
    const observations = [
      ...machine.pageErrors.map(({ message }) => ({
        kind: 'page-error' as const,
        message,
        count: 1,
      })),
      ...[...machine.unhandled].map(([message, count]) => ({
        kind: 'unhandled-command' as const,
        message,
        count,
      })),
    ]
    for (const observation of observations) {
      const allowance = remaining.find((entry) => {
        entry.pattern.lastIndex = 0
        return (
          entry.machine === machine.name &&
          entry.kind === observation.kind &&
          entry.pattern.test(observation.message)
        )
      })
      if (allowance) allowance.seen += observation.count
      else {
        problems.push(
          `${machine.name}: unexpected ${observation.kind}: ${observation.message}`
        )
      }
    }
  }
  for (const entry of remaining) {
    if (entry.seen !== entry.count) {
      problems.push(
        `${entry.machine}: expected ${entry.count} ${entry.kind} matching ${entry.pattern}, observed ${entry.seen}`
      )
    }
  }
  return problems
}
