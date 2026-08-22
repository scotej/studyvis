// Alice invites Bob and they end up in one session carrying real media.
//
// This is the scenario that needs everything at once: rendezvous over the lab's
// relay, an encrypted invite over a data channel, a second peer connection for
// the session room, and camera tracks in both directions. Two laptops in one
// process, which is the whole point of the harness.

import {
  inviteAndAccept,
  onboard,
  pairViaContactCard,
  videoState,
} from '../src/flows'
import { scenario } from '../src/scenario'

scenario('session', async ({ lab, step, check, ui }) => {
  step('two paired machines')
  const alice = await lab.addMachine({ name: 'alice' })
  const bob = await lab.addMachine({ name: 'bob' })
  await Promise.all([
    onboard(alice, { displayName: 'Alice' }),
    onboard(bob, { displayName: 'Bob' }),
  ])
  await pairViaContactCard(alice, bob)

  step('alice invites bob over his inbox room; bob accepts')
  await inviteAndAccept(alice, bob, 'Bob', 'Alice')

  step('both are in the same session, seeing each other')
  await ui.waitForText(alice.page(), 'Bob', 20_000)
  await ui.waitForText(bob.page(), 'Alice', 20_000)
  const aliceScreen = await ui.text(alice.page())
  const bobScreen = await ui.text(bob.page())
  check('alice logged both joins', aliceScreen.includes('Bob joined'))
  check('bob is in the session', bobScreen.includes('Study session'))

  step('media flows both ways')
  // Two videos per side: the local preview and the remote peer.
  await ui.until(
    async () =>
      (await videoState(alice)).filter((v) => v.width > 0).length >= 2,
    { label: 'alice to render two painting videos', timeoutMs: 30_000 }
  )
  await ui.until(
    async () => (await videoState(bob)).filter((v) => v.width > 0).length >= 2,
    { label: 'bob to render two painting videos', timeoutMs: 30_000 }
  )
  const aliceVideos = await videoState(alice)
  check(
    'alice paints live frames',
    aliceVideos.every((video) => video.width > 0 && video.playing)
  )
  check(
    'alice receives live audio and video tracks',
    aliceVideos.some(
      (video) =>
        video.tracks.includes('video:live') &&
        video.tracks.includes('audio:live')
    )
  )

  step('the session is durable and local')
  check(
    'no unhandled IPC',
    alice.backend.unhandled.size === 0 && bob.backend.unhandled.size === 0
  )
  check(
    'no page errors',
    alice.pageErrors.length === 0 && bob.pageErrors.length === 0
  )
  check('relay carried the rendezvous', lab.relay.stats().delivered > 0)
})
