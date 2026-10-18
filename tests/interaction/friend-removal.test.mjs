import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withComponentBrowser } from './component-browser.mjs'

const source = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Toaster } from 'sonner'
import { FriendsCategory } from '@/features/settings/categories/FriendsCategory'
import { useIdentityStore } from '@/stores/identityStore'
import { useFriendsStore } from '@/stores/friendsStore'
import '@/design/index.css'
window.__TAURI_INTERNALS__ = { invoke: async () => [] }
await Promise.resolve()
useIdentityStore.setState({ identity: null, status: 'absent' })
const friends = ['Alice', 'Bob', 'Cara'].map((name,i) => ({
  ed_pubkey_hex: String(i+1).padStart(64,'0'), x_pubkey_hex: 'aa'.repeat(32),
  display_name: name, paired_at: 10, last_studied_with: null,
}))
const pending = []
useFriendsStore.setState({ friends, remove: key => new Promise((resolve,reject) => {
  pending.push({ key, resolve: () => {
    useFriendsStore.setState(s => ({ friends: s.friends.filter(f => f.ed_pubkey_hex !== key) }))
    resolve()
  }, reject })
}) })
flushSync(() => createRoot(document.getElementById('root')).render(<><FriendsCategory /><Toaster /></>))
window.fixture = {
  settle: (fail = false) => fail ? pending[0].reject(new Error('Removal failed.')) : pending[0].resolve(),
  pending: () => pending.length,
  onlyOne: () => flushSync(() => useFriendsStore.setState({ friends: [friends[0]] })),
}
`

for (const fail of [false, true]) {
  test(`busy friend removal survives Escape/outside interaction until ${fail ? 'failure' : 'success'}`, async () => {
    await withComponentBrowser(source, async (page) => {
      await page
        .getByRole('button', { name: 'Remove Alice', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Remove', exact: true })
        .click()
      await page.waitForFunction(() => window.fixture.pending() === 1)
      await page.keyboard.press('Escape')
      await page.mouse.click(2, 2)
      assert.equal(await page.getByRole('dialog').count(), 1)
      assert.match(await page.getByRole('dialog').textContent(), /Alice/)
      assert.equal(
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Cancel', exact: true })
          .isDisabled(),
        true
      )
      await page.evaluate((failed) => window.fixture.settle(failed), fail)
      if (fail) {
        await page.getByText('Removal failed.', { exact: true }).waitFor()
        assert.match(await page.getByRole('dialog').textContent(), /Alice/)
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Cancel', exact: true })
          .click()
        await page.getByRole('dialog').waitFor({ state: 'hidden' })
      } else {
        await page.getByRole('dialog').waitFor({ state: 'hidden' })
        assert.equal(
          await page
            .getByRole('button', { name: 'Remove Alice', exact: true })
            .count(),
          0
        )
      }
      await page
        .getByRole('button', { name: 'Remove Bob', exact: true })
        .click()
      assert.match(await page.getByRole('dialog').textContent(), /Bob/)
    })
  })
}

for (const index of [0, 1, 2]) {
  test(`successful removal of row ${index + 1} restores focus to the list heading`, async () => {
    await withComponentBrowser(source, async (page) => {
      const opener = page.getByRole('button', {
        name: `Remove ${['Alice', 'Bob', 'Cara'][index]}`,
        exact: true,
      })
      await opener.focus()
      await page.keyboard.press('Enter')
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Remove', exact: true })
        .focus()
      await page.keyboard.press('Enter')
      await page.evaluate(() => window.fixture.settle())
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      await page.waitForFunction(() => document.activeElement?.tagName === 'H2')
      assert.equal(
        await page.evaluate(() => document.activeElement?.textContent),
        'Friends'
      )
    })
  })
}

test('removing the final friend still restores heading focus', async () => {
  await withComponentBrowser(source, async (page) => {
    await page.evaluate(() => window.fixture.onlyOne())
    await page
      .getByRole('button', { name: 'Remove Alice', exact: true })
      .focus()
    await page.keyboard.press('Enter')
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Remove', exact: true })
      .click()
    await page.evaluate(() => window.fixture.settle())
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.activeElement?.tagName === 'H2')
    assert.equal(
      await page.getByRole('button', { name: /^Remove / }).count(),
      0
    )
  })
})

for (const fail of [false, true]) {
  test(`${fail ? 'failed removal then cancel' : 'cancellation'} restores the surviving opener`, async () => {
    await withComponentBrowser(source, async (page) => {
      const opener = page.getByRole('button', {
        name: 'Remove Bob',
        exact: true,
      })
      await opener.focus()
      await page.keyboard.press('Enter')
      if (fail) {
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Remove', exact: true })
          .click()
        await page.evaluate(() => window.fixture.settle(true))
        await page.getByText('Removal failed.', { exact: true }).waitFor()
      }
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cancel', exact: true })
        .click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      await page.waitForFunction(
        () =>
          document.activeElement?.getAttribute('aria-label') === 'Remove Bob'
      )
    })
  })
}
