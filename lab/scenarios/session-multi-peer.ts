// #325 — one host invites two online friends into the same three-person mesh.
// Drive the second invite through the in-session picker, then require live
// media from both other machines on every participant's screen.

import {
  inviteAndAccept,
  onboard,
  pairViaContactCard,
  videoState,
} from '../src/flows'
import { scenario } from '../src/scenario'

scenario('session-multi-peer', async ({ lab, step, check, ui }) => {
  step('three machines are onboarded; alice is friends with both guests')
  const alice = await lab.addMachine({ name: 'alice' })
  const bob = await lab.addMachine({ name: 'bob' })
  const carol = await lab.addMachine({ name: 'carol' })
  await Promise.all([
    onboard(alice, { displayName: 'Alice' }),
    onboard(bob, { displayName: 'Bob' }),
    onboard(carol, { displayName: 'Carol' }),
  ])
  await pairViaContactCard(alice, bob)
  await pairViaContactCard(alice, carol)
  const bothOnline = async () =>
    (await alice
      .page()
      .getByRole('button', { name: 'Invite Bob' })
      .isVisible()) &&
    (await alice
      .page()
      .getByRole('button', { name: 'Invite Carol' })
      .isVisible())
  await ui.until(bothOnline, {
    label: 'both invitees to appear online',
    timeoutMs: 30_000,
  })
  check('both guests are online before inviting', await bothOnline())

  step('alice invites bob and bob joins the session')
  await inviteAndAccept(alice, bob, 'Bob', 'Alice')
  await ui.waitForText(alice.page(), 'Bob joined', 30_000)

  step('alice uses the live-session picker to invite carol')
  await ui.click(alice.page(), 'Invite a friend to this session')
  await ui.click(alice.page(), 'Invite Carol to this session')
  await ui.waitForText(carol.page(), 'invites you to study', 30_000)
  await ui.click(carol.page(), 'Accept the invite from Alice')
  await ui.waitForText(carol.page(), 'Study session', 20_000)
  await ui.press(alice.page(), 'Escape')

  step('all three participants see each other')
  for (const [machine, first, second] of [
    [alice, 'Bob', 'Carol'],
    [bob, 'Alice', 'Carol'],
    [carol, 'Alice', 'Bob'],
  ] as const) {
    await ui.waitForText(machine.page(), first, 30_000)
    await ui.waitForText(machine.page(), second, 30_000)
    const screen = await ui.text(machine.page())
    check(
      `${machine.name} sees both other participants`,
      screen.includes(first) && screen.includes(second)
    )
  }

  step('each participant paints live media from two remote peers')
  for (const machine of [alice, bob, carol]) {
    const remoteVideos = async () =>
      (await videoState(machine)).filter(
        (video) =>
          !video.muted &&
          video.width > 0 &&
          video.playing &&
          video.tracks.includes('video:live') &&
          video.tracks.includes('audio:live')
      )
    await ui.until(async () => (await remoteVideos()).length >= 2, {
      label: `${machine.name} to paint two remote camera streams`,
      timeoutMs: 30_000,
    })
    check(
      `${machine.name} has two live remote streams`,
      (await remoteVideos()).length >= 2
    )
  }

  check(
    'no page errors or unhandled IPC',
    [alice, bob, carol].every(
      (machine) =>
        machine.pageErrors.length === 0 && machine.backend.unhandled.size === 0
    )
  )
})
