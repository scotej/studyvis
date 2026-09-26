import { onboard, pairViaContactCard } from '../src/flows'
import { scenario } from '../src/scenario'

scenario('invite-recovery', async ({ lab, step, check, ui }) => {
  const alice = await lab.addMachine({ name: 'alice' })
  const bob = await lab.addMachine({ name: 'bob' })
  await Promise.all([
    onboard(alice, { displayName: 'Alice' }),
    onboard(bob, { displayName: 'Bob' }),
  ])
  await pairViaContactCard(alice, bob)
  await ui.waitForText(alice.page(), 'Available', 30_000)

  step(
    'bob remains visible through relay presence while his peer connection fails'
  )
  await bob.page().addInitScript({
    content:
      'globalThis.RTCPeerConnection = class { constructor() { throw new Error("lab: peer connection unavailable") } };',
  })
  await bob.page().reload()
  await ui.waitForText(bob.page(), 'Friends', 20_000)

  step('alice queues an invite after the direct inbox connection times out')
  await ui.click(alice.page(), 'Invite Bob')
  await alice
    .page()
    .getByText(
      /Couldn't deliver the invite yet|Your friend is online, but a direct connection isn't forming/
    )
    .waitFor({ timeout: 30_000 })
  check(
    'bob received no invite while WebRTC was unavailable',
    !(await ui.text(bob.page())).includes('invites you to study')
  )
  step(
    'a working Bob connection delivers the invite without a relay offline edge'
  )
  // Keep Bob's relay-only page alive. Closing it would send a goodbye and
  // produce an offline→online edge, which also retried invites in the old code.
  const restoredPage = await bob.openPage('restored', lab.app.url)
  await ui.waitForText(restoredPage, 'invites you to study', 60_000)
  check(
    'bob receives the queued invite',
    (await ui.text(restoredPage)).includes('invites you to study')
  )
})
