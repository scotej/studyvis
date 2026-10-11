import type { TestRunnerConfig } from '@storybook/test-runner'
import { STORY_FINISHED } from 'storybook/internal/core-events'

type FinishedStory = {
  storyId: string
  reporters?: Array<{
    type: string
    status: string
    result?: {
      error?: { name?: string; message?: string }
      passes?: unknown[]
      violations?: unknown[]
    }
  }>
}

type AuditWindow = typeof window & {
  __STORYBOOK_ADDONS_CHANNEL__: {
    on(event: string, listener: (data: FinishedStory) => void): void
    off(event: string, listener: (data: FinishedStory) => void): void
  }
  __studyvisA11y?: {
    storyId: string
    listener: (data: FinishedStory) => void
    finished?: FinishedStory
  }
}

const config: TestRunnerConfig = {
  async preVisit(page, { id }) {
    await page.evaluate(
      ({ id, event }) => {
        const target = window as AuditWindow
        const channel = target.__STORYBOOK_ADDONS_CHANNEL__
        if (target.__studyvisA11y) {
          channel.off(event, target.__studyvisA11y.listener)
        }
        const listener = (data: FinishedStory) => {
          if (data.storyId !== id) return
          target.__studyvisA11y!.finished = data
          channel.off(event, listener)
        }
        target.__studyvisA11y = { storyId: id, listener }
        channel.on(event, listener)
      },
      { id, event: STORY_FINISHED }
    )
  },
  async postVisit(page, { id, hasFailure }) {
    // Keep the runner's detailed render, play-function, and axe failures.
    if (hasFailure) return
    // The runner rejects violations, but ignores addon exceptions and missing
    // reports. Require a completed axe audit so those cannot produce green CI.
    await page.evaluate((id) => {
      const audit = (window as AuditWindow).__studyvisA11y
      const report =
        audit?.storyId === id && audit.finished?.storyId === id
          ? audit.finished.reporters?.find((entry) => entry.type === 'a11y')
          : undefined
      if (report?.result?.error) {
        throw new Error(
          `${id}: accessibility audit failed: ${report.result.error.message ?? report.result.error.name}`
        )
      }
      if (
        report?.status !== 'passed' ||
        !Array.isArray(report.result?.passes) ||
        !Array.isArray(report.result?.violations) ||
        report.result.violations.length !== 0
      ) {
        throw new Error(`${id}: no successful zero-violation axe audit`)
      }
    }, id)
  },
}

export default config
