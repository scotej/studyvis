// The 24 words are the only way back to an identity, and the derivation from
// them is a cross-version contract: change a constant and every existing user's
// keys move. This walks the real recovery screens on a second, empty machine
// and checks the same keys come back — the property a friend depends on when
// they replace a laptop.

import { onboard, recover } from '../src/flows'
import { scenario } from '../src/scenario'

scenario('recover', async ({ lab, step, check }) => {
  step('a machine mints an identity and is shown its words')
  const first = await lab.addMachine({ name: 'first' })
  const mnemonic = await onboard(first, { displayName: 'Alice' })
  check('twenty-four words were shown', mnemonic.length === 24)
  const original = first.backend.identity.loadRecord()

  step('a second, empty machine restores from those words')
  const second = await lab.addMachine({ name: 'second' })
  await recover(second, mnemonic, 'Alice on the new laptop')
  const restored = second.backend.identity.loadRecord()

  step('the same identity came back')
  check(
    'the signing key matches',
    restored?.ed_pubkey_hex === original?.ed_pubkey_hex
  )
  check(
    'the box key matches',
    restored?.x_pubkey_hex === original?.x_pubkey_hex
  )
  check(
    'the mnemonic fingerprint matches',
    restored?.mnemonic_fingerprint === original?.mnemonic_fingerprint
  )
  check(
    'the display name is the new one, not the old',
    restored?.display_name === 'Alice on the new laptop'
  )
  check(
    'the restored machine holds private keys',
    second.backend.identity.keysPresent()
  )
  check(
    'no page errors',
    first.pageErrors.length === 0 && second.pageErrors.length === 0
  )
})
