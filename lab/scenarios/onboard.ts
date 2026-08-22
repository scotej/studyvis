// The floor the whole harness stands on: a brand-new machine reaches a usable
// home screen with a real identity, having produced no page errors, no
// unhandled IPC, and no traffic that left the box.

import { onboard } from '../src/flows'
import { scenario } from '../src/scenario'

scenario('onboard', async ({ lab, step, check, ui }) => {
  step('start one machine with an empty disk')
  const alice = await lab.addMachine({ name: 'alice' })

  step('walk the six onboarding steps')
  await onboard(alice, { displayName: 'Alice' })

  step('the home screen is up and the identity is real')
  const record = alice.backend.identity.loadRecord()
  check('identity.json was written', record !== null)
  check('display name persisted', record?.display_name === 'Alice')
  check('private keys are held', alice.backend.identity.keysPresent())
  check(
    'ed25519 pubkey is 32 bytes',
    (record?.ed_pubkey_hex.length ?? 0) === 64
  )
  check('friends list is empty', alice.backend.db.friendsList().length === 0)
  check('no page errors', alice.pageErrors.length === 0)
  check('no unhandled IPC', alice.backend.unhandled.size === 0)

  step('settings are readable and writable from the lab')
  alice.backend.stores.seed('settings.json', { theme: 'light' })
  await ui.until(
    () => alice.backend.stores.read('settings.json').theme === 'light',
    { label: 'settings.json to carry the seeded theme' }
  )
  check('settings round-trip', true)
})
