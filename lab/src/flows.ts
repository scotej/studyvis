// Flows a scenario would otherwise repeat: the multi-screen journeys that are
// setup for the thing under test rather than the thing itself.
//
// They drive the real UI — no shortcut that writes a store file and calls it
// onboarded — because the setup path is also a path that can break.

import type { LabMachine } from './machine'
import * as ui from './ui'

export type OnboardOptions = {
  displayName: string
  /** Pair during onboarding instead of skipping the step. */
  addFriend?: boolean
}

/** Welcome → permissions → new identity → display name → friends → tips. */
export async function onboard(
  machine: LabMachine,
  options: OnboardOptions
): Promise<void> {
  const page = machine.page()

  await ui.waitForText(page, "Let's set you up")
  await ui.click(page, 'Set up StudyVis')

  await ui.waitForText(page, 'A few permissions')
  // Camera and microphone are already granted by the fake devices; only the
  // notification permission has a button, and only until it is granted.
  await ui.click(page, 'Grant').catch(() => {})
  await ui.click(page, 'Continue')

  await ui.waitForText(page, 'Set up your identity')
  await ui.click(page, 'Create a new identity')

  await ui.waitForText(page, 'Save these 24 words')
  await ui.click(page, "I've saved these words", { role: 'checkbox' })
  await ui.click(page, 'Continue')

  await ui.waitForText(page, 'What should friends see?')
  await ui.fill(page, 'Display name', options.displayName)
  await ui.click(page, 'Continue')

  await ui.waitForText(page, 'Add your first friend')
  if (!options.addFriend) await ui.click(page, 'Skip for now')

  if (!options.addFriend) {
    await ui.waitForText(page, 'How a session works')
    await ui.click(page, 'Get started')
    await ui.waitForText(page, 'Friends')
  }
}

/** The 24 words currently on screen, in order. Scenarios use this to test
 *  recovery; it is deliberately the only place the lab reads a mnemonic. */
export async function readMnemonic(machine: LabMachine): Promise<string[]> {
  const items = await machine
    .page()
    .getByRole('region', { name: '24-word recovery phrase' })
    .getByRole('listitem')
    .allInnerTexts()
  return items.map((item) => item.trim().split(/\s+/).pop() ?? '')
}
