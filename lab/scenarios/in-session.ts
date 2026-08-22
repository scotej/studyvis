// The things two people actually do once they are in a session together.
//
// Each of these is a separate wire message with its own failure mode, and none
// of them is reachable from a unit test: a note has to cross a data channel, a
// pomodoro has to synchronise two timers, a shared screen has to arrive as a
// second video track, and hold-to-talk has to flip a sender's enabled flag on
// a native key event that only Rust would normally send.

import { inviteAndAccept, onboard, pairViaContactCard } from '../src/flows'
import { scenario } from '../src/scenario'

scenario('in-session', async ({ lab, step, check, ui }) => {
  step('two machines in one session')
  const alice = await lab.addMachine({ name: 'alice' })
  const bob = await lab.addMachine({ name: 'bob' })
  await Promise.all([
    onboard(alice, { displayName: 'Alice' }),
    onboard(bob, { displayName: 'Bob' }),
  ])
  await pairViaContactCard(alice, bob)
  await inviteAndAccept(alice, bob, 'Bob', 'Alice')

  step('a note crosses to the other machine')
  await ui.fill(alice.page(), 'Note to your session', 'Starting chapter 3')
  await ui.click(alice.page(), 'Send the note')
  await ui.waitForText(bob.page(), 'Starting chapter 3', 20_000)
  check(
    'bob received the note',
    await ui.isVisible(bob.page(), 'Starting chapter 3')
  )

  step('a pomodoro started on one side runs on both')
  await ui.click(alice.page(), 'Open Pomodoro menu')
  await ui.click(alice.page(), 'Start')
  await ui.waitForText(alice.page(), 'Focus', 20_000)
  await ui.waitForText(bob.page(), 'Focus', 20_000)
  check(
    'bob logged that alice started it',
    (await ui.text(bob.page())).includes('started a Pomodoro')
  )

  step('a shared screen arrives as a second video')
  await ui.click(alice.page(), 'Share screen')
  await ui.waitForText(bob.page(), "Alice's screen", 30_000)
  check(
    "bob sees alice's screen",
    await ui.isVisible(bob.page(), "Alice's screen")
  )

  step('hold-to-talk flips the audio sender, and letting go flips it back')
  // The native key event Rust would emit. Nothing in the DOM changes, so the
  // assertion is on the sender's enabled flag — the same thing the app's own
  // push-to-talk watchdog reasons about.
  const enabled = async () =>
    ((await ui.evaluate(
      alice.page(),
      'window.__lab.peers().reduce((n, p) => n + p.enabledAudioSenders, 0)'
    )) as number) ?? 0
  const mutedBefore = await enabled()
  await alice.emit('ptt-friends-pressed', null)
  await ui.until(async () => (await enabled()) > mutedBefore, {
    label: 'the audio sender to go live while held',
    timeoutMs: 15_000,
  })
  check('holding the key unmutes', (await enabled()) > mutedBefore)
  await alice.emit('ptt-friends-released', null)
  await ui.until(async () => (await enabled()) === mutedBefore, {
    label: 'the audio sender to mute again on release',
    timeoutMs: 15_000,
  })
  check('letting go mutes again', (await enabled()) === mutedBefore)

  step('nothing broke along the way')
  check(
    'no page errors',
    alice.pageErrors.length === 0 && bob.pageErrors.length === 0
  )
  check(
    'no unhandled IPC',
    alice.backend.unhandled.size === 0 && bob.backend.unhandled.size === 0
  )
})
