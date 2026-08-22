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

/** Swaps self-signed contact cards both ways, confirming the safety number on
 *  each side. This is the shipped default pairing path: a pure local parse and
 *  insert, with no rendezvous — so a scenario that needs two friends can use it
 *  without depending on the relay being healthy. */
export async function pairViaContactCard(
  a: LabMachine,
  b: LabMachine
): Promise<void> {
  const cardOfA = await copyContactCard(a)
  await importContactCard(b, cardOfA)
  const cardOfB = await copyContactCard(b)
  await importContactCard(a, cardOfB)
}

async function copyContactCard(machine: LabMachine): Promise<string> {
  const page = machine.page()
  await ui.click(page, 'Add friend')
  await ui.waitForText(page, 'Your code')
  await ui.click(page, 'Copy your friend code')
  const card = await ui.clipboard(page)
  await ui.click(page, 'Cancel')
  return card
}

async function importContactCard(
  machine: LabMachine,
  card: string
): Promise<void> {
  const page = machine.page()
  await ui.click(page, 'Add friend')
  await ui.fill(page, "Your friend's code", card)
  await ui.click(page, 'Add')
  await ui.waitForText(page, 'Add this friend?')
  await ui.click(page, 'These digits match on both screens', {
    role: 'checkbox',
  })
  await ui.click(page, 'Add friend', {
    within: { role: 'dialog', name: 'Add this friend?' },
  })
}

/** Alice invites Bob and Bob accepts, leaving both in one live session. */
export async function inviteAndAccept(
  host: LabMachine,
  guest: LabMachine,
  guestFriendName: string,
  hostFriendName: string,
  topic = 'Lab work'
): Promise<void> {
  await ui.waitForText(host.page(), 'Available', 30_000)
  await ui.click(host.page(), `Invite ${guestFriendName}`)
  await declareTopicIfAsked(host, topic)
  await ui.waitForText(host.page(), 'Study session', 20_000)
  await ui.waitForText(guest.page(), 'invites you to study', 30_000)
  await ui.click(guest.page(), `Accept the invite from ${hostFriendName}`)
  await declareTopicIfAsked(guest, topic)
  await ui.waitForText(guest.page(), 'Study session', 20_000)
}

/** The topic gate only appears when AI features are on, so a scenario cannot
 *  know in advance whether it is coming. Answering it when it shows, and
 *  moving on when it does not, keeps one flow usable for both. */
export async function declareTopicIfAsked(
  machine: LabMachine,
  topic: string
): Promise<void> {
  const page = machine.page()
  const gate = page.getByRole('dialog', { name: 'What are you working on?' })
  const appeared = await gate
    .waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true)
    .catch(() => false)
  if (!appeared) return
  await ui.fill(page, 'Study topic', topic)
  await ui.click(page, 'Start studying')
}

/** Every <video> the page is currently rendering, with the state a scenario
 *  cares about: is it actually carrying live tracks and painting frames. */
export async function videoState(
  machine: LabMachine
): Promise<
  { width: number; height: number; playing: boolean; tracks: string[] }[]
> {
  return ui.evaluate(
    machine.page(),
    `Array.from(document.querySelectorAll('video')).map((video) => ({
      width: video.videoWidth,
      height: video.videoHeight,
      playing: !video.paused,
      tracks: video.srcObject
        ? video.srcObject.getTracks().map((track) => track.kind + ':' + track.readyState)
        : [],
    }))`
  )
}
