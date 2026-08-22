// The verbs a scenario (or an agent at the CLI) drives a machine with.
//
// Everything addresses the UI the way a user or a screen reader does — by role
// and accessible name — so a scenario reads like the thing it is testing and
// breaks when the app becomes unusable, not when a class name changes. That
// also keeps the harness honest about accessibility: an element the lab cannot
// name is an element assistive tech cannot name either.

import type { Locator, Page } from 'playwright-core'

export const DEFAULT_TIMEOUT_MS = 10_000

export type ClickOptions = {
  role?: string
  exact?: boolean
  nth?: number
  timeoutMs?: number
}

export async function snapshot(page: Page): Promise<string> {
  return page.locator('body').ariaSnapshot()
}

export async function text(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText)
}

function target(page: Page, name: string, options: ClickOptions): Locator {
  const byRole = page.getByRole(
    (options.role ?? 'button') as Parameters<Page['getByRole']>[0],
    { name, exact: options.exact ?? false }
  )
  return options.nth === undefined ? byRole.first() : byRole.nth(options.nth)
}

export async function click(
  page: Page,
  name: string,
  options: ClickOptions = {}
): Promise<void> {
  await target(page, name, options).click({
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
}

export async function fill(
  page: Page,
  name: string,
  value: string,
  options: ClickOptions = {}
): Promise<void> {
  // Spreading `options` last would let an explicit `role: undefined` win and
  // silently fall back to the button role.
  await target(page, name, {
    ...options,
    role: options.role ?? 'textbox',
  }).fill(value, {
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
}

export async function press(page: Page, keys: string): Promise<void> {
  await page.keyboard.press(keys)
}

/** Waits for text to appear anywhere on screen. The workhorse assertion. */
export async function waitForText(
  page: Page,
  needle: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<void> {
  await page
    .getByText(needle, { exact: false })
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
}

export async function waitForGone(
  page: Page,
  needle: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<void> {
  await page
    .getByText(needle, { exact: false })
    .first()
    .waitFor({ state: 'hidden', timeout: timeoutMs })
}

export async function isVisible(page: Page, needle: string): Promise<boolean> {
  return page
    .getByText(needle, { exact: false })
    .first()
    .isVisible()
    .catch(() => false)
}

/** Reads a value the page exposes on `window`, for state a screen doesn't show. */
export async function evaluate<T>(page: Page, expression: string): Promise<T> {
  return page.evaluate(`(() => (${expression}))()`) as Promise<T>
}

export async function screenshot(page: Page, file: string): Promise<void> {
  await page.screenshot({ path: file, fullPage: false })
}

/** Polls until `check` returns true. Used for cross-machine convergence, where
 *  the thing being waited on is another machine's state, not a DOM node. */
export async function until(
  check: () => Promise<boolean> | boolean,
  { timeoutMs = 20_000, intervalMs = 200, label = 'condition' } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) {
      throw new Error(
        `lab: timed out after ${timeoutMs}ms waiting for ${label}`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
