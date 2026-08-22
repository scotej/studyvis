// Two machines find each other with nothing but a loopback relay: contact cards
// both ways, then presence — the first thing in the app that needs a working
// rendezvous rather than a local parse.

import { onboard, pairViaContactCard } from '../src/flows'
import { scenario } from '../src/scenario'

scenario('pair', async ({ lab, step, check, ui }) => {
  step('start two machines and onboard both')
  const alice = await lab.addMachine({ name: 'alice' })
  const bob = await lab.addMachine({ name: 'bob' })
  await Promise.all([
    onboard(alice, { displayName: 'Alice' }),
    onboard(bob, { displayName: 'Bob' }),
  ])

  step('swap self-signed contact cards in both directions')
  await pairViaContactCard(alice, bob)

  const aliceFriends = alice.backend.db.friendsList()
  const bobFriends = bob.backend.db.friendsList()
  const aliceId = alice.backend.identity.loadRecord()
  const bobId = bob.backend.identity.loadRecord()

  check('alice has one friend', aliceFriends.length === 1)
  check('bob has one friend', bobFriends.length === 1)
  check(
    "alice stored bob's real identity key",
    aliceFriends[0]?.ed_pubkey_hex === bobId?.ed_pubkey_hex
  )
  check(
    "bob stored alice's real identity key",
    bobFriends[0]?.ed_pubkey_hex === aliceId?.ed_pubkey_hex
  )
  check(
    'display names crossed the wire',
    aliceFriends[0]?.display_name === 'Bob'
  )

  step('presence converges over the local relay')
  await ui.waitForText(alice.page(), 'Available', 30_000)
  await ui.waitForText(bob.page(), 'Available', 30_000)
  check(
    'alice sees bob available',
    await ui.isVisible(alice.page(), 'Available')
  )
  check('bob sees alice available', await ui.isVisible(bob.page(), 'Available'))

  step('the rendezvous really went through the lab relay')
  const relay = lab.relay.stats()
  check('relay carried events', relay.events > 0)
  check('relay fanned them out', relay.delivered > 0)
  check(
    'no page errors on either machine',
    alice.pageErrors.length === 0 && bob.pageErrors.length === 0
  )
})
