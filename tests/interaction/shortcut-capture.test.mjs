import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withComponentBrowser } from './component-browser.mjs'
const source = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ShortcutsCategory } from '@/features/settings/categories/ShortcutsCategory'
import { useSettingsStore } from '@/stores/settingsStore'
import '@/design/index.css'
const commits = [], pending = []
useSettingsStore.setState({setShortcutAccelerator: (action,accelerator) => {
  commits.push({action,accelerator})
  return new Promise((resolve,reject) => pending.push({resolve,reject}))
}})
flushSync(() => createRoot(document.getElementById('root')).render(<ShortcutsCategory />))
window.fixture = {
  commits,
  settle: (index,fail=false) => fail ? pending[index].reject(new Error('Shortcut refused.')) : pending[index].resolve(),
}
`

const captures = (page) => page.locator('button[aria-pressed]')

test('selecting AI capture disarms friends and assigns the next key only to AI', async () => {
  await withComponentBrowser(source, async (page) => {
    const controls = captures(page)
    await controls.nth(0).click()
    await controls.nth(1).click()
    assert.equal(await controls.nth(0).getAttribute('aria-pressed'), 'false')
    assert.equal(await controls.nth(1).getAttribute('aria-pressed'), 'true')
    await page.keyboard.press('Control+k')
    assert.deepEqual(await page.evaluate(() => window.fixture.commits), [
      { action: 'ptt-ai', accelerator: 'CmdOrCtrl+K' },
    ])
    await page.evaluate(() => window.fixture.settle(0))
    await page.waitForFunction(
      () =>
        document.querySelectorAll('button[aria-pressed="true"]').length === 0
    )
    await controls.nth(0).click()
    await page.keyboard.press('Escape')
    assert.equal(await controls.nth(0).getAttribute('aria-pressed'), 'false')
  })
})

for (const fail of [false, true]) {
  test(`an old pending ${fail ? 'failure' : 'success'} cannot affect a new capture`, async () => {
    await withComponentBrowser(source, async (page) => {
      const controls = captures(page)
      await controls.nth(0).click()
      await page.keyboard.press('Control+k')
      await controls.nth(1).click()
      await page.evaluate((failed) => window.fixture.settle(0, failed), fail)
      await page.waitForTimeout(50)
      assert.equal(await controls.nth(1).getAttribute('aria-pressed'), 'true')
      assert.equal(await page.getByRole('alert').count(), 0)
      await page.keyboard.press('Control+l')
      assert.deepEqual(
        await page.evaluate(() => window.fixture.commits.map((c) => c.action)),
        ['ptt-friends', 'ptt-ai']
      )
      await page.evaluate(() => window.fixture.settle(1))
      await page.waitForFunction(
        () =>
          document.querySelectorAll('button[aria-pressed="true"]').length === 0
      )
    })
  })
}
