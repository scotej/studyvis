import assert from 'node:assert/strict'
import { test } from 'node:test'

import { withComponentBrowser } from './component-browser.mjs'

const source = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Toaster } from 'sonner'
import { ContactImportDialog } from '@/features/friends/ContactImportDialog'
import { buildContactCard } from '@/features/friends/contactCard'
import { generateIdentity, signMessage } from '@/lib/crypto/identity'
import { bytesToHex } from '@/lib/encoding'
import { useIdentityStore } from '@/stores/identityStore'
import { useFriendsStore } from '@/stores/friendsStore'
import '@/design/index.css'

const people = [generateIdentity(), generateIdentity(), generateIdentity()]
const local = { ed_pubkey_hex: bytesToHex(people[0].edPub) }
const cards = await Promise.all(people.slice(1).map((p, i) =>
  buildContactCard(bytesToHex(p.edPub), bytesToHex(p.xPub), ['Alice', 'Bob'][i],
    async message => signMessage(p.edPriv, message))))
useIdentityStore.setState({ identity: local, status: 'ready' })
const pending = []
useFriendsStore.setState({ add: () => new Promise((resolve, reject) => pending.push({resolve, reject})) })
let controls
const events = []
function App() {
  const [card, setCard] = useState(cards[0])
  const [open, setOpen] = useState(true)
  controls = { setCard, setOpen }
  return <><ContactImportDialog open={open} cardBytes={card} source="remote"
    onOpenChange={next => { events.push(next); setOpen(next) }} /><Toaster /></>
}
const root = createRoot(document.getElementById('root'))
flushSync(() => root.render(<App />))
window.fixture = {
  replace: () => flushSync(() => controls.setCard(cards[1])),
  open: value => flushSync(() => controls.setOpen(value)),
  identity: () => flushSync(() => useIdentityStore.setState({ identity: { ed_pubkey_hex: bytesToHex(people[2].edPub) } })),
  settle: (index, fail = false) => fail ? pending[index].reject(new Error('fixture rejection')) : pending[index].resolve(),
  pending: () => pending.length,
  unmount: () => flushSync(() => root.unmount()),
  events,
}
`

async function confirm(page) {
  await page.getByRole('checkbox').click()
  await page.getByRole('button', { name: 'Add friend', exact: true }).click()
  await page.waitForFunction(() => window.fixture.pending() > 0)
}

for (const fail of [false, true]) {
  test(`card replacement ignores old ${fail ? 'failure' : 'success'} and finally`, async () => {
    await withComponentBrowser(source, async (page) => {
      await confirm(page)
      await page.evaluate(() => window.fixture.replace())
      assert.match(await page.getByRole('dialog').textContent(), /Bob/)
      assert.equal(
        await page.getByRole('checkbox').getAttribute('aria-checked'),
        'false'
      )
      await page.getByRole('checkbox').click()
      await page
        .getByRole('button', { name: 'Add friend', exact: true })
        .click()
      await page.waitForFunction(() => window.fixture.pending() === 2)
      await page.evaluate((failed) => window.fixture.settle(0, failed), fail)
      await page.waitForTimeout(50)
      assert.match(await page.getByRole('dialog').textContent(), /Bob/)
      assert.equal(
        await page
          .getByRole('button', { name: 'Add friend', exact: true })
          .isDisabled(),
        true
      )
      assert.equal(await page.locator('[data-sonner-toast]').count(), 0)
      await page.waitForTimeout(2600)
      assert.equal(await page.getByRole('dialog').count(), 1)
      await page.evaluate(() => window.fixture.settle(1))
      await page
        .getByRole('heading', { name: 'Added Bob.', exact: true })
        .waitFor()
      await page.waitForFunction(() => window.fixture.events.includes(false))
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      assert.equal(await page.getByRole('dialog').count(), 0)
    })
  })
}

for (const change of ['reopen', 'identity', 'unmount']) {
  test(`old completion cannot affect ${change}`, async () => {
    await withComponentBrowser(source, async (page) => {
      await confirm(page)
      if (change === 'identity')
        await page.evaluate(() => window.fixture.identity())
      else if (change === 'unmount')
        await page.evaluate(() => window.fixture.unmount())
      else {
        await page.evaluate(() => window.fixture.open(false))
        if (change === 'reopen')
          await page.evaluate(() => window.fixture.open(true))
      }
      await page.evaluate(() => window.fixture.settle(0))
      await page.waitForTimeout(2600)
      assert.equal(
        await page.getByText('Added Alice.', { exact: true }).count(),
        0
      )
      assert.deepEqual(await page.evaluate(() => window.fixture.events), [])
      if (change === 'reopen') {
        assert.equal(await page.getByRole('dialog').count(), 1)
        assert.equal(
          await page.getByRole('checkbox').getAttribute('aria-checked'),
          'false'
        )
      }
    })
  })
}
