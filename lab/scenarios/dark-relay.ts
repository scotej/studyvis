// Every Nostr relay is dark. The invite arrives anyway.
//
// Pairing, presence, the inbox and invite sends race Nostr AND MQTT precisely
// so one dead layer cannot strand a friend — the redundancy added after the
// v1.2.2 failure where blocked relays and clock-skewed peers made discovery
// fail symmetrically for everyone. That design has never been exercisable
// without arranging a real outage. Here it is one line.
//
// What this deliberately does NOT claim: the media-carrying session room is
// single-strategy Nostr on purpose (two transport rooms would open duplicate
// peer connections and double every video), so a session cannot form while
// Nostr is down. The invite reaching its target is the property under test.

import { onboard, pairViaContactCard } from '../src/flows'
import { scenario } from '../src/scenario'

scenario('dark-relay', async ({ lab, step, check, ui }) => {
  step('take every Nostr relay down before anything boots')
  lab.relay.faults.refuseConnections = true

  step('two machines onboard and pair — cards need no network at all')
  const alice = await lab.addMachine({ name: 'alice' })
  const bob = await lab.addMachine({ name: 'bob' })
  await Promise.all([
    onboard(alice, { displayName: 'Alice' }),
    onboard(bob, { displayName: 'Bob' }),
  ])
  await pairViaContactCard(alice, bob)

  step('presence still converges, carried by MQTT alone')
  await ui.waitForText(alice.page(), 'Available', 60_000)
  check(
    'alice sees bob available',
    await ui.isVisible(alice.page(), 'Available')
  )
  check('the relay refused every connection', lab.relay.stats().delivered === 0)
  check('the broker carried traffic instead', lab.broker.stats().published > 0)

  step('the invite reaches bob over the surviving transport')
  await ui.click(alice.page(), 'Invite Bob')
  await ui.waitForText(bob.page(), 'invites you to study', 60_000)
  check(
    'bob was rung with no Nostr relay reachable',
    await ui.isVisible(bob.page(), 'invites you to study')
  )
  check('still no relay deliveries', lab.relay.stats().delivered === 0)
  check(
    'no page errors on either machine',
    alice.pageErrors.length === 0 && bob.pageErrors.length === 0
  )
})
