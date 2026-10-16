import type { TestRunnerConfig } from '@storybook/test-runner'
import { STORY_FINISHED, UPDATE_GLOBALS } from 'storybook/internal/core-events'

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
    emit(event: string, payload: unknown): void
    on(event: string, listener: (data: FinishedStory) => void): void
    off(event: string, listener: (data: FinishedStory) => void): void
  }
  __STORYBOOK_PREVIEW__?: {
    ready(): Promise<void>
    storyStore?: { userGlobals?: { get(): { theme?: string } } }
  }
  __studyvisA11y?: {
    storyId: string
    listener: (data: FinishedStory) => void
    finished?: FinishedStory
  }
}

const config: TestRunnerConfig = {
  async prepare({ page }) {
    const theme = process.env.STUDYVIS_A11Y_THEME ?? 'dark'
    if (theme !== 'dark' && theme !== 'light') {
      throw new Error(`Unsupported accessibility theme: ${theme}`)
    }
    const url = new URL('iframe.html', process.env.TARGET_URL)
    await page.setViewportSize({ width: 1024, height: 640 })
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme })
    await page.goto(url.toString(), { waitUntil: 'load' })
    await page.waitForFunction(
      () => {
        const preview = (window as AuditWindow).__STORYBOOK_PREVIEW__
        if (!preview) return false
        return preview.ready().then(() => {
          if (!preview.storyStore?.userGlobals)
            throw new Error('Storybook initialized without user globals')
          return true
        })
      },
      undefined,
      { timeout: 30_000 }
    )
    // With no initial story selection, Storybook ignores URL globals. Update
    // its initialized store before the runner selects the first story.
    await page.evaluate(
      ({ theme, event }) => {
        ;(window as AuditWindow).__STORYBOOK_ADDONS_CHANNEL__.emit(event, {
          globals: { theme },
        })
      },
      { theme, event: UPDATE_GLOBALS }
    )
    await page.waitForFunction(
      (expected) =>
        (
          window as AuditWindow
        ).__STORYBOOK_PREVIEW__?.storyStore?.userGlobals?.get().theme ===
        expected,
      theme
    )
  },
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
    const theme = process.env.STUDYVIS_A11Y_THEME ?? 'dark'
    await page.waitForFunction(
      (expected) => document.documentElement.dataset.theme === expected,
      theme
    )
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
